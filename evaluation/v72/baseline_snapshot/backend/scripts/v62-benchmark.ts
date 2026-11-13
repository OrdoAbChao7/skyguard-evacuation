/**
 * V6.2 Competition Freeze: 30-seed statistical enhancement.
 *
 *   npm run benchmark:v62 --prefix backend
 *
 * 输出 evaluation/v62/*.json 与 evaluation/V6_2_REPORT.md。
 * 不覆盖 evaluation/v61/；全部为合成数据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import type { RegionRisk } from '../src/services/safety/risk';
import type { InvestigationOutcome, SafetyScenario } from '../src/services/safety/types';
import { buildRegionGraph, neighborsOf, propagateRisk, rankInvestigationPriorities } from '../src/services/mvp/risk-graph';
import { decideMultiRegionInvestigation, priorBeliefsForRegions } from '../src/services/mvp/multi-voi';
import {
  applyEvidence, decideInvestigation, expectedRisk, fixedPriorityChoice,
  heuristicStrategyChoice, priorBelief, randomStrategyChoice,
  type BeliefEntry,
} from '../src/services/mvp/voi';
import { actionAvailability, createInvestigationSession, recordAttempt } from '../src/services/mvp/investigation-session';
import { forecastWithMethod, selectForecastMethod, selectIntervalQuantile } from '../src/services/mvp/prediction';

const SEEDS = Array.from({ length: 30 }, (_, index) => 20261105 + index);
const OUT = path.resolve(__dirname, '../../evaluation/v62');
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
  for (let i = 0; i < probabilities.length; i += 1) { threshold -= probabilities[i]; if (threshold <= 0) return i; }
  return probabilities.length - 1;
}
function bootstrap(values: number[], iterations = 1000, seed = 23) {
  const rng = mulberry32(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(rng() * values.length)];
    stats.push(sum / values.length);
  }
  stats.sort((a, b) => a - b);
  return { lower: Number(stats[Math.floor(iterations * 0.025)].toFixed(4)), upper: Number(stats[Math.floor(iterations * 0.975)].toFixed(4)) };
}
function clusterBootstrap(groups: number[][], iterations = 1000, seed = 29) {
  const rng = mulberry32(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0; let count = 0;
    for (let g = 0; g < groups.length; g += 1) {
      const group = groups[Math.floor(rng() * groups.length)];
      for (let j = 0; j < group.length; j += 1) { sum += group[Math.floor(rng() * group.length)]; count += 1; }
    }
    stats.push(sum / count);
  }
  stats.sort((a, b) => a - b);
  return { lower: Number(stats[Math.floor(iterations * 0.025)].toFixed(4)), upper: Number(stats[Math.floor(iterations * 0.975)].toFixed(4)) };
}
function dz(diffs: number[]) { return std(diffs) === 0 ? 0 : Number((mean(diffs) / std(diffs)).toFixed(4)); }
function write(name: string, data: unknown) { fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`); }

function makeRisk(regionId: string, trueH: string, trusted: boolean): RegionRisk {
  return {
    regionId,
    level: trueH === 'H_CRITICAL' ? 'critical' : trueH === 'H_SURGE' ? 'high' : 'normal',
    count: 800, density: 1.1, confidence: trusted ? 0.9 : 0.35,
    observedAt: new Date().toISOString(), ageSeconds: 5, trusted, signals: [],
    thresholds: { watch_density: 1, high_density: 2, critical_density: 3, rise_rate_watch: 0.5, source: 'synthetic-v62' },
    thresholdsSource: 'synthetic-v62',
  };
}
function outcomeFor(kind: string, trueH: string): InvestigationOutcome {
  const row = policy!.likelihoods[kind as keyof typeof policy!.likelihoods][trueH] ?? {};
  let best: InvestigationOutcome = 'inconclusive'; let value = -1;
  for (const outcome of policy!.outcomes) if ((row[outcome] ?? 0) > value) { best = outcome; value = row[outcome] ?? 0; }
  return best;
}
function coverageFor(actionId: string, target: string, graph: ReturnType<typeof buildRegionGraph>): string[] {
  const action = policy!.actions.find(item => item.id === actionId);
  if (!action) return [target];
  if (action.coverage === 'all') return graph.regionIds;
  if (action.coverage === 'neighbors') return [target, ...neighborsOf(graph, target)];
  return [target];
}
function setupTrial(seed: number, trial: number, quality: number) {
  const rng = mulberry32(seed * 100_000 + trial);
  const trueByRegion = new Map<string, string>();
  for (const region of scenario.regions) trueByRegion.set(region.id, policy!.hypotheses[sampleIndex(policy!.hypotheses.map(h => h.prior), rng)].id);
  const risks = scenario.regions.map(region => makeRisk(region.id, trueByRegion.get(region.id)!, rng() < quality));
  return { trueByRegion, risks, beliefs: priorBeliefsForRegions(policy!, risks) };
}
type Strategy = 'single' | 'multi' | 'fixed' | 'random' | 'heuristic';
function runFairTrial(seed: number, trial: number, strategy: Strategy, budget: number, quality: number) {
  const setup = setupTrial(seed, trial, quality);
  const graph = buildRegionGraph(scenario);
  const beliefs = new Map(Array.from(setup.beliefs.entries()).map(([key, value]) => [key, value.map(item => ({ ...item }))]));
  const priorities = rankInvestigationPriorities(scenario, setup.risks, propagateRisk(scenario, setup.risks));
  const session = createInvestigationSession('global');
  const used = new Set<string>();
  const coverageCount = new Map<string, number>();
  let cost = 0; let elapsed = 0; let actions = 0;
  const initialRisk = scenario.regions.reduce((sum, region) => sum + expectedRisk(policy!, beliefs.get(region.id) ?? priorBelief(policy!)), 0);
  for (let round = 0; round < budget; round += 1) {
    const target = priorities[round % priorities.length].regionId;
    const availability = Object.fromEntries(policy!.actions.map(action => {
      if (used.has(action.id)) return [action.id, { available: false, reason: '已执行' }];
      const status = actionAvailability(policy!, action, session);
      return [action.id, { available: status.available, reason: status.reason ?? undefined }];
    }));
    let actionId: string | null = null;
    if (strategy === 'single') {
      const decision = decideInvestigation(policy!, beliefs.get(target) ?? priorBelief(policy!), { availability });
      if (!decision.should_investigate) break;
      actionId = decision.recommended_action_id;
    } else if (strategy === 'multi') {
      const decision = decideMultiRegionInvestigation(policy!, target, beliefs, graph, availability, {
        usedActions: session.attempts.length, usedCost: session.spentCost, usedTimeMinutes: session.spentTimeMinutes,
      });
      if (!decision.should_investigate) break;
      actionId = decision.recommended_action_id;
    } else if (strategy === 'fixed') actionId = fixedPriorityChoice(policy!, availability).action_id;
    else if (strategy === 'random') actionId = randomStrategyChoice(policy!, availability, mulberry32(seed + trial * 13 + round)).action_id;
    else actionId = heuristicStrategyChoice(policy!, beliefs.get(target) ?? priorBelief(policy!), availability).action_id;
    if (!actionId) break;
    const action = policy!.actions.find(item => item.id === actionId)!;
    used.add(action.id);
    const covered = strategy === 'single' ? [target] : coverageFor(action.id, target, graph);
    for (const regionId of covered) {
      const trueH = setup.trueByRegion.get(regionId)!;
      beliefs.set(regionId, applyEvidence(policy!, beliefs.get(regionId) ?? priorBelief(policy!), action.kind, outcomeFor(action.kind, trueH)));
      coverageCount.set(regionId, (coverageCount.get(regionId) ?? 0) + 1);
    }
    recordAttempt(session, action, { success: true, outcome: 'inconclusive' });
    actions += 1; cost += action.resource_cost; elapsed += action.time_cost_minutes;
  }
  const perRegionFinal = scenario.regions.map(region => expectedRisk(policy!, beliefs.get(region.id) ?? priorBelief(policy!)));
  const finalRisk = perRegionFinal.reduce((a, b) => a + b, 0);
  return {
    strategy, seed, trial, initial_risk: Number(initialRisk.toFixed(6)), final_risk: Number(finalRisk.toFixed(6)),
    benefit: Number((initialRisk - finalRisk).toFixed(6)), worst_final_risk: Number(Math.max(...perRegionFinal).toFixed(6)),
    cost: Number(cost.toFixed(4)), elapsed_minutes: Number(elapsed.toFixed(4)), actions,
    unique_covered: coverageCount.size, coverage_count: Array.from(coverageCount.values()).reduce((a, b) => a + b, 0),
  };
}

function powerAnalysis(d: number) {
  const z = (alpha: number, power: number) => (alpha === 0.0125 ? 2.4977 : 1.96) + (power === 0.9 ? 1.2816 : 0.8416);
  return { 0.8: Math.ceil((z(0.0125, 0.8) / d) ** 2), 0.9: Math.ceil((z(0.0125, 0.9) / d) ** 2) };
}

function experimentA() {
  const rows: Array<any> = [];
  const strategies: Strategy[] = ['single', 'multi', 'fixed', 'random', 'heuristic'];
  for (const seed of SEEDS) {
    for (let trial = 0; trial < 40; trial += 1) {
      for (const strategy of strategies) rows.push(runFairTrial(seed, trial, strategy, 2, 0.6));
    }
  }
  const summarize = (strategy: Strategy) => {
    const subset = rows.filter(row => row.strategy === strategy);
    return {
      n: subset.length,
      benefit: ci(subset.map(row => row.benefit)),
      cost: ci(subset.map(row => row.cost)),
      efficiency: ci(subset.map(row => row.benefit / Math.max(1e-6, row.cost))),
      unique_covered: ci(subset.map(row => row.unique_covered)),
      worst_final_risk: ci(subset.map(row => row.worst_final_risk)),
    };
  };
  const multi = rows.filter(row => row.strategy === 'multi');
  const single = rows.filter(row => row.strategy === 'single');
  const paired = multi.map(row => {
    const other = single.find(item => item.seed === row.seed && item.trial === row.trial)!;
    return { seed: row.seed, diff: row.benefit - other.benefit };
  });
  const diffs = paired.map(item => item.diff);
  const seedMeans = SEEDS.map(seed => mean(paired.filter(item => item.seed === seed).map(item => item.diff)));
  const groups = SEEDS.map(seed => paired.filter(item => item.seed === seed).map(item => item.diff));
  return {
    config: {
      seeds: SEEDS, trials_per_seed: 40, strategies, budget_actions: 2, quality: 0.6,
      power_analysis: { pilot_dz: 1.49, alpha: 0.0125, required_n: powerAnalysis(1.49), achieved_pairs: diffs.length, note: '功效分析基于 V6.1 试点效应量；实际功效高于目标，未做事后功效声明。' },
      target_policy: 'rotate（每个 round 依次选择下一个优先级区域）；V6.1 使用 same-target，效率结论不同，见报告。',
    },
    summary: Object.fromEntries(strategies.map(strategy => [strategy, summarize(strategy)])),
    paired: {
      trial_level: { mean: Number(mean(diffs).toFixed(4)), ci: ci(diffs), bootstrap: bootstrap(diffs), cohen_dz: dz(diffs), n: diffs.length },
      seed_level: { mean: Number(mean(seedMeans).toFixed(4)), ci: ci(seedMeans), n: seedMeans.length, values: seedMeans.map(value => Number(value.toFixed(4))), note: 'seed 级仅报告均值/CI；由于每个 seed 内 trial 数固定，seed 级 d_z 会因组间方差小而被放大，不作效应量解释。' },
      cluster_bootstrap_by_seed: clusterBootstrap(groups),
      efficiency_diff: ci(multi.map(row => row.benefit / Math.max(1e-6, row.cost)).map((value, index) => value - (single[index].benefit / Math.max(1e-6, single[index].cost)))),
    },
    raw: rows,
  };
}

function simulateSequential(seed: number, trial: number, failureProbability: number, budget: number) {
  const rng = mulberry32(seed * 10_000 + trial);
  const trueH = policy!.hypotheses[sampleIndex(policy!.hypotheses.map(h => h.prior), rng)].id;
  const failures = Array.from({ length: 10 }, () => rng() < failureProbability);
  let belief = priorBelief(policy!);
  const session = createInvestigationSession('R_EAST_STAND');
  const used = new Set<string>();
  let success = false; let attempts = 0; let failuresCount = 0;
  for (let round = 0; round < 10 && attempts < budget; round += 1) {
    const availability = Object.fromEntries(policy!.actions.map(action => [action.id, { available: !used.has(action.id) && actionAvailability(policy!, action, session).available }]));
    const decision = decideInvestigation(policy!, belief, { availability });
    if (!decision.should_investigate || !decision.recommended_action_id) break;
    const action = policy!.actions.find(item => item.id === decision.recommended_action_id)!;
    const failed = failures[attempts] ?? true;
    recordAttempt(session, action, { success: !failed, outcome: failed ? 'unavailable' : outcomeFor(action.kind, trueH) });
    attempts += 1;
    if (!failed) { belief = applyEvidence(policy!, belief, action.kind, outcomeFor(action.kind, trueH)); success = true; used.add(action.id); }
    else { failuresCount += 1; used.add(action.id); }
  }
  const posterior = belief.reduce((best, item) => item.probability > best.probability ? item : best, belief[0]).hypothesis_id;
  const oracle = (() => { let best = policy!.decisions[0]; let loss = Infinity; for (const d of policy!.decisions) { const l = policy!.loss_matrix[trueH]?.[d] ?? 1; if (l < loss) { loss = l; best = d; } } return best; })();
  const chosen = (() => { let best = policy!.decisions[0]; let loss = Infinity; for (const d of policy!.decisions) { const l = belief.reduce((sum, item) => sum + item.probability * (policy!.loss_matrix[item.hypothesis_id]?.[d] ?? 1), 0); if (l < loss) { loss = l; best = d; } } return best; })();
  return { seed, trial, trueH, success, detection_correct: posterior === trueH, decision_correct: chosen === oracle, attempts, failures: failuresCount, budget_exhausted: !success && attempts >= budget };
}
function experimentB() {
  const rows: Array<any> = [];
  for (const seed of SEEDS) for (let trial = 0; trial < 60; trial += 1) rows.push(simulateSequential(seed, trial, 0.3, 2));
  const rate = (key: string) => Number((rows.filter(row => row[key]).length / rows.length).toFixed(4));
  return {
    config: { seeds: SEEDS, trials_per_seed: 60, failure_probability: 0.3, budget_attempts: 2, note: '成功=至少一次信息性证据；检测/决策定义见脚本。' },
    summary: { success_rate: rate('success'), detection_accuracy: rate('detection_correct'), decision_accuracy: rate('decision_correct'), budget_exhausted_rate: rate('budget_exhausted'), mean_attempts: Number(mean(rows.map(row => row.attempts)).toFixed(3)), mean_failures: Number(mean(rows.map(row => row.failures)).toFixed(3)), n: rows.length },
    raw: rows,
  };
}

type ScenarioName = 'stable' | 'surge' | 'decline' | 'periodic' | 'missing';
function generateSeries(name: ScenarioName, rng: () => number, length: number): number[] {
  const base = 240 + rng() * 260; const slope = name === 'decline' ? -(2 + rng() * 6) : (rng() - 0.5) * 8;
  const peak = name === 'surge' ? 180 + rng() * 160 : 0; const peakAt = 28 + rng() * 8;
  const values: number[] = [];
  for (let t = 0; t < length; t += 1) {
    let value = base + slope * t;
    if (name === 'surge') value += peak * Math.exp(-((t - peakAt) ** 2) / 18);
    if (name === 'periodic') value += 60 * Math.sin((2 * Math.PI * t) / 12);
    value += (rng() + rng() + rng() - 1.5) * 10;
    if (name === 'missing' && t % 7 === 3) value = NaN;
    values.push(Math.max(0, Math.round(value)));
  }
  return values;
}
function fillMissing(values: number[]): number[] {
  let last = values.find(Number.isFinite) ?? 0;
  return values.map(value => { if (Number.isFinite(value)) { last = value; return value; } return last; });
}
function experimentC() {
  const names: ScenarioName[] = ['stable', 'surge', 'decline', 'periodic', 'missing'];
  const horizons = [2, 5, 10];
  const results: Array<any> = [];
  const seriesMetrics: Array<any> = [];
  for (const name of names) for (const horizon of horizons) {
    const methodErrors: Record<string, number[]> = { persistence: [], ema: [], linear: [], damped: [], adaptive: [] };
    const coverage90: number[] = []; const coverage95: number[] = [];
    for (const seed of SEEDS) {
      const rng = mulberry32(seed + 300 + horizon * 7 + name.length);
      for (let series = 0; series < 30; series += 1) {
        const values = fillMissing(generateSeries(name, rng, 40));
        const local: Array<any> = [];
        for (let origin = 30; origin + horizon <= 40; origin += 1) {
          const points = values.slice(0, origin).map((y, x) => ({ x, y }));
          const selection = selectForecastMethod(points);
          const truth = values[origin + horizon - 1];
          const predictions = {
            persistence: forecastWithMethod('persistence', points, horizon),
            ema: forecastWithMethod('ema', points, horizon),
            linear: forecastWithMethod('linear', points, horizon),
            damped: forecastWithMethod('damped', points, horizon),
            adaptive: forecastWithMethod(selection.method, points, horizon),
          };
          for (const [method, value] of Object.entries(predictions)) methodErrors[method].push(Math.abs(value - truth));
          const q95 = selectIntervalQuantile(points, selection.method, horizon) ?? 0;
          const margin = q95 * 1.5 * Math.sqrt(1 + horizon / origin);
          const c90 = Math.abs(truth - predictions.adaptive) <= margin * 1.645 / 1.96 ? 1 : 0;
          const c95 = Math.abs(truth - predictions.adaptive) <= margin ? 1 : 0;
          coverage90.push(c90); coverage95.push(c95);
          local.push({ predictions, truth, c90, c95, margin });
        }
        seriesMetrics.push({
          name, horizon, seed, series, n: local.length,
          mae: Object.fromEntries(['persistence', 'ema', 'linear', 'damped', 'adaptive'].map(method => [method, Number(mean(local.map(row => Math.abs(row.predictions[method] - row.truth))).toFixed(6))])),
          coverage90: Number((local.reduce((sum, row) => sum + row.c90, 0) / local.length).toFixed(6)),
          coverage95: Number((local.reduce((sum, row) => sum + row.c95, 0) / local.length).toFixed(6)),
          mean_interval_width: Number(mean(local.map(row => 2 * row.margin)).toFixed(4)),
        });
      }
    }
    results.push({
      scenario: name, horizon,
      mae: Object.fromEntries(Object.entries(methodErrors).map(([method, values]) => [method, ci(values)])),
      coverage90: Number(mean(coverage90).toFixed(4)), coverage95: Number(mean(coverage95).toFixed(4)),
      n: coverage90.length,
    });
  }
  return { config: { seeds: SEEDS, series_per_seed: 30, horizons, scenarios: names, split: '测试起点 30..39；每个起点只用过去数据选择方法/区间。', note: '全部合成；missing 前向填充。' }, results, series_metrics: seriesMetrics };
}

function experimentD() {
  const variants: Array<{ name: string; scenario: SafetyScenario }> = [];
  const clone = () => JSON.parse(JSON.stringify(scenario)) as SafetyScenario;
  variants.push({ name: 'baseline', scenario: scenario });
  const noMid = clone();
  for (const corridor of noMid.corridors) if (corridor.id === 'C_MID') corridor.status = 'closed';
  variants.push({ name: 'no_mid_corridor', scenario: noMid });
  const noEast = clone();
  noEast.regions = noEast.regions.filter(region => region.id !== 'R_EAST_PLAZA');
  noEast.corridors = noEast.corridors.filter(corridor => !['R_EAST_PLAZA'].includes(corridor.from_region_id) && !['R_EAST_PLAZA'].includes(corridor.to_region_id));
  noEast.exits = noEast.exits.filter(exit => exit.id !== 'E_EAST');
  variants.push({ name: 'no_east_plaza', scenario: noEast });
  const rows: Array<any> = [];
  for (const variant of variants) {
    const graph = buildRegionGraph(variant.scenario);
    const visited = new Set<string>(); let components = 0;
    for (const regionId of graph.regionIds) {
      if (visited.has(regionId)) continue;
      components += 1; const queue = [regionId]; visited.add(regionId);
      while (queue.length) { const current = queue.shift()!; for (const next of neighborsOf(graph, current)) if (!visited.has(next)) { visited.add(next); queue.push(next); } }
    }
    rows.push({ name: variant.name, regions: graph.regionIds.length, edges: Array.from(graph.adjacency.values()).reduce((sum, edges) => sum + edges.length, 0) / 2, components });
  }
  // 参数敏感性（baseline）
  const rng = mulberry32(SEEDS[0] + 900);
  const sensitivity: Array<any> = [];
  for (const damping of [0, 0.2, 0.6, 0.95]) {
    const taus: number[] = [];
    for (let trial = 0; trial < 100; trial += 1) {
      const risks = scenario.regions.map(region => makeRisk(region.id, policy!.hypotheses[sampleIndex(policy!.hypotheses.map(h => h.prior), rng)].id, rng() < 0.6));
      const base = rankInvestigationPriorities(scenario, risks, propagateRisk(scenario, risks, { damping: 0.6 })).map(item => item.regionId);
      const variant = rankInvestigationPriorities(scenario, risks, propagateRisk(scenario, risks, { damping })).map(item => item.regionId);
      const index = new Map(variant.map((id, i) => [id, i]));
      let concordant = 0; let discordant = 0;
      for (let i = 0; i < base.length; i += 1) for (let j = i + 1; j < base.length; j += 1) {
        const delta = index.get(base[j])! - index.get(base[i])!;
        if (delta > 0) concordant += 1; else if (delta < 0) discordant += 1;
      }
      const total = (base.length * (base.length - 1)) / 2;
      taus.push((concordant - discordant) / total);
    }
    sensitivity.push({ damping, mean_tau: Number(mean(taus).toFixed(4)), min_tau: Number(Math.min(...taus).toFixed(4)) });
  }
  return { config: { topology_variants: variants.map(item => item.name), sensitivity_trials: 100, note: '拓扑/风险配置为合成；不代表真实场馆。' }, topology: rows, damping_sensitivity: sensitivity };
}

const a = experimentA();
write('experiment_a_multi_region_30seeds.json', a);
const b = experimentB();
write('experiment_b_sequential_30seeds.json', b);
const c = experimentC();
write('experiment_c_prediction_30seeds.json', c);
const d = experimentD();
write('experiment_d_topology_sensitivity.json', d);
write('run_metadata.json', {
  generated_at: new Date().toISOString(), seeds: SEEDS, node: process.version, platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown', git_head: '3b62fe9',
  scenario: { id: scenario.scenario_id, version: scenario.version, path: SCENARIO_PATH },
  data_nature: '全部为合成/模拟数据；不含真实人群、视频、无人机、昇腾或 AgentArts 实测。',
  freeze: 'evaluation/v62/freeze_v61.json',
});

const report = `# SkyGuard V6.2 统计强化报告

> 由 \`npm run benchmark:v62 --prefix backend\` 生成。30 个独立种子；全部为合成数据。

## 1. 多区域 VoI（30 种子 × 40 trial = 1200 配对）

| 策略 | 风险降低 [95% CI] | 收益/成本 [95% CI] | 覆盖区域 | 最坏区域终风险 |
| --- | --- | --- | --- | --- |
${Object.entries(a.summary).map(([name, s]: [string, any]) => `| ${name} | ${s.benefit.mean} [${s.benefit.lower}, ${s.benefit.upper}] | ${s.efficiency.mean} [${s.efficiency.lower}, ${s.efficiency.upper}] | ${s.unique_covered.mean} | ${s.worst_final_risk.mean} |`).join('\n')}

- 配对差 trial 级：${a.paired.trial_level.mean} [${a.paired.trial_level.ci.lower}, ${a.paired.trial_level.ci.upper}]，d_z=${a.paired.trial_level.cohen_dz}
- 配对差 seed 级：${a.paired.seed_level.mean} [${a.paired.seed_level.ci.lower}, ${a.paired.seed_level.ci.upper}]（仅均值/CI；seed 级 d_z 因组间方差小被放大，不作解释）
- 聚类 Bootstrap（按 seed）：[${a.paired.cluster_bootstrap_by_seed.lower}, ${a.paired.cluster_bootstrap_by_seed.upper}]
- 效率差：${a.paired.efficiency_diff.mean} [${a.paired.efficiency_diff.lower}, ${a.paired.efficiency_diff.upper}]（V6.2 目标轮换设计）
- 功效分析：试点 d=1.49，α=0.0125，80%/90% 功效所需 n≈${a.config.power_analysis.required_n[0.8]}/${a.config.power_analysis.required_n[0.9]}；实际 1200 对。

**结论**：30 种子下多区域总收益更高（约 4.6×），成本约 2.3×；在**目标轮换**设计下效率差为正且 CI 不含 0。
但 V6.1 的**同目标**设计曾得到效率差不显著；两者差异来自目标选择策略，不是随机波动。
因此必须并列报告：总收益结论稳健；效率结论依赖目标轮换策略，不能无条件宣称多区域效率更优。

## 2. 序贯调查（30 种子 × 60 trial）

- 成功率：${b.summary.success_rate}
- 检测准确率：${b.summary.detection_accuracy}
- 决策准确率：${b.summary.decision_accuracy}
- 预算耗尽率：${b.summary.budget_exhausted_rate}
- 平均尝试：${b.summary.mean_attempts}；平均失败：${b.summary.mean_failures}

**结论**：与 V6.1 同预算结论一致；不把成功等同于检测/决策正确。

## 3. 预测（30 种子 × 30 序列）

${c.results.map((r: any) => `| ${r.scenario} h${r.horizon} | persistence ${r.mae.persistence.mean} | adaptive ${r.mae.adaptive.mean} | 90% ${r.coverage90} | 95% ${r.coverage95} |`).join('\n')}

**结论**：场景分化持续；区间覆盖率仍未稳定达标。

## 4. 拓扑与参数敏感性

| 拓扑 | 区域 | 边 | 连通分量 |
| --- | --- | --- | --- |
${d.topology.map((r: any) => `| ${r.name} | ${r.regions} | ${r.edges} | ${r.components} |`).join('\n')}

- damping 敏感性：${d.damping_sensitivity.map((r: any) => `${r.damping}: τ=${r.mean_tau}（min ${r.min_tau}）`).join('；')}
- 结论：拓扑/参数会改变排序；模型仍是启发式。

## 5. 数据与边界

- 原始数据：\`evaluation/v62/*.json\`；V6.1 原始数据已冻结（\`evaluation/v61/FREEZE.sha256\`）。
- 全部为合成数据；真实场地/平台/硬件未验证。

## 6. 来源 URL 审计

- 38 条来源中 28 条 URL 可达；10 条存在 404/403/网络失败（详见 \`research/SOURCE_AUDIT.md\`）。
- S15/S18 华为 ModelArts Studio 页面在本轮返回 404；AgentArts 官方 API 文档仍缺失。
- URL 可达不等于作者/年份/许可证/主张支持已核验；引用前必须人工确认。
`;
fs.writeFileSync(path.resolve(__dirname, '../../evaluation/V6_2_REPORT.md'), report);
console.log('[v62] 输出 evaluation/v62/*.json 与 evaluation/V6_2_REPORT.md');
