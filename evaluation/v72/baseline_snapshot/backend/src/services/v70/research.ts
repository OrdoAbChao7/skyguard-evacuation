/**
 * V7 研究预览服务：预测、联合 VoI、MPC 滚动规划与拥堵执行反馈。
 *
 * 安全语义：
 *  - 全部为**只读预览**，不发布方案、不改变四态、不写审计；
 *  - 观测不可信 / 缺失时 fail closed，返回 available=false 与原因；
 *  - 带预测到达的 MPC 步骤是**条件投影**，不声明“已通过独立校验”；
 *  - 只有无预测注入的第一步可以对照当前观测做独立校验。
 */
import type { SafetyDecisionService } from '../safety/decision-service';
import { assessObservation } from '../safety/observations';
import { resolveEffectiveNetwork } from '../safety/network';
import { validateSafetyPlan } from '../safety/validator';
import { buildRegionGraph, propagateRisk } from '../mvp/risk-graph';
import { priorBeliefsForRegions } from '../mvp/multi-voi';
import { decideJointInvestigation } from '../mvp/joint-voi';
import { ensembleForecast, type SeriesPoint } from '../mvp/forecast-advanced';
import { planEvacuationMpc } from '../safety/planning/mpc-planner';
import { simulatePlanExecution } from '../safety/planning/congestion';
import type { DensityObservation } from '../safety/types';

export interface ForecastPreview {
  available: boolean;
  reason?: string;
  region_id: string;
  horizon_minutes: number;
  result?: ReturnType<typeof ensembleForecast>;
  provenance: {
    algorithm: string;
    data_source: string;
    note: string;
  };
}

export function buildForecastPreview(
  safety: SafetyDecisionService,
  regionId: string,
  horizonMinutes = 5,
): ForecastPreview {
  const scenario = safety.getScenario();
  const boundedHorizon = Math.max(1, Math.min(30, Math.round(horizonMinutes)));
  const region = scenario.regions.find(item => item.id === regionId);
  if (!region || !region.enabled) {
    return {
      available: false,
      reason: `区域不存在或未启用：${regionId}`,
      region_id: regionId,
      horizon_minutes: boundedHorizon,
      provenance: { algorithm: 'ensemble_v70', data_source: 'observations', note: '未执行预测' },
    };
  }
  const now = new Date();
  const windowMinutes = Math.max(5, Math.round(scenario.config.trend_window_seconds / 60));
  const from = new Date(now.getTime() - windowMinutes * 60_000);
  const points = safety.getObservationStore()
    .window(regionId, from, now)
    .filter(item => item.valid && item.confidence >= scenario.config.min_confidence)
    .sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime());
  if (points.length < 4) {
    return {
      available: false,
      reason: `可信观测不足（${points.length} 点，要求 ≥4），不给出预测。`,
      region_id: regionId,
      horizon_minutes: boundedHorizon,
      provenance: { algorithm: 'ensemble_v70', data_source: 'observations', note: '数据不足，fail closed' },
    };
  }
  const origin = new Date(points[0].observed_at).getTime();
  const samples: SeriesPoint[] = points.map(point => ({
    x: (new Date(point.observed_at).getTime() - origin) / 60_000,
    y: point.estimated_count,
  }));
  const result = ensembleForecast(samples, {
    horizonMinutes: boundedHorizon,
    maxRelativeIntervalWidth: scenario.config.prediction_max_relative_interval_width,
  });
  return {
    available: true,
    region_id: regionId,
    horizon_minutes: boundedHorizon,
    result,
    provenance: {
      algorithm: 'ensemble_v70',
      data_source: `可信观测 ${points.length} 点（来源：${Array.from(new Set(points.map(item => item.source))).join(',')}）`,
      note: '研究级预测；区间为历史残差 conformal 近似；不替代四态安全判定。',
    },
  };
}

export interface JointVoIPreview {
  available: boolean;
  reason?: string;
  target_region_id: string;
  decision?: ReturnType<typeof decideJointInvestigation>;
  propagated_risk?: ReturnType<typeof propagateRisk>;
  provenance: { engine: string; note: string };
}

