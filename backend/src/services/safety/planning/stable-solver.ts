/**
 * V7.2 承诺式求解器（研究模块）。
 *
 * 目的：为「某区域继续使用上一出口」的承诺提供可执行的求解路径。
 * 单商品最小费用流无法表达「按来源区域的出口限制」（出口弧只属于出口所在区域），
 * 因此本模块采用**逐区域顺序求解 + 容量预留**：
 *   1. 按区域 ID 顺序，对承诺区域单独求解（场景只保留其承诺出口）；
 *   2. 从工作容量中扣除该区域已占用的走廊/出口逐分钟容量；
 *   3. 剩余区域在剩余容量上统一求解。
 * 结果是可行（不超容量）的贪心多商品近似，不是联合最优；报告必须披露这一点。
 *
 * 安全边界：结果仍须经独立校验器；承诺出口不可用时跳过承诺并记录紧急覆盖。
 */
import type { EvacuationPlan, EvacuationRoute, SafetyScenario } from '../types';
import type { EffectiveNetwork } from '../network';
import { solveTimeExpandedPlan, type SolveVersions } from './strategies';
import { checkPlanCapacity } from './route-stability';

export interface StableSolveInput {
  scenario: SafetyScenario;
  network: EffectiveNetwork;
  demandByRegion: Map<string, number>;
  horizonMinutes: number;
  baseMinute: number;
  versions: SolveVersions;
  now: Date;
  /** 承诺：区域 -> 保持的出口。 */
  commitments: Map<string, string>;
  /**
   * 承诺份额（0~1，默认 0.8）：只把该比例的当前在场人数固定到承诺出口，
   * 其余人数与未来到达仍参与自由优化，避免「全量固定」造成的过度拥堵。
   * 份额 > 0.5 时该区域的支配出口仍为承诺出口，从而抑制切换统计。
   */
  commitmentShare?: number;
  predictedArrivals?: Map<string, Array<{ offsetMinute: number; persons: number }>>;
  corridorCapacityFactor?: (corridorId: string, absoluteMinute: number) => number;
  exitCapacityFactor?: (exitId: string, absoluteMinute: number) => number;
  holdCostPerMinute?: number;
}

export interface StableSolveOutput {
  plan: EvacuationPlan;
  committed_regions: string[];
  emergency_overrides: string[];
  /** 承诺区域因承诺出口容量不足而未能疏散的人数。 */
  commitment_shortfall: Map<string, number>;
  /** 自由剩余需求的未疏散明细（诊断用）。 */
  free_unresolved: Array<{ region_id: string; persons: number; reason: string }>;
  /** 自由剩余需求总量（诊断用）。 */
  free_demand_total: number;
  /** 合并后逐分钟容量冲突；非空时调用方不得采用该方案。 */
  capacity_violations: Array<{ kind: 'corridor' | 'exit'; id: string; minute: number; load: number; capacity: number }>;
}

function sumMap(map: Map<string, number>): number {
  let total = 0;
  for (const value of map.values()) total += Math.max(0, value);
  return total;
}

function cloneNetworkWithExits(network: EffectiveNetwork, keepExitIds: Set<string>): EffectiveNetwork {
  const exits = new Map<string, EffectiveNetwork['exits'] extends Map<string, infer V> ? V : never>();
  for (const [id, value] of network.exits) {
    if (keepExitIds.has(id)) exits.set(id, value);
  }
  return { ...network, exits };
}

function subtractCapacity(
  map: Map<string, Map<number, number>>,
  id: string,
  minute: number,
  persons: number,
): void {
  const byMinute = map.get(id);
  if (!byMinute) return;
  const current = byMinute.get(minute) ?? 0;
  byMinute.set(minute, Math.max(0, current - persons));
}

function addUsage(
  map: Map<string, Map<number, number>>,
  id: string,
  minute: number,
  persons: number,
): void {
  if (persons <= 0) return;
  const byMinute = map.get(id) ?? new Map<number, number>();
  byMinute.set(minute, (byMinute.get(minute) ?? 0) + persons);
  map.set(id, byMinute);
}

