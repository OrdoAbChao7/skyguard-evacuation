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
import type { EvacuationPlan, EvacuationRoute, Incident, SafetyScenario } from '../types';
import type { EffectiveNetwork } from '../network';
import { resolveEffectiveNetwork } from '../network';
import { simulateRoutesExecution, type CongestionMetrics } from './congestion';
import { solveTimeExpandedPlan, type SolveVersions } from './strategies';
import { planEvacuation } from './evacuation-planner';
import {
  checkPlanCapacity,
  dominantExits,
  regionDensity,
  regionRiskRatio,
  resolveStabilityConfig,
  shouldUseCommitment,
  switchingImpact,
  type RouteStabilityConfig,
} from './route-stability';
import { solveCommitmentAwarePlan } from './stable-solver';
import { EmergencyStateMachine } from '../emergency/emergency-state';
import {
  adaptiveSwitchPenalty,
  appendExitHistory,
  detectOscillatingRegions,
  resolveAdaptiveStability,
  scorePlan,
  weightedSwitchPersons,
  type AdaptiveStabilityConfig,
} from './v73-stability';

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
  /** 求解器：v7 = 可配置时间扩展求解器；legacy = 既有安全规划器（用于公平基线）。 */
  solver?: 'v7' | 'legacy';
  /** 重规划策略：periodic = 每个控制步；event = 仅事件/队列/偏差触发。 */
  replanPolicy?: 'periodic' | 'event';
  /** 事件触发策略下的最长重规划间隔（分钟）。 */
  eventMaxIntervalMinutes?: number;
  /** 出口队列人数触发阈值。 */
  eventQueueThreshold?: number;
  /** 在场人数相对变化触发阈值。 */
  eventOccupancyChangeRatio?: number;
  /** 路线稳定性：优先保持上一控制步的出口分配，若代价可接受。 */
  stabilizeRoutes?: boolean;
  /** 稳定性允许的目标函数劣化比例（默认 0.05）。 */
  stabilizationTolerance?: number;
  /**
   * V7.2 稳定性策略（迟滞/切换惩罚/承诺窗口/自适应）。
   * 与 stabilizeRoutes 并存：旧选项保持 V7.1 行为不变，新策略单独生效。
   */
  stability?: Partial<RouteStabilityConfig>;
  /** V7.3 自适应稳定性：拥堵/风险自适应惩罚、振荡惩罚、风险加权、多目标。 */
  adaptiveStability?: Partial<AdaptiveStabilityConfig>;
  /** V7.4 执行感知门控：候选执行投影不得劣于基线超过容差。 */
  executionGate?: { enabled?: boolean; makespanToleranceMinutes?: number; queueTolerancePersonMinutes?: number };
  /** V7.4 Pareto 份额扫描：枚举承诺份额，在门控内选切换最少者。 */
  paretoStability?: { shares?: number[]; makespanToleranceMinutes?: number; queueTolerancePersonMinutes?: number };
  /** V7.5 容量感知承诺：承诺出口的投影需求超过容量时，逐区域放弃承诺。 */
  capacityAwareCommitment?: { enabled?: boolean; headroomRatio?: number };
  /** V7.5 紧急覆盖状态机：NORMAL→RISK_WARNING→EMERGENCY_OVERRIDE→RECOVERY→NORMAL。 */
  emergencyMachine?: { enabled?: boolean; config?: Partial<import('../emergency/emergency-state').EmergencyConfig> };
  /** V7.5 观测质量：过期/冲突观测必须阻止状态机发布（缺省视为有效）。 */
  observationsValid?: boolean;
  sensorConflict?: boolean;
  observationStale?: boolean;
  /** V7.3 动态容量因子（按绝对分钟），用于时间变化的走廊/出口容量。 */
  corridorCapacityFactor?: (corridorId: string, absoluteMinute: number) => number;
  exitCapacityFactor?: (exitId: string, absoluteMinute: number) => number;
  /** 规划开始前已确认的事件；缺省视为与传入 network 一致。 */
  incidents?: Incident[];
  /**
   * 运行中故障注入（研究/演练用）：到指定分钟后该出口/通道不可用。
   * 触发后重算有效网络；承诺窗口立即失效（紧急覆盖），并记录次数。
   */
  midRunDisruptions?: Array<{
    minute: number;
    exit_ids?: string[];
    corridor_ids?: string[];
    description?: string;
  }>;
}

