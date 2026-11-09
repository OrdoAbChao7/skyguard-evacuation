/**
 * 拥堵反馈与拥堵感知规划（研究原型）。
 *
 * 静态规划器假设通道容量恒定；真实人群中通道通行能力会随利用率下降。
 * 本模块提供两类能力：
 *  1. planWithCongestion：用 BPR 型容量折减迭代重规划（保守容量），产出可审计的
 *     effective_capacity 与迭代次数；
 *  2. simulateCongestion：对给定方案做逐分钟排队仿真，暴露静态方案在拥堵下的
 *     排队、未服务人数与完成时间。
 *
 * 边界：BPR 参数是未标定启发式，不是人群动力学模型；结果不得表述为真实疏散时间预测。
 */
import type { EvacuationPlan, SafetyScenario } from '../types';
import { planEvacuation, type PlanInput, type PlanOutput } from './evacuation-planner';

export interface CongestionPolicy {
  enabled: boolean;
  bpr_alpha: number;
  bpr_beta: number;
  max_capacity_reduction: number;
  max_iterations: number;
}

export const DEFAULT_CONGESTION_POLICY: CongestionPolicy = {
  enabled: false,
  bpr_alpha: 0.15,
  bpr_beta: 4,
  max_capacity_reduction: 0.6,
  max_iterations: 4,
};

/** BPR 型容量折减：利用率越高，可用容量越低；下限由 max_capacity_reduction 控制。 */
export function effectiveCapacity(baseCapacity: number, utilization: number, policy: CongestionPolicy): number {
  if (!Number.isFinite(baseCapacity) || baseCapacity <= 0) return Math.max(0, baseCapacity);
  const ratio = Math.max(0, utilization);
  const factor = 1 / (1 + policy.bpr_alpha * ratio ** policy.bpr_beta);
  const floor = 1 - Math.max(0, Math.min(0.95, policy.max_capacity_reduction));
  return Math.max(baseCapacity * floor, baseCapacity * Math.min(1, factor));
}

function maxFlow(usage: Map<string, Map<number, number>>, id: string): number {
  const perMinute = usage.get(id);
  if (!perMinute) return 0;
  let maximum = 0;
  for (const value of perMinute.values()) maximum = Math.max(maximum, value);
  return maximum;
}

/** 从方案路线重建通道逐分钟流量（与 Validator 的口径一致：按出发分钟、双向合计）。 */
export function corridorUsageFromPlan(plan: EvacuationPlan): Map<string, Map<number, number>> {
  const usage = new Map<string, Map<number, number>>();
  for (const route of plan.routes) {
    for (const step of route.steps) {
      const perMinute = usage.get(step.corridor_id) ?? new Map<number, number>();
      perMinute.set(step.depart_minute, (perMinute.get(step.depart_minute) ?? 0) + route.persons);
      usage.set(step.corridor_id, perMinute);
    }
  }
  return usage;
}

/** 从方案路线重建出口逐分钟到达流量。 */
export function exitUsageFromPlan(plan: EvacuationPlan): Map<string, Map<number, number>> {
  const usage = new Map<string, Map<number, number>>();
  for (const route of plan.routes) {
    const perMinute = usage.get(route.exit_id) ?? new Map<number, number>();
    perMinute.set(route.arrive_minute, (perMinute.get(route.arrive_minute) ?? 0) + route.persons);
    usage.set(route.exit_id, perMinute);
  }
  return usage;
}

export interface CongestionPlanResult extends PlanOutput {
  congestion: {
    iterations: number;
    effective_capacity: Array<{ corridor_id: string; base: number | null; effective: number | null }>;
    policy: CongestionPolicy;
    note: string;
  };
}

/**
 * 拥堵感知规划：先用静态容量规划，再按方案的实际通道利用率折减容量并重规划，
 * 直到容量不再显著变化或达到迭代上限。折减只会降低容量，因此不会产生更乐观的方案。
 */
