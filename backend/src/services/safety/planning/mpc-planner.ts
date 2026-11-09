/**
 * 滚动时域规划（Model Predictive Control 风格）——V7.1。
 *
 * 闭环：观测/预测 → 时间扩展最小费用流规划 → 只执行第一个控制步 →
 *       动态执行反馈（队列/延迟）→ 重新规划。
 *
 * 安全边界：
 *  - 本模块只产出研究用计划；任何对外发布仍必须经独立校验器逐条校验；
 *  - 只有第一个控制步的计划可以对应「当前观测」；后续步骤是条件投影，不是已验证方案；
 *  - 预测只用于提前分配容量，不替代四态判定。
 */
import type { EvacuationPlan, EvacuationRoute, SafetyScenario } from '../types';
import type { EffectiveNetwork } from '../network';
import { simulateRoutesExecution, type CongestionMetrics } from './congestion';
import { solveTimeExpandedPlan, type SolveVersions } from './strategies';

export interface PredictedArrival {
  /** 相对规划起点的分钟偏移。 */
  offsetMinute: number;
  persons: number;
}

export interface MpcPlannerInput {
  scenario: SafetyScenario;
  network: EffectiveNetwork;
  initialDemandByRegion: Map<string, number>;
  versions: SolveVersions;
  now?: Date;
  /** 控制步长度（分钟），默认 2。 */
  controlIntervalMinutes?: number;
  /** 最大控制步数，默认 40。 */
  maxSteps?: number;
  /** 单次规划展望（分钟），默认场景 horizon。 */
  planningHorizonMinutes?: number;
  /** 执行时间上限（分钟），默认 horizon×2。 */
  maxExecutionMinutes?: number;
  /** 预测到达（相对起点）；useForecast=false 时忽略。用于提前分配容量。 */
  predictedArrivals?: Map<string, PredictedArrival[]>;
  /** 实际到达（相对起点）；用于推进真实世界状态与总人数口径。缺省时退化为 predictedArrivals。 */
  actualArrivals?: Map<string, PredictedArrival[]>;
  useForecast?: boolean;
  /** 是否用出口队列反馈扣减未来出口容量。 */
  queueFeedback?: boolean;
  holdCostPerMinute?: number;
  bprA?: number;
  bprB?: number;
}

export interface MpcStepRecord {
  step: number;
  start_minute: number;
  control_end_minute: number;
  plan: EvacuationPlan;
  execution: CongestionMetrics;
  queue_feedback_applied: boolean;
  executed_routes: EvacuationRoute[];
}

export interface MpcResult {
  steps: MpcStepRecord[];
  executed_routes: EvacuationRoute[];
  total_input_persons: number;
  completed_persons: number;
  unserved_persons: number;
  makespan_minute: number;
  total_queue_person_minutes: number;
  max_queue_persons: number;
  mean_wait_minutes: number;
  p95_wait_minutes: number;
  switch_events: number;
  switch_persons: number;
  final_occupancy: Map<string, number>;
  notes: string[];
}

function sumMap(map: Map<string, number>): number {
  let total = 0;
  for (const value of map.values()) total += Math.max(0, value);
  return total;
}

function dominantExits(routes: EvacuationRoute[]): Map<string, string> {
  const byRegion = new Map<string, Map<string, number>>();
  for (const route of routes) {
    const exits = byRegion.get(route.from_region_id) ?? new Map<string, number>();
    exits.set(route.exit_id, (exits.get(route.exit_id) ?? 0) + route.persons);
    byRegion.set(route.from_region_id, exits);
  }
  const result = new Map<string, string>();
  for (const [regionId, exits] of byRegion) {
    let bestExit = '';
    let bestPersons = -1;
    for (const [exitId, persons] of exits) {
      if (persons > bestPersons) {
        bestPersons = persons;
        bestExit = exitId;
      }
    }
    result.set(regionId, bestExit);
  }
  return result;
}