export interface MpcStepRecord {
  step: number;
  start_minute: number;
  control_end_minute: number;
  plan: EvacuationPlan;
  plan_base_minute: number;
  replanned: boolean;
  solve_ms: number;
  stabilized: boolean;
  /** V7.2：本步是否因承诺窗口/迟滞而采用受限方案。 */
  committed?: boolean;
  /** V7.2：本步是否触发了紧急覆盖（上一出口不可用）。 */
  emergency_override?: boolean;
  stability_mode?: string;
  /** V7.3：本步逐分钟容量冲突数。 */
  capacity_violations?: number;
  /** V7.3：本步是否检测到 A→B→A 振荡。 */
  oscillation?: boolean;
  /** V7.3：本步自适应切换惩罚。 */
  adaptive_penalty?: number;
  /** V7.4：本步 Pareto 候选数与门控拒绝数。 */
  pareto_candidates?: number;
  gate_rejected?: number;
  /** V7.5：本步紧急状态机状态。 */
  emergency_state?: string;
  /** V7.5：本步状态机是否允许发布（观测有效且独立校验通过）。 */
  emergency_publishable?: boolean;
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
  replans: number;
  total_solve_ms: number;
  stabilized_steps: number;
  /** V7.2：承诺窗口生效步数。 */
  committed_steps: number;
  /** V7.2：紧急覆盖次数（出口故障时解除承诺）。 */
  emergency_overrides: number;
  /** V7.2：逐区域最大密度（人/m²）与最坏风险区域。 */
  max_density_persons_per_m2: number;
  worst_region_id: string | null;
  worst_risk_ratio: number;
  /** V7.3：逐分钟容量冲突计数（所有步骤合计）。 */
  capacity_violations: number;
  /** V7.3：A→B→A 路线振荡事件与受影响人数。 */
  oscillation_events: number;
  oscillation_persons: number;
  /** V7.3：自适应切换惩罚的平均值（未启用时为 0）。 */
  adaptive_penalty_avg: number;
  /** V7.4：Pareto 评估候选总数与执行门控拒绝数。 */
  pareto_candidates: number;
  gate_rejections: number;
  /** V7.4：因高风险自动释放承诺的次数。 */
  commitment_releases: number;
  /** V7.5：紧急冷却后重新建立承诺的次数。 */
  commitment_recommits: number;
  /** V7.5：紧急状态机审计事件。 */
  emergency_events: Array<{ tick: number; from: string; to: string; reason: string; risk: number; active_work_orders: number }>;
  /** V7.5：状态机判定不可发布的控制步数（观测无效/冲突/过期或方案未校验）。 */
  unpublishable_steps: number;
  final_occupancy: Map<string, number>;
  notes: string[];
}