export function buildJointVoIPreview(
  safety: SafetyDecisionService,
  targetRegionId: string,
  options: { correlation?: number; redundancyPenalty?: number; maxSequence?: number } = {},
): JointVoIPreview {
  const scenario = safety.getScenario();
  const policy = scenario.investigation;
  if (!policy) {
    return {
      available: false,
      reason: '场景未配置 investigation 策略',
      target_region_id: targetRegionId,
      provenance: { engine: 'joint-voi-v1', note: '未执行' },
    };
  }
  const status = safety.getStatus();
  const region = scenario.regions.find(item => item.id === targetRegionId);
  if (!region || !region.enabled) {
    return {
      available: false,
      reason: `区域不存在或未启用：${targetRegionId}`,
      target_region_id: targetRegionId,
      provenance: { engine: 'joint-voi-v1', note: '未执行' },
    };
  }
  const risks = status.risks;
  const graph = buildRegionGraph(scenario);
  const beliefs = priorBeliefsForRegions(policy, risks);
  const propagated = propagateRisk(scenario, risks);
  const clamp01 = (value: number | undefined): number | undefined =>
    value === undefined ? undefined : Math.max(0, Math.min(1, value));
  const decision = decideJointInvestigation(policy, targetRegionId, beliefs, graph, {}, {
    correlation: clamp01(options.correlation),
    redundancyPenalty: clamp01(options.redundancyPenalty),
    maxSequence: options.maxSequence === undefined ? undefined : Math.max(1, Math.min(6, Math.round(options.maxSequence))),
  });
  return {
    available: true,
    target_region_id: targetRegionId,
    decision,
    propagated_risk: propagated,
    provenance: {
      engine: 'joint-voi-v1',
      note: '研究级联合 VoI 预览；不创建工单、不改变安全状态；参数未在真实数据上标定。',
    },
  };
}

export interface MpcPreview {
  available: boolean;
  reason?: string;
  steps?: Array<{
    step: number;
    start_minute: number;
    control_end_minute: number;
    plan_summary: {
      plan_id: string;
      routes: number;
      executed_routes: number;
      evacuated_persons: number;
      unresolved_persons: number;
    };
    validation: { performed: boolean; valid: boolean | null; violation_codes: string[]; note: string };
    execution: {
      completed_persons: number;
      unserved_persons: number;
      queue_person_minutes: number;
      max_queue_persons: number;
      makespan_minute: number;
    };
  }>;
  projection?: {
    total_input_persons: number;
    completed_persons: number;
    unserved_persons: number;
    makespan_minute: number;
    total_queue_person_minutes: number;
    max_queue_persons: number;
    p95_wait_minutes: number;
    switch_events: number;
    switch_persons: number;
  };
  forecast?: {
    regions: Array<{ region_id: string; predicted: number | null; current: number | null; reliability: string; note: string }>;
    arrivals_model: string;
  };
  provenance: {
    algorithm: string;
    safety_boundary: string;
    data_source: string;
  };
}

