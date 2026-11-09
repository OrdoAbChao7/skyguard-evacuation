/**
 * V7.1 动态疏散规划组件：可配置时间扩展网络求解器 + 公平基线。
 *
 * 与既有 `evacuation-planner.ts` 的关系：
 *  - 既有规划器保持原样（安全主链路），本模块提供研究用的可配置求解器；
 *  - 支持容量/成本随分钟变化、预测到达注入、出口分配限制，
 *    用于 MPC、最大流、MILP 等价枚举与消融实验。
 *
 * 所有结果仍必须经过 `validateSafetyPlan`；本模块不改变四态与发布语义。
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
import { MinCostFlowNetwork, type DecomposedPath, type FlowEdgeMeta } from './min-cost-flow';
import { computeEgressReachability } from './evacuation-planner';

export interface SolveVersions {
  scenarioVersion: string;
  constraintVersion: number;
  observationVersion: number;
}

export interface TimeExpandedSolveInput {
  scenario: SafetyScenario;
  network: EffectiveNetwork;
  demandByRegion: Map<string, number>;
  horizonMinutes: number;
  baseMinute?: number;
  versions: SolveVersions;
  now?: Date;
  /** 通道有效容量系数（相对名义容量），按绝对分钟。 */
  corridorCapacityFactor?: (corridorId: string, absoluteMinute: number) => number;
  /** 出口有效容量系数（相对名义容量），按绝对分钟。 */
  exitCapacityFactor?: (exitId: string, absoluteMinute: number) => number;
  /** 通道弧费用乘数（默认 1；0 = 最大流）。 */
  corridorCostMultiplier?: number;
  /** 等待弧每分钟费用（默认 0；正值鼓励尽早出发）。 */
  holdCostPerMinute?: number;
  /** 允许某区域使用的出口集合（MILP 枚举用）；缺省全部可用出口。 */
  allowedExitsByRegion?: Map<string, Set<string>>;
  /** 预测到达：区域 -> 相对本步起点的分钟偏移与人数。 */
  predictedArrivals?: Map<string, Array<{ offsetMinute: number; persons: number }>>;
  /** 算法标签。 */
  algorithm?: string;
  model?: string;
}

export interface SolveOutput {
  plan: EvacuationPlan;
  exclusions: Array<{ kind: 'corridor' | 'exit' | 'region'; id: string; reason: string }>;
  solveMs: number;
  /** 计划中未覆盖的初始/预测人数（按区域）。 */
  uncoveredByRegion: Map<string, number>;
}

function routeSignature(path: DecomposedPath): string {
  return [
    path.regionId,
    path.exitId,
    String(path.departMinute),
    String(path.arriveMinute),
    path.steps.map(step => `${step.corridorId}@${step.departMinute}`).join('>'),
  ].join('|');
}

