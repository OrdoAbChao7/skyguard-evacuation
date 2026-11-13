/**
 * 动态拥堵与执行反馈模型（V7.2）。
 *
 * 目的：把静态时间扩展流给出的「计划路线」放进一个离散时间执行模型中，
 * 显式建模区域队列、通道服务率与出口队列，从而得到：
 *   - 实际疏散完成时间（makespan）
 *   - 队列人·分钟、最大队列、平均/P95 等待
 *   - 出口利用率与未疏散人数
 *
 * 模型（必须与文档一致）：
 *  - 1 分钟离散；通道按人/分钟服务，超出的批次在区域排队，下一分钟重试；
 *  - 采用 BPR 型行程时间放大：factor = 1 + a·(load/capacity)^b，a=0.15、b=2，
 *    参数是**未标定的启发式**，不是实测人群速度模型；
 *  - 出口按人/分钟服务，超出部分在出口队列排队；
 *  - 不建模逆行、恐慌、跌倒、二次事故与出口外空间。
 *
 * 这不是人群动力学仿真，结果只用于比较不同规划策略在**同一执行模型**下的相对表现。
 */
import type { EvacuationPlan, EvacuationRoute, SafetyScenario } from '../types';
import { traversalMinutes } from '../network';

export interface CongestionOptions {
  /** BPR 系数 a。 */
  bprA?: number;
  /** BPR 指数 b。 */
  bprB?: number;
  /** 模拟最长时间（分钟）；超出后计入未疏散。默认 horizon×2+30。 */
  maxMinutes?: number;
  /** 只执行到该分钟（用于滚动控制步）；缺省执行到全部完成或 maxMinutes。 */
  stopAtMinute?: number;
  /** 初始区域在场人数（滚动执行时来自上一步残差）；缺省仅使用 routes。 */
  initialOccupancy?: Map<string, number>;
  /** 执行期间新到达人数（合成入流）；按分钟注入对应区域，未分配路线者计为未疏散。 */
  inflow?: Array<{ regionId: string; minute: number; persons: number }>;
  /** 是否启用出口拥挤服务衰减（默认开启）；关闭后出口服务率为名义值。 */
  exitServiceDegradation?: boolean;
  /** 执行片段起点（绝对分钟），用于动态容量因子。 */
  baseMinute?: number;
  /** 走廊容量因子（按绝对分钟）；缺省 1。 */
  corridorCapacityFactor?: (corridorId: string, absoluteMinute: number) => number;
  /** 出口容量因子（按绝对分钟）；缺省 1。 */
  exitCapacityFactor?: (exitId: string, absoluteMinute: number) => number;
}

export interface CongestionMetrics {
  horizon_minutes: number;
  executed_minutes: number;
  total_persons: number;
  completed_persons: number;
  unserved_persons: number;
  makespan_minute: number;
  total_queue_person_minutes: number;
  max_queue_persons: number;
  mean_wait_minutes: number;
  p95_wait_minutes: number;
  mean_queue_wait_minutes: number;
  exit_served: Record<string, number>;
  exit_utilization: Record<string, number>;
  corridor_service_peak: Record<string, number>;
  wait_samples: Array<{ persons: number; wait_minutes: number }>;
  queue_series: number[];
  /** 控制步结束时仍在各区域（含出口队列）的人数；滚动规划用。 */
  residual_persons_by_region: Record<string, number>;
  residual_exit_queue_by_exit: Record<string, number>;
  notes: string[];
}

interface ActiveBatch {
  id: number;
  regionId: string;
  exitId: string;
  persons: number;
  plannedExitMinute: number;
  stepIndex: number;
  readyMinute: number;
  steps: Array<{ corridorId: string; fromRegionId: string; toRegionId: string; departMinute: number; arriveMinute: number }>;
}

interface TransitRecord {
  batch: ActiveBatch;
  arriveMinute: number;
  nextRegionId: string;
  nextStepIndex: number;
}

interface ExitQueueEntry {
  persons: number;
  plannedExitMinute: number;
  joinedMinute: number;
}

/**
 * 执行一组路线（不重规划），返回拥堵指标。
 * routes 可以是一个滚动计划中某一控制步的路线集合。
 */
