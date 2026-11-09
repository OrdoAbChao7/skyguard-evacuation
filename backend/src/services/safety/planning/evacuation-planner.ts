/**
 * 容量约束疏散规划器（时间扩展网络流）。
 *
 * 模型说明（必须与文档一致，不得夸大）：
 *  - 采用**时间扩展网络流**：节点为 (区域, 分钟)，通道弧为 (u,t)→(v,t+τ) 且容量为
 *    「该分钟内可出发的人数 = 通道通行能力(人/分钟)」，出口弧 (region,t)→汇点 容量为
 *    「该分钟内可接收人数 = 出口接收能力(人/分钟)」。
 *  - 因此求解结果同时满足：通道容量、出口容量、中间区域流量守恒、人群完整分配或
 *    明确未解决需求，并且**在时间上可行**（到达出口不晚于 horizon）。
 *  - 这不是人群动力学仿真：不建模拥挤导致的减速、恐慌、逆行、队伍长度演化。
 *    结果应被理解为「在给定容量与行程时间假设下的可疏散吞吐上限与分配方案」。
 *
 * 与灵小禅旅游路线的区别：后者是单人最短路径 + 时间窗；本规划器是多源多路径、
 * 带容量约束的人群分配，不能相互替代。
 */
import type {
  EvacuationPlan,
  EvacuationRoute,
  SafetyScenario,
  UnresolvedDemand,
} from '../types';
import {
  corridorDirections,
  traversalMinutes,
  type EffectiveNetwork,
} from '../network';
import { MinCostFlowNetwork, type DecomposedPath, type FlowEdgeMeta, type FlowNodeMeta } from './min-cost-flow';

export interface PlanInput {
  scenario: SafetyScenario;
  network: EffectiveNetwork;
  demandByRegion: Map<string, number>;
  /** 需求来源审计信息（预测驱动规划时必填；observed 模式可省略）。 */
  demandProvenance?: Array<{
    region_id: string;
    observed_count: number;
    planned_count: number;
    source: string;
    predicted_count: number | null;
    interval_upper: number | null;
    reliability: string;
  }>;
  scenarioVersion: string;
  constraintVersion: number;
  observationVersion: number;
  now?: Date;
}

export interface PlanOutput {
  plan: EvacuationPlan;
  /** 规划过程中被排除的元素与原因，用于 Trace 与前端说明。 */
  exclusions: Array<{ kind: 'corridor' | 'exit' | 'region'; id: string; reason: string }>;
  solveMs: number;
  /** 求解器达到增广上限时为 true；未解决需求不能据此判定为容量不足。 */
  solverTruncated: boolean;
}

interface RegionIndex {
  id: string;
  index: number;
  demand: number;
  holdingCapacity: number;
}

function routeSignature(path: DecomposedPath): string {
  return [
    path.regionId,
    path.exitId,
    String(path.departMinute),
    // 到达出口的时刻必须参与合并键：否则等待出口容量释放的两批人会合并成一条错误路线
    String(path.arriveMinute),
    path.steps.map(step => `${step.corridorId}@${step.departMinute}`).join('>'),
  ].join('|');
}