export function solveTimeExpandedPlan(input: TimeExpandedSolveInput): SolveOutput {
  const started = Date.now();
  const { scenario, network, demandByRegion } = input;
  const horizon = Math.max(1, Math.floor(input.horizonMinutes));
  const baseMinute = input.baseMinute ?? 0;
  const now = input.now ?? new Date();
  const corridorCostMultiplier = input.corridorCostMultiplier ?? 1;
  const holdCost = input.holdCostPerMinute ?? 0;
  const timeSteps = horizon + 1;

  const regions = scenario.regions.filter(region => region.enabled).map((region, index) => ({ region, index }));
  const regionById = new Map(regions.map(item => [item.region.id, item]));
  const nodeIndex = (regionIndex: number, minute: number): number => regionIndex * timeSteps + minute;
  const sourceNode = regions.length * timeSteps;
  const sinkNode = sourceNode + 1;
  const flow = new MinCostFlowNetwork(sinkNode + 1);
  const exclusions: SolveOutput['exclusions'] = [];

  for (const item of regions) {
    for (let t = 0; t < timeSteps; t += 1) {
      flow.setNodeMeta(nodeIndex(item.index, t), { kind: 'region', regionId: item.region.id, minute: t });
    }
  }
  flow.setNodeMeta(sourceNode, { kind: 'source' });
  flow.setNodeMeta(sinkNode, { kind: 'sink' });

  const initialDemand = new Map<string, number>();
  const predictedByRegion = input.predictedArrivals ?? new Map<string, Array<{ offsetMinute: number; persons: number }>>();
  for (const item of regions) {
    const demand = Math.max(0, Math.floor(demandByRegion.get(item.region.id) ?? 0));
    const arrivals = (predictedByRegion.get(item.region.id) ?? [])
      .filter(entry => entry.offsetMinute >= 0 && entry.offsetMinute <= horizon && entry.persons > 0)
      .map(entry => ({ minute: Math.floor(entry.offsetMinute), persons: Math.floor(entry.persons) }));
    initialDemand.set(item.region.id, demand + arrivals.reduce((sum, entry) => sum + entry.persons, 0));
    if (demand > 0) {
      flow.addEdge(sourceNode, nodeIndex(item.index, 0), demand, 0, { kind: 'source', regionId: item.region.id });
    }
    for (const arrival of arrivals) {
      flow.addEdge(sourceNode, nodeIndex(item.index, arrival.minute), arrival.persons, 0, {
        kind: 'source',
        regionId: item.region.id,
      });
    }
  }

  // 等待弧
  for (const item of regions) {
    const demand = initialDemand.get(item.region.id) ?? 0;
    const holding = Math.max(item.region.holding_capacity_persons, demand, 1);
    for (let t = 0; t < horizon; t += 1) {
      flow.addEdge(nodeIndex(item.index, t), nodeIndex(item.index, t + 1), holding, holdCost, { kind: 'hold', regionId: item.region.id });
    }
  }

  // 通道弧
  for (const corridor of scenario.corridors) {
    const effective = network.corridors.get(corridor.id);
    if (!effective) continue;
    if (!effective.usable) {
      exclusions.push({ kind: 'corridor', id: corridor.id, reason: effective.unusableReason ?? '不可用' });
      continue;
    }
    const nominal = corridor.capacity_per_min ?? 0;
    const transit = traversalMinutes(corridor);
    for (const direction of corridorDirections(corridor)) {
      const from = regionById.get(direction.from);
      const to = regionById.get(direction.to);
      if (!from || !to) {
        exclusions.push({ kind: 'corridor', id: corridor.id, reason: '端点区域未启用或不存在' });
        continue;
      }
      for (let t = 0; t + transit <= horizon; t += 1) {
        const absoluteMinute = baseMinute + t;
        const factor = input.corridorCapacityFactor ? Math.max(0, input.corridorCapacityFactor(corridor.id, absoluteMinute)) : 1;
        const capacity = Math.floor(nominal * factor);
        if (capacity <= 0) continue;
        const meta: FlowEdgeMeta = {
          kind: 'corridor',
          corridorId: corridor.id,
          fromRegionId: from.region.id,
          toRegionId: to.region.id,
          departMinute: t,
          arriveMinute: t + transit,
        };
        flow.addEdge(nodeIndex(from.index, t), nodeIndex(to.index, t + transit), capacity, transit * corridorCostMultiplier, meta);
      }
    }
  }

  // 出口弧
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
    const allowed = input.allowedExitsByRegion?.get(owner.region.id);
    if (allowed && !allowed.has(exit.id)) continue;
    const nominal = exit.capacity_per_min ?? 0;
    for (let t = 0; t < timeSteps; t += 1) {
      const absoluteMinute = baseMinute + t;
      const factor = input.exitCapacityFactor ? Math.max(0, input.exitCapacityFactor(exit.id, absoluteMinute)) : 1;
      const capacity = Math.floor(nominal * factor);
      if (capacity <= 0) continue;
      const meta: FlowEdgeMeta = {
        kind: 'exit',
        exitId: exit.id,
        regionId: owner.region.id,
        departMinute: t,
        arriveMinute: t,
      };
      flow.addEdge(nodeIndex(owner.index, t), sinkNode, capacity, 0, meta);
    }
  }

  const solve = flow.minCostMaxFlowDijkstra(sourceNode, sinkNode);
  const paths = flow.decompose(sourceNode, sinkNode);
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

  const routedByRegion = new Map<string, number>();
  for (const route of routes) routedByRegion.set(route.from_region_id, (routedByRegion.get(route.from_region_id) ?? 0) + route.persons);
  const uncoveredByRegion = new Map<string, number>();
  const unresolved: UnresolvedDemand[] = [];
  const reachable = computeEgressReachability(scenario, network);
  for (const item of regions) {
    const demand = initialDemand.get(item.region.id) ?? 0;
    const routed = routedByRegion.get(item.region.id) ?? 0;
    const remaining = Math.max(0, demand - routed);
    if (remaining > 0) {
      uncoveredByRegion.set(item.region.id, remaining);
      unresolved.push({
        region_id: item.region.id,
        persons: remaining,
        reason: reachable.has(item.region.id)
          ? `${horizon} 分钟内通道/出口容量不足，无法完整疏散`
          : `${horizon} 分钟内无可达且可用的出口`,
      });
    }
  }

  const totalPersons = [...initialDemand.values()].reduce((sum, value) => sum + value, 0);
  const evacuated = routes.reduce((sum, route) => sum + route.persons, 0);
  const exitTotalsMap = new Map<string, number>();
  const corridorTotalsMap = new Map<string, number>();
  for (const route of routes) {
    exitTotalsMap.set(route.exit_id, (exitTotalsMap.get(route.exit_id) ?? 0) + route.persons);
    for (const step of route.steps) {
      corridorTotalsMap.set(step.corridor_id, (corridorTotalsMap.get(step.corridor_id) ?? 0) + route.persons);
    }
  }

  const plan: EvacuationPlan = {
    plan_id: `PLAN-${now.getTime().toString(36).toUpperCase()}-${baseMinute}`,
    created_at: now.toISOString(),
    scenario_version: input.versions.scenarioVersion,
    constraint_version: input.versions.constraintVersion,
    observation_version: input.versions.observationVersion,
    horizon_minutes: scenario.config.horizon_minutes,
    status: totalPersons === 0 ? 'feasible' : evacuated === 0 ? 'infeasible' : evacuated >= totalPersons ? 'feasible' : 'partial',
    routes,
    unresolved,
    exit_totals: [...exitTotalsMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([exitId, persons]) => ({ exit_id: exitId, persons })),
    corridor_totals: [...corridorTotalsMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([corridorId, persons]) => ({ corridor_id: corridorId, persons })),
    demand_by_region: [...initialDemand.entries()].filter(([, persons]) => persons > 0).map(([regionId, persons]) => ({ region_id: regionId, persons })),
    total_persons: totalPersons,
    evacuated_persons: evacuated,
    unresolved_persons: totalPersons - evacuated,
    planner: {
      algorithm: input.algorithm ?? 'time-expanded min-cost max-flow (research solver)',
      model: input.model ?? 'capacity-constrained assignment on a 1-minute time-expanded network',
      notes: [
        '研究用可配置求解器；安全发布仍需独立校验器通过。',
        '未建模拥挤减速、恐慌、逆行等群体动力学效应。',
        '未知状态或未知容量的通道/出口一律排除。',
      ],
    },
  };
  void solve;
  return { plan, exclusions, solveMs: Date.now() - started, uncoveredByRegion };
}