export function solveCommitmentAwarePlan(input: StableSolveInput): StableSolveOutput {
  const { scenario, network, demandByRegion, horizonMinutes, baseMinute, versions, now } = input;
  const horizon = Math.max(1, Math.floor(horizonMinutes));
  const timeSteps = horizon + 1;
  const usableExitIds = new Set([...network.exits.entries()].filter(([, value]) => value.usable).map(([id]) => id));
  // 已承诺区域占用的通道容量（方向 -> 分钟 -> 人数）；核心求解按名义容量减已用建弧。
  const corridorUsed = new Map<string, Map<number, number>>();
  const exitCapacity = new Map<string, Map<number, number>>();
  for (const exit of scenario.exits) {
    if (!usableExitIds.has(exit.id)) continue;
    const nominal = exit.capacity_per_min ?? 0;
    const byMinute = new Map<number, number>();
    for (let t = 0; t < timeSteps; t += 1) {
      const factor = input.exitCapacityFactor
        ? Math.max(0, input.exitCapacityFactor(exit.id, baseMinute + t))
        : 1;
      byMinute.set(t, Math.floor(nominal * factor));
    }
    exitCapacity.set(exit.id, byMinute);
  }

  const emergencyOverrides: string[] = [];
  const effectiveCommitments = new Map<string, string>();
  for (const [regionId, exitId] of input.commitments) {
    if ((demandByRegion.get(regionId) ?? 0) <= 0) continue;
    if (!usableExitIds.has(exitId)) {
      emergencyOverrides.push(regionId);
      continue;
    }
    effectiveCommitments.set(regionId, exitId);
  }

  const arrivalsFor = (regionIds: Set<string>): Map<string, Array<{ offsetMinute: number; persons: number }>> => {
    const result = new Map<string, Array<{ offsetMinute: number; persons: number }>>();
    for (const [regionId, arrivals] of input.predictedArrivals ?? new Map()) {
      if (!regionIds.has(regionId)) continue;
      const valid = arrivals.filter((item: { persons: number; offsetMinute: number }) => item.persons > 0 && item.offsetMinute >= 0 && item.offsetMinute <= horizon);
      if (valid.length > 0) result.set(regionId, valid);
    }
    return result;
  };

  const routes: EvacuationRoute[] = [];
  const committedRegions: string[] = [];
  const commitmentShortfall = new Map<string, number>();
  const share = Math.max(0, Math.min(1, input.commitmentShare ?? 0.8));
  const deferredDemand = new Map<string, number>();

  const committedIds = [...effectiveCommitments.keys()].sort();
  for (const regionId of committedIds) {
    const exitId = effectiveCommitments.get(regionId)!;
    const total = Math.max(0, Math.floor(demandByRegion.get(regionId) ?? 0));
    const sticky = Math.floor(total * share);
    if (total - sticky > 0) deferredDemand.set(regionId, total - sticky);
    if (sticky <= 0) continue;
    const demand = new Map([[regionId, sticky]]);
    const exit = scenario.exits.find(item => item.id === exitId);
    if (!exit) {
      emergencyOverrides.push(regionId);
      continue;
    }
    const subsetScenario: SafetyScenario = {
      ...scenario,
      exits: [exit],
    };
    const subsetNetwork = cloneNetworkWithExits(network, new Set([exitId]));
    const solved = solveTimeExpandedPlan({
      scenario: subsetScenario,
      network: subsetNetwork,
      demandByRegion: demand,
      horizonMinutes: horizon,
      baseMinute,
      versions,
      now,
      corridorUsedByMinute: corridorUsed,
      exitCapacityByMinute: exitCapacity,
      holdCostPerMinute: input.holdCostPerMinute ?? 0.05,
      algorithm: 'commitment-aware sequential time-expanded flow',
      model: `committed region ${regionId} -> exit ${exitId}; capacity reserved from prior regions`,
    });
    committedRegions.push(regionId);
    const remaining = solved.plan.unresolved_persons;
    if (remaining > 0) commitmentShortfall.set(regionId, remaining);
    routes.push(...solved.plan.routes);
    for (const route of solved.plan.routes) {
      for (const step of route.steps) {
        addUsage(corridorUsed, `${step.corridor_id}|${step.from_region_id}->${step.to_region_id}`, step.depart_minute, route.persons);
      }
      subtractCapacity(exitCapacity, route.exit_id, route.arrive_minute, route.persons);
    }
  }

  const remainingDemand = new Map<string, number>();
  for (const [regionId, persons] of demandByRegion) {
    if (effectiveCommitments.has(regionId)) continue;
    if (persons > 0) remainingDemand.set(regionId, Math.floor(persons));
  }
  for (const [regionId, persons] of deferredDemand) {
    if (persons > 0) remainingDemand.set(regionId, (remainingDemand.get(regionId) ?? 0) + persons);
  }
  const remainingRegions = new Set([...remainingDemand.keys(), ...effectiveCommitments.keys()]);
  const freeSolved = solveTimeExpandedPlan({
    scenario,
    network,
    demandByRegion: remainingDemand,
    horizonMinutes: horizon,
    baseMinute,
    versions,
    now,
    predictedArrivals: arrivalsFor(remainingRegions),
    corridorUsedByMinute: corridorUsed,
    exitCapacityByMinute: exitCapacity,
    holdCostPerMinute: input.holdCostPerMinute ?? 0.05,
    algorithm: 'commitment-aware sequential time-expanded flow (free remainder)',
    model: 'remaining regions solved on capacity left after committed regions',
  });
  routes.push(...freeSolved.plan.routes);

  const ordered = routes
    .map((route, index) => ({ ...route, route_id: `RT-CMT-${String(index + 1).padStart(3, '0')}` }))
    .sort((a, b) => a.from_region_id.localeCompare(b.from_region_id)
      || a.exit_id.localeCompare(b.exit_id)
      || a.depart_minute - b.depart_minute);

  const totalDemand = new Map<string, number>();
  for (const [regionId, persons] of demandByRegion) {
    if (persons > 0) totalDemand.set(regionId, Math.floor(persons));
  }
  for (const [regionId, arrivals] of input.predictedArrivals ?? new Map()) {
    const extra = arrivals
      .filter((item: { persons: number; offsetMinute: number }) => item.persons > 0 && item.offsetMinute >= 0 && item.offsetMinute <= horizon)
      .reduce((sum: number, item: { persons: number }) => sum + Math.floor(item.persons), 0);
    if (extra > 0) totalDemand.set(regionId, (totalDemand.get(regionId) ?? 0) + extra);
  }
  const totalPersons = sumMap(totalDemand);
  const routedByRegion = new Map<string, number>();
  for (const route of ordered) {
    routedByRegion.set(route.from_region_id, (routedByRegion.get(route.from_region_id) ?? 0) + route.persons);
  }
  const unresolved = [];
  let unresolvedPersons = 0;
  for (const [regionId, demand] of totalDemand) {
    const remaining = Math.max(0, demand - (routedByRegion.get(regionId) ?? 0));
    if (remaining <= 0) continue;
    unresolvedPersons += remaining;
    unresolved.push({
      region_id: regionId,
      persons: remaining,
      reason: effectiveCommitments.has(regionId)
        ? `承诺出口 ${effectiveCommitments.get(regionId)} 在 ${horizon} 分钟内容量不足`
        : `${horizon} 分钟内通道/出口容量不足，无法完整疏散`,
    });
  }
  const evacuated = ordered.reduce((sum, route) => sum + route.persons, 0);
  const exitTotals = new Map<string, number>();
  const corridorTotals = new Map<string, number>();
  for (const route of ordered) {
    exitTotals.set(route.exit_id, (exitTotals.get(route.exit_id) ?? 0) + route.persons);
    for (const step of route.steps) {
      corridorTotals.set(step.corridor_id, (corridorTotals.get(step.corridor_id) ?? 0) + route.persons);
    }
  }
  const plan: EvacuationPlan = {
    plan_id: `PLAN-CMT-${now.getTime().toString(36).toUpperCase()}-${baseMinute}`,
    created_at: now.toISOString(),
    scenario_version: versions.scenarioVersion,
    constraint_version: versions.constraintVersion,
    observation_version: versions.observationVersion,
    horizon_minutes: scenario.config.horizon_minutes,
    status: totalPersons === 0 ? 'feasible' : evacuated === 0 ? 'infeasible' : evacuated >= totalPersons ? 'feasible' : 'partial',
    routes: ordered,
    unresolved,
    exit_totals: [...exitTotals.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([exit_id, persons]) => ({ exit_id, persons })),
    corridor_totals: [...corridorTotals.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([corridor_id, persons]) => ({ corridor_id, persons })),
    demand_by_region: [...totalDemand.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([region_id, persons]) => ({ region_id, persons })),
    total_persons: totalPersons,
    evacuated_persons: evacuated,
    unresolved_persons: unresolvedPersons,
    planner: {
      algorithm: 'commitment-aware sequential time-expanded min-cost flow',
      model: 'committed regions solved first with reserved capacity; remaining regions solved on residual capacity',
      notes: [
        '逐区域顺序求解是贪心多商品近似，不是联合最优；容量不超限但 makespan 可能劣化。',
        '承诺出口不可用时跳过承诺并记录紧急覆盖。',
        '结果仍须经独立校验器；本模块不改变四态与发布语义。',
      ],
    },
  };
  const capacityViolations = checkPlanCapacity(scenario, ordered, baseMinute, {
    corridorCapacityFactor: input.corridorCapacityFactor,
    exitCapacityFactor: input.exitCapacityFactor,
  });
  // 容量冲突时逐步降低承诺份额重解；仍冲突则如实返回，由调用方拒绝。
  if (capacityViolations.length > 0 && share > 0.2 + 1e-9) {
    return solveCommitmentAwarePlan({
      ...input,
      commitmentShare: Math.max(0.2, Number((share - 0.2).toFixed(4))),
    });
  }
  return {
    plan,
    committed_regions: committedRegions,
    emergency_overrides: emergencyOverrides,
    commitment_shortfall: commitmentShortfall,
    capacity_violations: capacityViolations,
    free_unresolved: freeSolved.plan.unresolved.map(item => ({ ...item })),
    free_demand_total: [...remainingDemand.values()].reduce((sum, value) => sum + value, 0)
      + [...arrivalsFor(remainingRegions).values()].reduce(
        (sum, list) => sum + list.reduce((inner, item) => inner + Math.floor(item.persons), 0),
        0,
      ),
  };
}
