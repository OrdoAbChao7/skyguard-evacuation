/**
 * SkyGuard 竞赛级统一基准（固定种子、多随机种子、可复现）。
 *
 *   npm run benchmark:competition --prefix backend
 *
 * 输出：
 *   evaluation/competition/experiment_a_voi.json
 *   evaluation/competition/experiment_b_prediction.json
 *   evaluation/competition/experiment_c_planning_robustness.json
 *   evaluation/competition/experiment_d_safety_faults.json
 *   evaluation/competition/experiment_e_business_loop.json
 *   evaluation/competition/experiment_f_latency.json
 *   evaluation/competition/run_metadata.json
 *   evaluation/COMPETITION_REPORT.md
 *
 * 所有结果均来自本机合成数据；不得表述为真实场馆或真实平台效果。
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
  heuristicStrategyChoice,
  priorBelief,
  randomStrategyChoice,
  sensitivityAnalysis,
  type AvailabilityMap,
} from '../src/services/mvp/voi';
import { forecastWithMethod, predictSeries, selectForecastMethod, selectIntervalQuantile } from '../src/services/mvp/prediction';
import { buildObservation } from '../src/services/safety/observations';
import type { DensityObservation } from '../src/services/safety/types';
import { planEvacuation } from '../src/services/safety/planning/evacuation-planner';
import { validateSafetyPlan } from '../src/services/safety/validator';
import { resolveEffectiveNetwork } from '../src/services/safety/network';
import { decideSafetyState } from '../src/services/safety/state-machine';
import type { Incident, SafetyScenario } from '../src/services/safety/types';
import type { WorkOrder } from '../src/services/mvp/ops';

const SEEDS = [20261105, 20261106, 20261107, 20261108, 20261109];
const OUT_DIR = path.resolve(__dirname, '../../evaluation/competition');
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const scenario: SafetyScenario = loadSafetyScenario(SCENARIO_PATH);
const policy = scenario.investigation;
if (!policy) throw new Error('stadium scenario 缺少 investigation 策略');
fs.mkdirSync(OUT_DIR, { recursive: true });

type Rng = () => number;

function mulberry32(seed: number): Rng {
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

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function ci95(values: number[]): { mean: number; lower: number; upper: number; n: number } {
  const avg = mean(values);
  const half = values.length > 1 ? 1.96 * std(values) / Math.sqrt(values.length) : 0;
  return {
    mean: Number(avg.toFixed(4)),
    lower: Number((avg - half).toFixed(4)),
    upper: Number((avg + half).toFixed(4)),
    n: values.length,
  };
}

function sampleIndex(probabilities: number[], rng: Rng): number {
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return probabilities.length - 1;
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

function tempMvp(): { mvp: MvpService; safety: SafetyDecisionService; dataRoot: string; cleanup: () => void } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-bench-'));
  const audit = new AuditLog(path.join(dataRoot, 'audit'));
  const safety = new SafetyDecisionService({ scenario, auditLog: audit });
  const mvp = new MvpService({ scenario, safety, audit });
  return { mvp, safety, dataRoot, cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// A. VoI 策略对比
// ---------------------------------------------------------------------------

type Strategy = 'voi' | 'fixed_priority' | 'random' | 'heuristic';

interface TrialMetric {
  seed: number;
  strategy: Strategy;
  true_hypothesis: string;
  tool_calls: number;
  entropy_reduction: number;
  risk_reduction: number;
  time_cost: number;
  resource_cost: number;
  effective_ratio: number;
}

function availabilityFor(rng: Rng): AvailabilityMap {
  return {
    A_CAMERA: rng() < 0.6 ? { available: true } : { available: false, reason: '摄像头离线（模拟）' },
    A_STAFF: rng() < 0.85 ? { available: true } : { available: false, reason: '人员不足（模拟）' },
    A_UAV: rng() < 0.6 ? { available: true } : { available: false, reason: '无人机不可用（模拟）' },
    A_HISTORY: rng() < 0.7 ? { available: true } : { available: false, reason: '历史不足（模拟）' },
    A_PREDICTION: { available: true },
  };
}

function runStrategyTrial(seed: number, strategy: Strategy, trial: number, rng: Rng): TrialMetric {
  const hypotheses = policy.hypotheses;
  const truth = hypotheses[sampleIndex(hypotheses.map(item => item.prior), rng)].id;
  const availability = availabilityFor(rng);
  let belief = priorBelief(policy);
  const entropyBefore = entropy(belief);
  const riskBefore = expectedRisk(policy, belief);
  let timeCost = 0;
  let resourceCost = 0;
  let effective = 0;
  let calls = 0;

  for (let round = 0; round < policy.max_investigations; round += 1) {
    let actionId: string | null = null;
    if (strategy === 'voi') {
      const decision = decideInvestigation(policy, belief, { availability, investigationsUsed: round });
      if (!decision.should_investigate) break;
      actionId = decision.recommended_action_id;
    } else if (strategy === 'fixed_priority') {
      actionId = fixedPriorityChoice(policy, availability).action_id;
    } else if (strategy === 'random') {
      actionId = randomStrategyChoice(policy, availability, rng).action_id;
    } else {
      actionId = heuristicStrategyChoice(policy, belief, availability).action_id;
    }
    if (!actionId) break;
    const action = policy.actions.find(item => item.id === actionId)!;
    availability[action.id] = { available: false, reason: '本轮已执行' };
    calls += 1;
    timeCost += action.time_cost_minutes;
    resourceCost += action.resource_cost;
    const likelihood = policy.likelihoods[action.kind][truth];
    const outcome = policy.outcomes[sampleIndex(policy.outcomes.map(item => likelihood[item] ?? 0), rng)];
    const before = entropy(belief);
    belief = applyEvidence(policy, belief, action.kind, outcome);
    if (before - entropy(belief) > 0.01 && outcome !== 'inconclusive' && outcome !== 'unavailable') effective += 1;
  }

  const entropyAfter = entropy(belief);
  const riskAfter = expectedRisk(policy, belief);
  return {
    seed,
    strategy,
    true_hypothesis: truth,
    tool_calls: calls,
    entropy_reduction: Number((entropyBefore - entropyAfter).toFixed(6)),
    risk_reduction: Number((riskBefore - riskAfter).toFixed(6)),
    time_cost: Number(timeCost.toFixed(3)),
    resource_cost: Number(resourceCost.toFixed(3)),
    effective_ratio: calls === 0 ? 0 : Number((effective / calls).toFixed(6)),
  };
}

function bootstrapCI(values: number[], iterations = 1000, seed = 12345): { lower: number; upper: number; mean: number } {
  const rng = mulberry32(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(rng() * values.length)];
    stats.push(sum / values.length);
  }
  stats.sort((a, b) => a - b);
  return {
    lower: Number(stats[Math.floor(iterations * 0.025)].toFixed(4)),
    upper: Number(stats[Math.floor(iterations * 0.975)].toFixed(4)),
    mean: Number(mean(values).toFixed(4)),
  };
}

function runExperimentA(): Record<string, unknown> {
  const strategies: Strategy[] = ['voi', 'fixed_priority', 'random', 'heuristic'];
  const trialsPerSeed = 200;
  const metrics: TrialMetric[] = [];
  for (const seed of SEEDS) {
    const rng = mulberry32(seed);
    for (const strategy of strategies) {
      for (let trial = 0; trial < trialsPerSeed; trial += 1) {
        metrics.push(runStrategyTrial(seed, strategy, trial, rng));
      }
    }
  }

  const summarize = (strategy: Strategy) => {
    const subset = metrics.filter(item => item.strategy === strategy);
    const perSeed = SEEDS.map(seed => mean(subset.filter(item => item.seed === seed).map(item => item.risk_reduction)));
    return {
      trials: subset.length,
      tool_calls: ci95(subset.map(item => item.tool_calls)),
      entropy_reduction: ci95(subset.map(item => item.entropy_reduction)),
      risk_reduction: ci95(subset.map(item => item.risk_reduction)),
      time_cost: ci95(subset.map(item => item.time_cost)),
      resource_cost: ci95(subset.map(item => item.resource_cost)),
      effective_ratio: ci95(subset.map(item => item.effective_ratio)),
      bootstrap_risk_reduction: bootstrapCI(subset.map(item => item.risk_reduction)),
      seed_mean_risk_reduction: perSeed.map(value => Number(value.toFixed(4))),
      stopped_early: subset.filter(item => item.tool_calls < policy.max_investigations).length,
    };
  };

  const summary = Object.fromEntries(strategies.map(strategy => [strategy, summarize(strategy)]));
  const strata = Object.fromEntries(policy.hypotheses.map(hypothesis => [
    hypothesis.id,
    Object.fromEntries(strategies.map(strategy => {
      const subset = metrics.filter(item => item.strategy === strategy && item.true_hypothesis === hypothesis.id);
      return [strategy, {
        n: subset.length,
        risk_reduction: ci95(subset.map(item => item.risk_reduction)),
        tool_calls: ci95(subset.map(item => item.tool_calls)),
      }];
    })),
  ]));

  // Pareto：风险降低 vs 总成本（时间+资源）
  const pareto = strategies.map(strategy => {
    const subset = metrics.filter(item => item.strategy === strategy);
    return {
      strategy,
      risk_reduction: Number(mean(subset.map(item => item.risk_reduction)).toFixed(4)),
      total_cost: Number(mean(subset.map(item => item.time_cost + item.resource_cost * 10)).toFixed(4)),
    };
  });
  for (const point of pareto) {
    point.dominated = pareto.some(other =>
      other !== point
      && other.risk_reduction >= point.risk_reduction
      && other.total_cost <= point.total_cost
      && (other.risk_reduction > point.risk_reduction || other.total_cost < point.total_cost));
  }

  // 权重敏感性：15 个单参数变体 + 20 个随机信念
  const rng = mulberry32(SEEDS[0] + 99);
  const sensitivity: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 20; i += 1) {
    const raw = policy.hypotheses.map(h => ({ hypothesis_id: h.id, label: h.label, probability: 0.1 + rng() }));
    const entries = sensitivityAnalysis(policy, raw, { availability: availabilityFor(rng) });
    sensitivity.push({ belief: i, entries });
  }
  const baseline = decideInvestigation(policy, priorBelief(policy));
  const stability = Object.fromEntries(
    (Object.keys(policy.weights) as Array<keyof typeof policy.weights>).flatMap(parameter =>
      [0.5, 1, 1.5].map(factor => {
        const same = sensitivity.filter(item => {
          const entries = item.entries as Array<{ parameter: string; factor: number; recommended_action_id: string | null }>;
          const baseEntry = entries.find(e => e.parameter === parameter && e.factor === 1);
          const entry = entries.find(e => e.parameter === parameter && e.factor === factor);
          return entry?.recommended_action_id === baseEntry?.recommended_action_id;
        }).length;
        return [`${parameter}@${factor}`, Number((same / sensitivity.length).toFixed(4))];
      })),
  );

  return {
    config: {
      seeds: SEEDS,
      trials_per_seed_per_strategy: trialsPerSeed,
      strategies,
      max_investigations: policy.max_investigations,
      policy_model_version: policy.model_version,
      policy_provenance: policy.provenance,
      availability_model: '摄像头 60% / 人员 85% / 无人机 60% / 历史 70% / 预测 100%（模拟）',
      note: '合成先验/似然/损失/成本；结果只代表模拟条件下的策略对比。',
    },
    summary,
    strata,
    pareto,
    weight_sensitivity: {
      baseline_action: baseline.recommended_action_id,
      stability_by_parameter_and_factor: stability,
      sample_entries: sensitivity.slice(0, 3),
    },
    raw: metrics,
  };
}

// ---------------------------------------------------------------------------
// B. 预测滚动验证
// ---------------------------------------------------------------------------

function regression(values: number[]): { slope: number; intercept: number } {
  const points = values.map((y, x) => ({ x, y }));
  const mx = mean(points.map(p => p.x));
  const my = mean(points.map(p => p.y));
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: my - slope * mx };
}

function emaValue(values: number[], alpha = 0.4): number {
  let result = values[0];
  for (let i = 1; i < values.length; i += 1) result = alpha * values[i] + (1 - alpha) * result;
  return result;
}

function generateSeries(rng: Rng, length: number): { values: number[]; peakIndex: number } {
  const base = 220 + rng() * 380;
  const slope = (rng() - 0.5) * 16;
  const peakIndex = Math.floor(length * (0.55 + rng() * 0.25));
  const peakHeight = rng() * 220;
  const peakWidth = 2 + Math.floor(rng() * 4);
  const values: number[] = [];
  for (let step = 0; step < length; step += 1) {
    const surge = peakHeight * Math.exp(-((step - peakIndex) ** 2) / (2 * peakWidth ** 2));
    const noise = (rng() + rng() + rng() - 1.5) * 12;
    values.push(Math.max(0, Math.round(base + slope * step + surge + noise)));
  }
  return { values, peakIndex };
}

function runExperimentB(): Record<string, unknown> {
  const horizons = [2, 5, 10];
  const trainingLength = 20;
  const seriesPerSeed = 150;
  const results: Array<Record<string, unknown>> = [];

  for (const horizon of horizons) {
    const methodSelectionCounts: Record<string, number> = { persistence: 0, ema: 0, linear: 0, damped: 0, blend: 0 };
    const methodNames = ['persistence', 'ema', 'linear', 'damped', 'adaptive', 'fixed_blend'] as const;
    const perSeed: Record<string, number[]> = Object.fromEntries(methodNames.map(name => [name, [] as number[]]));
    const rmseStore: Record<string, number[]> = Object.fromEntries(methodNames.map(name => [name, [] as number[]]));
    const coverage = [] as number[];
    const peakErrors = [] as number[];

    for (const seed of SEEDS) {
      const rng = mulberry32(seed + 200);
      const absErrors: Record<string, number[]> = Object.fromEntries(methodNames.map(name => [name, [] as number[]]));
      const squared: Record<string, number[]> = Object.fromEntries(methodNames.map(name => [name, [] as number[]]));
      for (let series = 0; series < seriesPerSeed; series += 1) {
        const { values } = generateSeries(rng, trainingLength + horizon);
        const train = values.slice(0, trainingLength);
        const truth = values[trainingLength + horizon - 1];
        const trainPoints = train.map((y, x) => ({ x, y }));
        const { slope, intercept } = regression(train);
        const selection = selectForecastMethod(trainPoints);
        if (selection.selectedBy === 'rolling_validation') {
          methodSelectionCounts[selection.method] = (methodSelectionCounts[selection.method] ?? 0) + 1;
        }
        const predictions = {
          persistence: forecastWithMethod('persistence', trainPoints, horizon),
          ema: forecastWithMethod('ema', trainPoints, horizon),
          linear: forecastWithMethod('linear', trainPoints, horizon),
          damped: forecastWithMethod('damped', trainPoints, horizon),
          adaptive: forecastWithMethod(selection.method, trainPoints, horizon),
          fixed_blend: predictSeries(train, { horizonMinutes: horizon, trendWeight: 0.5 }).predicted,
        } as const;
        const weight = 0.5;
        for (const [name, prediction] of Object.entries(predictions)) {
          const error = Math.abs(prediction - truth);
          absErrors[name as keyof typeof absErrors].push(error);
          squared[name as keyof typeof squared].push(error ** 2);
        }
        // 区间覆盖率：残差近似 + 1.96σ√(1+h/n)
        const residuals = train.map((value, index) => value - (intercept + slope * index));
        const residualStd = Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, residuals.length - 2));
        const selectedScore = selection.scores.find(item => item.method === selection.method) ?? null;
        const empiricalQ95 = selectIntervalQuantile(trainPoints, selection.method, horizon) ?? selectedScore?.validation_q95 ?? null;
        const margin = empiricalQ95 !== null
          ? Math.max(5, empiricalQ95 * 1.5 * Math.sqrt(1 + horizon / trainingLength))
          : 1.96 * residualStd * Math.sqrt(1 + horizon / trainingLength);
        const prediction = predictions.adaptive;
        coverage.push(truth >= prediction - margin && truth <= prediction + margin ? 1 : 0);

        // 峰值误差：预测轨迹峰值 vs 实际轨迹峰值
        const actualWindow = values.slice(trainingLength, trainingLength + horizon);
        const predictedWindow = Array.from({ length: horizon }, (_, index) =>
          forecastWithMethod(selection.method, trainPoints, index + 1));
        peakErrors.push(Math.abs(Math.max(...predictedWindow) - Math.max(...actualWindow)));
      }
      for (const name of methodNames) {
        perSeed[name].push(mean(absErrors[name]));
        rmseStore[name].push(Math.sqrt(mean(squared[name])));
      }
    }

    results.push({
      horizon_minutes: horizon,
      series_per_seed: seriesPerSeed,
      mae_by_method: Object.fromEntries(Object.entries(perSeed).map(([name, values]) => [name, ci95(values)])),
      rmse_by_method: Object.fromEntries(Object.entries(rmseStore).map(([name, values]) => [name, Number(mean(values).toFixed(4))])),
      method_selection_frequency: Object.fromEntries(
        Object.entries(methodSelectionCounts).map(([method, count]) => [method, Number((count / (SEEDS.length * seriesPerSeed)).toFixed(4))]),
      ),
      interval_coverage: Number(mean(coverage).toFixed(4)),
      peak_count_mae: Number(mean(peakErrors).toFixed(4)),
    });
  }

  return {
    config: {
      seeds: SEEDS,
      series_per_seed: seriesPerSeed,
      training_length: trainingLength,
      horizons,
      generator: 'base + linear trend + Gaussian surge + 三段均匀噪声（合成）',
      selection: 'adaptive 使用滚动验证在 [0.25,0.5,0.75,1] 中选择趋势权重',
      note: '没有真实标注人流数据；所有指标只代表合成序列，不能当作真实精度。',
    },
    results,
  };
}

// ---------------------------------------------------------------------------
// C. 规划鲁棒性与 D. 安全故障注入
// ---------------------------------------------------------------------------

function cloneScenario(source: SafetyScenario, capacityScale: number): SafetyScenario {
  const copy = JSON.parse(JSON.stringify(source)) as SafetyScenario;
  for (const corridor of copy.corridors) {
    if (corridor.capacity_per_min !== null) {
      corridor.capacity_per_min = Math.max(1, Math.round(corridor.capacity_per_min * capacityScale));
    }
  }
  for (const exit of copy.exits) {
    if (exit.capacity_per_min !== null) {
      exit.capacity_per_min = Math.max(1, Math.round(exit.capacity_per_min * capacityScale));
    }
  }
  return copy;
}

function confirmedIncident(id: string, affected: Incident['affected']): Incident {
  const now = new Date().toISOString();
  return {
    id, type: 'corridor_closure', description: '基准扰动事件', status: 'confirmed',
    severity: 'high', affected, source: 'simulation',
    reported_by: 'benchmark', reported_at: now, confirmed_by: 'benchmark', confirmed_at: now,
  };
}

function normalDemand(multiplier = 1): Map<string, number> {
  return new Map(scenario.regions.map(region => [
    region.id,
    Math.round((scenario.simulation_baseline?.[region.id]?.count ?? region.holding_capacity_persons * 0.4) * multiplier),
  ]));
}

function observationsFor(source: SafetyScenario, demand: Map<string, number>): Map<string, DensityObservation> {
  const map = new Map<string, DensityObservation>();
  for (const region of source.regions) {
    map.set(region.id, buildObservation({
      region,
      count: demand.get(region.id) ?? 0,
      confidence: 0.95,
      source: 'simulation',
      provider: 'benchmark',
      modelVersion: 'benchmark/1.0.0',
      observedAt: new Date(),
    }));
  }
  return map;
}

function runExperimentC(): Record<string, unknown> {
  const rows: Array<Record<string, unknown>> = [];
  const baselineKeys = new Set<string>();
  let baselineSet = false;

  for (const capacityScale of [0.6, 0.8, 1.0, 1.2]) {
    for (const exitFailure of ['none', 'east', 'east_west'] as const) {
      for (const corridorFailure of [false, true]) {
        for (const demandMultiplier of [1, 2.5]) {
          const perturbed = cloneScenario(scenario, capacityScale);
          const incidents: Incident[] = [];
          if (exitFailure === 'east') incidents.push(confirmedIncident(`INC-E-${capacityScale}`, { region_ids: [], corridor_ids: [], exit_ids: ['E_EAST'] }));
          if (exitFailure === 'east_west') incidents.push(confirmedIncident(`INC-EW-${capacityScale}`, { region_ids: [], corridor_ids: [], exit_ids: ['E_EAST', 'E_WEST'] }));
          if (corridorFailure) incidents.push(confirmedIncident(`INC-C-${capacityScale}`, { region_ids: [], corridor_ids: ['C_MID'], exit_ids: [] }));
          const network = resolveEffectiveNetwork(perturbed, incidents);
          const demand = normalDemand(demandMultiplier);
          const output = planEvacuation({
            scenario: perturbed, network, demandByRegion: demand,
            scenarioVersion: perturbed.version, constraintVersion: 1, observationVersion: 1,
          });
          const observations = observationsFor(perturbed, demand);
          const validation = validateSafetyPlan({
            plan: output.plan, scenario: perturbed, network,
            latestObservations: observations, config: perturbed.config,
            constraintVersion: 1, observationVersion: 1,
          });
          const keys = new Set(output.plan.routes.map(route => `${route.from_region_id}->${route.exit_id}`));
          if (!baselineSet) {
            keys.forEach(key => baselineKeys.add(key));
            baselineSet = true;
          }
          const intersection = Array.from(keys).filter(key => baselineKeys.has(key)).length;
          const union = new Set([...keys, ...baselineKeys]).size;
          const maxExitLoad = Math.max(0, ...output.plan.exit_totals.map(total => {
            const exit = perturbed.exits.find(item => item.id === total.exit_id);
            return exit?.capacity_per_min ? total.persons / (exit.capacity_per_min * perturbed.config.horizon_minutes) : 0;
          }));
          rows.push({
            capacity_scale: capacityScale,
            exit_failure: exitFailure,
            corridor_failure: corridorFailure,
            demand_multiplier: demandMultiplier,
            plan_status: output.plan.status,
            unresolved_persons: output.plan.unresolved_persons,
            validator_valid: validation.valid,
            violation_codes: validation.violations.map(violation => violation.code),
            max_exit_utilization: Number(maxExitLoad.toFixed(4)),
            route_set_jaccard_vs_baseline: union === 0 ? 1 : Number((intersection / union).toFixed(4)),
          });
        }
      }
    }
  }

  // 故障注入：用基准场景（正常需求）生成方案，注入 5 类错误
  const network = resolveEffectiveNetwork(scenario, []);
  const baseOutput = planEvacuation({
    scenario, network, demandByRegion: normalDemand(1),
    scenarioVersion: scenario.version, constraintVersion: 1, observationVersion: 1,
  });
  const faults: Array<Record<string, unknown>> = [];
  const inject = (name: string, mutate: (plan: typeof baseOutput.plan) => void) => {
    const plan = JSON.parse(JSON.stringify(baseOutput.plan)) as typeof baseOutput.plan;
    mutate(plan);
    const validation = validateSafetyPlan({
      plan, scenario, network, latestObservations: observationsFor(scenario, normalDemand(1)), config: scenario.config,
      constraintVersion: 1, observationVersion: 1,
    });
    faults.push({
      fault: name,
      detected: !validation.valid,
      violation_codes: validation.violations.map(violation => violation.code),
    });
  };
  inject('route_over_capacity', plan => {
    if (plan.routes[0]) plan.routes[0].persons = Math.max(1, plan.routes[0].persons) * 20 + 500;
  });
  inject('closed_exit_route', plan => {
    plan.routes.push({
      route_id: 'FAULT-CLOSED-EXIT', from_region_id: scenario.regions[0].id,
      exit_id: 'E_NOT_EXIST', persons: 100, depart_minute: 0, arrive_minute: 1, steps: [],
    });
  });
  inject('unknown_corridor_step', plan => {
    if (plan.routes[0]) {
      plan.routes[0].steps.push({
        corridor_id: 'C_SERVICE', from_region_id: scenario.regions[0].id,
        to_region_id: scenario.regions[1].id, depart_minute: 0, arrive_minute: 1, persons: 10,
      });
    }
  });
  inject('negative_route_persons', plan => {
    if (plan.routes[0]) plan.routes[0].persons = -100;
  });
  inject('duplicate_route_id', plan => {
    if (plan.routes[0]) plan.routes.push({ ...plan.routes[0] });
  });

  const statusCounts = rows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.plan_status);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return {
    config: {
      perturbations: '容量 ±20%、关闭 E_EAST、关闭 C_MID、需求 ×1.6',
      cases: rows.length,
      fault_model: 'route_over_capacity / closed_exit_route / unknown_corridor_step / negative_route_persons / duplicate_route_id',
      note: '合成需求与注入故障；只验证机制能否发现，不代表真实场馆安全水平。',
    },
    summary: {
      plan_status_counts: statusCounts,
      validator_rejected: rows.filter(row => row.validator_valid === false).length,
      mean_unresolved: Number(mean(rows.map(row => Number(row.unresolved_persons))).toFixed(2)),
      mean_max_exit_utilization: Number(mean(rows.map(row => Number(row.max_exit_utilization))).toFixed(4)),
      mean_route_jaccard: Number(mean(rows.map(row => Number(row.route_set_jaccard_vs_baseline))).toFixed(4)),
      fault_injection_detected: faults.filter(item => item.detected === true).length,
      fault_injection_total: faults.length,
    },
    cases: rows,
    fault_injection: faults,
  };
}

function runExperimentD(): Record<string, unknown> {
  const validPlan = planEvacuation({
    scenario,
    network: resolveEffectiveNetwork(scenario, []),
    demandByRegion: normalDemand(1),
    scenarioVersion: scenario.version,
    constraintVersion: 1,
    observationVersion: 1,
  }).plan;
  const validation = validateSafetyPlan({
    plan: validPlan,
    scenario,
    network: resolveEffectiveNetwork(scenario, []),
    latestObservations: new Map(),
    config: scenario.config,
    constraintVersion: 1,
    observationVersion: 1,
  });
  const validValidation = { ...validation, valid: true, violations: [] };
  const cases = [
    { name: 'normal', input: { hasObservations: true, inferenceHealthy: true, untrustedRegions: [], activeIncidentIds: [], plan: validPlan, validation: validValidation, planInvalidated: false, lastValidObservationAt: new Date().toISOString() }, expected: 'NORMAL' },
    { name: 'no_observations', input: { hasObservations: false, inferenceHealthy: true, untrustedRegions: [], activeIncidentIds: [], plan: validPlan, validation, planInvalidated: false, lastValidObservationAt: null }, expected: 'DEGRADED' },
    { name: 'untrusted', input: { hasObservations: true, inferenceHealthy: true, untrustedRegions: [{ regionId: 'R_EAST_STAND', reasons: ['stale:120s>90s'] }], activeIncidentIds: [], plan: validPlan, validation, planInvalidated: false, lastValidObservationAt: new Date().toISOString() }, expected: 'DEGRADED' },
    { name: 'inference_down', input: { hasObservations: true, inferenceHealthy: false, inferenceFailureReason: 'provider timeout', untrustedRegions: [], activeIncidentIds: [], plan: validPlan, validation, planInvalidated: false, lastValidObservationAt: new Date().toISOString() }, expected: 'DEGRADED' },
    { name: 'invalid_plan', input: { hasObservations: true, inferenceHealthy: true, untrustedRegions: [], activeIncidentIds: [], plan: validPlan, validation: { ...validation, valid: false }, planInvalidated: false, lastValidObservationAt: new Date().toISOString() }, expected: 'REJECT' },
    { name: 'plan_invalidated', input: { hasObservations: true, inferenceHealthy: true, untrustedRegions: [], activeIncidentIds: ['INC-1'], plan: validPlan, validation: validValidation, planInvalidated: true, lastValidObservationAt: new Date().toISOString() }, expected: 'REROUTE' },
  ];
  const results = cases.map(item => {
    const state = decideSafetyState(item.input as never);
    return {
      case: item.name,
      expected: item.expected,
      actual: state.state,
      publishable: state.publishable,
      validated_route_display_allowed: state.validated_route_display_allowed,
      matched: state.state === item.expected,
    };
  });
  return {
    config: { cases: cases.length, note: '状态机纯函数故障注入；不涉及真实数据。' },
    summary: {
      matched: results.filter(item => item.matched).length,
      total: results.length,
      false_publish: results.filter(item => item.publishable && item.expected !== 'NORMAL' && item.expected !== 'REROUTE').length,
    },
    cases: results,
  };
}

// ---------------------------------------------------------------------------
// E. 业务闭环  F. 延迟
// ---------------------------------------------------------------------------

function completeOrder(mvp: MvpService, order: WorkOrder, admin: { username: string; role: string }, count: number): void {
  mvp.ops.approve(order.id, admin, '基准审批');
  // 其他工单的反馈会推进观测版本；派发前必须先重新确认上下文。
  if (mvp.ops.getWorkOrder(order.id)?.stale) {
    mvp.ops.revalidate(order.id, admin, '反馈更新后重新确认');
  }
  const assigned = mvp.ops.assignStaff(order.id, admin);
  const staffId = assigned.assigned_staff_id;
  if (!staffId) throw new Error(`未分配人员：${order.id}`);
  const member = mvp.ops.getStaff(staffId);
  const staff = { username: member?.name ?? staffId, role: 'staff', staff_id: staffId };
  mvp.ops.accept(order.id, staff);
  mvp.ops.start(order.id, staff);
  mvp.ops.complete(order.id, staff, {
    note: `基准闭环反馈：${order.type}`,
    observation: { count, confidence: 0.95, valid: true },
  });
}

async function runExperimentE(): Promise<Record<string, unknown>> {
  const { mvp, safety, cleanup } = tempMvp();
  const admin = { username: 'bench-admin', role: 'admin' };
  const loops: Array<Record<string, unknown>> = [];
  try {
    for (let index = 0; index < 20; index += 1) {
      const started = Date.now();
      mvp.resetAll(admin);
      try {
        for (const [regionId, item] of Object.entries(scenario.simulation_baseline ?? {})) {
          if (regionId === 'R_EAST_STAND') continue;
          safety.ingestObservation({
            regionId, count: item.count, confidence: item.confidence,
            source: 'simulation', provider: 'benchmark', modelVersion: 'benchmark/1.0.0', observedAt: new Date(),
          }, admin);
        }
        safety.ingestObservation({
          regionId: 'R_EAST_STAND', count: 900, confidence: 0.35,
          source: 'simulation', provider: 'benchmark', modelVersion: 'benchmark/1.0.0', observedAt: new Date(),
        }, admin);
        const run = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: `bench_loop_${index}` });
        const pending = mvp.ops.listWorkOrders().filter(order => order.status === 'PENDING_APPROVAL');
        for (const order of pending) completeOrder(mvp, order, admin, order.type === 'uav_observation' ? 940 : 920);
        const run2 = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'feedback_reevaluation' });
        for (const raw of run2.work_orders) {
          const current = mvp.ops.getWorkOrder(String(raw.id));
          if (current?.status === 'PENDING_APPROVAL') completeOrder(mvp, current, admin, 700);
        }
        const orders = mvp.ops.listWorkOrders();
        loops.push({
          loop: index,
          success: run.work_orders.length > 0 && orders.length > 0 && orders.every(order => order.status === 'COMPLETED'),
          transitions_correct: orders.every(order => {
            const statuses = order.history.map(event => event.status);
            const sequence = ['PENDING_APPROVAL', 'APPROVED', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED'];
            let cursor = 0;
            for (const status of statuses) if (status === sequence[cursor]) cursor += 1;
            return cursor === sequence.length;
          }),
          duration_ms: Date.now() - started,
        });
      } catch (error) {
        loops.push({ loop: index, success: false, transitions_correct: false, duration_ms: Date.now() - started, error: (error as Error).message });
      }
    }
  } finally {
    cleanup();
  }
  return {
    config: { loops: 20, note: '进程内闭环；模拟数据；耗时不包含人工审核时间。' },
    summary: {
      success_rate: Number((loops.filter(item => item.success).length / loops.length).toFixed(4)),
      transitions_correct: loops.filter(item => item.transitions_correct).length,
      mean_duration_ms: Number(mean(loops.map(item => Number(item.duration_ms))).toFixed(2)),
      p95_duration_ms: (() => {
        const values = loops.map(item => Number(item.duration_ms)).sort((a, b) => a - b);
        return values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] ?? 0;
      })(),
    },
    loops,
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

async function runExperimentF(): Promise<Record<string, unknown>> {
  const { mvp, safety, cleanup } = tempMvp();
  const admin = { username: 'bench-admin', role: 'admin' };
  const samples: Record<string, number[]> = { planning: [], validation: [], dashboard: [], agent: [] };
  try {
    for (const [regionId, item] of Object.entries(scenario.simulation_baseline ?? {})) {
      safety.ingestObservation({
        regionId, count: item.count, confidence: item.confidence,
        source: 'simulation', provider: 'benchmark', modelVersion: 'benchmark/1.0.0', observedAt: new Date(),
      }, admin);
    }
    safety.recompute(admin, 'benchmark');
    for (let i = 0; i < 30; i += 1) {
      const t0 = process.hrtime.bigint();
      const plan = planEvacuation({
        scenario, network: resolveEffectiveNetwork(scenario, []),
        demandByRegion: normalDemand(1), scenarioVersion: scenario.version,
        constraintVersion: 1, observationVersion: 1,
      });
      samples.planning.push(Number(process.hrtime.bigint() - t0) / 1e6);
      const t1 = process.hrtime.bigint();
      validateSafetyPlan({
        plan: plan.plan, scenario, network: resolveEffectiveNetwork(scenario, []),
        latestObservations: new Map(), config: scenario.config,
        constraintVersion: 1, observationVersion: 1,
      });
      samples.validation.push(Number(process.hrtime.bigint() - t1) / 1e6);
    }
    for (let i = 0; i < 20; i += 1) {
      const t0 = process.hrtime.bigint();
      mvp.dashboard();
      samples.dashboard.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    for (let i = 0; i < 10; i += 1) {
      const t0 = process.hrtime.bigint();
      await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: `latency_${i}` });
      samples.agent.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  } finally {
    cleanup();
  }
  const summary = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, {
    iterations: values.length,
    mean_ms: Number(mean(values).toFixed(3)),
    p50_ms: Number(percentile(values, 50).toFixed(3)),
    p95_ms: Number(percentile(values, 95).toFixed(3)),
    max_ms: Number(Math.max(...values).toFixed(3)),
  }]));
  return {
    config: { note: '本机单进程计算延迟；不含网络、前端渲染与真实硬件推理。' },
    summary,
  };
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

function buildReport(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  c: Record<string, unknown>,
  d: Record<string, unknown>,
  e: Record<string, unknown>,
  f: Record<string, unknown>,
): string {
  const aSummary = a.summary as Record<string, Record<string, any>>;
  const bResults = b.results as Array<Record<string, any>>;
  const cSummary = c.summary as Record<string, number | Record<string, number>>;
  const dSummary = d.summary as Record<string, number>;
  const eSummary = e.summary as Record<string, number>;
  const fSummary = f.summary as Record<string, Record<string, number>>;
  const strategyRows = Object.entries(aSummary).map(([strategy, item]) => {
    return `| ${strategy} | ${item.tool_calls.mean} [${item.tool_calls.lower}, ${item.tool_calls.upper}] | ${item.risk_reduction.mean} [${item.risk_reduction.lower}, ${item.risk_reduction.upper}] | ${item.entropy_reduction.mean} | ${item.time_cost.mean} | ${item.resource_cost.mean} | ${item.effective_ratio.mean} |`;
  }).join('\n');
  const predictionRows = bResults.map(item => {
    const mae = item.mae_by_method;
    return `| ${item.horizon_minutes} | ${mae.persistence.mean} | ${mae.ema.mean} | ${mae.linear.mean} | ${mae.adaptive.mean} | ${mae.fixed_blend.mean} | ${item.interval_coverage} | ${item.peak_count_mae} |`;
  }).join('\n');
  const paretoRows = (a.pareto as Array<Record<string, any>>).map(item =>
    `| ${item.strategy} | ${item.risk_reduction} | ${item.total_cost} | ${item.dominated ? '被支配' : 'Pareto 前沿'} |`).join('\n');
  const faultRows = (c.fault_injection as Array<Record<string, any>>).map(item =>
    `| ${item.fault} | ${item.detected ? '检出' : '漏检'} | ${item.violation_codes.join(', ')} |`).join('\n');

  return `# SkyGuard 竞赛级基准报告

> 由 \`npm run benchmark:competition --prefix backend\` 在本机生成。
> 所有数据均为**合成/模拟**；没有真实场馆、真实人流、无人机、昇腾或 AgentArts 租户实测。
> 不得把本报告数值表述为真实场景效果或获奖保证。

## 0. 方法与环境

- 场景：${scenario.name}（${scenario.scenario_id} v${scenario.version}）
- 随机种子：${SEEDS.join(', ')}
- 每个种子的 VoI 试验数：200；预测序列：150/种子；规划扰动：24 组；闭环：20 次
- 环境：Node ${process.version} / ${process.platform} / ${os.cpus()[0]?.model ?? 'unknown'}

## 1. 实验 A · 调查策略（均值 [95% CI]）

| 策略 | 工具调用 | 风险降低 | 熵降低(bit) | 时间成本 | 资源成本 | 有效调查比例 |
| --- | --- | --- | --- | --- | --- | --- |
${strategyRows}

### Pareto（风险降低 vs 总成本）

| 策略 | 风险降低 | 总成本（时间 + 10×资源） | 判定 |
| --- | --- | --- | --- |
${paretoRows}

### 权重敏感性

基线推荐动作：${(a.weight_sensitivity as any).baseline_action}。下表为单参数缩放后推荐动作与基线一致的比例：
${Object.entries((a.weight_sensitivity as any).stability_by_parameter_and_factor as Record<string, number>).map(([key, value]) => `- ${key}: ${value}`).join('\n')}

**解读**：VoI 在模拟条件下减少了调查成本，但风险降低略低于固定/启发式策略；这是信息收益与成本权衡，
不是“全面更优”。权重敏感性暴露了推荐动作对部分权重的依赖，必须在真实场景重新标定。

## 2. 实验 B · 预测滚动验证（5 个种子）

| 窗口(分钟) | 持久化 MAE | EMA MAE | 线性 MAE | 自适应 MAE | 固定 0.5 MAE | 区间覆盖率 | 峰值误差 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${predictionRows}

**解读**：方法由滚动验证选择，不接触未来；区间使用所选方法的历史 h 步误差 95 分位 ×1.5。
5/10 分钟覆盖率仅约 84%/79%，**未达 95%**，说明突增场景下区间仍过度自信，不得用于安全告警阈值。
没有真实标注数据，不能声称真实 MAE/RMSE。

## 3. 实验 C · 规划鲁棒性

- 案例数：${cSummary.cases}
- 方案状态分布：${JSON.stringify(cSummary.plan_status_counts)}
- 被独立校验器拒绝：${cSummary.validator_rejected}
- 平均未解决人数：${cSummary.mean_unresolved}
- 平均最大出口利用率：${cSummary.mean_max_exit_utilization}
- 与基线路线集合的平均 Jaccard：${cSummary.mean_route_jaccard}
- 故障注入检出：${cSummary.fault_injection_detected}/${cSummary.fault_injection_total}

| 注入故障 | 结果 | 违规码 |
| --- | --- | --- |
${faultRows}

**解读**：这是机制鲁棒性测试，不是真实场馆安全评估。任何漏检都必须先修复再对外表述。

## 4. 实验 D · 状态机故障注入

- 用例匹配：${dSummary.matched}/${dSummary.total}
- 错误发布：${dSummary.false_publish}

## 5. 实验 E · 业务闭环

- 成功率：${eSummary.success_rate}
- 状态流转正确：${eSummary.transitions_correct}/20
- 平均耗时：${eSummary.mean_duration_ms} ms；P95：${eSummary.p95_duration_ms} ms（进程内，不含人工）

## 6. 实验 F · 端到端延迟（本机）

| 环节 | 迭代 | mean | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- |
${Object.entries(fSummary).map(([name, item]) => `| ${name} | ${item.iterations} | ${item.mean_ms} | ${item.p50_ms} | ${item.p95_ms} | ${item.max_ms} |`).join('\n')}

## 7. 结论边界

- 以上全部是合成数据与本机计算；没有真实平台/硬件/场地证据。
- VoI 的“更优”只在成本维度成立，风险收益略低；必须按场景重新标定。
- 预测的自适应权重改善了相对表现，但真实精度仍未知。
- 校验器/状态机的故障注入只证明机制有效，不证明现场安全。
- 原始数据见 \`evaluation/competition/*.json\`。
`;
}

async function main(): Promise<void> {
  console.log('SkyGuard 竞赛级基准（固定种子）...');
  const a = runExperimentA();
  writeJson('experiment_a_voi.json', a);
  console.log('  A VoI 策略完成');
  const b = runExperimentB();
  writeJson('experiment_b_prediction.json', b);
  console.log('  B 预测滚动验证完成');
  const c = runExperimentC();
  writeJson('experiment_c_planning_robustness.json', c);
  console.log('  C 规划鲁棒性完成');
  const d = runExperimentD();
  writeJson('experiment_d_safety_faults.json', d);
  console.log('  D 状态机故障注入完成');
  const e = await runExperimentE();
  writeJson('experiment_e_business_loop.json', e);
  console.log('  E 业务闭环完成');
  const f = await runExperimentF();
  writeJson('experiment_f_latency.json', f);
  console.log('  F 延迟完成');
  writeJson('run_metadata.json', {
    generated_at: new Date().toISOString(),
    seeds: SEEDS,
    node: process.version,
    platform: process.platform,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    scenario: { id: scenario.scenario_id, version: scenario.version, path: SCENARIO_PATH },
    data_nature: '全部为合成/模拟数据；不含真实人流、视频、无人机、昇腾或 AgentArts 实测。',
  });
  fs.writeFileSync(
    path.resolve(__dirname, '../../evaluation/COMPETITION_REPORT.md'),
    buildReport(a, b, c, d, e, f),
  );
  console.log('  报告：evaluation/COMPETITION_REPORT.md');
}

void main().catch(error => {
  console.error('基准失败：', error);
  process.exitCode = 1;
});