export function planEvacuationMpc(input: MpcPlannerInput): MpcResult {
  const interval = Math.max(1, Math.floor(input.controlIntervalMinutes ?? 2));
  const maxSteps = Math.max(1, Math.floor(input.maxSteps ?? 40));
  const planningHorizon = Math.max(interval, Math.floor(input.planningHorizonMinutes ?? input.scenario.config.horizon_minutes));
  const maxExecution = Math.max(planningHorizon, Math.floor(input.maxExecutionMinutes ?? input.scenario.config.horizon_minutes * 2));
  const useForecast = input.useForecast ?? true;
  const queueFeedback = input.queueFeedback ?? true;
  const bprA = input.bprA ?? 0.15;
  const bprB = input.bprB ?? 2;
  const now = input.now ?? new Date();

  let occupancy = new Map<string, number>();
  for (const [regionId, persons] of input.initialDemandByRegion) {
    if (persons > 0) occupancy.set(regionId, Math.floor(persons));
  }
  const arrivalQueue: Array<{ regionId: string; offsetMinute: number; persons: number }> = [];
  const actualSource = input.actualArrivals ?? input.predictedArrivals ?? new Map<string, PredictedArrival[]>();
  for (const [regionId, arrivals] of actualSource) {
    for (const arrival of arrivals) {
      if (arrival.persons <= 0) continue;
      if (arrival.offsetMinute <= 0) {
        occupancy.set(regionId, (occupancy.get(regionId) ?? 0) + Math.floor(arrival.persons));
      } else if (arrival.offsetMinute <= maxExecution) {
        arrivalQueue.push({ regionId, offsetMinute: Math.floor(arrival.offsetMinute), persons: Math.floor(arrival.persons) });
      }
    }
  }
  arrivalQueue.sort((a, b) => a.offsetMinute - b.offsetMinute);
  const totalInput = sumMap(occupancy) + arrivalQueue.reduce((sum, item) => sum + item.persons, 0);

  const steps: MpcStepRecord[] = [];
  const executedRoutes: EvacuationRoute[] = [];
  let elapsed = 0;
  let completed = 0;
  let totalQueuePersonMinutes = 0;
  let maxQueue = 0;
  const waitSamples: Array<{ persons: number; wait_minutes: number }> = [];
  let lastCompletionAbsolute = 0;
  let residualExitQueue = new Map<string, number>();
  let previousExits = new Map<string, string>();
  let switchEvents = 0;
  let switchPersons = 0;

  for (let step = 0; step < maxSteps && elapsed < maxExecution; step += 1) {
    if (sumMap(occupancy) <= 0) break;
    const stepEnd = Math.min(maxExecution, elapsed + interval);
    const stepLength = Math.max(1, stepEnd - elapsed);

    // 本控制步内到期的预测到达（保守地按步初在场处理）。
    const due: typeof arrivalQueue = [];
    while (arrivalQueue.length > 0 && arrivalQueue[0].offsetMinute <= stepEnd) {
      due.push(arrivalQueue.shift()!);
    }
    for (const arrival of due) {
      occupancy.set(arrival.regionId, (occupancy.get(arrival.regionId) ?? 0) + arrival.persons);
    }

    const horizonThisStep = Math.max(stepLength, Math.min(planningHorizon, maxExecution - elapsed));
    const plannedArrivals = new Map<string, PredictedArrival[]>();
    if (useForecast) {
      const forecastSource = input.predictedArrivals ?? input.actualArrivals ?? new Map<string, PredictedArrival[]>();
      for (const [regionId, arrivals] of forecastSource) {
        for (const arrival of arrivals) {
          if (arrival.persons <= 0) continue;
          if (arrival.offsetMinute - elapsed <= stepLength) continue; // 本步内到期者已计入 occupancy
          if (arrival.offsetMinute - elapsed > horizonThisStep) continue;
          const list = plannedArrivals.get(regionId) ?? [];
          list.push({ offsetMinute: Math.max(0, arrival.offsetMinute - elapsed), persons: Math.floor(arrival.persons) });
          plannedArrivals.set(regionId, list);
        }
      }
    }

    const exitCapacityFactor = (exitId: string, absoluteMinute: number): number => {
      if (!queueFeedback) return 1;
      const queued = residualExitQueue.get(exitId) ?? 0;
      if (queued <= 0) return 1;
      const exit = input.scenario.exits.find(item => item.id === exitId);
      const capacity = exit?.capacity_per_min ?? 0;
      if (capacity <= 0) return 1;
      // 与执行模型一致的拥挤服务衰减：按队列随服务排空的估计值计算。
      const drained = capacity * Math.max(0, absoluteMinute - elapsed);
      const estimatedQueue = Math.max(0, queued - drained);
      return Math.max(0.5, 1 / (1 + estimatedQueue / Math.max(1, capacity * 5)));
    };

    const solved = solveTimeExpandedPlan({
      scenario: input.scenario,
      network: input.network,
      demandByRegion: new Map(occupancy),
      horizonMinutes: horizonThisStep,
      baseMinute: elapsed,
      versions: input.versions,
      now,
      predictedArrivals: plannedArrivals,
      exitCapacityFactor,
      holdCostPerMinute: input.holdCostPerMinute ?? 0.05,
      algorithm: 'MPC: rolling time-expanded min-cost flow',
      model: `control interval ${stepLength} min; planning horizon ${horizonThisStep} min; queue feedback ${queueFeedback}`,
    });
    const plan = solved.plan;
    plan.plan_id = `PLAN-MPC-${now.getTime().toString(36).toUpperCase()}-${step}`;
    plan.created_at = now.toISOString();

    // 预测可能包含尚未到场的人：执行时必须按当前实际在场人数截断，
    // 不得把预测人群当作已存在人群疏散（安全与真实性要求）。
    const availableByRegion = new Map(occupancy);
    const executed: EvacuationRoute[] = [];
    for (const route of plan.routes) {
      if (route.depart_minute >= stepLength) continue;
      const available = availableByRegion.get(route.from_region_id) ?? 0;
      if (available <= 0) continue;
      const persons = Math.min(route.persons, available);
      if (persons <= 0) continue;
      availableByRegion.set(route.from_region_id, available - persons);
      executed.push(persons === route.persons
        ? route
        : {
          ...route,
          persons,
          steps: route.steps.map(step => ({ ...step, persons })),
        });
    }
    // 未执行人员：当前在场 − 本步实际执行人数（含预测提前注入），必须带到下一步。
    const executedByRegion = new Map<string, number>();
    for (const route of executed) {
      executedByRegion.set(route.from_region_id, (executedByRegion.get(route.from_region_id) ?? 0) + route.persons);
    }
    const carry = new Map<string, number>();
    for (const [regionId, persons] of occupancy) {
      const remaining = persons - (executedByRegion.get(regionId) ?? 0);
      if (remaining > 0) carry.set(regionId, remaining);
    }

    const execution = simulateRoutesExecution(input.scenario, executed, {
      stopAtMinute: stepLength,
      maxMinutes: maxExecution,
      initialOccupancy: carry,
      bprA,
      bprB,
    });

    // 支配出口切换统计（仅统计本步实际执行且有人员的区域）。
    const currentExits = dominantExits(executed);
    for (const [regionId, exitId] of currentExits) {
      const previous = previousExits.get(regionId);
      if (previous && previous !== exitId) {
        switchEvents += 1;
        switchPersons += executedByRegion.get(regionId) ?? 0;
      }
    }
    for (const [regionId, exitId] of currentExits) previousExits.set(regionId, exitId);

    executedRoutes.push(...executed);
    completed += execution.completed_persons;
    totalQueuePersonMinutes += execution.total_queue_person_minutes;
    maxQueue = Math.max(maxQueue, execution.max_queue_persons);
    waitSamples.push(...execution.wait_samples);
    if (execution.completed_persons > 0) {
      lastCompletionAbsolute = Math.max(lastCompletionAbsolute, elapsed + execution.makespan_minute);
    }
    residualExitQueue = new Map(Object.entries(execution.residual_exit_queue_by_exit));
    const nextOccupancy = new Map<string, number>();
    for (const [regionId, persons] of Object.entries(execution.residual_persons_by_region)) {
      if (regionId === '__unrouted__') continue;
      if (persons > 0) nextOccupancy.set(regionId, persons);
    }
    const unrouted = execution.residual_persons_by_region['__unrouted__'] ?? 0;
    if (unrouted > 0) nextOccupancy.set('__unrouted__', unrouted);
    occupancy = nextOccupancy;

    steps.push({
      step,
      start_minute: elapsed,
      control_end_minute: stepEnd,
      plan,
      execution,
      queue_feedback_applied: queueFeedback,
      executed_routes: executed,
    });
    elapsed = stepEnd;
  }

  const unserved = Math.max(0, totalInput - completed);
  const totalWaitPersons = waitSamples.reduce((sum, item) => sum + item.persons, 0);
  const weightedWait = waitSamples.reduce((sum, item) => sum + item.persons * item.wait_minutes, 0);
  const orderedWait = [...waitSamples].sort((a, b) => a.wait_minutes - b.wait_minutes);
  let p95 = 0;
  let cumulative = 0;
  const target = totalWaitPersons * 0.95;
  for (const item of orderedWait) {
    cumulative += item.persons;
    if (cumulative >= target) {
      p95 = item.wait_minutes;
      break;
    }
  }

  return {
    steps,
    executed_routes: executedRoutes,
    total_input_persons: totalInput,
    completed_persons: completed,
    unserved_persons: unserved,
    makespan_minute: lastCompletionAbsolute,
    total_queue_person_minutes: totalQueuePersonMinutes,
    max_queue_persons: maxQueue,
    mean_wait_minutes: totalWaitPersons > 0 ? Number((weightedWait / totalWaitPersons).toFixed(4)) : 0,
    p95_wait_minutes: p95,
    switch_events: switchEvents,
    switch_persons: switchPersons,
    final_occupancy: occupancy,
    notes: [
      `控制步 ${interval} 分钟；预测 ${useForecast ? '启用' : '禁用'}；队列反馈 ${queueFeedback ? '启用' : '禁用'}。`,
      '只有第一步计划对应当前观测；后续步骤是条件投影，不是已验证方案。',
      '执行模型为 1 分钟离散 FIFO 队列 + BPR 行程时间放大，结果只用于策略比较。',
    ],
  };
}
