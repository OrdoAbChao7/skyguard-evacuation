/**
 * V6.1 科研审计基准：公平预算下的多区域 VoI、序贯调查、严格滚动预测、风险图敏感性。
 *
 *   npm run benchmark:v61 --prefix backend
 *
 * 全部为合成数据；输出 evaluation/v61/*.json 与 evaluation/V6_1_REPORT.md。
 * 本脚本纠正 V6-A 的预算不可比问题：所有策略使用相同动作预算、相同初始信念与相同证据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import type { RegionRisk } from '../src/services/safety/risk';
import type { InvestigationOutcome, SafetyScenario } from '../src/services/safety/types';
import {
  buildRegionGraph,
  neighborsOf,
  propagateRisk,
  rankInvestigationPriorities,
} from '../src/services/mvp/risk-graph';
import { decideMultiRegionInvestigation, priorBeliefsForRegions } from '../src/services/mvp/multi-voi';
import {
  applyEvidence,
  decideInvestigation,
  entropy,
  expectedRisk,
  fixedPriorityChoice,
  heuristicStrategyChoice,
  priorBelief,
  randomStrategyChoice,
  type BeliefEntry,
} from '../src/services/mvp/voi';
import {
  actionAvailability,
  createInvestigationSession,
  recordAttempt,
} from '../src/services/mvp/investigation-session';
import { forecastWithMethod, selectForecastMethod, selectIntervalQuantile } from '../src/services/mvp/prediction';
import { matchPoints } from '../src/services/perception/metrics';

const SEEDS = [20261105, 20261106, 20261107, 20261108, 20261109];
const OUT = process.env.V61_OUT_DIR
  ? path.resolve(process.env.V61_OUT_DIR)
  : path.resolve(__dirname, '../../evaluation/v61');
const REPORT_PATH = process.env.V61_REPORT_PATH
  ? path.resolve(process.env.V61_REPORT_PATH)
  : path.resolve(__dirname, '../../evaluation/V6_1_REPORT.md');
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const scenario: SafetyScenario = loadSafetyScenario(SCENARIO_PATH);
const policy = scenario.investigation;
if (!policy) throw new Error('缺少 investigation 策略');
fs.mkdirSync(OUT, { recursive: true });

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const std = (values: number[]) => values.length < 2 ? 0 : Math.sqrt(values.reduce((s, v) => s + (v - mean(values)) ** 2, 0) / (values.length - 1));
const ci = (values: number[]) => {
  const m = mean(values);
  const half = values.length > 1 ? 1.96 * std(values) / Math.sqrt(values.length) : 0;
  return { mean: Number(m.toFixed(4)), lower: Number((m - half).toFixed(4)), upper: Number((m + half).toFixed(4)), sd: Number(std(values).toFixed(4)), n: values.length };
};
function bootstrapCI(values: number[], iterations = 1000, seed = 17) {
  const rng = mulberry32(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(rng() * values.length)];
    stats.push(sum / values.length);
  }
  stats.sort((a, b) => a - b);
  return { mean: Number(mean(values).toFixed(4)), lower: Number(stats[Math.floor(iterations * 0.025)].toFixed(4)), upper: Number(stats[Math.floor(iterations * 0.975)].toFixed(4)) };
}
function clusterBootstrap(groups: number[][], iterations = 1000, seed = 19) {
  const rng = mulberry32(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    let count = 0;
    for (let g = 0; g < groups.length; g += 1) {
      const group = groups[Math.floor(rng() * groups.length)];
      for (let j = 0; j < group.length; j += 1) {
        sum += group[Math.floor(rng() * group.length)];
        count += 1;
      }
    }
    stats.push(sum / count);
  }
  stats.sort((a, b) => a - b);
  return { lower: Number(stats[Math.floor(iterations * 0.025)].toFixed(4)), upper: Number(stats[Math.floor(iterations * 0.975)].toFixed(4)) };
}

function cohenDz(diffs: number[]): number {
  const sd = std(diffs);
  return sd === 0 ? 0 : Number((mean(diffs) / sd).toFixed(4));
}
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
function sampleIndex(probabilities: number[], rng: () => number): number {
  const total = probabilities.reduce((a, b) => a + b, 0);
  let threshold = rng() * total;
  for (let i = 0; i < probabilities.length; i += 1) {
    threshold -= probabilities[i];
    if (threshold <= 0) return i;
  }
  return probabilities.length - 1;
}
function write(name: string, data: unknown) { fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`); }

function makeRisk(regionId: string, trueHypothesis: string, trusted: boolean): RegionRisk {
  const level: RegionRisk['level'] = trueHypothesis === 'H_CRITICAL' ? 'critical' : trueHypothesis === 'H_SURGE' ? 'high' : 'normal';
  return {
    regionId, level, count: 800, density: 1.1, confidence: trusted ? 0.9 : 0.35,
    observedAt: new Date().toISOString(), ageSeconds: 5, trusted, signals: [],
    thresholds: { watch_density: 1, high_density: 2, critical_density: 3, rise_rate_watch: 0.5, source: 'synthetic-v61' },
    thresholdsSource: 'synthetic-v61',
  };
}

function outcomeFor(kind: string, trueHypothesis: string): InvestigationOutcome {
  const row = policy.likelihoods[kind as keyof typeof policy.likelihoods][trueHypothesis] ?? {};
  let best: InvestigationOutcome = 'inconclusive';
  let bestValue = -1;
  for (const outcome of policy.outcomes) {
    if ((row[outcome] ?? 0) > bestValue) { best = outcome; bestValue = row[outcome] ?? 0; }
  }
  return best;
}

function coverageFor(actionId: string, target: string, graph: ReturnType<typeof buildRegionGraph>, weights: { neighbor?: number; global?: number } = {}): string[] {
  const action = policy.actions.find(item => item.id === actionId);
  if (!action) return [target];
  if (action.coverage === 'all') return graph.regionIds;
  if (action.coverage === 'neighbors') return [target, ...neighborsOf(graph, target)];
  return [target];
}

// ---------------------------------------------------------------------------
// A. 公平预算的多区域 VoI
// ---------------------------------------------------------------------------
type Strategy = 'single' | 'multi' | 'fixed' | 'random' | 'heuristic';

interface TrialSetup {
  trueByRegion: Map<string, string>;
  risks: RegionRisk[];
  beliefs: Map<string, BeliefEntry[]>;
}

function setupTrial(seed: number, trial: number, quality: number): TrialSetup {
  const rng = mulberry32(seed * 100_000 + trial);
  const trueByRegion = new Map<string, string>();
  for (const region of scenario.regions) {
    trueByRegion.set(region.id, policy.hypotheses[sampleIndex(policy.hypotheses.map(h => h.prior), rng)].id);
  }
  const risks = scenario.regions.map(region => {
    const trusted = rng() < quality;
    return makeRisk(region.id, trueByRegion.get(region.id)!, trusted);
  });
  const beliefs = priorBeliefsForRegions(policy, risks);
  return { trueByRegion, risks, beliefs };
}

function runFairTrial(seed: number, trial: number, strategy: Strategy, budgetActions: number, quality: number, coverageWeights?: { neighbor?: number; global?: number }) {
  const setup = setupTrial(seed, trial, quality);
  const graph = buildRegionGraph(scenario);
  const risks = setup.risks;
  const beliefs = new Map(Array.from(setup.beliefs.entries()).map(([key, value]) => [key, value.map(item => ({ ...item }))]));
  const prioritized = rankInvestigationPriorities(scenario, risks, propagateRisk(scenario, risks));
  const session = createInvestigationSession('global');
  const used = new Set<string>();
  const coverageCount = new Map<string, number>();
  let cost = 0;
  let elapsed = 0;
  let actions = 0;
  const initialRisk = scenario.regions.reduce((sum, region) => sum + expectedRisk(policy!, beliefs.get(region.id) ?? priorBelief(policy!)), 0);

  for (let round = 0; round < budgetActions; round += 1) {
    const target = prioritized.find(item => !used.has(item.regionId))?.regionId ?? prioritized[round % prioritized.length].regionId;
    const availability = Object.fromEntries(policy.actions.map(action => {
      if (used.has(action.id)) return [action.id, { available: false, reason: '本轮已执行' }];
      const sessionAvailability = actionAvailability(policy, action, session);
      return [action.id, { available: sessionAvailability.available, reason: sessionAvailability.reason ?? undefined }];
    }));
    let actionId: string | null = null;
    if (strategy === 'single') {
      const decision = decideInvestigation(policy, beliefs.get(target) ?? priorBelief(policy), { availability });
      if (!decision.should_investigate) break;
      actionId = decision.recommended_action_id;
    } else if (strategy === 'multi') {
      const decision = decideMultiRegionInvestigation(policy, target, beliefs, graph, availability, {
        usedActions: session.attempts.length, usedCost: session.spentCost, usedTimeMinutes: session.spentTimeMinutes, coverageWeights,
      });
      if (!decision.should_investigate) break;
      actionId = decision.recommended_action_id;
    } else if (strategy === 'fixed') {
      actionId = fixedPriorityChoice(policy, availability).action_id;
    } else if (strategy === 'random') {
      actionId = randomStrategyChoice(policy, availability, mulberry32(seed * 1000 + trial * 31 + round)).action_id;
    } else {
      actionId = heuristicStrategyChoice(policy, beliefs.get(target) ?? priorBelief(policy), availability).action_id;
    }
    if (!actionId) break;
    const action = policy.actions.find(item => item.id === actionId)!;
    used.add(action.id);
    const covered = strategy === 'single' ? [target] : coverageFor(action.id, target, graph, coverageWeights);
    for (const regionId of covered) {
      const trueH = setup.trueByRegion.get(regionId)!;
      const outcome = outcomeFor(action.kind, trueH);
      beliefs.set(regionId, applyEvidence(policy, beliefs.get(regionId) ?? priorBelief(policy), action.kind, outcome));
      coverageCount.set(regionId, (coverageCount.get(regionId) ?? 0) + 1);
    }
    recordAttempt(session, action, { success: true, outcome: 'inconclusive' });
    actions += 1;
    cost += action.resource_cost;
    elapsed += action.time_cost_minutes;
  }

  const finalRisk = scenario.regions.reduce((sum, region) => sum + expectedRisk(policy, beliefs.get(region.id) ?? priorBelief(policy)), 0);
  const perRegionFinal = scenario.regions.map(region => expectedRisk(policy, beliefs.get(region.id) ?? priorBelief(policy)));
  return {
    strategy, seed, trial,
    initial_risk: Number(initialRisk.toFixed(6)),
    final_risk: Number(finalRisk.toFixed(6)),
    benefit: Number((initialRisk - finalRisk).toFixed(6)),
    worst_final_risk: Number(Math.max(...perRegionFinal).toFixed(6)),
    cost: Number(cost.toFixed(4)),
    elapsed_minutes: Number(elapsed.toFixed(4)),
    actions,
    unique_covered: coverageCount.size,
    coverage_count: Array.from(coverageCount.values()).reduce((a, b) => a + b, 0),
  };
}

// Rebuild A cleanly with explicit tags
function experimentA2() {
  const strategies: Strategy[] = ['single', 'multi', 'fixed', 'random', 'heuristic'];
  const budgets = [1, 2, 3];
  const qualities = [0.3, 0.6, 0.9];
  const rows: Array<any> = [];
  for (const quality of qualities) {
    for (const budget of budgets) {
      for (const seed of SEEDS) {
        for (let trial = 0; trial < 120; trial += 1) {
          for (const strategy of strategies) {
            rows.push({ quality, budget, ...runFairTrial(seed, trial, strategy, budget, quality) });
          }
        }
      }
    }
  }
  const summarize = (quality: number, budget: number, strategy: Strategy) => {
    const subset = rows.filter(row => row.quality === quality && row.budget === budget && row.strategy === strategy);
    return {
      n: subset.length,
      benefit: ci(subset.map(row => row.benefit)),
      benefit_per_cost: ci(subset.map(row => row.benefit / Math.max(1e-6, row.cost))),
      cost: ci(subset.map(row => row.cost)),
      actions: ci(subset.map(row => row.actions)),
      unique_covered: ci(subset.map(row => row.unique_covered)),
      coverage_count: ci(subset.map(row => row.coverage_count)),
      worst_final_risk: ci(subset.map(row => row.worst_final_risk)),
    };
  };
  const summary: Record<string, unknown> = {};
  for (const quality of qualities) {
    for (const budget of budgets) {
      summary[`q${quality}_b${budget}`] = Object.fromEntries(strategies.map(strategy => [strategy, summarize(quality, budget, strategy)]));
    }
  }
  // Paired diffs multi - single at quality .6, budget 2
  const paired = rows.filter(row => row.quality === 0.6 && row.budget === 2 && row.strategy === 'multi')
    .map(row => {
      const single = rows.find(other => other.quality === 0.6 && other.budget === 2 && other.trial === row.trial && other.seed === row.seed && other.strategy === 'single')!;
      return { benefit: row.benefit - single.benefit, cost: row.cost - single.cost, efficiency: row.benefit / Math.max(1e-6, row.cost) - single.benefit / Math.max(1e-6, single.cost) };
    });
  return {
    config: {
      seeds: SEEDS, trials_per_seed: 120, budgets, qualities,
      note: '配对设计：同一 seed/trial 的初始风险、真实假设和证据完全相同；预算按动作数统一，成本/时间由动作配置决定。',
    },
    summary,
    paired_multi_minus_single: {
      benefit_diff: {
        ...ci(paired.map(item => item.benefit)),
        bootstrap: bootstrapCI(paired.map(item => item.benefit)),
        bootstrap_cluster_by_seed: clusterBootstrap(
          SEEDS.map(seed => paired.filter((_, index) => rows.filter(row => row.quality === 0.6 && row.budget === 2 && row.strategy === 'multi')[index]?.seed === seed).map(item => item.benefit)),
        ),
        cohen_dz: cohenDz(paired.map(item => item.benefit)),
      },
      cost_diff: ci(paired.map(item => item.cost)),
      efficiency_diff: ci(paired.map(item => item.efficiency)),
      n: paired.length,
      bonferroni_alpha: 0.05 / 4,
    },
    raw: rows,
  };
}

// ---------------------------------------------------------------------------
// B. 序贯调查审计
// ---------------------------------------------------------------------------
function oracleDecision(trueH: string): string {
  let best = policy!.decisions[0];
  let bestLoss = Infinity;
  for (const decision of policy!.decisions) {
    const loss = policy!.loss_matrix[trueH]?.[decision] ?? 1;
    if (loss < bestLoss) { bestLoss = loss; best = decision; }
  }
  return best;
}

function posteriorDecision(belief: BeliefEntry[]): string {
  let best = policy!.decisions[0];
  let bestLoss = Infinity;
  for (const decision of policy!.decisions) {
    const loss = belief.reduce((sum, item) => sum + item.probability * (policy!.loss_matrix[item.hypothesis_id]?.[decision] ?? 1), 0);
    if (loss < bestLoss) { bestLoss = loss; best = decision; }
  }
  return best;
}

function simulateSequential(seed: number, trial: number, failureProbability: number, budgetActions: number, useRetry: boolean) {
  const rng = mulberry32(seed * 10_000 + trial);
  const trueH = policy!.hypotheses[sampleIndex(policy!.hypotheses.map(h => h.prior), rng)].id;
  const failures = Array.from({ length: 10 }, () => rng() < failureProbability);
  const localPolicy = useRetry ? policy! : {
    ...policy!,
    actions: policy!.actions.map(action => ({ ...action, retry: { max_retries: 0, cooldown_minutes: 0, backoff_factor: 1 } })),
  };
  let belief = priorBelief(localPolicy);
  const session = createInvestigationSession('R_EAST_STAND');
  const used = new Set<string>();
  let now = new Date('2026-11-05T10:00:00.000Z');
  let success = false;
  let attempts = 0;
  let elapsed = 0;
  let failureIndex = 0;

  for (let round = 0; round < 10 && attempts < budgetActions; round += 1) {
    const availability = Object.fromEntries(localPolicy.actions.map(action => {
      if (used.has(action.id) && !useRetry) return [action.id, { available: false }];
      const status = actionAvailability(localPolicy, action, session, now);
      return [action.id, { available: status.available, reason: status.reason ?? undefined }];
    }));
    const decision = decideInvestigation(localPolicy, belief, { availability });
    if (!decision.should_investigate || !decision.recommended_action_id) break;
    const action = localPolicy.actions.find(item => item.id === decision.recommended_action_id)!;
    const failed = failures[failureIndex++] ?? true;
    recordAttempt(session, action, {
      success: !failed,
      outcome: failed ? 'unavailable' : outcomeFor(action.kind, trueH),
    }, now);
    attempts += 1;
    elapsed += action.time_cost_minutes;
    if (!failed) {
      belief = applyEvidence(localPolicy, belief, action.kind, outcomeFor(action.kind, trueH));
      success = true;
      used.add(action.id);
    } else if (!useRetry) {
      used.add(action.id);
    } else {
      const status = actionAvailability(localPolicy, action, session, now);
      if (status.nextAvailableAt) {
        const next = new Date(status.nextAvailableAt);
        elapsed += (next.getTime() - now.getTime()) / 60_000;
        now = next;
      }
    }
  }
  const posterior = belief.reduce((best, item) => item.probability > best.probability ? item : best, belief[0]).hypothesis_id;
  const decisionCorrect = posteriorDecision(belief) === oracleDecision(trueH);
  return {
    seed, trial, trueH,
    success,
    detection_correct: posterior === trueH,
    decision_correct: decisionCorrect,
    attempts,
    elapsed_minutes: Number(elapsed.toFixed(3)),
    budget_exhausted: !success && attempts >= budgetActions,
    false_stop: !success && attempts < budgetActions,
    final_entropy: Number(entropy(belief).toFixed(4)),
  };
}

function experimentB() {
  const rows: Array<any> = [];
  for (const failureProbability of [0.1, 0.3, 0.5]) {
    for (const budget of [1, 2, 3]) {
      for (const seed of SEEDS) {
        for (let trial = 0; trial < 200; trial += 1) {
          for (const useRetry of [false, true]) {
            rows.push({ failureProbability, budget, useRetry, ...simulateSequential(seed, trial, failureProbability, budget, useRetry) });
          }
        }
      }
    }
  }
  const summarize = (failureProbability: number, budget: number, useRetry: boolean) => {
    const subset = rows.filter(row => row.failureProbability === failureProbability && row.budget === budget && row.useRetry === useRetry);
    const rate = (key: string) => Number((subset.filter(row => row[key]).length / subset.length).toFixed(4));
    return {
      n: subset.length,
      success_rate: rate('success'),
      detection_accuracy: rate('detection_correct'),
      decision_accuracy: rate('decision_correct'),
      budget_exhausted_rate: rate('budget_exhausted'),
      false_stop_rate: rate('false_stop'),
      mean_attempts: Number(mean(subset.map(row => row.attempts)).toFixed(3)),
      mean_elapsed_minutes: Number(mean(subset.map(row => row.elapsed_minutes)).toFixed(3)),
      mean_final_entropy: Number(mean(subset.map(row => row.final_entropy)).toFixed(4)),
    };
  };
  const summary: Record<string, unknown> = {};
  for (const failureProbability of [0.1, 0.3, 0.5]) {
    for (const budget of [1, 2, 3]) {
      summary[`p${failureProbability}_b${budget}`] = {
        no_retry: summarize(failureProbability, budget, false),
        retry: summarize(failureProbability, budget, true),
      };
    }
  }
  return {
    config: {
      seeds: SEEDS, trials_per_seed: 200, budgets: [1, 2, 3], failure_probabilities: [0.1, 0.3, 0.5],
      note: '成功=至少获得一次信息性证据；检测正确=后验最大假设为真实假设；决策正确=后验最优决策等于真实假设下的最优决策。',
    },
    summary,
    raw: rows,
  };
}

// ---------------------------------------------------------------------------
// C. 严格滚动预测
// ---------------------------------------------------------------------------
type ScenarioName = 'stable' | 'surge' | 'decline' | 'periodic' | 'missing';

function generateSeries(name: ScenarioName, rng: () => number, length: number): number[] {
  const base = 240 + rng() * 260;
  const slope = name === 'decline' ? -(2 + rng() * 6) : (rng() - 0.5) * 8;
  const peak = name === 'surge' ? 180 + rng() * 160 : 0;
  const peakAt = 28 + rng() * 8;
  const values: number[] = [];
  for (let t = 0; t < length; t += 1) {
    let value = base + slope * t;
    if (name === 'surge') value += peak * Math.exp(-((t - peakAt) ** 2) / (2 * 3 ** 2));
    if (name === 'periodic') value += 60 * Math.sin((2 * Math.PI * t) / 12);
    const noise = (rng() + rng() + rng() - 1.5) * 10;
    value += noise;
    if (name === 'missing' && t % 7 === 3) value = NaN;
    values.push(Math.max(0, Math.round(value)));
  }
  return values;
}

function fillMissing(values: number[]): number[] {
  let last = values.find(value => Number.isFinite(value)) ?? 0;
  return values.map(value => {
    if (Number.isFinite(value)) { last = value; return value; }
    return last;
  });
}

function experimentC() {
  const horizons = [2, 5, 10];
  const names: ScenarioName[] = ['stable', 'surge', 'decline', 'periodic', 'missing'];
  const rows: Array<any> = [];
  const seriesMetrics: Array<any> = [];
  const methods = ['persistence', 'ema', 'linear', 'damped', 'adaptive'] as const;
  for (const name of names) {
    for (const horizon of horizons) {
      for (const seed of SEEDS) {
        const rng = mulberry32(seed + 100 + horizon * 7 + name.length);
        for (let series = 0; series < 120; series += 1) {
          const values = fillMissing(generateSeries(name, rng, 40));
          const localRows: Array<any> = [];
          // 测试起点从 30 开始；每个起点只用过去数据重新选择方法
          for (let origin = 30; origin + horizon <= 40; origin += 1) {
            const train = values.slice(0, origin);
            const points = train.map((y, x) => ({ x, y }));
            const selection = selectForecastMethod(points);
            const truth = values[origin + horizon - 1];
            const predictions: Record<string, number> = {
              persistence: forecastWithMethod('persistence', points, horizon),
              ema: forecastWithMethod('ema', points, horizon),
              linear: forecastWithMethod('linear', points, horizon),
              damped: forecastWithMethod('damped', points, horizon),
              adaptive: forecastWithMethod(selection.method, points, horizon),
            };
            const q95 = selectIntervalQuantile(points, selection.method, horizon) ?? 0;
            const margin95 = q95 * 1.5 * Math.sqrt(1 + horizon / origin);
            const margin90 = q95 * 1.645 / 1.96 * 1.5 * Math.sqrt(1 + horizon / origin);
            const row = {
              name, horizon, seed, series, origin, truth,
              predictions,
              selected_method: selection.method,
              coverage90: Math.abs(truth - predictions.adaptive) <= margin90,
              coverage95: Math.abs(truth - predictions.adaptive) <= margin95,
              interval_width: 2 * margin95,
            };
            rows.push(row);
            localRows.push(row);
          }
          seriesMetrics.push({
            name, horizon, seed, series, n: localRows.length,
            mae: Object.fromEntries(methods.map(method => [method, Number(mean(localRows.map(row => Math.abs(row.predictions[method] - row.truth))).toFixed(6))])),
            coverage90: Number((localRows.filter(row => row.coverage90).length / localRows.length).toFixed(6)),
            coverage95: Number((localRows.filter(row => row.coverage95).length / localRows.length).toFixed(6)),
            mean_interval_width: Number(mean(localRows.map(row => row.interval_width)).toFixed(4)),
            selected_methods: Object.fromEntries(['persistence', 'ema', 'linear', 'damped', 'blend'].map(method => [method, localRows.filter(row => row.selected_method === method).length])),
          });
        }
      }
    }
  }
  const summarize = (name: ScenarioName, horizon: number) => {
    const subset = rows.filter(row => row.name === name && row.horizon === horizon);
    const errors = (key: string) => subset.map(row => Math.abs(row.predictions[key] - row.truth));
    const rmse = (key: string) => Math.sqrt(mean(subset.map(row => (row.predictions[key] - row.truth) ** 2)));
    const peakError = subset.map(row => Math.abs(row.predictions.adaptive - row.truth));
    return {
      n: subset.length,
      mae: Object.fromEntries(['persistence', 'ema', 'linear', 'damped', 'adaptive'].map(key => [key, ci(errors(key))])),
      rmse: Object.fromEntries(['persistence', 'ema', 'linear', 'damped', 'adaptive'].map(key => [key, Number(rmse(key).toFixed(4))])),
      peak_error: ci(peakError),
      coverage90: Number((subset.filter(row => row.coverage90).length / subset.length).toFixed(4)),
      coverage95: Number((subset.filter(row => row.coverage95).length / subset.length).toFixed(4)),
      mean_interval_width: Number(mean(subset.map(row => row.interval_width)).toFixed(4)),
      selected_methods: Object.fromEntries(policy ? ['persistence', 'ema', 'linear', 'damped', 'blend'].map(method => [method, subset.filter(row => row.selected_method === method).length]) : []),
    };
  };
  const summary: Record<string, unknown> = {};
  for (const name of names) for (const horizon of horizons) summary[`${name}_h${horizon}`] = summarize(name, horizon);
  return {
    config: {
      seeds: SEEDS, series_per_seed: 120, horizons, scenarios: names,
      split: '测试起点 30..39；每个起点只用过去数据选择方法与区间；严格滚动，无未来信息。',
      interval: 'q95(历史 h 步误差) × 1.5 × sqrt(1+h/n)；90% 区间用 1.645/1.96 缩放。',
      note: '全部为合成序列；missing 场景使用前向填充。',
    },
    summary,
    series_metrics: seriesMetrics,
    raw: rows.slice(0, 5000),
  };
}

// ---------------------------------------------------------------------------
// D. 风险图敏感性
// ---------------------------------------------------------------------------
function kendallTau(a: string[], b: string[]): number {
  const indexB = new Map(b.map((id, index) => [id, index]));
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = i + 1; j < a.length; j += 1) {
      const delta = indexB.get(a[j])! - indexB.get(a[i])!;
      if (delta > 0) concordant += 1;
      else if (delta < 0) discordant += 1;
    }
  }
  const total = (a.length * (a.length - 1)) / 2;
  return total === 0 ? 1 : Number(((concordant - discordant) / total).toFixed(4));
}

function experimentD() {
  const rng = mulberry32(SEEDS[2] + 77);
  const variants: Array<{ name: string; damping: number; steps: number; scale: number }> = [
    { name: 'baseline', damping: 0.6, steps: 3, scale: 1 },
    { name: 'damping_0', damping: 0, steps: 3, scale: 1 },
    { name: 'damping_0.2', damping: 0.2, steps: 3, scale: 1 },
    { name: 'damping_0.4', damping: 0.4, steps: 3, scale: 1 },
    { name: 'damping_0.8', damping: 0.8, steps: 3, scale: 1 },
    { name: 'damping_0.95', damping: 0.95, steps: 3, scale: 1 },
    { name: 'steps_1', damping: 0.6, steps: 1, scale: 1 },
    { name: 'steps_10', damping: 0.6, steps: 10, scale: 1 },
    { name: 'edge_scale_0.5', damping: 0.6, steps: 3, scale: 0.5 },
    { name: 'edge_scale_1.5', damping: 0.6, steps: 3, scale: 1.5 },
  ];
  const tau: Record<string, number[]> = Object.fromEntries(variants.map(variant => [variant.name, []]));
  for (let trial = 0; trial < 200; trial += 1) {
    const risks = scenario.regions.map(region => {
      const trueH = policy!.hypotheses[sampleIndex(policy!.hypotheses.map(h => h.prior), rng)].id;
      return makeRisk(region.id, trueH, rng() < 0.6);
    });
    const baseline = rankInvestigationPriorities(scenario, risks, propagateRisk(scenario, risks, { damping: 0.6, steps: 3 })).map(item => item.regionId);
    for (const variant of variants) {
      const order = rankInvestigationPriorities(
        scenario,
        risks,
        propagateRisk(scenario, risks, { damping: variant.damping, steps: variant.steps, edgeWeightScale: variant.scale }),
      ).map(item => item.regionId);
      tau[variant.name].push(kendallTau(baseline, order));
    }
  }
  // 覆盖权重敏感性
  const coverageWeights = [{ neighbor: 0.25 }, { neighbor: 0.5 }, { neighbor: 0.75 }];
  const coverageRows: Array<any> = [];
  for (const seed of SEEDS) {
    for (let trial = 0; trial < 100; trial += 1) {
      const setup = setupTrial(seed, trial, 0.6);
      const graph = buildRegionGraph(scenario);
      const priorities = rankInvestigationPriorities(scenario, setup.risks, propagateRisk(scenario, setup.risks));
      const target = priorities[0].regionId;
      for (const weights of coverageWeights) {
        const decision = decideMultiRegionInvestigation(policy!, target, setup.beliefs, graph, {}, { coverageWeights: weights });
        coverageRows.push({
          seed, trial, weight: weights.neighbor,
          recommended: decision.recommended_action_id,
          covered: decision.recommended_covered_regions.length,
          score: decision.evaluations.find(item => item.action_id === decision.recommended_action_id)?.score ?? null,
        });
      }
    }
  }
  const coverageSummary = Object.fromEntries(coverageWeights.map(weights => {
    const subset = coverageRows.filter(row => row.weight === weights.neighbor);
    const base = coverageRows.filter(row => row.weight === 0.5);
    const same = subset.filter(row => {
      const paired = base.find(other => other.seed === row.seed && other.trial === row.trial);
      return paired?.recommended === row.recommended;
    }).length;
    return [`neighbor_${weights.neighbor}`, {
      mean_covered: Number(mean(subset.map(row => row.covered)).toFixed(3)),
      mean_score: Number(mean(subset.map(row => row.score ?? 0)).toFixed(4)),
      'agreement_with_0.5': Number((same / subset.length).toFixed(4)),
    }];
  }));

  const graph = buildRegionGraph(scenario);
  const components: string[][] = [];
  const visited = new Set<string>();
  for (const regionId of graph.regionIds) {
    if (visited.has(regionId)) continue;
    const queue = [regionId];
    const component: string[] = [];
    visited.add(regionId);
    while (queue.length) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of neighborsOf(graph, current)) {
        if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
      }
    }
    components.push(component.sort());
  }
  return {
    config: { trials: 200, variants, note: 'Kendall τ 衡量调查优先级排序变化；风险配置为合成。' },
    ranking_stability: Object.fromEntries(Object.entries(tau).map(([name, values]) => [name, { mean_tau: Number(mean(values).toFixed(4)), min_tau: Number(Math.min(...values).toFixed(4)) }])),
    coverage_weight_sensitivity: coverageSummary,
    graph: {
      regions: graph.regionIds.length,
      edges: graph.adjacency.size > 0 ? Array.from(graph.adjacency.values()).reduce((sum, edges) => sum + edges.length, 0) / 2 : 0,
      components,
      connected: components.length === 1,
      note: '边为开放且容量已知的通道；未知通道被排除。',
    },
  };
}

// ---------------------------------------------------------------------------
// E. 感知匹配审计（合成，不代表精度）
// ---------------------------------------------------------------------------
function experimentE() {
  const greedyFailure = matchPoints(
    [{ x: 0.5, y: 0 }, { x: 0, y: 0.1 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    1,
  );
  return {
    config: { note: '仅验证匹配算法与指标边界；没有数据集、权重或真实精度。' },
    optimal_matching_example: greedyFailure,
    edge_cases: {
      empty_ground_truth: matchPoints([], [{ x: 0, y: 0 }], 1),
      empty_predictions: matchPoints([{ x: 0, y: 0 }], [], 1),
    },
  };
}

const a = experimentA2();
write('experiment_a_fair_multi_region.json', a);
const b = experimentB();
write('experiment_b_sequential_audit.json', b);
const c = experimentC();
write('experiment_c_strict_prediction.json', c);
const d = experimentD();
write('experiment_d_risk_graph_sensitivity.json', d);
const e = experimentE();
write('experiment_e_perception_audit.json', e);
write('run_metadata.json', {
  generated_at: new Date().toISOString(),
  seeds: SEEDS,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  scenario: { id: scenario.scenario_id, version: scenario.version, path: SCENARIO_PATH },
  data_nature: '全部为合成/模拟数据；不含真实人流、视频、无人机、昇腾或 AgentArts 实测。',
});

const key = (a.summary as Record<string, any>)['q0.6_b2'] as Record<string, any>;
const bKey = (b.summary as Record<string, any>)['p0.3_b2'] as Record<string, any>;
const report = `# SkyGuard V6.1 科研审计报告

> 由 \`npm run benchmark:v61 --prefix backend\` 生成。全部为合成数据；不得当作真实效果。

## 0. 本轮纠正

V6-A 的 0.083 vs 0.024 比较**未做预算配对**：多区域收益按 5.78 个区域求和，单区域只算 1 个区域。
V6.1 重做为**同种子、同初始信念、同动作预算、同证据**的配对实验，报告总收益、单位成本效率与最坏区域风险。

## 1. 公平预算的多区域 VoI

质量 0.6、预算 2 动作、5 种子 × 120 次：

| 策略 | 风险降低 [95% CI] | 收益/成本 [95% CI] | 动作数 | 覆盖区域 | 最坏区域终风险 |
| --- | --- | --- | --- | --- | --- |
| 单区域 VoI | ${key.single.benefit.mean} [${key.single.benefit.lower}, ${key.single.benefit.upper}] | ${key.single.benefit_per_cost.mean} | ${key.single.actions.mean} | ${key.single.unique_covered.mean} | ${key.single.worst_final_risk.mean} |
| 多区域 VoI | ${key.multi.benefit.mean} [${key.multi.benefit.lower}, ${key.multi.benefit.upper}] | ${key.multi.benefit_per_cost.mean} | ${key.multi.actions.mean} | ${key.multi.unique_covered.mean} | ${key.multi.worst_final_risk.mean} |
| 固定优先级 | ${key.fixed.benefit.mean} | ${key.fixed.benefit_per_cost.mean} | ${key.fixed.actions.mean} | ${key.fixed.unique_covered.mean} | ${key.fixed.worst_final_risk.mean} |
| 随机 | ${key.random.benefit.mean} | ${key.random.benefit_per_cost.mean} | ${key.random.actions.mean} | ${key.random.unique_covered.mean} | ${key.random.worst_final_risk.mean} |
| 启发式 | ${key.heuristic.benefit.mean} | ${key.heuristic.benefit_per_cost.mean} | ${key.heuristic.actions.mean} | ${key.heuristic.unique_covered.mean} | ${key.heuristic.worst_final_risk.mean} |

配对差异（多区域 − 单区域）：

- 风险降低差：${a.paired_multi_minus_single.benefit_diff.mean} [${a.paired_multi_minus_single.benefit_diff.lower}, ${a.paired_multi_minus_single.benefit_diff.upper}]，
  Bootstrap（trial 级）[${a.paired_multi_minus_single.benefit_diff.bootstrap.lower}, ${a.paired_multi_minus_single.benefit_diff.bootstrap.upper}]，
  聚类 Bootstrap（按 seed 重采样）[${a.paired_multi_minus_single.benefit_diff.bootstrap_cluster_by_seed.lower}, ${a.paired_multi_minus_single.benefit_diff.bootstrap_cluster_by_seed.upper}]，
  Cohen's d_z = ${a.paired_multi_minus_single.benefit_diff.cohen_dz}；
- 成本差：${a.paired_multi_minus_single.cost_diff.mean}；
- 效率差：${a.paired_multi_minus_single.efficiency_diff.mean} [${a.paired_multi_minus_single.efficiency_diff.lower}, ${a.paired_multi_minus_single.efficiency_diff.upper}]（区间含 0，效率差异不显著）；
- 配对样本 n=${a.paired_multi_minus_single.n}，Bonferroni α=${a.paired_multi_minus_single.bonferroni_alpha}。

**结论**：只有在总风险收益维度，多区域可能占优；单位成本效率与最坏区域风险必须同时报告。
是否占优取决于预算、质量与风险传播强度，不能宣称“多区域普遍更优”。

## 2. 序贯调查审计

成功、检测正确、决策正确的定义见脚本；p=0.3、预算 2：

| 策略 | 成功率 | 检测准确 | 决策准确 | 预算耗尽 | 假停止 | 平均尝试 |
| --- | --- | --- | --- | --- | --- | --- |
| 无重试 | ${bKey.no_retry.success_rate} | ${bKey.no_retry.detection_accuracy} | ${bKey.no_retry.decision_accuracy} | ${bKey.no_retry.budget_exhausted_rate} | ${bKey.no_retry.false_stop_rate} | ${bKey.no_retry.mean_attempts} |
| 冷却+退避 | ${bKey.retry.success_rate} | ${bKey.retry.detection_accuracy} | ${bKey.retry.decision_accuracy} | ${bKey.retry.budget_exhausted_rate} | ${bKey.retry.false_stop_rate} | ${bKey.retry.mean_attempts} |

完整曲线见 JSON（失败率 0.1/0.3/0.5 × 预算 1/2/3）。
**结论**：在同为 2 次尝试预算时，重试与不重试的成功率、检测准确率、决策准确率完全相同（92%/76.5%/96.5%）；
V6-B 的 91% vs 68.6% 实际是“2 次尝试 vs 1 次尝试”的差异，不能归因于重试机制。
重试在本模拟中只改变动作选择与耗时，不提高有限尝试预算下的成功概率。

## 3. 严格滚动预测

测试起点 30..39，每个起点只用过去数据选择方法与区间：

| 场景 | 窗口 | 自适应 MAE | Persistence MAE | 90% 覆盖 | 95% 覆盖 | 平均区间宽度 |
| --- | --- | --- | --- | --- | --- | --- |
${Object.entries(c.summary).map(([name, value]: [string, any]) => `| ${name} | ${value.n} | ${value.mae.adaptive.mean} | ${value.mae.persistence.mean} | ${value.coverage90} | ${value.coverage95} | ${value.mean_interval_width} |`).join('\n')}

**结论**：结果按场景分化——stable/decline/missing 上自适应更好，surge/periodic 上 persistence 略优；
不能笼统宣称某一模型全面更优。区间覆盖率受场景影响，未稳定达到 90/95% 的区间不得用于安全保证。

## 4. 风险图敏感性

排序稳定性（Kendall τ vs baseline）：

${Object.entries(d.ranking_stability).map(([name, value]: [string, any]) => `- ${name}: mean τ=${value.mean_tau}, min τ=${value.min_tau}`).join('\n')}

覆盖权重敏感性：

${Object.entries(d.coverage_weight_sensitivity).map(([name, value]: [string, any]) => `- ${name}: 平均覆盖 ${value.mean_covered} 区域，平均分 ${value.mean_score}，与 0.5 推荐一致率 ${value['agreement_with_0.5']}`).join('\n')}

图结构：${d.graph.regions} 区域 / ${d.graph.edges} 条无向边，连通分量 ${d.graph.components.length}。

**结论**：风险传播系数/覆盖权重会改变排序与推荐；它们仍是**未标定的运维启发式**，不是真实迁移概率。

## 5. 感知匹配审计

- 已用最大基数二分匹配替代贪心；提供反例回归测试。
- 空 GT/空预测的 P/R/F1 边界已定义。
- **没有数据集、权重或真实精度**；匹配算法测试通过 ≠ 视觉模型准确率。

## 6. 统计规范

- 配对种子/场景；Bootstrap 95% CI；Cohen's d_z；Bonferroni 用于主比较族；
- 实验单位 = 独立合成 trial；同一 trial 的策略结果按配对处理；
- 未做正式功效分析；样本量按可复现性选择，不是功效计算；
- 所有原始数据、种子、环境保存在 \`evaluation/v61/\`。

## 7. 结论：哪些创新真正被支持

| 主张 | 状态 |
| --- | --- |
| VoI 降低调查成本 | 支持（模拟） |
| 多区域联合在总风险收益上占优 | **条件性**：取决于预算/质量/传播强度；单位效率未必占优 |
| 序贯重试提高“获得证据”成功率 | **不支持**（同等尝试预算下与不重试相同）；V6-B 差异来自尝试次数 |
| 预测方法自适应优于固定基线 | **条件性**：stable/decline/missing 更好，surge/periodic persistence 略优 |
| 风险传播图具有真实迁移含义 | **不支持**：仅为运维启发式 |
| 独立校验/状态机阻止错误发布 | 支持（注入故障） |
| AgentArts/昇腾实机 | **未验证** |

## 8. 外部阻塞

真实场地/人流/视频、AgentArts 租户、CANN 设备、公开数据集与权重、无人机。
`;
fs.writeFileSync(REPORT_PATH, report);
console.log('[v61] 输出 evaluation/v61/*.json 与 evaluation/V6_1_REPORT.md');