export function planWithCongestion(
  input: PlanInput,
  policy: CongestionPolicy = DEFAULT_CONGESTION_POLICY,
): CongestionPlanResult {
  const basePlan = planEvacuation(input);
  if (!policy.enabled) {
    return {
      ...basePlan,
      congestion: {
        iterations: 0,
        effective_capacity: [],
        policy,
        note: '拥堵感知未启用；返回静态容量规划。',
      },
    };
  }
  let capacities = new Map<string, number>();
  for (const corridor of input.scenario.corridors) {
    if (corridor.capacity_per_min !== null) capacities.set(corridor.id, corridor.capacity_per_min);
  }
  let plan = basePlan;
  let iterations = 0;
  for (let round = 0; round < policy.max_iterations; round += 1) {
    iterations = round + 1;
    const usage = corridorUsageFromPlan(plan.plan);
    let changed = false;
    const next = new Map(capacities);
    for (const corridor of input.scenario.corridors) {
      const base = corridor.capacity_per_min;
      if (base === null || base <= 0) continue;
      const utilization = maxFlow(usage, corridor.id) / base;
      const effective = effectiveCapacity(base, utilization, policy);
      const previous = next.get(corridor.id) ?? base;
      if (Math.abs(effective - previous) / Math.max(1, base) > 1e-3) changed = true;
      next.set(corridor.id, Math.min(previous, effective));
    }
    capacities = next;
    if (!changed) break;
    const scenario: SafetyScenario = {
      ...input.scenario,
      corridors: input.scenario.corridors.map(corridor => ({
        ...corridor,
        capacity_per_min: corridor.capacity_per_min === null
          ? null
          : capacities.get(corridor.id) ?? corridor.capacity_per_min,
      })),
    };
    plan = planEvacuation({ ...input, scenario });
  }
  return {
    ...plan,
    congestion: {
      iterations,
      effective_capacity: input.scenario.corridors.map(corridor => ({
        corridor_id: corridor.id,
        base: corridor.capacity_per_min,
        effective: corridor.capacity_per_min === null ? null : capacities.get(corridor.id) ?? corridor.capacity_per_min,
      })),
      policy,
      note: `BPR 容量折减 ${iterations} 轮；参数未标定，仅用于静态/动态规划对照研究。`,
    },
  };
}

export interface CongestionSimulationMinute {
  minute: number;
  corridor_queue: number;
  exit_queue: number;
  served_by_corridor: number;
  served_by_exit: number;
  effective_corridor_capacity: number;
  effective_exit_capacity: number;
}

export interface CongestionSimulationResult {
  plan_id: string;
  horizon_minutes: number;
  minutes: CongestionSimulationMinute[];
  scheduled_persons: number;
  served_persons: number;
  abandoned_persons: number;
  max_corridor_queue: number;
  max_exit_queue: number;
  congestion_minutes: number;
  completion_minute: number | null;
  policy: CongestionPolicy;
  note: string;
}

/**
 * 对方案做逐分钟拥堵仿真。队列按（通道/出口）保留并结转；超过 horizon 的队列计入
 * abandoned_persons。该仿真不重新分配路线，只回答“给定方案在拥堵下会怎样”。
 */