export function simulateRoutesExecution(
  scenario: SafetyScenario,
  routes: EvacuationRoute[],
  options: CongestionOptions = {},
): CongestionMetrics {
  const bprA = options.bprA ?? 0.15;
  const bprB = options.bprB ?? 2;
  const horizon = scenario.config.horizon_minutes;
  const maxMinutes = options.maxMinutes ?? horizon * 2 + 30;
  const exitCapacity = new Map(scenario.exits.map(exit => [exit.id, exit.capacity_per_min ?? 0]));
  const corridorCapacity = new Map(scenario.corridors.map(corridor => [corridor.id, corridor.capacity_per_min ?? 0]));
  const corridorTransit = new Map(scenario.corridors.map(corridor => [corridor.id, traversalMinutes(corridor)]));
  const exitByRegion = new Map<string, string[]>();
  for (const exit of scenario.exits) {
    const list = exitByRegion.get(exit.region_id) ?? [];
    list.push(exit.id);
    exitByRegion.set(exit.region_id, list);
  }

  let nextBatchId = 0;
  const batches: ActiveBatch[] = routes
    .filter(route => route.persons > 0 && route.steps.length > 0)
    .map(route => ({
      id: nextBatchId++,
      regionId: route.from_region_id,
      exitId: route.exit_id,
      persons: route.persons,
      plannedExitMinute: route.arrive_minute,
      stepIndex: 0,
      readyMinute: route.depart_minute,
      steps: route.steps.map(step => ({
        corridorId: step.corridor_id,
        fromRegionId: step.from_region_id,
        toRegionId: step.to_region_id,
        departMinute: step.depart_minute,
        arriveMinute: step.arrive_minute,
      })),
    }));
  // 没有通道步骤、直接位于出口区域的路线：直接进入出口队列。
  const exitQueues = new Map<string, ExitQueueEntry[]>();
  const pushExitQueue = (exitId: string, persons: number, plannedExitMinute: number, joinedMinute: number) => {
    const list = exitQueues.get(exitId) ?? [];
    list.push({ persons, plannedExitMinute, joinedMinute });
    exitQueues.set(exitId, list);
  };
  for (const route of routes) {
    if (route.persons <= 0 || route.steps.length > 0) continue;
    pushExitQueue(route.exit_id, route.persons, route.arrive_minute, route.depart_minute);
  }

  const transits: TransitRecord[] = [];
  const exitServed: Record<string, number> = {};
  const corridorServicePeak: Record<string, number> = {};
  const waitSamples: Array<{ persons: number; wait_minutes: number }> = [];
  const queueSeries: number[] = [];
  const totalPersons = routes.reduce((sum, route) => sum + route.persons, 0)
    + [...(options.initialOccupancy?.values() ?? [])].reduce((sum, value) => sum + Math.max(0, value), 0)
    + (options.inflow ?? []).reduce((sum, item) => sum + Math.max(0, item.persons), 0);
  const stranded = new Map<string, number>(options.initialOccupancy ?? []);
  for (const [regionId, persons] of stranded) if (persons <= 0) stranded.delete(regionId);
  const inflowQueue = [...(options.inflow ?? [])]
    .filter(item => item.persons > 0)
    .map(item => ({ ...item, persons: Math.floor(item.persons), minute: Math.max(0, Math.floor(item.minute)) }))
    .sort((a, b) => a.minute - b.minute);
  let completed = 0;
  let totalQueuePersonMinutes = 0;
  let maxQueue = 0;
  let makespan = 0;
  const stopAt = Math.min(maxMinutes, options.stopAtMinute ?? maxMinutes);

  for (let minute = 0; minute <= stopAt; minute += 1) {
    // 0. 新到达入流：注入区域，等待规划/疏散。
    while (inflowQueue.length > 0 && inflowQueue[0].minute <= minute) {
      const arrival = inflowQueue.shift()!;
      stranded.set(arrival.regionId, (stranded.get(arrival.regionId) ?? 0) + arrival.persons);
    }
    // 1. 通道行程结束：批次到达下一个区域。
    for (let index = transits.length - 1; index >= 0; index -= 1) {
      if (transits[index].arriveMinute <= minute) {
        const transit = transits[index];
        transits.splice(index, 1);
        transit.batch.regionId = transit.nextRegionId;
        transit.batch.stepIndex = transit.nextStepIndex;
        transit.batch.readyMinute = minute;
        batches.push(transit.batch);
      }
    }

    // 2. 通道服务：同一通道按 readyMinute 排序 FIFO，每分钟能力固定。
    const corridorCandidates = new Map<string, ActiveBatch[]>();
    for (const batch of batches) {
      if (batch.persons <= 0 || batch.stepIndex >= batch.steps.length) continue;
      const step = batch.steps[batch.stepIndex];
      if (step.fromRegionId !== batch.regionId) continue;
      if (batch.readyMinute > minute) continue;
      const list = corridorCandidates.get(step.corridorId) ?? [];
      list.push(batch);
      corridorCandidates.set(step.corridorId, list);
    }
    for (const [corridorId, candidates] of corridorCandidates) {
      const nominalCapacity = corridorCapacity.get(corridorId) ?? 0;
      const capacityFactor = options.corridorCapacityFactor
        ? Math.max(0, options.corridorCapacityFactor(corridorId, (options.baseMinute ?? 0) + minute))
        : 1;
      const capacity = Math.floor(nominalCapacity * capacityFactor);
      if (capacity <= 0) continue;
      candidates.sort((a, b) => a.readyMinute - b.readyMinute || a.id - b.id);
      let remainingCapacity = capacity;
      let servedTotal = 0;
      const served: Array<{ batch: ActiveBatch; persons: number; nextRegionId: string }> = [];
      for (const batch of candidates) {
        if (remainingCapacity <= 0) break;
        const step = batch.steps[batch.stepIndex];
        const persons = Math.min(batch.persons, remainingCapacity);
        if (persons <= 0) continue;
        batch.persons -= persons;
        remainingCapacity -= persons;
        servedTotal += persons;
        served.push({ batch, persons, nextRegionId: step.toRegionId });
      }
      if (servedTotal === 0) continue;
      const loadRatio = servedTotal / capacity;
      const factor = 1 + bprA * loadRatio ** bprB;
      const effectiveTransit = Math.max(1, Math.ceil((corridorTransit.get(corridorId) ?? 1) * factor));
      for (const item of served) {
        // 每个被服务的子批次独立推进，携带剩余路线与目标出口。
        transits.push({
          batch: {
            id: nextBatchId++,
            regionId: item.batch.regionId,
            exitId: item.batch.exitId,
            persons: item.persons,
            plannedExitMinute: item.batch.plannedExitMinute,
            stepIndex: item.batch.stepIndex,
            readyMinute: minute,
            steps: item.batch.steps,
          },
          arriveMinute: minute + effectiveTransit,
          nextRegionId: item.nextRegionId,
          nextStepIndex: item.batch.stepIndex + 1,
        });
      }
      corridorServicePeak[corridorId] = Math.max(corridorServicePeak[corridorId] ?? 0, servedTotal);
    }

    // 3. 到达出口区域：进入出口队列，等待出口服务。
    for (const batch of batches) {
      if (batch.persons <= 0 || batch.stepIndex < batch.steps.length) continue;
      const exitsHere = exitByRegion.get(batch.regionId) ?? [];
      if (exitsHere.length === 0) continue;
      const exitId = exitsHere.includes(batch.exitId) ? batch.exitId : exitsHere[0];
      pushExitQueue(exitId, batch.persons, batch.plannedExitMinute, minute);
      batch.persons = 0;
    }

    // 4. 出口服务：FIFO 队列，每分钟能力固定；队列越长，服务率越受拥挤影响。
    for (const [exitId, queue] of exitQueues) {
      const nominal = exitCapacity.get(exitId) ?? 0;
      if (nominal <= 0) continue;
      const exitFactor = options.exitCapacityFactor
        ? Math.max(0, options.exitCapacityFactor(exitId, (options.baseMinute ?? 0) + minute))
        : 1;
      if (exitFactor <= 0) continue;
      const queued = queue.reduce((sum, entry) => sum + entry.persons, 0);
      // 拥挤服务衰减：factor = 1 / (1 + queue / (nominal × 5))，下限 0.5。
      // 这是未标定的启发式（队伍越长、出口通过越慢），不是实测服务率模型。
      const serviceFactor = options.exitServiceDegradation !== false && queued > 0
        ? Math.max(0.5, 1 / (1 + queued / Math.max(1, nominal * 5)))
        : 1;
      const capacity = Math.max(1, Math.floor(nominal * exitFactor * serviceFactor));
      let remainingCapacity = capacity;
      while (queue.length > 0 && remainingCapacity > 0) {
        const entry = queue[0];
        const persons = Math.min(entry.persons, remainingCapacity);
        entry.persons -= persons;
        remainingCapacity -= persons;
        completed += persons;
        makespan = Math.max(makespan, minute);
        exitServed[exitId] = (exitServed[exitId] ?? 0) + persons;
        waitSamples.push({ persons, wait_minutes: Math.max(0, minute - entry.plannedExitMinute) });
        if (entry.persons <= 0) queue.shift();
      }
    }

    // 5. 队列统计（区域 + 通道行程中的等待不重复计入；行程中是"在途"而非排队）。
    let waiting = 0;
    for (const batch of batches) if (batch.persons > 0) waiting += batch.persons;
    for (const queue of exitQueues.values()) for (const entry of queue) waiting += entry.persons;
    for (const persons of stranded.values()) waiting += persons;
    totalQueuePersonMinutes += waiting;
    maxQueue = Math.max(maxQueue, waiting);
    queueSeries.push(waiting);

    if (completed >= totalPersons) break;
  }

  const residualByRegion: Record<string, number> = {};
  const bumpResidual = (regionId: string, persons: number) => {
    if (persons > 0) residualByRegion[regionId] = (residualByRegion[regionId] ?? 0) + persons;
  };
  for (const batch of batches) if (batch.persons > 0) bumpResidual(batch.regionId, batch.persons);
  for (const transit of transits) bumpResidual(transit.nextRegionId, transit.batch.persons);
  // 未分配路线但在场的人员必须保留原区域身份，否则滚动规划无法再次路由。
  for (const [regionId, persons] of stranded) bumpResidual(regionId, persons);
  const residualExitQueue: Record<string, number> = {};
  const regionByExit = new Map(scenario.exits.map(exit => [exit.id, exit.region_id]));
  for (const [exitId, queue] of exitQueues) {
    const persons = queue.reduce((sum, entry) => sum + entry.persons, 0);
    if (persons <= 0) continue;
    residualExitQueue[exitId] = persons;
    bumpResidual(regionByExit.get(exitId) ?? '__unrouted__', persons);
  }

  const unserved = Math.max(0, totalPersons - completed);
  const executedMinutes = Math.min(maxMinutes, Math.max(1, makespan + 1));
  const exitUtilization: Record<string, number> = {};
  for (const exit of scenario.exits) {
    const capacity = exit.capacity_per_min ?? 0;
    const served = exitServed[exit.id] ?? 0;
    exitUtilization[exit.id] = capacity > 0
      ? Number(Math.min(1, served / (capacity * executedMinutes)).toFixed(4))
      : 0;
  }
  const weightedWait = waitSamples.reduce((sum, item) => sum + item.persons * item.wait_minutes, 0);
  const totalWaitPersons = waitSamples.reduce((sum, item) => sum + item.persons, 0);
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
    horizon_minutes: horizon,
    executed_minutes: executedMinutes,
    total_persons: totalPersons,
    completed_persons: completed,
    unserved_persons: unserved,
    makespan_minute: completed > 0 ? makespan : maxMinutes,
    total_queue_person_minutes: totalQueuePersonMinutes,
    max_queue_persons: maxQueue,
    mean_wait_minutes: totalWaitPersons > 0 ? Number((weightedWait / totalWaitPersons).toFixed(4)) : 0,
    p95_wait_minutes: p95,
    mean_queue_wait_minutes: Number((totalQueuePersonMinutes / Math.max(1, totalPersons)).toFixed(4)),
    exit_served: exitServed,
    exit_utilization: exitUtilization,
    corridor_service_peak: corridorServicePeak,
    wait_samples: waitSamples,
    queue_series: queueSeries,
    residual_persons_by_region: residualByRegion,
    residual_exit_queue_by_exit: residualExitQueue,
    notes: [
      '1 分钟离散、FIFO 队列、BPR 型行程时间放大（a=0.15, b=2，未标定启发式）。',
      '等待时间 = 实际通过出口时刻 − 计划通过出口时刻；区间与队列用于策略相对比较。',
      '不是真实人群动力学预测。',
    ],
  };
}

export function simulatePlanExecution(
  scenario: SafetyScenario,
  plan: EvacuationPlan,
  options: CongestionOptions = {},
): CongestionMetrics {
  return simulateRoutesExecution(scenario, plan.routes, options);
}

/** 计划层面的静态下界：按计划到达时间统计，不考虑拥堵（仅用于诊断，不作为效果证据）。 */
export function plannedCompletion(plan: EvacuationPlan): {
  planned_makespan_minute: number;
  planned_queue_person_minutes: number;
} {
  let makespan = 0;
  let queue = 0;
  for (const route of plan.routes) {
    makespan = Math.max(makespan, route.arrive_minute);
    queue += route.persons * Math.max(0, route.depart_minute);
  }
  return { planned_makespan_minute: makespan, planned_queue_person_minutes: queue };
}