function sumMap(map: Map<string, number>): number {
  let total = 0;
  for (const value of map.values()) total += Math.max(0, value);
  return total;
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
      if (!Number.isFinite(arrival.offsetMinute) || !Number.isFinite(arrival.persons) || arrival.persons <= 0) continue;
      const persons = Math.min(10_000_000, Math.floor(arrival.persons));
      if (arrival.offsetMinute <= 0) {
        occupancy.set(regionId, (occupancy.get(regionId) ?? 0) + persons);
      } else if (arrival.offsetMinute <= maxExecution) {
        arrivalQueue.push({ regionId, offsetMinute: Math.floor(arrival.offsetMinute), persons });
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
  let replans = 0;
  let totalSolveMs = 0;
  let stabilizedSteps = 0;
  const solver = input.solver ?? 'v7';
  const stabilizeRoutes = input.stabilizeRoutes ?? false;
  const stabilizationTolerance = Math.max(0, input.stabilizationTolerance ?? 0.05);
  const stability = resolveStabilityConfig(input.stability);
  const adaptiveStability = resolveAdaptiveStability(input.adaptiveStability);
  const replanPolicy = input.replanPolicy ?? 'periodic';
  const eventMaxInterval = Math.max(interval, Math.floor(input.eventMaxIntervalMinutes ?? interval * 2));
  const eventQueueThreshold = Math.max(0, input.eventQueueThreshold ?? 200);
  const eventOccupancyRatio = Math.max(0, input.eventOccupancyChangeRatio ?? 0.1);
  let activePlan: { baseMinute: number; plan: EvacuationPlan; plannedOccupancy: number } | null = null;

  // 运行中故障：到点后重算有效网络，并触发紧急覆盖。
  const disruptions = (input.midRunDisruptions ?? [])
    .filter(item => Number.isFinite(item.minute))
    .map((item, index) => ({ ...item, index, minute: Math.max(0, Math.floor(item.minute)) }))
    .sort((a, b) => a.minute - b.minute);
  const appliedDisruptions = new Set<number>();
  const baseIncidents = input.incidents ?? [];
  let stepNetwork: EffectiveNetwork = disruptions.length > 0
    ? resolveEffectiveNetwork(input.scenario, baseIncidents)
    : input.network;
  const refreshNetwork = (minute: number): boolean => {
    if (disruptions.length === 0) return false;
    let changed = false;
    for (const disruption of disruptions) {
      if (appliedDisruptions.has(disruption.index)) continue;
      if (disruption.minute > minute) continue;
      appliedDisruptions.add(disruption.index);
      changed = true;
    }
    if (!changed) return false;
    const injected = [...appliedDisruptions].map(index => {
      const disruption = disruptions.find(item => item.index === index)!;
      const nowIso = now.toISOString();
      return {
        id: `INC-MIDRUN-${index}`,
        type: 'fire' as const,
        description: disruption.description ?? '运行中故障注入（研究/演练）',
        status: 'confirmed' as const,
        severity: 'high' as const,
        affected: {
          region_ids: [],
          corridor_ids: disruption.corridor_ids ?? [],
          exit_ids: disruption.exit_ids ?? [],
        },
        source: 'simulation' as const,
        reported_by: 'mpc-midrun-injection',
        reported_at: nowIso,
        confirmed_by: 'mpc-midrun-injection',
        confirmed_at: nowIso,
      };
    });
    stepNetwork = resolveEffectiveNetwork(input.scenario, [...baseIncidents, ...injected]);
    return true;
  };
  let emergencyOverrides = 0;
  let committedSteps = 0;
  let maxDensity = 0;
  let worstRegionId: string | null = null;
  let worstRiskRatio = 0;
  let capacityViolations = 0;
  let oscillationEvents = 0;
  let oscillationPersons = 0;
  let adaptivePenaltySum = 0;
  let paretoCandidates = 0;
  let gateRejections = 0;
  let commitmentReleases = 0;
  let commitmentRecommits = 0;
  let lastReleaseMinute = -Infinity;
  let recommitPending = false;
  let emergencyStateThisStep: string | undefined;
  let emergencyPublishableThisStep: boolean | undefined;
  let unpublishableSteps = 0;
  const emergencyMachine = input.emergencyMachine?.enabled
    ? new EmergencyStateMachine(input.emergencyMachine.config)
    : null;
  let adaptivePenaltyCount = 0;
  const exitHistory = new Map<string, string[]>();

  for (let step = 0; step < maxSteps && elapsed < maxExecution; step += 1) {
    if (sumMap(occupancy) <= 0) break;
    refreshNetwork(elapsed);
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

    // 区域密度/风险追踪（步初在场人数 / 区域面积）。
    for (const [regionId, persons] of occupancy) {
      const density = regionDensity(input.scenario, regionId, persons);
      if (density > maxDensity) {
        maxDensity = density;
        worstRegionId = regionId;
      }
      worstRiskRatio = Math.max(worstRiskRatio, regionRiskRatio(input.scenario, regionId, persons));
    }

    const horizonThisStep = Math.max(stepLength, Math.min(planningHorizon, maxExecution - elapsed));
    const plannedArrivals = new Map<string, PredictedArrival[]>();
    if (useForecast) {
      const forecastSource = input.predictedArrivals ?? input.actualArrivals ?? new Map<string, PredictedArrival[]>();
      for (const [regionId, arrivals] of forecastSource) {
        for (const arrival of arrivals) {
          if (!Number.isFinite(arrival.offsetMinute) || !Number.isFinite(arrival.persons) || arrival.persons <= 0) continue;
          if (arrival.offsetMinute - elapsed <= stepLength) continue; // 本步内到期者已计入 occupancy
          if (arrival.offsetMinute - elapsed > horizonThisStep) continue;
          const list = plannedArrivals.get(regionId) ?? [];
          list.push({
            offsetMinute: Math.max(0, arrival.offsetMinute - elapsed),
            persons: Math.min(10_000_000, Math.floor(arrival.persons)),
          });
          plannedArrivals.set(regionId, list);
        }
      }
    }

    const baseExitFactor = input.exitCapacityFactor ?? (() => 1);
    const exitCapacityFactor = (exitId: string, absoluteMinute: number): number => {
      const base = Math.max(0, baseExitFactor(exitId, absoluteMinute));
      if (!queueFeedback) return base;
      const queued = residualExitQueue.get(exitId) ?? 0;
      if (queued <= 0) return base;
      const exit = input.scenario.exits.find(item => item.id === exitId);
      const capacity = exit?.capacity_per_min ?? 0;
      if (capacity <= 0) return base;
      // 与执行模型一致的拥挤服务衰减：按队列随服务排空的估计值计算。
      const drained = capacity * Math.max(0, absoluteMinute - elapsed);
      const estimatedQueue = Math.max(0, queued - drained);
      return base * Math.max(0.5, 1 / (1 + estimatedQueue / Math.max(1, capacity * 5)));
    };

    const elapsedSincePlan = activePlan ? elapsed - activePlan.baseMinute : Number.POSITIVE_INFINITY;
    const queueTotal = [...residualExitQueue.values()].reduce((sum, value) => sum + value, 0);
    const usableExitIds = new Set(
      [...stepNetwork.exits.entries()].filter(([, value]) => value.usable).map(([id]) => id),
    );

    let adaptivePenaltyThisStep = 0;
    let oscillationThisStep = false;
    const solvePlan = (): {
      plan: EvacuationPlan;
      solveMs: number;
      stabilized: boolean;
      committed: boolean;
      emergencyOverride: boolean;
    } => {
      const startedAt = Date.now();
      if (solver === 'legacy') {
        const built = planEvacuation({
          scenario: input.scenario,
          network: stepNetwork,
          demandByRegion: new Map(occupancy),
          scenarioVersion: input.versions.scenarioVersion,
          constraintVersion: input.versions.constraintVersion,
          observationVersion: input.versions.observationVersion,
          now,
        });
        const legacyPlan = built.plan;
        legacyPlan.plan_id = `PLAN-MPC-LEGACY-${now.getTime().toString(36).toUpperCase()}-${step}`;
        legacyPlan.created_at = now.toISOString();
        return { plan: legacyPlan, solveMs: Date.now() - startedAt, stabilized: false, committed: false, emergencyOverride: false };
      }
      const solveV7 = (allowedExitsByRegion?: Map<string, Set<string>>) => solveTimeExpandedPlan({
        scenario: input.scenario,
        network: stepNetwork,
        demandByRegion: new Map(occupancy),
        horizonMinutes: horizonThisStep,
        baseMinute: elapsed,
        versions: input.versions,
        now,
        predictedArrivals: plannedArrivals,
        exitCapacityFactor,
        corridorCapacityFactor: input.corridorCapacityFactor,
        allowedExitsByRegion,
        holdCostPerMinute: input.holdCostPerMinute ?? 0.05,
        algorithm: 'MPC: rolling time-expanded min-cost flow',
        model: `control interval ${stepLength} min; planning horizon ${horizonThisStep} min; queue feedback ${queueFeedback}; stability ${stability.mode}`,
      });

      const base = solveV7();
      let chosen = base;
      let stabilized = false;
      let committed = false;
      let emergencyOverride = false;

      // 承诺式稳定性：以“整体方案”为单位决策，避免只固定子集把压力挤到其它区域。
      const effectiveMode = stability.mode !== 'none' ? stability.mode : (stabilizeRoutes ? 'hysteresis' : 'none');
      const effectiveConfig = stability.mode !== 'none'
        ? stability
        : { ...stability, mode: 'hysteresis' as const, hysteresisGap: stabilizationTolerance };
      const prior = activePlan;
      if (effectiveMode !== 'none' && prior !== null && previousExits.size > 0) {
        const withinCommit = effectiveConfig.commitMinutes > 0
          && elapsed - prior.baseMinute < effectiveConfig.commitMinutes;
        const congested = queueTotal > effectiveConfig.adaptiveQueueThreshold;
        let stepRisk = 0;
        for (const [regionId, persons] of occupancy) {
          stepRisk = Math.max(stepRisk, regionRiskRatio(input.scenario, regionId, persons));
        }
        const penalty = adaptiveStability.enabled
          ? adaptiveSwitchPenalty(adaptiveStability, { queueTotal, worstRiskRatio: stepRisk })
          : effectiveConfig.switchPenaltyPerPerson;
        adaptivePenaltyThisStep = Number(penalty.toFixed(3));
        adaptivePenaltySum += penalty;
        adaptivePenaltyCount += 1;
        const decisionConfig = { ...effectiveConfig, switchPenaltyPerPerson: penalty };
        // V7.4：高风险时自动释放承诺，避免为了稳定而延迟紧急改派。
        let releaseOnRisk = adaptiveStability.enabled
          && adaptiveStability.releaseOnRiskThreshold > 0
          && stepRisk >= adaptiveStability.releaseOnRiskThreshold;
        if (releaseOnRisk) {
          commitmentReleases += 1;
          lastReleaseMinute = elapsed;
          recommitPending = true;
          emergencyOverride = true;
        }
        // V7.5：释放后的冷却期内禁止重新承诺；冷却结束后的首次承诺计为 re-commit。
        const inRecommitCooldown = adaptiveStability.enabled
          && adaptiveStability.recommitCooldownMinutes > 0
          && elapsed - lastReleaseMinute < adaptiveStability.recommitCooldownMinutes;
        if (inRecommitCooldown) releaseOnRisk = true;
        const regionIds = [...previousExits.keys()].filter(regionId => (occupancy.get(regionId) ?? 0) > 0).sort();
        const commitments = new Map<string, string>();
        let unusableExit = false;
        for (const regionId of regionIds) {
          const exitId = previousExits.get(regionId)!;
          if (!usableExitIds.has(exitId)) {
            unusableExit = true;
            continue;
          }
          if (adaptiveStability.enabled && adaptiveStability.regionSelectiveRiskThreshold < 1) {
            const risk = regionRiskRatio(input.scenario, regionId, occupancy.get(regionId) ?? 0);
            if (risk >= adaptiveStability.regionSelectiveRiskThreshold) continue;
          }
          commitments.set(regionId, exitId);
        }
        // V7.5：容量感知承诺——承诺出口的投影需求超过容量时，优先放弃高风险区域的承诺。
        if (input.capacityAwareCommitment?.enabled && commitments.size > 0) {
          const minute = elapsed + interval;
          const headroom = Math.max(0.1, Math.min(1.5, input.capacityAwareCommitment.headroomRatio ?? 0.9));
          const byExit = new Map<string, Array<{ regionId: string; persons: number; risk: number }>>();
          for (const [regionId, exitId] of commitments) {
            const list = byExit.get(exitId) ?? [];
            const persons = occupancy.get(regionId) ?? 0;
            list.push({ regionId, persons, risk: regionRiskRatio(input.scenario, regionId, persons) });
            byExit.set(exitId, list);
          }
          for (const [exitId, list] of byExit) {
            const exit = input.scenario.exits.find(item => item.id === exitId);
            const factor = Math.max(0, input.exitCapacityFactor?.(exitId, minute) ?? 1);
            const capacity = Math.floor((exit?.capacity_per_min ?? 0) * factor * headroom);
            let load = list.reduce((sum, item) => sum + item.persons, 0);
            const ordered = [...list].sort((a, b) => b.risk - a.risk || b.persons - a.persons);
            while (load > capacity && ordered.length > 0) {
              const dropped = ordered.shift()!;
              commitments.delete(dropped.regionId);
              load -= dropped.persons;
            }
          }
        }
        // V7.5：紧急状态机可在风险/出口/容量事件时失效承诺，并阻止恢复前的重新承诺。
        if (emergencyMachine) {
          const baseCapacity = checkPlanCapacity(input.scenario, base.plan.routes, elapsed, {
            corridorCapacityFactor: input.corridorCapacityFactor,
            exitCapacityFactor: input.exitCapacityFactor,
          });
          const outcome = emergencyMachine.evaluate({
            tick: elapsed,
            riskRatio: stepRisk,
            unusableExit,
            capacityViolation: baseCapacity.length > 0,
            observationsValid: input.observationsValid !== false,
            sensorConflict: input.sensorConflict === true,
            stale: input.observationStale === true,
            planValidated: true,
          });
          emergencyStateThisStep = outcome.state;
          emergencyPublishableThisStep = outcome.publishable;
          if (outcome.invalidateCommitments || !outcome.mayCommit) {
            if (!releaseOnRisk) {
              commitmentReleases += outcome.event?.releaseCommitments ? 1 : 0;
              lastReleaseMinute = elapsed;
              recommitPending = true;
            }
            releaseOnRisk = true;
            emergencyOverride = true;
          }
        }
        if (commitments.size > 0 && !releaseOnRisk) {
          if (recommitPending) {
            commitmentRecommits += 1;
            recommitPending = false;
          }
          const baseSwitchWeighted = adaptiveStability.enabled
            ? weightedSwitchPersons({
              candidateRoutes: base.plan.routes,
              previousExits,
              scenario: input.scenario,
              occupancy,
              riskWeight: adaptiveStability.riskWeightedSwitching ? 1 : 0,
            })
            : switchingImpact(base.plan.routes, previousExits).persons;
          const objective = (planValue: EvacuationPlan, switchPersons: number): number => {
            if (adaptiveStability.enabled) {
              return scorePlan(planValue, {
                previousExits,
                config: adaptiveStability,
                switchPersonsOverride: switchPersons,
              }).score;
            }
            return planValue.unresolved_persons * 10_000
              + planValue.routes.reduce((sum, route) => sum + route.persons * route.arrive_minute, 0);
          };
          const baseObjective = objective(base.plan, baseSwitchWeighted);
          const baseOscillation = detectOscillatingRegions(exitHistory, base.plan.routes);
          const gateEnabled = Boolean(input.paretoStability) || input.executionGate?.enabled === true;
          const makespanTolerance = input.paretoStability?.makespanToleranceMinutes
            ?? input.executionGate?.makespanToleranceMinutes
            ?? 0;
          const queueTolerance = input.paretoStability?.queueTolerancePersonMinutes
            ?? input.executionGate?.queueTolerancePersonMinutes
            ?? 0;
          const baseProjection = gateEnabled
            ? simulateRoutesExecution(input.scenario, base.plan.routes, {
              maxMinutes: maxExecution,
              bprA,
              bprB,
              corridorCapacityFactor: input.corridorCapacityFactor,
              exitCapacityFactor: input.exitCapacityFactor,
            })
            : null;
          const shares = input.paretoStability
            ? (input.paretoStability.shares && input.paretoStability.shares.length > 0
              ? input.paretoStability.shares
              : [0.8, 0.6, 0.4, 0.2])
            : [0.8];
          let bestCandidate: {
            candidate: ReturnType<typeof solveCommitmentAwarePlan>;
            switchWeighted: number;
            projection: ReturnType<typeof simulateRoutesExecution> | null;
          } | null = null;
          for (const share of shares) {
            paretoCandidates += 1;
            const candidate = solveCommitmentAwarePlan({
              scenario: input.scenario,
              network: stepNetwork,
              demandByRegion: new Map(occupancy),
              horizonMinutes: horizonThisStep,
              baseMinute: elapsed,
              versions: input.versions,
              now,
              commitments,
              predictedArrivals: plannedArrivals,
              commitmentShare: share,
              exitCapacityFactor,
              corridorCapacityFactor: input.corridorCapacityFactor,
              holdCostPerMinute: input.holdCostPerMinute ?? 0.05,
            });
            if (candidate.plan.unresolved_persons > base.plan.unresolved_persons
              || candidate.capacity_violations.length > 0) {
              continue;
            }
            const candidateSwitchWeighted = adaptiveStability.enabled
              ? weightedSwitchPersons({
                candidateRoutes: candidate.plan.routes,
                previousExits,
                scenario: input.scenario,
                occupancy,
                riskWeight: adaptiveStability.riskWeightedSwitching ? 1 : 0,
              })
              : switchingImpact(candidate.plan.routes, previousExits).persons;
            const candidateObjective = objective(candidate.plan, candidateSwitchWeighted);
            const candidateOscillation = detectOscillatingRegions(exitHistory, candidate.plan.routes);
            const oscillationPenalty = adaptiveStability.enabled ? adaptiveStability.oscillationPenaltyPerPerson : 0;
            const decision = shouldUseCommitment({
              mode: effectiveMode,
              config: { ...decisionConfig, switchPenaltyPerPerson: penalty + oscillationPenalty },
              withinCommit,
              congested,
              baseObjective,
              committedObjective: candidateObjective,
              baseSwitchPersons: baseSwitchWeighted,
              committedSwitchPersons: candidateSwitchWeighted,
            });
            const withinGuardrail = candidateObjective <= baseObjective * (1 + effectiveConfig.maxObjectiveDegradation) + 1;
            const oscillationGuard = !adaptiveStability.enabled
              || candidateOscillation.persons <= baseOscillation.persons;
            if (!decision.use || !withinGuardrail || !oscillationGuard) continue;
            let projection: ReturnType<typeof simulateRoutesExecution> | null = null;
            if (gateEnabled && baseProjection) {
              projection = simulateRoutesExecution(input.scenario, candidate.plan.routes, {
                maxMinutes: maxExecution,
                bprA,
                bprB,
                corridorCapacityFactor: input.corridorCapacityFactor,
                exitCapacityFactor: input.exitCapacityFactor,
              });
              if (projection.makespan_minute > baseProjection.makespan_minute + makespanTolerance
                || projection.total_queue_person_minutes > baseProjection.total_queue_person_minutes + queueTolerance) {
                gateRejections += 1;
                continue;
              }
            }
            if (!bestCandidate || candidateSwitchWeighted < bestCandidate.switchWeighted) {
              bestCandidate = { candidate, switchWeighted: candidateSwitchWeighted, projection };
            }
          }
          const requireSwitchReduction = Boolean(input.paretoStability) || input.executionGate?.enabled === true;
          if (bestCandidate && (!requireSwitchReduction || bestCandidate.switchWeighted < baseSwitchWeighted)) {
            chosen = { ...base, plan: bestCandidate.candidate.plan };
            stabilized = bestCandidate.candidate.committed_regions.length > 0;
            committed = stabilized;
            oscillationThisStep = detectOscillatingRegions(exitHistory, bestCandidate.candidate.plan.routes).persons > 0;
            if (bestCandidate.candidate.emergency_overrides.length > 0) emergencyOverride = true;
          }
        }
        if (unusableExit && (effectiveMode === 'commitment' || effectiveMode === 'adaptive')) {
          // 承诺本应生效但出口已不可用：记录紧急覆盖，承诺立即失效。
          emergencyOverride = true;
        }
      }

      chosen.plan.plan_id = `PLAN-MPC-${now.getTime().toString(36).toUpperCase()}-${step}`;
      chosen.plan.created_at = now.toISOString();
      return { plan: chosen.plan, solveMs: Date.now() - startedAt, stabilized, committed, emergencyOverride };
    };

    const plannedOccupancy = activePlan?.plannedOccupancy ?? 0;
    // 只对“未预期的人数上升”触发；执行导致的人数下降是正常进展，不应触发重规划。
    const occupancyIncrease = activePlan
      ? Math.max(0, sumMap(occupancy) - plannedOccupancy) / Math.max(1, plannedOccupancy)
      : 1;
    const eventTrigger = due.length > 0
      || elapsedSincePlan >= eventMaxInterval
      || queueTotal > eventQueueThreshold
      || occupancyIncrease > eventOccupancyRatio;
    let replannedThisStep = !activePlan || replanPolicy === 'periodic' || eventTrigger;
    let solveMs = 0;
    let stabilizedThisStep = false;
    let committedThisStep = false;
    let emergencyThisStep = false;
    if (replannedThisStep) {
      const solved = solvePlan();
      solveMs = solved.solveMs;
      stabilizedThisStep = solved.stabilized;
      committedThisStep = solved.committed;
      emergencyThisStep = solved.emergencyOverride;
      if (stabilizedThisStep) stabilizedSteps += 1;
      if (committedThisStep) committedSteps += 1;
      if (emergencyThisStep) emergencyOverrides += 1;
      totalSolveMs += solveMs;
      replans += 1;
      activePlan = { baseMinute: elapsed, plan: solved.plan, plannedOccupancy: sumMap(occupancy) };
    }

    const executeWindow = (baseMinute: number, planValue: EvacuationPlan): EvacuationRoute[] => {
      const startRel = elapsed - baseMinute;
      const endRel = stepEnd - baseMinute;
      const availableByRegion = new Map(occupancy);
      const out: EvacuationRoute[] = [];
      for (const route of planValue.routes) {
        if (route.depart_minute < startRel || route.depart_minute >= endRel) continue;
        const available = availableByRegion.get(route.from_region_id) ?? 0;
        if (available <= 0) continue;
        const persons = Math.min(route.persons, available);
        if (persons <= 0) continue;
        availableByRegion.set(route.from_region_id, available - persons);
        out.push({
          ...route,
          persons,
          depart_minute: route.depart_minute - startRel,
          arrive_minute: route.arrive_minute - startRel,
          steps: route.steps.map(stepValue => ({
            ...stepValue,
            persons,
            depart_minute: stepValue.depart_minute - startRel,
            arrive_minute: stepValue.arrive_minute - startRel,
          })),
        });
      }
      return out;
    };

    let executed = activePlan ? executeWindow(activePlan.baseMinute, activePlan.plan) : [];
    // 仅当活动计划确实没有后续路线时才强制重规划；否则等待其后续路线，避免空转与不必要求解。
    const hasFutureRoutes = activePlan
      ? activePlan.plan.routes.some(route => route.depart_minute >= stepEnd - activePlan!.baseMinute)
      : false;
    if (executed.length === 0 && sumMap(occupancy) > 0 && !replannedThisStep && !hasFutureRoutes) {
      const solved = solvePlan();
      solveMs = solved.solveMs;
      stabilizedThisStep = solved.stabilized;
      committedThisStep = solved.committed;
      emergencyThisStep = solved.emergencyOverride;
      if (stabilizedThisStep) stabilizedSteps += 1;
      if (committedThisStep) committedSteps += 1;
      if (emergencyThisStep) emergencyOverrides += 1;
      totalSolveMs += solveMs;
      replans += 1;
      replannedThisStep = true;
      activePlan = { baseMinute: elapsed, plan: solved.plan, plannedOccupancy: sumMap(occupancy) };
      executed = executeWindow(activePlan.baseMinute, activePlan.plan);
    }
    const plan = activePlan!.plan;
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
      baseMinute: elapsed,
      corridorCapacityFactor: input.corridorCapacityFactor,
      exitCapacityFactor: input.exitCapacityFactor,
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
    // V7.3：A→B→A 振荡检测（基于历史，而不是单步切换）。
    const currentOscillation = detectOscillatingRegions(exitHistory, executed);
    if (currentOscillation.persons > 0) {
      oscillationEvents += 1;
      oscillationPersons += currentOscillation.persons;
      oscillationThisStep = true;
    }
    appendExitHistory(exitHistory, executed);
    for (const [regionId, exitId] of currentExits) previousExits.set(regionId, exitId);
    const stepCapacityViolations = checkPlanCapacity(input.scenario, plan.routes, activePlan!.baseMinute, {
      corridorCapacityFactor: input.corridorCapacityFactor,
      exitCapacityFactor: input.exitCapacityFactor,
    });
    capacityViolations += stepCapacityViolations.length;

    executedRoutes.push(...executed.map(route => ({
      ...route,
      depart_minute: route.depart_minute + elapsed,
      arrive_minute: route.arrive_minute + elapsed,
      steps: route.steps.map(stepValue => ({
        ...stepValue,
        depart_minute: stepValue.depart_minute + elapsed,
        arrive_minute: stepValue.arrive_minute + elapsed,
      })),
    })));
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
      plan_base_minute: activePlan!.baseMinute,
      replanned: replannedThisStep,
      solve_ms: solveMs,
      stabilized: stabilizedThisStep,
      committed: committedThisStep,
      emergency_override: emergencyThisStep,
      stability_mode: stability.mode,
      capacity_violations: stepCapacityViolations.length,
      oscillation: oscillationThisStep,
      adaptive_penalty: adaptiveStability.enabled ? adaptivePenaltyThisStep : undefined,
      pareto_candidates: input.paretoStability ? paretoCandidates : undefined,
      gate_rejected: input.paretoStability || input.executionGate?.enabled ? gateRejections : undefined,
      emergency_state: emergencyStateThisStep,
      emergency_publishable: emergencyPublishableThisStep,
      execution,
      queue_feedback_applied: queueFeedback,
      executed_routes: executed,
    });
    if (emergencyPublishableThisStep === false) unpublishableSteps += 1;
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
    replans,
    total_solve_ms: totalSolveMs,
    stabilized_steps: stabilizedSteps,
    committed_steps: committedSteps,
    emergency_overrides: emergencyOverrides,
    max_density_persons_per_m2: Number(maxDensity.toFixed(4)),
    worst_region_id: worstRegionId,
    worst_risk_ratio: Number(worstRiskRatio.toFixed(4)),
    capacity_violations: capacityViolations,
    oscillation_events: oscillationEvents,
    oscillation_persons: oscillationPersons,
    adaptive_penalty_avg: adaptivePenaltyCount > 0 ? Number((adaptivePenaltySum / adaptivePenaltyCount).toFixed(3)) : 0,
    pareto_candidates: paretoCandidates,
    gate_rejections: gateRejections,
    commitment_releases: commitmentReleases,
    commitment_recommits: commitmentRecommits,
    emergency_events: emergencyMachine
      ? emergencyMachine.auditEvents.map(event => ({
        tick: event.tick,
        from: event.from,
        to: event.to,
        reason: event.reason,
        risk: event.risk,
        active_work_orders: event.activeWorkOrders,
      }))
      : [],
    unpublishable_steps: unpublishableSteps,
    final_occupancy: occupancy,
    notes: [
      `控制步 ${interval} 分钟；预测 ${useForecast ? '启用' : '禁用'}；队列反馈 ${queueFeedback ? '启用' : '禁用'}。`,
      `稳定性模式 ${stability.mode}；切换惩罚 ${stability.switchPenaltyPerPerson}/人；承诺窗口 ${stability.commitMinutes} 分钟；迟滞容差 ${stability.hysteresisGap}。`,
      adaptiveStability.enabled
        ? `V7.3 自适应稳定性：基础惩罚 ${adaptiveStability.basePenaltyPerPerson}/人；振荡惩罚 ${adaptiveStability.oscillationPenaltyPerPerson}/人；风险加权 ${adaptiveStability.riskWeightedSwitching}。`
        : 'V7.3 自适应稳定性未启用。',
      '只有第一步计划对应当前观测；后续步骤是条件投影，不是已验证方案。',
      '执行模型为 1 分钟离散 FIFO 队列 + BPR 行程时间放大，结果只用于策略比较。',
      '稳定性候选必须满足未疏散人数不增加；出口不可用时承诺立即失效（紧急覆盖）。',
    ],
  };
}
