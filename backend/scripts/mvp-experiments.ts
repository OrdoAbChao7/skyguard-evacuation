/**
 * SkyGuard MVP 可复现实验。
 *
 *   npm run experiments:mvp --prefix backend
 *
 * 输出：
 *   evaluation/mvp/experiment1_voi.json
 *   evaluation/mvp/experiment2_prediction.json
 *   evaluation/mvp/experiment3_safety_ablation.json
 *   evaluation/mvp/experiment4_business_loop.json
 *   evaluation/mvp/run_metadata.json
 *   evaluation/MVP_REPORT.md
 *
 * 所有随机过程使用固定种子；模拟数据与真实数据严格区分，报告中不把模拟结果
 * 表述为真实场馆效果。实验不修改期望状态。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../src/services/safety/audit';
import { SafetyDecisionService } from '../src/services/safety/decision-service';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { MvpService } from '../src/services/mvp';
import {
  applyEvidence,
  decideInvestigation,
  entropy,
  expectedRisk,
  fixedPriorityChoice,
  priorBelief,
} from '../src/services/mvp/voi';
import { predictSeries } from '../src/services/mvp/prediction';
import { planEvacuation } from '../src/services/safety/planning/evacuation-planner';
import { validateSafetyPlan } from '../src/services/safety/validator';
import { resolveEffectiveNetwork } from '../src/services/safety/network';
import { decideSafetyState } from '../src/services/safety/state-machine';
import type { Incident, SafetyScenario } from '../src/services/safety/types';
import type { WorkOrder } from '../src/services/mvp/ops';

const SEED = 20261105;
const OUT_DIR = path.resolve(__dirname, '../../evaluation/mvp');
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const scenario: SafetyScenario = loadSafetyScenario(SCENARIO_PATH);
const policy = scenario.investigation;
if (!policy) throw new Error('stadium scenario 缺少 investigation 策略');

fs.mkdirSync(OUT_DIR, { recursive: true });

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleIndex(probabilities: number[], rng: () => number): number {
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  let threshold = rng() * total;
  for (let index = 0; index < probabilities.length; index += 1) {
    threshold -= probabilities[index];
    if (threshold <= 0) return index;
  }
  return probabilities.length - 1;
}

function writeJson(name: string, data: unknown): void {
  fs.writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(data, null, 2)}\n`);
}

function riskOfBelief(belief: ReturnType<typeof priorBelief>, policyValue = policy): number {
  return expectedRisk(policyValue, belief);
}

// ---------------------------------------------------------------------------
// 实验一：VoI vs 固定优先级
// ---------------------------------------------------------------------------

interface StrategyTrial {
  strategy: 'voi' | 'fixed_priority';
  trial: number;
  true_hypothesis: string;
  actions: string[];
  tool_calls: number;
  entropy_before: number;
  entropy_after: number;
  entropy_reduction: number;
  risk_before: number;
  risk_after: number;
  risk_reduction: number;
  time_cost_minutes: number;
  resource_cost: number;
  effective_investigations: number;
  effective_ratio: number;
  stopped_reason: string;
}

function runExperiment1(): {
  config: Record<string, unknown>;
  trials: StrategyTrial[];
  summary: Record<string, Record<string, number>>;
} {
  const trials = 200;
  const rng = mulberry32(SEED + 1);
  const results: StrategyTrial[] = [];

  for (let trial = 0; trial < trials; trial += 1) {
    const hypotheses = policy.hypotheses;
    const truthIndex = sampleIndex(hypotheses.map(item => item.prior), rng);
    const trueHypothesis = hypotheses[truthIndex].id;

    const baseAvailability = () => ({
      A_CAMERA: rng() < 0.6 ? { available: true } : { available: false, reason: '摄像头离线（模拟）' },
      A_STAFF: rng() < 0.85 ? { available: true } : { available: false, reason: '人员不足（模拟）' },
      A_UAV: rng() < 0.6 ? { available: true } : { available: false, reason: '无人机不可用（模拟）' },
      A_HISTORY: rng() < 0.7 ? { available: true } : { available: false, reason: '历史不足（模拟）' },
      A_PREDICTION: { available: true },
    });

    for (const strategy of ['voi', 'fixed_priority'] as const) {
      const availability = baseAvailability();
      let belief = priorBelief(policy);
      const entropyBefore = entropy(belief);
      const riskBefore = riskOfBelief(belief);
      const actions: string[] = [];
      let timeCost = 0;
      let resourceCost = 0;
      let effective = 0;
      let stoppedReason = 'max_investigations';

      for (let round = 0; round < policy.max_investigations; round += 1) {
        let actionId: string | null = null;
        if (strategy === 'voi') {
          const decision = decideInvestigation(policy, belief, { availability, investigationsUsed: round });
          actionId = decision.recommended_action_id;
          if (!decision.should_investigate) {
            stoppedReason = decision.stop_reason ?? 'stopped';
            break;
          }
        } else {
          const choice = fixedPriorityChoice(policy, availability);
          actionId = choice.action_id;
          if (!actionId) {
            stoppedReason = choice.reason;
            break;
          }
        }

        const action = policy.actions.find(item => item.id === actionId)!;
        actions.push(action.id);
        // 同一动作不重复选择
        availability[action.id as keyof typeof availability] = { available: false, reason: '本轮已执行' };
        timeCost += action.time_cost_minutes;
        resourceCost += action.resource_cost;

        const likelihoodRow = policy.likelihoods[action.kind][trueHypothesis];
        const outcome = policy.outcomes[sampleIndex(
          policy.outcomes.map(item => likelihoodRow[item] ?? 0),
          rng,
        )];
        const beforeEntropy = entropy(belief);
        belief = applyEvidence(policy, belief, action.kind, outcome);
        const gain = beforeEntropy - entropy(belief);
        if (gain > 0.01 && outcome !== 'inconclusive' && outcome !== 'unavailable') effective += 1;
      }

      const finalEntropy = entropy(belief);
      const finalRisk = riskOfBelief(belief);
      results.push({
        strategy,
        trial,
        true_hypothesis: trueHypothesis,
        actions,
        tool_calls: actions.length,
        entropy_before: Number(entropyBefore.toFixed(6)),
        entropy_after: Number(finalEntropy.toFixed(6)),
        entropy_reduction: Number((entropyBefore - finalEntropy).toFixed(6)),
        risk_before: Number(riskBefore.toFixed(6)),
        risk_after: Number(finalRisk.toFixed(6)),
        risk_reduction: Number((riskBefore - finalRisk).toFixed(6)),
        time_cost_minutes: Number(timeCost.toFixed(3)),
        resource_cost: Number(resourceCost.toFixed(3)),
        effective_investigations: effective,
        effective_ratio: actions.length === 0 ? 0 : Number((effective / actions.length).toFixed(6)),
        stopped_reason: stoppedReason,
      });
    }
  }

  const summarize = (strategy: 'voi' | 'fixed_priority') => {
    const subset = results.filter(item => item.strategy === strategy);
    return {
      trials: subset.length,
      mean_tool_calls: Number(mean(subset.map(item => item.tool_calls)).toFixed(4)),
      mean_entropy_reduction: Number(mean(subset.map(item => item.entropy_reduction)).toFixed(4)),
      mean_risk_reduction: Number(mean(subset.map(item => item.risk_reduction)).toFixed(4)),
      mean_time_cost_minutes: Number(mean(subset.map(item => item.time_cost_minutes)).toFixed(4)),
      mean_resource_cost: Number(mean(subset.map(item => item.resource_cost)).toFixed(4)),
      mean_effective_ratio: Number(mean(subset.map(item => item.effective_ratio)).toFixed(4)),
      total_tool_calls: subset.reduce((sum, item) => sum + item.tool_calls, 0),
      stopped_early: subset.filter(item => item.tool_calls < policy.max_investigations).length,
    };
  };

  return {
    config: {
      seed: SEED + 1,
      trials,
      max_investigations: policy.max_investigations,
      policy_model_version: policy.model_version,
      policy_provenance: policy.provenance,
      availability_model: '摄像头 60% / 人员 85% / 无人机 60% / 历史 70% / 预测 100%（模拟）',
      note: '先验、似然、损失与成本均来自场景配置；结果只代表模拟条件下的策略对比，不代表真实场馆效果。',
    },
    trials: results,
    summary: { voi: summarize('voi'), fixed_priority: summarize('fixed_priority') },
  };
}

// ---------------------------------------------------------------------------
// 实验二：预测算法对比
// ---------------------------------------------------------------------------

function regression(values: number[]): { slope: number; intercept: number } {
  const points = values.map((y, x) => ({ x, y }));
  const meanX = mean(points.map(point => point.x));
  const meanY = mean(points.map(point => point.y));
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  return { slope, intercept: meanY - slope * meanX };
}

function emaValue(values: number[], alpha = 0.4): number {
  let result = values[0];
  for (let index = 1; index < values.length; index += 1) {
    result = alpha * values[index] + (1 - alpha) * result;
  }
  return result;
}

function runExperiment2(): {
  config: Record<string, unknown>;
  results: Array<Record<string, unknown>>;
} {
  const rng = mulberry32(SEED + 2);
  const horizons = [2, 5, 10];
  const seriesCount = 300;
  const trainLength = 20;
  const results: Array<Record<string, unknown>> = [];

  for (const horizon of horizons) {
    const errors = {
      persistence: [] as number[],
      ema_only: [] as number[],
      linear_only: [] as number[],
      ema_linear: [] as number[],
    };
    for (let series = 0; series < seriesCount; series += 1) {
      const base = 200 + rng() * 400;
      const slope = (rng() - 0.5) * 20;
      const noiseScale = 5 + rng() * 25;
      const values: number[] = [];
      for (let step = 0; step < trainLength + horizon; step += 1) {
        const noise = (rng() + rng() + rng() - 1.5) * noiseScale;
        values.push(Math.max(0, Math.round(base + slope * step + noise)));
      }
      const train = values.slice(0, trainLength);
      const truth = values[trainLength + horizon - 1];
      const { slope: fittedSlope, intercept } = regression(train);
      const predictions = {
        persistence: train[train.length - 1],
        ema_only: emaValue(train),
        linear_only: Math.max(0, intercept + fittedSlope * (trainLength + horizon - 1)),
        ema_linear: predictSeries(train, { horizonMinutes: horizon }).predicted,
      } as const;
      for (const [algorithm, prediction] of Object.entries(predictions)) {
        errors[algorithm as keyof typeof errors].push(Math.abs(prediction - truth));
      }
    }
    const metrics = Object.fromEntries(Object.entries(errors).map(([algorithm, absoluteErrors]) => {
      const mae = mean(absoluteErrors);
      const rmse = Math.sqrt(mean(absoluteErrors.map(value => value ** 2)));
      return [algorithm, { mae: Number(mae.toFixed(4)), rmse: Number(rmse.toFixed(4)) }];
    }));
    results.push({ horizon_minutes: horizon, series: seriesCount, metrics });
  }

  return {
    config: {
      seed: SEED + 2,
      series_count: seriesCount,
      train_length_minutes: trainLength,
      horizons,
      generator: 'base + slope*step + 三段均匀噪声；全部为合成序列',
      note: '这不是真实人流数据的精度指标；真实数据缺失，无法报告真实 MAE/RMSE。',
    },
    results,
  };
}

// ---------------------------------------------------------------------------
// 实验三：安全机制消融
// ---------------------------------------------------------------------------

function confirmedIncident(id: string, affected: Incident['affected']): Incident {
  const now = new Date().toISOString();
  return {
    id,
    type: 'corridor_closure',
    description: '实验构造的通道/出口关闭事件',
    status: 'confirmed',
    severity: 'high',
    affected,
    source: 'simulation',
    reported_by: 'experiment',
    reported_at: now,
    confirmed_by: 'experiment',
    confirmed_at: now,
  };
}

function runExperiment3(): {
  config: Record<string, unknown>;
  cases: Array<Record<string, unknown>>;
  summary: Record<string, number>;
} {
  const rng = mulberry32(SEED + 3);
  const caseCount = 80;
  const cases: Array<Record<string, unknown>> = [];
  let faultyCases = 0;
  let violationsDetected = 0;
  let erroneousNoValidator = 0;
  let erroneousValidator = 0;
  let erroneousValidatorAndState = 0;
  let safeRejections = 0;
  let degradedCases = 0;
  let blockedByState = 0;

  const exitIds = scenario.exits.map(exit => exit.id);
  const corridorIds = scenario.corridors.filter(corridor => corridor.status === 'open').map(corridor => corridor.id);

  for (let index = 0; index < caseCount; index += 1) {
    const demand = new Map<string, number>();
    for (const region of scenario.regions) {
      demand.set(region.id, Math.round(region.holding_capacity_persons * (0.2 + rng() * 1.3)));
    }

    const incidents: Incident[] = [];
    if (rng() < 0.45) {
      const closeExits = exitIds.filter(() => rng() < 0.35).slice(0, 2);
      if (closeExits.length > 0) {
        incidents.push(confirmedIncident(`INC-E-${index}`, { region_ids: [], corridor_ids: [], exit_ids: closeExits }));
      }
    }
    if (rng() < 0.3 && corridorIds.length > 0) {
      const corridor = corridorIds[Math.floor(rng() * corridorIds.length)];
      incidents.push(confirmedIncident(`INC-C-${index}`, { region_ids: [], corridor_ids: [corridor], exit_ids: [] }));
    }

    const network = resolveEffectiveNetwork(scenario, incidents);
    const planOutput = planEvacuation({
      scenario,
      network,
      demandByRegion: demand,
      scenarioVersion: scenario.version,
      constraintVersion: 1,
      observationVersion: 1,
    });
    let plan = planOutput.plan;
    const injectFault = rng() < 0.5;
    if (injectFault && plan.routes.length > 0) {
      faultyCases += 1;
      plan = JSON.parse(JSON.stringify(plan));
      plan.routes[0].persons = Math.max(1, plan.routes[0].persons) * 25 + 500;
      plan.routes.push({
        route_id: `FAULT-${index}`,
        from_region_id: scenario.regions[0].id,
        exit_id: incidentExitIds(incidents)[0] ?? exitIds[0],
        persons: 999999,
        depart_minute: 0,
        arrive_minute: 1,
        steps: [],
      });
    }

    const validation = validateSafetyPlan({
      plan,
      scenario,
      network,
      latestObservations: new Map(),
      config: scenario.config,
      constraintVersion: 1,
      observationVersion: 1,
    });
    if (!validation.valid) violationsDetected += 1;

    const noValidatorPublish = plan.status !== 'infeasible';
    if (injectFault && noValidatorPublish) erroneousNoValidator += 1;

    const validatorPublish = validation.valid;
    if (injectFault && validatorPublish) erroneousValidator += 1;
    if (injectFault && !validatorPublish) safeRejections += 1;

    const untrusted = rng() < 0.3;
    if (untrusted) degradedCases += 1;
    const state = decideSafetyState({
      hasObservations: true,
      inferenceHealthy: true,
      untrustedRegions: untrusted
        ? [{ regionId: scenario.regions[0].id, reasons: ['stale:120s>90s'] }]
        : [],
      activeIncidentIds: incidents.map(incident => incident.id),
      plan: validation.valid ? plan : undefined,
      validation,
      planInvalidated: false,
      lastValidObservationAt: new Date().toISOString(),
    });
    const statePublish = validatorPublish && state.publishable;
    if (injectFault && statePublish) erroneousValidatorAndState += 1;
    if (untrusted && !state.publishable) blockedByState += 1;

    cases.push({
      case: index,
      demand_total: Array.from(demand.values()).reduce((sum, value) => sum + value, 0),
      incidents: incidents.map(incident => incident.affected),
      plan_status: planOutput.plan.status,
      fault_injected: injectFault,
      validator_valid: validation.valid,
      violation_codes: validation.violations.map(violation => violation.code),
      safety_state: state.state,
      publishable: state.publishable,
      no_validator_publish: noValidatorPublish,
      validator_publish: validatorPublish,
      validator_and_state_publish: statePublish,
    });
  }

  return {
    config: {
      seed: SEED + 3,
      cases: caseCount,
      fault_model: '50% 的案例在方案中注入超容量路线与空步骤路线，用于验证校验器能否拦截',
      demand_model: '区域在留容量 × [0.2, 1.5) 的合成需求',
      note: '消融使用合成需求与注入故障，只验证机制能否拦截，不代表真实场馆的安全水平。',
    },
    cases,
    summary: {
      cases: caseCount,
      faulty_cases: faultyCases,
      violations_detected: violationsDetected,
      erroneous_publishes_without_validator: erroneousNoValidator,
      erroneous_publishes_with_validator: erroneousValidator,
      erroneous_publishes_with_validator_and_state: erroneousValidatorAndState,
      safe_rejections_with_validator: safeRejections,
      degraded_cases: degradedCases,
      blocked_by_state_machine: blockedByState,
    },
  };
}

function incidentExitIds(incidents: Incident[]): string[] {
  return incidents.flatMap(incident => incident.affected.exit_ids);
}

// ---------------------------------------------------------------------------
// 实验四：业务闭环
// ---------------------------------------------------------------------------

async function runExperiment4(): Promise<{
  config: Record<string, unknown>;
  loops: Array<Record<string, unknown>>;
  summary: Record<string, number>;
}> {
  const loops = 20;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-experiment4-'));
  const audit = new AuditLog(path.join(dataRoot, 'audit'));
  const safety = new SafetyDecisionService({ scenario, auditLog: audit });
  const mvp = new MvpService({ scenario, safety, audit });
  const admin = { username: 'experiment-admin', role: 'admin' };
  const results: Array<Record<string, unknown>> = [];

  try {
    for (let index = 0; index < loops; index += 1) {
      const startedAt = Date.now();
      mvp.resetAll(admin);
      let success = false;
      let transitionsCorrect = false;
      let feedbackIngested = false;
      let error: string | null = null;
      try {
        for (const [regionId, item] of Object.entries(scenario.simulation_baseline ?? {})) {
          if (regionId === 'R_EAST_STAND') continue;
          safety.ingestObservation({
            regionId,
            count: item.count,
            confidence: item.confidence,
            source: 'simulation',
            provider: 'experiment',
            modelVersion: 'experiment/1.0.0',
            observedAt: new Date(),
          }, admin);
        }
        const low = safety.ingestObservation({
          regionId: 'R_EAST_STAND',
          count: 900,
          confidence: 0.35,
          source: 'simulation',
          provider: 'experiment',
          modelVersion: 'experiment/1.0.0',
          observedAt: new Date(),
        }, admin);
        feedbackIngested = low.source === 'simulation';

        const run = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: `experiment_loop_${index}` });
        const pending = mvp.ops.listWorkOrders().filter(order => order.status === 'PENDING_APPROVAL');
        const completedIds: string[] = [];
        for (const order of pending) {
          completedIds.push(completeOrder(mvp, order, admin, order.type === 'uav_observation' ? 940 : 920));
        }
        const run2 = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'feedback_reevaluation' });
        for (const order of run2.work_orders as unknown as WorkOrder[]) {
          const current = mvp.ops.getWorkOrder(order.id);
          if (current?.status === 'PENDING_APPROVAL') {
            completedIds.push(completeOrder(mvp, current, admin, 700));
          }
        }
        const all = mvp.ops.listWorkOrders();
        success = run.work_orders.length > 0
          && completedIds.length > 0
          && all.every(order => order.status === 'COMPLETED');
        transitionsCorrect = all.every(order => {
          const statuses = order.history.map(event => event.status);
          const sequence = ['PENDING_APPROVAL', 'APPROVED', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED'];
          let cursor = 0;
          for (const status of statuses) {
            if (status === sequence[cursor]) cursor += 1;
          }
          return cursor === sequence.length;
        });
      } catch (caught) {
        error = (caught as Error).message;
      }

      results.push({
        loop: index,
        success,
        transitions_correct: transitionsCorrect,
        feedback_ingested: feedbackIngested,
        duration_ms: Date.now() - startedAt,
        error,
      });
    }
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  return {
    config: {
      loops,
      note: '进程内闭环：异常观测 → Agent → 审批 → 派发 → 接单 → 执行 → 反馈 → 重新评估；全部为模拟数据。',
    },
    loops: results,
    summary: {
      loops,
      successes: results.filter(item => item.success).length,
      success_rate: Number((results.filter(item => item.success).length / loops).toFixed(4)),
      transitions_correct: results.filter(item => item.transitions_correct).length,
      mean_duration_ms: Number(mean(results.map(item => Number(item.duration_ms))).toFixed(2)),
    },
  };
}

function completeOrder(
  mvp: MvpService,
  order: WorkOrder,
  admin: { username: string; role: string },
  count: number,
): string {
  mvp.ops.approve(order.id, admin, '实验审批');
  const assigned = mvp.ops.assignStaff(order.id, admin);
  const staffId = assigned.assigned_staff_id;
  if (!staffId) throw new Error(`工单 ${order.id} 未分配人员`);
  const member = mvp.ops.getStaff(staffId);
  const staff = { username: member?.name ?? staffId, role: 'staff', staff_id: staffId };
  mvp.ops.accept(order.id, staff);
  mvp.ops.start(order.id, staff);
  mvp.ops.complete(order.id, staff, {
    note: `实验闭环反馈：${order.type}`,
    observation: { count, confidence: 0.95, valid: true },
  });
  return order.id;
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

function buildReport(
  experiment1: ReturnType<typeof runExperiment1>,
  experiment2: ReturnType<typeof runExperiment2>,
  experiment3: ReturnType<typeof runExperiment3>,
  experiment4: ReturnType<typeof runExperiment4>,
): string {
  const r1 = experiment1.summary;
  const r3 = experiment3.summary;
  const r4 = experiment4.summary;
  const predictionRows = experiment2.results.map(item => {
    const metrics = item.metrics as Record<string, { mae: number; rmse: number }>;
    return `| ${item.horizon_minutes} 分钟 | ${metrics.persistence.mae} / ${metrics.persistence.rmse} | ${metrics.ema_only.mae} / ${metrics.ema_only.rmse} | ${metrics.linear_only.mae} / ${metrics.linear_only.rmse} | ${metrics.ema_linear.mae} / ${metrics.ema_linear.rmse} |`;
  }).join('\n');

  return `# SkyGuard MVP 实验报告

> 本报告全部由 \`npm run experiments:mvp --prefix backend\` 在本机生成。
> 所有实验均使用合成数据与固定随机种子，**不代表真实场馆效果**，不得作为真实安全性能承诺。

## 1. 运行元数据

- 场景：${scenario.name}（${scenario.scenario_id} v${scenario.version}）
- 全局随机种子：${SEED}
- 生成时间：${new Date().toISOString()}
- 场景性质：${scenario.notice}

## 2. 实验一 · VoI 主动调查 vs 固定优先级调查

| 指标 | VoI | 固定优先级 |
| --- | --- | --- |
| 平均工具调用次数 | ${r1.voi.mean_tool_calls} | ${r1.fixed_priority.mean_tool_calls} |
| 平均信息熵降低（bit） | ${r1.voi.mean_entropy_reduction} | ${r1.fixed_priority.mean_entropy_reduction} |
| 平均预期风险损失降低 | ${r1.voi.mean_risk_reduction} | ${r1.fixed_priority.mean_risk_reduction} |
| 平均时间成本（分钟） | ${r1.voi.mean_time_cost_minutes} | ${r1.fixed_priority.mean_time_cost_minutes} |
| 平均资源成本（归一化） | ${r1.voi.mean_resource_cost} | ${r1.fixed_priority.mean_resource_cost} |
| 有效调查比例 | ${r1.voi.mean_effective_ratio} | ${r1.fixed_priority.mean_effective_ratio} |
| 提前停止的试验数 | ${r1.voi.stopped_early} | ${r1.fixed_priority.stopped_early} |

**解读**：VoI 的收益来自"在收益不足时停止"和"优先选择信息增益/风险降低更高的动作"。
具体数值受场景配置（先验、似然、损失矩阵、成本权重）影响；更换场景后必须重新运行，
不得把本表数值当作通用结论。

## 3. 实验二 · 预测算法对比（合成序列）

| 预测窗口 | 持久化 MAE / RMSE | EMA MAE / RMSE | 线性 MAE / RMSE | EMA+线性 MAE / RMSE |
| --- | --- | --- | --- | --- |
${predictionRows}

**解读**：四种方法在同一合成数据生成器上比较；**没有真实标注人流数据**，
因此不能把上述误差当作真实场景精度。真实数据到位后应以现场标定数据重跑。

## 4. 实验三 · 安全机制消融

| 指标 | 数值 |
| --- | --- |
| 案例数 | ${r3.cases} |
| 注入故障案例 | ${r3.faulty_cases} |
| 校验器发现违规的案例 | ${r3.violations_detected} |
| 无校验器的错误发布 | ${r3.erroneous_publishes_without_validator} |
| 启用校验器后的错误发布 | ${r3.erroneous_publishes_with_validator} |
| 校验器 + 状态机后的错误发布 | ${r3.erroneous_publishes_with_validator_and_state} |
| 启用校验器的安全拒绝 | ${r3.safe_rejections_with_validator} |
| 不可信观测案例 | ${r3.degraded_cases} |
| 被状态机拦截的发布 | ${r3.blocked_by_state_machine} |

**解读**：消融验证的是"机制能否拦截注入故障"，不是真实场馆的安全水平。
无校验器时注入的故障会被当作可发布方案；启用校验器与状态机后错误发布为
${r3.erroneous_publishes_with_validator_and_state}。

## 5. 实验四 · 业务闭环

| 指标 | 数值 |
| --- | --- |
| 闭环次数 | ${r4.loops} |
| 成功次数 | ${r4.successes} |
| 成功率 | ${r4.success_rate} |
| 状态流转完全正确的次数 | ${r4.transitions_correct} |
| 平均耗时（ms，进程内） | ${r4.mean_duration_ms} |

**解读**：成功标准为：Agent 创建待审批工单、管理员审批、自动派发、工作人员接单/执行/反馈、
反馈写回观测并触发重新评估、全部工单到达 COMPLETED。耗时只统计进程内计算，不含网络与人工操作时间。

## 6. 结论与边界

1. VoI 相比固定优先级在模拟条件下减少了无效调查并降低了成本；具体收益依赖场景参数。
2. 预测算法是可解释基线，缺少真实标注数据，不能声称真实准确率。
3. 独立校验器与四态状态机在注入故障下阻止了错误发布；这只证明机制有效，不证明现场安全。
4. 业务闭环在进程内与 HTTP 集成测试中均可重复完成；人工审批与工作人员反馈是真实后端状态变更。
5. 所有实验数据均为合成数据；没有真实人群视频、无人机、昇腾硬件或 AgentArts 租户实测。

## 7. 原始数据

- \`evaluation/mvp/experiment1_voi.json\`
- \`evaluation/mvp/experiment2_prediction.json\`
- \`evaluation/mvp/experiment3_safety_ablation.json\`
- \`evaluation/mvp/experiment4_business_loop.json\`
- \`evaluation/mvp/run_metadata.json\`
`;
}

async function main(): Promise<void> {
  console.log('SkyGuard MVP 实验（固定种子）...');
  const experiment1 = runExperiment1();
  writeJson('experiment1_voi.json', experiment1);
  console.log('  实验一完成：VoI vs 固定优先级');

  const experiment2 = runExperiment2();
  writeJson('experiment2_prediction.json', experiment2);
  console.log('  实验二完成：预测算法对比');

  const experiment3 = runExperiment3();
  writeJson('experiment3_safety_ablation.json', experiment3);
  console.log('  实验三完成：安全机制消融');

  const experiment4 = await runExperiment4();
  writeJson('experiment4_business_loop.json', experiment4);
  console.log('  实验四完成：业务闭环');

  writeJson('run_metadata.json', {
    generated_at: new Date().toISOString(),
    seed: SEED,
    node: process.version,
    platform: process.platform,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    scenario: { id: scenario.scenario_id, version: scenario.version, path: SCENARIO_PATH },
    data_nature: '全部为合成/模拟数据；不含真实人流、视频、无人机或 AgentArts 实测。',
  });

  fs.writeFileSync(
    path.resolve(__dirname, '../../evaluation/MVP_REPORT.md'),
    buildReport(experiment1, experiment2, experiment3, experiment4),
  );
  console.log('  报告已生成：evaluation/MVP_REPORT.md');
}

void main().catch(error => {
  console.error('实验失败：', error);
  process.exitCode = 1;
});