export function planEvacuation(input: PlanInput): PlanOutput {
  const startedAt = Date.now();
  const now = input.now ?? new Date();
  const { scenario, network, demandByRegion } = input;
  const horizon = scenario.config.horizon_minutes;

  const regions: RegionIndex[] = scenario.regions
    .filter(region => region.enabled)
    .map((region, index) => ({
      id: region.id,
      index,
      demand: Math.max(0, Math.floor(demandByRegion.get(region.id) ?? 0)),
      holdingCapacity: region.holding_capacity_persons,
    }));

  const regionByIndex = new Map<number, RegionIndex>();
  const regionById = new Map<string, RegionIndex>();
  for (const region of regions) {
    regionByIndex.set(region.index, region);
    regionById.set(region.id, region);
  }

  const timeSteps = horizon + 1;
  const nodeIndex = (regionIndex: number, minute: number): number => regionIndex * timeSteps + minute;
  const sourceNode = regions.length * timeSteps;
  const sinkNode = sourceNode + 1;
  // 双向通道需要一对「闸门」节点共享同一分钟容量，保证正反方向合计不超过 capacity_per_min。
  const gateSlots = scenario.corridors.reduce((sum, corridor) => {
    if (corridor.direction !== 'both') return sum;
    const transit = traversalMinutes(corridor);
    if (transit > horizon) return sum;
    return sum + (horizon - transit + 1) * 2;
  }, 0);
  const gateBase = sinkNode + 1;

  const flow = new MinCostFlowNetwork(gateBase + gateSlots);
  let gateCursor = gateBase;
  for (const region of regions) {
    for (let t = 0; t < timeSteps; t += 1) {
      flow.setNodeMeta(nodeIndex(region.index, t), { kind: 'region', regionId: region.id, minute: t });
    }
  }
  flow.setNodeMeta(sourceNode, { kind: 'source' });
  flow.setNodeMeta(sinkNode, { kind: 'sink' });

  const exclusions: Array<{ kind: 'corridor' | 'exit' | 'region'; id: string; reason: string }> = [];

  // 1. 源 -> 区域(0)，容量 = 该区域需要疏散的人数
  for (const region of regions) {
    if (region.demand <= 0) continue;
    const meta: FlowEdgeMeta = { kind: 'source', regionId: region.id };
    flow.addEdge(sourceNode, nodeIndex(region.index, 0), region.demand, 0, meta);
  }

  // 2. 区域内的等待/滞留弧 (r,t) -> (r,t+1)
  //    在留容量是硬约束：超出部分不得被静默放大吸收，只能通过通道离开或计入未解决需求。
  for (const region of regions) {
    const holdCapacity = Math.max(0, Math.floor(region.holdingCapacity));
    for (let t = 0; t < horizon; t += 1) {
      const meta: FlowEdgeMeta = { kind: 'hold', regionId: region.id };
      flow.addEdge(nodeIndex(region.index, t), nodeIndex(region.index, t + 1), holdCapacity, 0, meta);
    }
  }

  // 3. 通道弧
  for (const corridor of scenario.corridors) {
    const effective = network.corridors.get(corridor.id);
    if (!effective) continue;
    if (!effective.usable) {
      exclusions.push({ kind: 'corridor', id: corridor.id, reason: effective.unusableReason ?? '不可用' });
      continue;
    }
    const capacity = corridor.capacity_per_min ?? 0;
    const transit = traversalMinutes(corridor);
    const directions = corridorDirections(corridor);
    const usableDirections: Array<{ from: RegionIndex; to: RegionIndex }> = [];
    for (const direction of directions) {
      const from = regionById.get(direction.from);
      const to = regionById.get(direction.to);
      if (!from || !to) {
        exclusions.push({ kind: 'corridor', id: corridor.id, reason: '端点区域未启用或不存在' });
        continue;
      }
      usableDirections.push({ from, to });
    }
    if (usableDirections.length === 0) continue;

    if (usableDirections.length === 1) {
      const { from, to } = usableDirections[0];
      for (let t = 0; t + transit <= horizon; t += 1) {
        flow.addEdge(nodeIndex(from.index, t), nodeIndex(to.index, t + transit), capacity, transit, {
          kind: 'corridor',
          corridorId: corridor.id,
          fromRegionId: from.id,
          toRegionId: to.id,
          departMinute: t,
          arriveMinute: t + transit,
        });
      }
      continue;
    }

    // 双向通道：正反两个方向共享同一分钟容量（与 Validator 的聚合口径一致）。
    // 结构：from_t -> gateIn -> gateOut -> to_{t+transit}，gateIn->gateOut 的容量即通道容量。
    for (let t = 0; t + transit <= horizon; t += 1) {
      const gateIn = gateCursor++;
      const gateOut = gateCursor++;
      flow.setNodeMeta(gateIn, { kind: 'region', regionId: corridor.id, minute: t });
      flow.setNodeMeta(gateOut, { kind: 'region', regionId: corridor.id, minute: t + transit });
      flow.addEdge(gateIn, gateOut, capacity, 0, { kind: 'hold', regionId: corridor.id });
      for (const { from, to } of usableDirections) {
        flow.addEdge(nodeIndex(from.index, t), gateIn, capacity, 0, {
          kind: 'hold',
          regionId: from.id,
        });
        flow.addEdge(gateOut, nodeIndex(to.index, t + transit), capacity, transit, {
          kind: 'corridor',
          corridorId: corridor.id,
          fromRegionId: from.id,
          toRegionId: to.id,
          departMinute: t,
          arriveMinute: t + transit,
        });
      }
    }
  }

  // 4. 出口弧 (region,t) -> 汇点
  for (const exit of scenario.exits) {
    const effective = network.exits.get(exit.id);
    if (!effective) continue;
    const owner = regionById.get(exit.region_id);
    if (!owner) {
      exclusions.push({ kind: 'exit', id: exit.id, reason: '所属区域未启用' });
      continue;
    }
    if (!effective.usable) {
      exclusions.push({ kind: 'exit', id: exit.id, reason: effective.unusableReason ?? '不可用' });
      continue;
    }
    const capacity = exit.capacity_per_min ?? 0;
    for (let t = 0; t < timeSteps; t += 1) {
      const meta: FlowEdgeMeta = {
        kind: 'exit',
        exitId: exit.id,
        regionId: owner.id,
        departMinute: t,
        arriveMinute: t,
      };
      flow.addEdge(nodeIndex(owner.index, t), sinkNode, capacity, 0, meta);
    }
  }

  const solve = flow.minCostMaxFlow(sourceNode, sinkNode);
  let solverTruncated = solve.iterations >= 200000;
  if (process.env.SKYGUARD_DEBUG_FLOW) {
    const exits = flow.debugEdgeFlows().filter(e => e.meta?.kind === 'exit' && e.flow > 0);
    console.error('[flow] exit arcs:', JSON.stringify(exits.map(e => ({ exit: e.meta!.exitId, t: e.meta!.departMinute, flow: e.flow, cap: e.capacity }))));
    const src = flow.debugEdgeFlows().filter(e => e.meta?.kind === 'source');
    console.error('[flow] source arcs:', JSON.stringify(src.map(e => ({ r: e.meta!.regionId, flow: e.flow, cap: e.capacity }))));
    console.error('[flow] total', solve);
  }
  const paths = flow.decompose(sourceNode, sinkNode);

  // 合并同一 (区域, 出口, 出发分钟, 通道序列) 的路径
  const merged = new Map<string, DecomposedPath>();
  for (const path of paths) {
    const key = routeSignature(path);
    const existing = merged.get(key);
    if (existing) existing.persons += path.persons;
    else merged.set(key, { ...path });
  }

  const routes: EvacuationRoute[] = [...merged.values()]
    .sort((a, b) => a.regionId.localeCompare(b.regionId) || a.exitId.localeCompare(b.exitId) || a.departMinute - b.departMinute)
    .map((path, index) => ({
      route_id: `RT-${String(index + 1).padStart(3, '0')}`,
      from_region_id: path.regionId,
      exit_id: path.exitId,
      persons: path.persons,
      depart_minute: path.departMinute,
      arrive_minute: path.arriveMinute,
      steps: path.steps.map(step => ({
        corridor_id: step.corridorId,
        from_region_id: step.fromRegionId,
        to_region_id: step.toRegionId,
        depart_minute: step.departMinute,
        arrive_minute: step.arriveMinute,
        persons: path.persons,
      })),
    }));

  // 自检：路径分解不得出现方向/链路错配（双向共享闸门的潜在后处理风险）。
  const decompositionInvalid = routes.some(route => {
    let cursor = route.from_region_id;
    for (const step of route.steps) {
      if (step.from_region_id !== cursor) return true;
      cursor = step.to_region_id;
    }
    return false;
  });
  if (decompositionInvalid) solverTruncated = true;

  // 未解决需求
  const evacuatedByRegion = new Map<string, number>();
  for (const route of routes) {
    evacuatedByRegion.set(route.from_region_id, (evacuatedByRegion.get(route.from_region_id) ?? 0) + route.persons);
  }

  const reachableRegions = computeEgressReachability(scenario, network);
  const unresolved: UnresolvedDemand[] = [];
  for (const region of regions) {
    const evacuated = evacuatedByRegion.get(region.id) ?? 0;
    const remaining = region.demand - evacuated;
    if (remaining > 0) {
      unresolved.push({
        region_id: region.id,
        persons: remaining,
        reason: reachableRegions.has(region.id)
          ? `${horizon} 分钟内通道/出口容量不足，无法完整疏散`
          : `${horizon} 分钟内无可达且可用的出口`,
      });
    }
  }

  const exitTotalsMap = new Map<string, number>();
  for (const route of routes) {
    exitTotalsMap.set(route.exit_id, (exitTotalsMap.get(route.exit_id) ?? 0) + route.persons);
  }
  const corridorTotalsMap = new Map<string, number>();
  for (const route of routes) {
    for (const step of route.steps) {
      corridorTotalsMap.set(step.corridor_id, (corridorTotalsMap.get(step.corridor_id) ?? 0) + route.persons);
    }
  }

  const totalPersons = regions.reduce((sum, region) => sum + region.demand, 0);
  const evacuated = routes.reduce((sum, route) => sum + route.persons, 0);
  const unresolvedPersons = totalPersons - evacuated;

  const plan: EvacuationPlan = {
    plan_id: `PLAN-${now.getTime().toString(36).toUpperCase()}`,
    created_at: now.toISOString(),
    scenario_version: input.scenarioVersion,
    constraint_version: input.constraintVersion,
    observation_version: input.observationVersion,
    horizon_minutes: horizon,
    status: unresolvedPersons === 0 ? 'feasible' : evacuated === 0 ? 'infeasible' : 'partial',
    routes,
    unresolved,
    exit_totals: [...exitTotalsMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([exitId, persons]) => ({ exit_id: exitId, persons })),
    corridor_totals: [...corridorTotalsMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([corridorId, persons]) => ({ corridor_id: corridorId, persons })),
    demand_by_region: regions
      .filter(region => region.demand > 0)
      .map(region => ({ region_id: region.id, persons: region.demand })),
    ...(input.demandProvenance ? { demand_provenance: input.demandProvenance } : {}),
    total_persons: totalPersons,
    evacuated_persons: evacuated,
    unresolved_persons: unresolvedPersons,
    planner: {
      algorithm: 'time-expanded min-cost max-flow (successive shortest path, SPFA)',
      model: 'multi-path capacity-constrained assignment on a 1-minute time-expanded network',
      notes: [
        '通道容量按人/分钟计入对应出发时刻的弧容量；双向通道正反方向共享同一分钟容量。',
        '区域在留容量是硬约束；超出部分只能通过通道离开或计入未解决需求。',
        '未建模拥挤减速、恐慌、逆行等群体动力学效应，结果不可作为精确疏散时间预测。',
        '未知状态或未知容量的通道/出口一律排除，不按无限容量处理。',
        ...(input.demandProvenance
          ? ['需求可来自预测；预测只用于上调需求，不可靠或数据不足时回退最新观测。来源见 demand_provenance。']
          : []),
        ...(solverTruncated
          ? ['求解器达到 200000 次增广上限，结果可能未达到最大流；未解决需求不一定是真实容量不足。']
          : []),
        ...(decompositionInvalid
          ? ['路径分解出现方向/链路错配，方案已标记为不可发布（solver_truncated）。']
          : []),
      ],
    },
    ...(solverTruncated ? { solver_truncated: true } : {}),
  };

  return { plan, exclusions, solveMs: Date.now() - startedAt, solverTruncated };
}

/** 在「可用」通道网络上判断区域是否能到达任一可用出口（用于区分未解决原因与风险评估）。 */
export function computeEgressReachability(
  scenario: SafetyScenario,
  network: EffectiveNetwork,
): Set<string> {
  const enabled = new Set(scenario.regions.filter(region => region.enabled).map(region => region.id));
  const adjacency = new Map<string, string[]>();
  for (const regionId of enabled) adjacency.set(regionId, []);
  for (const corridor of scenario.corridors) {
    const effective = network.corridors.get(corridor.id);
    if (!effective?.usable) continue;
    for (const direction of corridorDirections(corridor)) {
      if (!enabled.has(direction.from) || !enabled.has(direction.to)) continue;
      adjacency.get(direction.from)?.push(direction.to);
    }
  }

  const regionWithExit = new Set<string>();
  for (const exit of scenario.exits) {
    if (network.exits.get(exit.id)?.usable && enabled.has(exit.region_id)) {
      regionWithExit.add(exit.region_id);
    }
  }

  const reachable = new Set<string>(regionWithExit);
  const queue = [...regionWithExit];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  return reachable;
}