export function buildMpcPreview(
  safety: SafetyDecisionService,
  options: {
    controlIntervalMinutes?: number;
    planningHorizonMinutes?: number;
    useForecast?: boolean;
    queueFeedback?: boolean;
    maxSteps?: number;
  } = {},
): MpcPreview {
  const scenario = safety.getScenario();
  const now = new Date();
  const network = resolveEffectiveNetwork(scenario, safety.getIncidentStore().list());
  const latest = new Map<string, DensityObservation>();
  const demand = new Map<string, number>();
  const untrusted: Array<{ region_id: string; reasons: string[] }> = [];

  for (const region of scenario.regions) {
    if (!region.enabled) continue;
    const observation = safety.getObservationStore().latest(region.id);
    if (!observation) {
      untrusted.push({ region_id: region.id, reasons: ['no_observation'] });
      continue;
    }
    const assessment = assessObservation(observation, scenario.config, now);
    if (!assessment.trusted || network.sensorFailedRegionIds.has(region.id)) {
      untrusted.push({
        region_id: region.id,
        reasons: [...assessment.untrustedReasons, ...(network.sensorFailedRegionIds.has(region.id) ? ['sensor_failure_incident'] : [])],
      });
      continue;
    }
    latest.set(region.id, observation);
    demand.set(region.id, observation.estimated_count);
  }
  if (untrusted.length > 0) {
    return {
      available: false,
      reason: `观测不可信，MPC 预览 fail closed：${untrusted.map(item => `${item.region_id}(${item.reasons.join(',')})`).join('; ')}`,
      provenance: {
        algorithm: 'MPC rolling time-expanded min-cost flow',
        safety_boundary: '预览不可用时不给出任何路线',
        data_source: 'observations',
      },
    };
  }

  // 预测到达：用集成预测的增量（predicted − current）作为未来入流，偏移取 horizon/2。
  const predictedArrivals = new Map<string, Array<{ offsetMinute: number; persons: number }>>();
  const forecastSummary: NonNullable<MpcPreview['forecast']>['regions'] = [];
  for (const region of scenario.regions) {
    if (!region.enabled) continue;
    const current = demand.get(region.id) ?? 0;
    const preview = buildForecastPreview(safety, region.id, Math.min(5, scenario.config.horizon_minutes));
    if (!preview.available || !preview.result) {
      forecastSummary.push({ region_id: region.id, predicted: null, current, reliability: 'unavailable', note: preview.reason ?? '预测不可用' });
      continue;
    }
    const predicted = preview.result.predicted;
    const reliability = preview.result.reliability.status;
    forecastSummary.push({
      region_id: region.id,
      predicted,
      current,
      reliability,
      note: preview.result.reliability.reasons.join('、') || 'ok',
    });
    const increment = predicted - current;
    if (increment > 0 && reliability !== 'failed') {
      const list = predictedArrivals.get(region.id) ?? [];
      list.push({ offsetMinute: Math.max(1, Math.round(preview.result.horizon_minutes / 2)), persons: increment });
      predictedArrivals.set(region.id, list);
    }
  }

  const versions = {
    scenarioVersion: scenario.version,
    constraintVersion: safety.getVersions().constraint,
    observationVersion: safety.getObservationStore().getVersion(),
  };
  const mpc = planEvacuationMpc({
    scenario,
    network,
    initialDemandByRegion: demand,
    versions,
    now,
    useForecast: options.useForecast ?? true,
    queueFeedback: options.queueFeedback ?? true,
    predictedArrivals,
    // 预览没有真实未来到达数据：预测只用于规划容量，不得计入“已到达”人数。
    actualArrivals: new Map(),
    maxSteps: options.maxSteps === undefined ? undefined : Math.max(1, Math.min(40, Math.round(options.maxSteps))),
    controlIntervalMinutes: options.controlIntervalMinutes === undefined
      ? undefined
      : Math.max(1, Math.min(10, Math.round(options.controlIntervalMinutes))),
    planningHorizonMinutes: options.planningHorizonMinutes === undefined
      ? undefined
      : Math.max(1, Math.min(30, Math.round(options.planningHorizonMinutes))),
  });

  const steps = mpc.steps.map(step => {
    const performed = step.step === 0 && !(options.useForecast ?? true);
    const validation = performed
      ? validateSafetyPlan({
        plan: step.plan,
        scenario,
        network,
        latestObservations: latest,
        config: scenario.config,
        constraintVersion: versions.constraintVersion,
        observationVersion: versions.observationVersion,
        now,
      })
      : null;
    return {
      step: step.step,
      start_minute: step.start_minute,
      control_end_minute: step.control_end_minute,
      plan_summary: {
        plan_id: step.plan.plan_id,
        routes: step.plan.routes.length,
        executed_routes: step.executed_routes.length,
        evacuated_persons: step.plan.evacuated_persons,
        unresolved_persons: step.plan.unresolved_persons,
      },
      validation: {
        performed,
        valid: validation ? validation.valid : null,
        violation_codes: validation ? validation.violations.map(item => item.code) : [],
        note: performed
          ? '第一步对照当前观测做独立校验。'
          : '该步骤包含预测到达或为后续控制步，属于条件投影，不声明已验证。',
      },
      execution: {
        completed_persons: step.execution.completed_persons,
        unserved_persons: step.execution.unserved_persons,
        queue_person_minutes: step.execution.total_queue_person_minutes,
        max_queue_persons: step.execution.max_queue_persons,
        makespan_minute: step.execution.makespan_minute,
      },
    };
  });

  return {
    available: true,
    steps,
    projection: {
      total_input_persons: mpc.total_input_persons,
      completed_persons: mpc.completed_persons,
      unserved_persons: mpc.unserved_persons,
      makespan_minute: mpc.makespan_minute,
      total_queue_person_minutes: mpc.total_queue_person_minutes,
      max_queue_persons: mpc.max_queue_persons,
      p95_wait_minutes: mpc.p95_wait_minutes,
      switch_events: mpc.switch_events,
      switch_persons: mpc.switch_persons,
    },
    forecast: {
      regions: forecastSummary,
      arrivals_model: '预测增量（predicted − current）在 horizon/2 处以入流注入；预测可靠性 failed 时不注入。',
    },
    provenance: {
      algorithm: 'MPC: rolling time-expanded min-cost flow + FIFO queue/BPR execution feedback',
      safety_boundary: '只读预览；不发布方案；带预测的步骤是条件投影；安全发布仍走 recompute + 独立校验。',
      data_source: '当前可信观测 + ensemble_v70 预测',
    },
  };
}

export interface CongestionPreview {
  available: boolean;
  reason?: string;
  metrics?: ReturnType<typeof simulatePlanExecution>;
  provenance: { model: string; note: string };
}

export function buildCongestionPreview(safety: SafetyDecisionService): CongestionPreview {
  const scenario = safety.getScenario();
  const plan = safety.getPlan() ?? safety.getCandidatePlan();
  if (!plan) {
    return {
      available: false,
      reason: '当前没有已发布或候选方案，无法评估拥堵投影。',
      provenance: { model: 'FIFO queue + BPR', note: '未执行' },
    };
  }
  return {
    available: true,
    metrics: simulatePlanExecution(scenario, plan),
    provenance: {
      model: '1-minute FIFO queue + BPR travel-time inflation (a=0.15, b=2, uncalibrated)',
      note: '研究级执行投影；不是人群动力学仿真，也不改变安全状态。',
    },
  };
}