// ---------------------------------------------------------------------------
// 基线策略
// ---------------------------------------------------------------------------

export interface StaticPlannerInput {
  scenario: SafetyScenario;
  network: EffectiveNetwork;
  demandByRegion: Map<string, number>;
  versions: SolveVersions;
  now?: Date;
}

/** 最短通行时间分配（容量盲）：每个区域所有人走最短时间路线，全部在第 0 分钟出发。 */
export function planShortestPath(input: StaticPlannerInput): SolveOutput {
  const started = Date.now();
  const { scenario, network, demandByRegion } = input;
  const enabled = new Set(scenario.regions.filter(region => region.enabled).map(region => region.id));
  const adjacency = new Map<string, Array<{ to: string; corridorId: string; minutes: number }>>();
  for (const regionId of enabled) adjacency.set(regionId, []);
  for (const corridor of scenario.corridors) {
    const effective = network.corridors.get(corridor.id);
    if (!effective?.usable || corridor.capacity_per_min === null) continue;
    const minutes = traversalMinutes(corridor);
    for (const direction of corridorDirections(corridor)) {
      if (!enabled.has(direction.from) || !enabled.has(direction.to)) continue;
      adjacency.get(direction.from)?.push({ to: direction.to, corridorId: corridor.id, minutes });
    }
  }
  const exitByRegion = new Map<string, string>();
  for (const exit of scenario.exits) {
    if (network.exits.get(exit.id)?.usable && enabled.has(exit.region_id)) {
      if (!exitByRegion.has(exit.region_id)) exitByRegion.set(exit.region_id, exit.id);
    }
  }

  const routes: EvacuationRoute[] = [];
  let routeIndex = 0;
  const unresolved: UnresolvedDemand[] = [];
  for (const region of scenario.regions) {
    if (!region.enabled) continue;
    const demand = Math.floor(demandByRegion.get(region.id) ?? 0);
    if (demand <= 0) continue;
    // Dijkstra
    const distances = new Map<string, number>();
    const previous = new Map<string, { regionId: string; corridorId: string }>();
    distances.set(region.id, 0);
    const visited = new Set<string>();
    const queue = new Set<string>(enabled);
    while (queue.size > 0) {
      let current: string | null = null;
      let best = Number.POSITIVE_INFINITY;
      for (const candidate of queue) {
        const distance = distances.get(candidate) ?? Number.POSITIVE_INFINITY;
        if (distance < best) {
          best = distance;
          current = candidate;
        }
      }
      if (!current || best === Number.POSITIVE_INFINITY) break;
      queue.delete(current);
      visited.add(current);
      for (const edge of adjacency.get(current) ?? []) {
        if (visited.has(edge.to)) continue;
        const next = best + edge.minutes;
        if (next < (distances.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
          distances.set(edge.to, next);
          previous.set(edge.to, { regionId: current, corridorId: edge.corridorId });
        }
      }
    }
    let targetExit: string | null = null;
    let targetRegion: string | null = null;
    let targetDistance = Number.POSITIVE_INFINITY;
    for (const [exitRegionId, exitId] of exitByRegion) {
      const distance = distances.get(exitRegionId);
      if (distance !== undefined && distance < targetDistance) {
        targetDistance = distance;
        targetExit = exitId;
        targetRegion = exitRegionId;
      }
    }
    if (!targetExit || !targetRegion) {
      unresolved.push({ region_id: region.id, persons: demand, reason: '无可用路径与出口（容量盲最短路径基线）' });
      continue;
    }
    const corridorPath: string[] = [];
    let cursor = targetRegion;
    while (cursor !== region.id) {
      const step = previous.get(cursor);
      if (!step) break;
      corridorPath.unshift(step.corridorId);
      cursor = step.regionId;
    }
    let depart = 0;
    const steps: EvacuationRoute['steps'] = [];
    let from = region.id;
    for (const corridorId of corridorPath) {
      const corridor = scenario.corridors.find(item => item.id === corridorId);
      if (!corridor) break;
      const to = corridor.from_region_id === from ? corridor.to_region_id : corridor.from_region_id;
      const arrive = depart + traversalMinutes(corridor);
      steps.push({ corridor_id: corridorId, from_region_id: from, to_region_id: to, depart_minute: depart, arrive_minute: arrive, persons: demand });
      from = to;
      depart = arrive;
    }
    routes.push({
      route_id: `RT-SP-${String(routeIndex + 1).padStart(3, '0')}`,
      from_region_id: region.id,
      exit_id: targetExit,
      persons: demand,
      depart_minute: 0,
      arrive_minute: depart,
      steps,
    });
    routeIndex += 1;
  }

  const evacuated = routes.reduce((sum, route) => sum + route.persons, 0);
  const plan: EvacuationPlan = {
    plan_id: `PLAN-SP-${(input.now ?? new Date()).getTime().toString(36).toUpperCase()}`,
    created_at: (input.now ?? new Date()).toISOString(),
    scenario_version: input.versions.scenarioVersion,
    constraint_version: input.versions.constraintVersion,
    observation_version: input.versions.observationVersion,
    horizon_minutes: scenario.config.horizon_minutes,
    status: unresolved.length === 0 ? 'feasible' : evacuated === 0 ? 'infeasible' : 'partial',
    routes,
    unresolved,
    exit_totals: [],
    corridor_totals: [],
    demand_by_region: scenario.regions.filter(region => (demandByRegion.get(region.id) ?? 0) > 0).map(region => ({ region_id: region.id, persons: Math.floor(demandByRegion.get(region.id) ?? 0) })),
    total_persons: [...demandByRegion.values()].reduce((sum, value) => sum + Math.floor(value), 0),
    evacuated_persons: evacuated,
    unresolved_persons: [...demandByRegion.values()].reduce((sum, value) => sum + Math.floor(value), 0) - evacuated,
    planner: {
      algorithm: 'capacity-blind shortest path assignment',
      model: 'each region takes its shortest-time path to the nearest usable exit; all depart at t=0',
      notes: ['容量盲基线：不考虑通道/出口容量与并发冲突，执行时会排队；用于对照。'],
    },
  };
  return { plan, exclusions: [], solveMs: Date.now() - started, uncoveredByRegion: new Map(unresolved.map(item => [item.region_id, item.persons])) };
}

/** 时间扩展最大流：只最大化疏散人数，不考虑行程时间。 */
export function planMaxFlow(input: StaticPlannerInput): SolveOutput {
  return solveTimeExpandedPlan({
    scenario: input.scenario,
    network: input.network,
    demandByRegion: input.demandByRegion,
    horizonMinutes: input.scenario.config.horizon_minutes,
    versions: input.versions,
    now: input.now,
    corridorCostMultiplier: 0,
    holdCostPerMinute: 0,
    algorithm: 'time-expanded max flow (SPFA)',
    model: 'maximize evacuated persons within horizon; zero-cost arcs',
  });
}

/**
 * MILP 等价枚举：每个区域在「最近的 K 个出口」中二选一（二进制分配变量），
 * 对分配组合枚举分支（K=2 时最多 2^区域数），每个分支用时间扩展最小费用流求解；
 * 目标为最小化「人数 × 到达分钟」之和，其次最小化未疏散人数。
 *
 * 这是受限制送代集合上的精确 MILP 求解，不是全局连续 MILP 求解器；
 * 候选出口限制必须在报告中披露。
 */
export function planRestrictedMilp(input: StaticPlannerInput & { nearestExitsPerRegion?: number }): SolveOutput & {
  enumerated: number;
  restricted_candidates: Record<string, string[]>;
  variable_regions: string[];
  fixed_regions: Record<string, string>;
  enumeration_note: string;
} {
  const started = Date.now();
  const K = input.nearestExitsPerRegion ?? 2;
  const MAX_BRANCHES = 32;
  const { scenario, network } = input;
  const enabled = new Set(scenario.regions.filter(region => region.enabled).map(region => region.id));
  // Dijkstra 距离用于候选出口排序。
  const adjacency = new Map<string, Array<{ to: string; minutes: number }>>();
  for (const regionId of enabled) adjacency.set(regionId, []);
  for (const corridor of scenario.corridors) {
    const effective = network.corridors.get(corridor.id);
    if (!effective?.usable || corridor.capacity_per_min === null) continue;
    for (const direction of corridorDirections(corridor)) {
      if (!enabled.has(direction.from) || !enabled.has(direction.to)) continue;
      adjacency.get(direction.from)?.push({ to: direction.to, minutes: traversalMinutes(corridor) });
    }
  }
  const exitIds = scenario.exits.filter(exit => network.exits.get(exit.id)?.usable && enabled.has(exit.region_id)).map(exit => exit.id);
  const candidates = new Map<string, string[]>();
  const gapRatio = new Map<string, number>();
  for (const region of scenario.regions) {
    if (!region.enabled) continue;
    if ((input.demandByRegion.get(region.id) ?? 0) <= 0) continue;
    const distances = new Map<string, number>([[region.id, 0]]);
    const visited = new Set<string>();
    while (visited.size < enabled.size) {
      let current: string | null = null;
      let best = Number.POSITIVE_INFINITY;
      for (const [candidate, distance] of distances) {
        if (visited.has(candidate)) continue;
        if (distance < best) {
          best = distance;
          current = candidate;
        }
      }
      if (!current) break;
      visited.add(current);
      for (const edge of adjacency.get(current) ?? []) {
        if (visited.has(edge.to)) continue;
        const next = best + edge.minutes;
        if (next < (distances.get(edge.to) ?? Number.POSITIVE_INFINITY)) distances.set(edge.to, next);
      }
    }
    const ranked = exitIds
      .map(exitId => {
        const exitRegion = scenario.exits.find(exit => exit.id === exitId)!.region_id;
        return { exitId, distance: distances.get(exitRegion) ?? Number.POSITIVE_INFINITY };
      })
      .filter(item => Number.isFinite(item.distance))
      .sort((a, b) => a.distance - b.distance);
    const nearest = ranked[0]?.distance ?? Number.POSITIVE_INFINITY;
    // 只保留与最近出口行程时间相差 ≤25% 的候选；其余区域固定使用最近出口。
    // 这是限制候选集后的精确枚举，限制条件必须在报告中披露。
    const competitive = ranked
      .filter(item => item.distance <= nearest * 1.25 + 1)
      .slice(0, K)
      .map(item => item.exitId);
    if (competitive.length > 0) {
      candidates.set(region.id, competitive);
      gapRatio.set(region.id, competitive.length > 1 && nearest > 0 ? (ranked[1].distance - nearest) / nearest : Number.POSITIVE_INFINITY);
    }
  }

  const regionIds = [...candidates.keys()];
  // 组合爆炸控制：只对“两个出口竞争最激烈”的区域枚举二进制选择；
  // 其余区域固定在最近出口。MAX_BRANCHES 约束下最多枚举 2^5 个分支。
  const variableIds = regionIds
    .filter(regionId => (candidates.get(regionId)?.length ?? 0) > 1)
    .sort((a, b) => (gapRatio.get(a) ?? Number.POSITIVE_INFINITY) - (gapRatio.get(b) ?? Number.POSITIVE_INFINITY))
    .slice(0, Math.min(5, Math.floor(Math.log2(MAX_BRANCHES))));
  const variableSet = new Set(variableIds);
  const optionsPerRegion = regionIds.map(regionId => {
    const exits = candidates.get(regionId)!;
    return variableSet.has(regionId) ? exits.slice(0, 2) : [exits[0]];
  });
  const fixedRegions: Record<string, string> = {};
  for (const regionId of regionIds) {
    if (!variableSet.has(regionId)) fixedRegions[regionId] = candidates.get(regionId)![0];
  }
  let best: { plan: EvacuationPlan; objective: number; uncovered: number; exclusions: SolveOutput['exclusions'] } | null = null;
  let enumerated = 0;
  const totalCombinations = optionsPerRegion.reduce((product, options) => product * Math.max(1, options.length), 1);
  if (totalCombinations > MAX_BRANCHES * 2) {
    // 理论上不会发生（变量区域 ≤5），保留防御性回退。
    for (let index = 0; index < optionsPerRegion.length; index += 1) optionsPerRegion[index] = [optionsPerRegion[index][0]];
  }
  const recurse = (index: number, choice: Map<string, Set<string>>) => {
    if (index === regionIds.length) {
      enumerated += 1;
      const solved = solveTimeExpandedPlan({
        scenario: input.scenario,
        network: input.network,
        demandByRegion: input.demandByRegion,
        horizonMinutes: input.scenario.config.horizon_minutes,
        versions: input.versions,
        now: input.now,
        allowedExitsByRegion: new Map([...choice.entries()].map(([regionId, set]) => [regionId, new Set(set)])),
        holdCostPerMinute: 0.05,
        algorithm: 'MILP (restricted binary exit assignment, exhaustive branch-and-bound)',
        model: `binary exit assignment over nearest ${K} exits per region + time-expanded min-cost flow`,
      });
      let objective = solved.plan.routes.reduce((sum, route) => sum + route.persons * route.arrive_minute, 0);
      objective += solved.plan.unresolved_persons * 10_000;
      if (!best || objective < best.objective - 1e-9) {
        best = {
          plan: solved.plan,
          objective,
          uncovered: solved.plan.unresolved_persons,
          exclusions: solved.exclusions,
        };
      }
      return;
    }
    const regionId = regionIds[index];
    for (const exitId of optionsPerRegion[index]) {
      const next = new Map(choice);
      next.set(regionId, new Set([exitId]));
      recurse(index + 1, next);
    }
  };
  recurse(0, new Map());
  const chosen = best as { plan: EvacuationPlan; objective: number; uncovered: number; exclusions: SolveOutput['exclusions'] } | null;
  if (!chosen) {
    const fallback = solveTimeExpandedPlan({
      scenario: input.scenario,
      network: input.network,
      demandByRegion: input.demandByRegion,
      horizonMinutes: input.scenario.config.horizon_minutes,
      versions: input.versions,
      now: input.now,
      algorithm: 'MILP fallback (no feasible assignment enumeration)',
    });
    return {
      ...fallback,
      solveMs: Date.now() - started,
      enumerated,
      restricted_candidates: Object.fromEntries(candidates),
      variable_regions: variableIds,
      fixed_regions: fixedRegions,
      enumeration_note: '无可枚举分支，回退为完整网络求解。',
    };
  }
  return {
    plan: chosen.plan,
    exclusions: chosen.exclusions,
    solveMs: Date.now() - started,
    uncoveredByRegion: new Map(chosen.plan.unresolved.map(item => [item.region_id, item.persons])),
    enumerated,
    restricted_candidates: Object.fromEntries(candidates),
    variable_regions: variableIds,
    fixed_regions: fixedRegions,
    enumeration_note: `枚举 ${enumerated} 个分支（≤${MAX_BRANCHES}）；仅 ${variableIds.length} 个竞争最激烈的区域参与二进制出口选择，其余固定在最近出口。`,
  };
}