export function simulateCongestion(
  input: { scenario: SafetyScenario; plan: EvacuationPlan; policy?: CongestionPolicy; horizonMinutes?: number },
): CongestionSimulationResult {
  const policy = input.policy ?? DEFAULT_CONGESTION_POLICY;
  const plan = input.plan;
  const horizon = input.horizonMinutes ?? plan.horizon_minutes;
  const corridorCap = new Map(input.scenario.corridors.map(c => [c.id, c.capacity_per_min]));
  const exitCap = new Map(input.scenario.exits.map(e => [e.id, e.capacity_per_min]));

  const corridorArrivals = new Map<string, Map<number, number>>();
  const exitArrivals = new Map<string, Map<number, number>>();
  for (const route of plan.routes) {
    for (const step of route.steps) {
      const perMinute = corridorArrivals.get(step.corridor_id) ?? new Map<number, number>();
      perMinute.set(step.depart_minute, (perMinute.get(step.depart_minute) ?? 0) + route.persons);
      corridorArrivals.set(step.corridor_id, perMinute);
    }
    const perMinute = exitArrivals.get(route.exit_id) ?? new Map<number, number>();
    perMinute.set(route.arrive_minute, (perMinute.get(route.arrive_minute) ?? 0) + route.persons);
    exitArrivals.set(route.exit_id, perMinute);
  }

  const corridorQueue = new Map<string, number>();
  const exitQueue = new Map<string, number>();
  const minutes: CongestionSimulationMinute[] = [];
  let scheduled = 0;
  let served = 0;
  let maxCorridorQueue = 0;
  let maxExitQueue = 0;
  let congestionMinutes = 0;
  let completion: number | null = null;

  for (let minute = 0; minute <= horizon; minute += 1) {
    let servedCorridor = 0;
    let servedExit = 0;
    let effectiveCorridor = 0;
    let effectiveExit = 0;

    for (const [corridorId, perMinute] of corridorArrivals) {
      const base = corridorCap.get(corridorId);
      if (base === null || base === undefined) continue;
      const attempt = (perMinute.get(minute) ?? 0) + (corridorQueue.get(corridorId) ?? 0);
      if (attempt <= 0) continue;
      const utilization = attempt / Math.max(1, base);
      const cap = effectiveCapacity(base, utilization, policy);
      const take = Math.min(attempt, cap);
      servedCorridor += take;
      const queue = attempt - take;
      corridorQueue.set(corridorId, queue);
      maxCorridorQueue = Math.max(maxCorridorQueue, queue);
      effectiveCorridor += cap;
      if (queue > 0) congestionMinutes += 1;
    }

    for (const [exitId, perMinute] of exitArrivals) {
      const base = exitCap.get(exitId);
      if (base === null || base === undefined) continue;
      const attempt = (perMinute.get(minute) ?? 0) + (exitQueue.get(exitId) ?? 0);
      if (attempt <= 0) continue;
      scheduled += perMinute.get(minute) ?? 0;
      const utilization = attempt / Math.max(1, base);
      const cap = effectiveCapacity(base, utilization, policy);
      const take = Math.min(attempt, cap);
      servedExit += take;
      served += take;
      const queue = attempt - take;
      exitQueue.set(exitId, queue);
      maxExitQueue = Math.max(maxExitQueue, queue);
      effectiveExit += cap;
      if (queue > 0) congestionMinutes += 1;
    }

    if (servedCorridor > 0 || servedExit > 0) completion = minute;
    minutes.push({
      minute,
      corridor_queue: Number([...corridorQueue.values()].reduce((sum, value) => sum + value, 0).toFixed(4)),
      exit_queue: Number([...exitQueue.values()].reduce((sum, value) => sum + value, 0).toFixed(4)),
      served_by_corridor: Number(servedCorridor.toFixed(4)),
      served_by_exit: Number(servedExit.toFixed(4)),
      effective_corridor_capacity: Number(effectiveCorridor.toFixed(4)),
      effective_exit_capacity: Number(effectiveExit.toFixed(4)),
    });
  }

  const abandoned = [...corridorQueue.values()].reduce((sum, value) => sum + value, 0)
    + [...exitQueue.values()].reduce((sum, value) => sum + value, 0);
  return {
    plan_id: plan.plan_id,
    horizon_minutes: horizon,
    minutes,
    scheduled_persons: Number(scheduled.toFixed(4)),
    served_persons: Number(served.toFixed(4)),
    abandoned_persons: Number(abandoned.toFixed(4)),
    max_corridor_queue: Number(maxCorridorQueue.toFixed(4)),
    max_exit_queue: Number(maxExitQueue.toFixed(4)),
    congestion_minutes: congestionMinutes,
    completion_minute: completion,
    policy,
    note: 'BPR 型逐分钟排队仿真；参数未标定，不重新分配路线，不代表真实疏散时间。',
  };
}

/** 供实验复用：按当前拥堵折减后的网络容量。 */
export function congestedScenario(
  scenario: SafetyScenario,
  policy: CongestionPolicy = DEFAULT_CONGESTION_POLICY,
): SafetyScenario {
  return {
    ...scenario,
    corridors: scenario.corridors.map(corridor => {
      if (corridor.capacity_per_min === null) return corridor;
      return { ...corridor, capacity_per_min: effectiveCapacity(corridor.capacity_per_min, 1, policy) };
    }),
    exits: scenario.exits.map(exit => {
      if (exit.capacity_per_min === null) return exit;
      return { ...exit, capacity_per_min: effectiveCapacity(exit.capacity_per_min, 1, policy) };
    }),
  };
}
