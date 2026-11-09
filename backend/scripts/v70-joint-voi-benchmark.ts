/**
 * V7.2 联合 VoI 公平对照实验。
 *
 *   npm run benchmark:v70 --prefix backend -- --only=joint-voi
 *
 * 公平性设计：
 *  - 所有策略对同一物理动作获得**相同覆盖区域**；
 *  - 观测结果按 P(outcome | hypothesis, action) 采样，随机数按
 *    (seed, trial, round, region, action.kind) 固定，策略间共享（common random numbers）；
 *  - 预算准入统一为 used + candidate <= max；
 *  - 目标区域按优先级轮换，与 V6.4 公平复跑一致；
 *  - Oracle 是知道真实状态的上界基线，只用于参照，不参与配对显著性比较。
 *
 * 对照：random / fixed / greedy(单区域) / multi(现有多区域) / joint(联合 VoI) / oracle。
 * 全部为合成数据；参数未在真实数据上标定。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import type { RegionRisk } from '../src/services/safety/risk';
import type { InvestigationKind, InvestigationOutcome, InvestigationPolicy, SafetyScenario } from '../src/services/safety/types';
import { buildRegionGraph, neighborsOf, propagateRisk, rankInvestigationPriorities } from '../src/services/mvp/risk-graph';
import { decideMultiRegionInvestigation, priorBeliefsForRegions } from '../src/services/mvp/multi-voi';
import { decideJointInvestigation } from '../src/services/mvp/joint-voi';
import {
  applyEvidence,
  decideInvestigation,
  entropy,
  expectedRisk,
  fixedPriorityChoice,
  priorBelief,
  randomStrategyChoice,
  type BeliefEntry,
} from '../src/services/mvp/voi';

const SEEDS = Array.from({ length: 30 }, (_, index) => 20261105 + index);
const TRIALS = 40;
const BUDGET = 2;
const QUALITY = 0.6;
const GROUND_TRUTH_CORRELATION = 0.5;
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const RUN_ID = process.env.V70_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v70', RUN_ID);
const scenario: SafetyScenario = loadSafetyScenario(SCENARIO_PATH);
const policy = scenario.investigation;
if (!policy) throw new Error('缺少 investigation 策略');

type Strategy = 'random' | 'fixed' | 'greedy' | 'multi' | 'joint';
const STRATEGIES: Strategy[] = ['random', 'fixed', 'greedy', 'multi', 'joint'];

const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const std = (values: number[]): number => (values.length < 2 ? 0 : Math.sqrt(values.reduce((s, v) => s + (v - mean(values)) ** 2, 0) / (values.length - 1)));
const ci = (values: number[]) => {
  const m = mean(values);
  const half = values.length > 1 ? 1.96 * std(values) / Math.sqrt(values.length) : 0;
  return { mean: Number(m.toFixed(4)), lower: Number((m - half).toFixed(4)), upper: Number((m + half).toFixed(4)), sd: Number(std(values).toFixed(4)), n: values.length };
};
const dz = (diffs: number[]): number => (std(diffs) === 0 ? 0 : Number((mean(diffs) / std(diffs)).toFixed(4)));

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
  for (let index = 0; index < probabilities.length; index += 1) {
    threshold -= probabilities[index];
    if (threshold <= 0) return index;
  }
  return probabilities.length - 1;
}
function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
}
function bootstrap(values: number[], iterations = 2000, seed = 37): { lower: number; upper: number } {
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
function clusterBootstrap(groups: number[][], iterations = 2000, seed = 41): { lower: number; upper: number } {
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
    stats.push(sum / Math.max(1, count));
  }
  stats.sort((a, b) => a - b);
  return { lower: Number(stats[Math.floor(iterations * 0.025)].toFixed(4)), upper: Number(stats[Math.floor(iterations * 0.975)].toFixed(4)) };
}
function normalCdf(value: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(value));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * value * value) * poly;
  return value >= 0 ? cdf : 1 - cdf;
}
function pairedPValue(diffs: number[]): number {
  if (diffs.length < 2) return 1;
  const sd = std(diffs);
  if (sd === 0) return mean(diffs) === 0 ? 1 : 0;
  const z = Math.abs(mean(diffs)) / (sd / Math.sqrt(diffs.length));
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(z))));
}
function holm(pValues: Record<string, number>): Record<string, { raw: number; adjusted: number; rejected_0_05: boolean }> {
  const entries = Object.entries(pValues).sort((a, b) => a[1] - b[1]);
  const m = entries.length;
  const result: Record<string, { raw: number; adjusted: number; rejected_0_05: boolean }> = {};
  let previous = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const [key, value] = entries[index];
    const next = Math.min(1, Math.max(previous, (m - index) * value));
    previous = next;
    result[key] = { raw: Number(value.toFixed(6)), adjusted: Number(next.toFixed(6)), rejected_0_05: next < 0.05 };
  }
  return result;
}

function makeRisk(regionId: string, trueHypothesis: string, trusted: boolean): RegionRisk {
  return {
    regionId,
    level: trueHypothesis === 'H_CRITICAL' ? 'critical' : trueHypothesis === 'H_SURGE' ? 'high' : 'normal',
    count: 800, density: 1.1, confidence: trusted ? 0.9 : 0.35,
    observedAt: new Date().toISOString(), ageSeconds: 5, trusted, signals: [],
    thresholds: { watch_density: 1, high_density: 2, critical_density: 3, rise_rate_watch: 0.5, source: 'synthetic-joint-voi' },
    thresholdsSource: 'synthetic-joint-voi',
  };
}

function setupTrial(seed: number, trial: number) {
  const rng = mulberry32(seed * 100_000 + trial);
  const priors = policy!.hypotheses.map(hypothesis => hypothesis.prior);
  const shared = policy!.hypotheses[sampleIndex(priors, rng)].id;
  const trueByRegion = new Map<string, string>();
  for (const region of scenario.regions) {
    const hypothesis = rng() < GROUND_TRUTH_CORRELATION
      ? shared
      : policy!.hypotheses[sampleIndex(priors, rng)].id;
    trueByRegion.set(region.id, hypothesis);
  }
  const risks = scenario.regions.map(region => makeRisk(region.id, trueByRegion.get(region.id)!, rng() < QUALITY));
  return { trueByRegion, risks, beliefs: priorBeliefsForRegions(policy!, risks) };
}

function sampleOutcome(kind: string, trueHypothesis: string, rng: () => number): InvestigationOutcome {
  const row = policy!.likelihoods[kind as keyof typeof policy!.likelihoods]?.[trueHypothesis] ?? {};
  const probabilities = policy!.outcomes.map(outcome => row[outcome] ?? 0);
  return policy!.outcomes[sampleIndex(probabilities, rng)];
}

function coverageFor(actionId: string, target: string): string[] {
  const action = policy!.actions.find(item => item.id === actionId);
  if (!action) return [target];
  const graph = buildRegionGraph(scenario);
  if (action.coverage === 'all') return graph.regionIds;
  if (action.coverage === 'neighbors') return [target, ...neighborsOf(graph, target)];
  return [target];
}

function posteriorDecision(policyValue: InvestigationPolicy, belief: BeliefEntry[]): string {
  let best = policyValue.decisions[0];
  let bestLoss = Number.POSITIVE_INFINITY;
  for (const decision of policyValue.decisions) {
    const expected = belief.reduce((sum, entry) => {
      const loss = policyValue.loss_matrix[entry.hypothesis_id]?.[decision] ?? 0;
      return sum + entry.probability * loss;
    }, 0);
    if (expected < bestLoss) {
      bestLoss = expected;
      best = decision;
    }
  }
  return best;
}

function trueDecision(trueHypothesis: string): string {
  let best = policy!.decisions[0];
  let bestLoss = Number.POSITIVE_INFINITY;
  for (const decision of policy!.decisions) {
    const loss = policy!.loss_matrix[trueHypothesis]?.[decision] ?? 0;
    if (loss < bestLoss) {
      bestLoss = loss;
      best = decision;
    }
  }
  return best;
}

function argmaxHypothesis(belief: BeliefEntry[]): string {
  let best = belief[0];
  for (const entry of belief) if (entry.probability > best.probability) best = entry;
  return best.hypothesis_id;
}

interface TrialResult {
  strategy: Strategy;
  seed: number;
  trial: number;
  initial_risk: number;
  final_risk: number;
  benefit: number;
  worst_final_risk: number;
  information_gain: number;
  cost: number;
  elapsed_minutes: number;
  actions: number;
  unique_covered: number;
  coverage_count: number;
  detection_accuracy: number;
  decision_accuracy: number;
  true_congested: number;
  detected_congested: number;
  congested_coverage: number;
}

function runTrial(seed: number, trial: number, strategy: Strategy, budget: number, jointCorrelation?: number): TrialResult {
  const setup = setupTrial(seed, trial);
  const graph = buildRegionGraph(scenario);
  const beliefs = new Map(Array.from(setup.beliefs.entries()).map(([key, value]) => [key, value.map(item => ({ ...item }))]));
  const priorities = rankInvestigationPriorities(scenario, setup.risks, propagateRisk(scenario, setup.risks));
  const used = new Set<string>();
  const previouslySelected: Array<{ action_id: string; kind: InvestigationKind; covered_regions: string[] }> = [];
  const coverageCount = new Map<string, number>();
  let cost = 0;
  let elapsed = 0;
  let actions = 0;
  const initialRisk = scenario.regions.reduce((sum, region) => sum + expectedRisk(policy!, beliefs.get(region.id) ?? priorBelief(policy!)), 0);
  const initialEntropy = scenario.regions.reduce((sum, region) => sum + entropy(beliefs.get(region.id) ?? priorBelief(policy!)), 0);

  for (let round = 0; round < budget; round += 1) {
    const target = priorities[round % priorities.length].regionId;
    const availability = Object.fromEntries(policy!.actions.map(action => {
      if (used.has(action.id)) return [action.id, { available: false, reason: '已执行' }];
      return [action.id, { available: action.base_availability === 'available', reason: undefined }];
    }));
    let actionId: string | null = null;
    if (strategy === 'random') {
      actionId = randomStrategyChoice(policy!, availability, mulberry32(seed + trial * 13 + round)).action_id;
    } else if (strategy === 'fixed') {
      actionId = fixedPriorityChoice(policy!, availability).action_id;
    } else if (strategy === 'greedy') {
      const decision = decideInvestigation(policy!, beliefs.get(target) ?? priorBelief(policy!), { availability });
      actionId = decision.should_investigate ? decision.recommended_action_id : null;
    } else if (strategy === 'multi') {
      const decision = decideMultiRegionInvestigation(policy!, target, beliefs, graph, availability, {
        usedActions: actions, usedCost: cost, usedTimeMinutes: elapsed,
      });
      actionId = decision.should_investigate ? decision.recommended_action_id : null;
    } else {
      const decision = decideJointInvestigation(policy!, target, beliefs, graph, availability, {
        usedActions: actions, usedCost: cost, usedTimeMinutes: elapsed,
        maxSequence: 1,
        correlation: jointCorrelation ?? undefined,
        previouslySelected,
      });
      actionId = decision.should_investigate ? decision.selected[0]?.action_id ?? null : null;
    }
    if (!actionId) break;
    const action = policy!.actions.find(item => item.id === actionId)!;
    used.add(action.id);
    const covered = coverageFor(action.id, target);
    for (const regionId of covered) {
      const trueHypothesis = setup.trueByRegion.get(regionId)!;
      const outcomeRng = mulberry32(
        seed * 7_919 + trial * 104_729 + round * 1_009 + hashString(regionId) + hashString(action.kind),
      );
      const outcome = sampleOutcome(action.kind, trueHypothesis, outcomeRng);
      beliefs.set(regionId, applyEvidence(policy!, beliefs.get(regionId) ?? priorBelief(policy!), action.kind, outcome));
      coverageCount.set(regionId, (coverageCount.get(regionId) ?? 0) + 1);
    }
    previouslySelected.push({ action_id: action.id, kind: action.kind, covered_regions: covered });
    actions += 1;
    cost += action.resource_cost;
    elapsed += action.time_cost_minutes;
  }

  const finalRiskPerRegion = scenario.regions.map(region => expectedRisk(policy!, beliefs.get(region.id) ?? priorBelief(policy!)));
  const finalEntropy = scenario.regions.reduce((sum, region) => sum + entropy(beliefs.get(region.id) ?? priorBelief(policy!)), 0);
  let detectionCorrect = 0;
  let decisionCorrect = 0;
  let trueCongested = 0;
  let detectedCongested = 0;
  let congestedCovered = 0;
  const coveredRegions = new Set<string>();
  for (const entry of previouslySelected) for (const regionId of entry.covered_regions) coveredRegions.add(regionId);
  for (const region of scenario.regions) {
    const truth = setup.trueByRegion.get(region.id)!;
    const belief = beliefs.get(region.id) ?? priorBelief(policy!);
    if (argmaxHypothesis(belief) === truth) detectionCorrect += 1;
    if (posteriorDecision(policy, belief) === trueDecision(truth)) decisionCorrect += 1;
    if (truth !== 'H_STABLE') {
      trueCongested += 1;
      if (argmaxHypothesis(belief) !== 'H_STABLE') detectedCongested += 1;
      if (coveredRegions.has(region.id)) congestedCovered += 1;
    }
  }

  return {
    strategy, seed, trial,
    initial_risk: Number(initialRisk.toFixed(6)),
    final_risk: Number(finalRiskPerRegion.reduce((a, b) => a + b, 0).toFixed(6)),
    benefit: Number((initialRisk - finalRiskPerRegion.reduce((a, b) => a + b, 0)).toFixed(6)),
    worst_final_risk: Number(Math.max(...finalRiskPerRegion).toFixed(6)),
    information_gain: Number((initialEntropy - finalEntropy).toFixed(6)),
    cost: Number(cost.toFixed(4)),
    elapsed_minutes: Number(elapsed.toFixed(4)),
    actions,
    unique_covered: coverageCount.size,
    coverage_count: Array.from(coverageCount.values()).reduce((a, b) => a + b, 0),
    detection_accuracy: Number((detectionCorrect / scenario.regions.length).toFixed(4)),
    decision_accuracy: Number((decisionCorrect / scenario.regions.length).toFixed(4)),
    true_congested: trueCongested,
    detected_congested: detectedCongested,
    congested_coverage: trueCongested === 0 ? 1 : Number((congestedCovered / trueCongested).toFixed(4)),
  };
}

/** Oracle 上界：知道真实状态，在预算内选择「动作 + 目标区域」以覆盖最多真实拥堵区域。 */
function runOracle(seed: number, trial: number, budget: number) {
  const setup = setupTrial(seed, trial);
  const trueCongested = scenario.regions.filter(region => setup.trueByRegion.get(region.id) !== 'H_STABLE').map(region => region.id);
  const targets = scenario.regions.map(region => region.id);
  const options: Array<{ actionId: string; target: string; coverage: Set<string>; cost: number }> = [];
  for (const action of policy!.actions) {
    for (const target of targets) {
      options.push({
        actionId: action.id,
        target,
        coverage: new Set(coverageFor(action.id, target)),
        cost: action.resource_cost,
      });
    }
  }
  const score = (coverage: Set<string>, cost: number) => {
    const covered = trueCongested.length === 0
      ? 1
      : trueCongested.filter(regionId => coverage.has(regionId)).length / trueCongested.length;
    return { covered, cost };
  };
  let best = { coverage: -1, cost: 0, actionIds: [] as string[], targets: [] as string[] };
  for (const option of options) {
    const result = score(option.coverage, option.cost);
    if (result.covered > best.coverage || (result.covered === best.coverage && result.cost < best.cost)) {
      best = { coverage: result.covered, cost: result.cost, actionIds: [option.actionId], targets: [option.target] };
    }
  }
  if (budget >= 2) {
    for (let i = 0; i < options.length; i += 1) {
      for (let j = i + 1; j < options.length; j += 1) {
        if (options[i].actionId === options[j].actionId) continue;
        const union = new Set([...options[i].coverage, ...options[j].coverage]);
        const result = score(union, options[i].cost + options[j].cost);
        if (result.covered > best.coverage || (result.covered === best.coverage && result.cost < best.cost)) {
          best = {
            coverage: result.covered,
            cost: result.cost,
            actionIds: [options[i].actionId, options[j].actionId],
            targets: [options[i].target, options[j].target],
          };
        }
      }
    }
  }
  return {
    strategy: 'oracle' as const,
    seed, trial,
    congested_coverage: Number(best.coverage.toFixed(4)),
    cost: Number(best.cost.toFixed(4)),
    true_congested: trueCongested.length,
    action_ids: best.actionIds,
    targets: best.targets,
    note: 'Oracle 知道真实状态并可选择目标区域；只作为检测覆盖上界，不参与配对显著性比较。',
  };
}

fs.mkdirSync(OUT, { recursive: true });

const rows: TrialResult[] = [];
for (const seed of SEEDS) {
  for (let trial = 0; trial < TRIALS; trial += 1) {
    for (const strategy of STRATEGIES) rows.push(runTrial(seed, trial, strategy, BUDGET));
  }
}
const oracleRows = [];
for (const seed of SEEDS.slice(0, 10)) {
  for (let trial = 0; trial < TRIALS; trial += 1) oracleRows.push(runOracle(seed, trial, BUDGET));
}

const summarize = (strategy: Strategy) => {
  const subset = rows.filter(row => row.strategy === strategy);
  return {
    n: subset.length,
    benefit: ci(subset.map(row => row.benefit)),
    worst_final_risk: ci(subset.map(row => row.worst_final_risk)),
    information_gain: ci(subset.map(row => row.information_gain)),
    cost: ci(subset.map(row => row.cost)),
    efficiency: ci(subset.map(row => row.benefit / Math.max(1e-6, row.cost))),
    detection_accuracy: ci(subset.map(row => row.detection_accuracy)),
    decision_accuracy: ci(subset.map(row => row.decision_accuracy)),
    congested_coverage: ci(subset.map(row => row.congested_coverage)),
    unique_covered: ci(subset.map(row => row.unique_covered)),
    actions: ci(subset.map(row => row.actions)),
  };
};

const summary = Object.fromEntries(STRATEGIES.map(strategy => [strategy, summarize(strategy)]));

const metrics = ['benefit', 'worst_final_risk', 'cost', 'efficiency', 'detection_accuracy'] as const;
const paired: Record<string, unknown> = {};
const holmFamilies: Record<string, Record<string, { raw: number; adjusted: number; rejected_0_05: boolean }>> = {};
for (const metric of metrics) {
  const pValues: Record<string, number> = {};
  const metricPaired: Record<string, unknown> = {};
  for (const other of STRATEGIES.filter(strategy => strategy !== 'joint')) {
    const diffs: number[] = [];
    const perSeed: number[][] = SEEDS.map(() => []);
    for (const row of rows.filter(item => item.strategy === 'joint')) {
      const counterpart = rows.find(item => item.strategy === other && item.seed === row.seed && item.trial === row.trial)!;
      const value = metric === 'efficiency'
        ? row.benefit / Math.max(1e-6, row.cost) - counterpart.benefit / Math.max(1e-6, counterpart.cost)
        : Number(row[metric]) - Number(counterpart[metric]);
      diffs.push(value);
      perSeed[SEEDS.indexOf(row.seed)].push(value);
    }
    metricPaired[other] = {
      mean_diff: Number(mean(diffs).toFixed(4)),
      ci: ci(diffs),
      bootstrap: bootstrap(diffs),
      cluster_bootstrap_by_seed: clusterBootstrap(perSeed),
      cohen_dz: dz(diffs),
      n_pairs: diffs.length,
    };
    pValues[other] = pairedPValue(diffs);
  }
  paired[metric] = metricPaired;
  holmFamilies[metric] = holm(pValues);
}

// 敏感性：联合 VoI 的相关性参数与预算（10 个种子）。
const sensitivity: Record<string, unknown> = {};
for (const correlation of [0, 0.5, 0.8]) {
  const subset: TrialResult[] = [];
  for (const seed of SEEDS.slice(0, 10)) {
    for (let trial = 0; trial < TRIALS; trial += 1) subset.push(runTrial(seed, trial, 'joint', BUDGET, correlation));
  }
  sensitivity[`correlation_${correlation}`] = {
    benefit: ci(subset.map(row => row.benefit)),
    worst_final_risk: ci(subset.map(row => row.worst_final_risk)),
    cost: ci(subset.map(row => row.cost)),
    detection_accuracy: ci(subset.map(row => row.detection_accuracy)),
  };
}
for (const budget of [1, 2, 3]) {
  const subset: TrialResult[] = [];
  for (const seed of SEEDS.slice(0, 10)) {
    for (let trial = 0; trial < TRIALS; trial += 1) subset.push(runTrial(seed, trial, 'joint', budget));
  }
  sensitivity[`budget_${budget}`] = {
    benefit: ci(subset.map(row => row.benefit)),
    worst_final_risk: ci(subset.map(row => row.worst_final_risk)),
    cost: ci(subset.map(row => row.cost)),
    actions: ci(subset.map(row => row.actions)),
  };
}

const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('joint_voi_rows.json', rows);
write('joint_voi_summary.json', {
  config: {
    seeds: SEEDS,
    trials_per_seed: TRIALS,
    strategies: STRATEGIES,
    budget_actions: BUDGET,
    trusted_observation_rate: QUALITY,
    ground_truth_correlation: GROUND_TRUTH_CORRELATION,
    joint_config: policy.joint ?? null,
    fairness: [
      '所有策略对同一物理动作获得相同覆盖区域',
      '观测结果按似然采样，随机数按 (seed,trial,round,region,kind) 共享',
      '预算准入统一为 used + candidate <= max',
      '目标区域按优先级轮换',
    ],
    data_nature: '合成数据；不代表真实人群行为或场馆效果。',
  },
  summary,
  paired,
  holm_families: holmFamilies,
  sensitivity,
  oracle: {
    n: oracleRows.length,
    congested_coverage: ci(oracleRows.map(row => row.congested_coverage)),
    cost: ci(oracleRows.map(row => row.cost)),
    note: 'Oracle 知道真实状态；只作为检测覆盖上界，不参与配对显著性比较。',
  },
  raw_oracle: oracleRows,
});

const report = `# V7.2 联合 VoI 公平对照实验

> 运行 ID：\`${RUN_ID}\`。**全部为合成数据**；所有策略共享动作覆盖、观测采样随机数与预算。
> 生成命令：\`npm run benchmark:v70 --prefix backend -- --only=joint-voi\`。

## 1. 主结果（30 种子 × 40 trial = 1200 对）

| 策略 | 风险降低 [95% CI] | 最坏区域终风险 | 信息增益 | 成本 | 效率 | 检测准确率 | 决策准确率 | 真实拥堵覆盖 | 覆盖区域 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${STRATEGIES.map(strategy => {
  const value = summary[strategy] as any;
  return `| ${strategy} | ${value.benefit.mean} [${value.benefit.lower}, ${value.benefit.upper}] | ${value.worst_final_risk.mean} | ${value.information_gain.mean} | ${value.cost.mean} | ${value.efficiency.mean} | ${value.detection_accuracy.mean} | ${value.decision_accuracy.mean} | ${value.congested_coverage.mean} | ${value.unique_covered.mean} |`;
}).join('\n')}

Oracle 上界（10 种子，知道真实状态）：真实拥堵区域覆盖 ${(ci(oracleRows.map(row => row.congested_coverage)) as any).mean}，成本 ${(ci(oracleRows.map(row => row.cost)) as any).mean}。**Oracle 不参与显著性比较。**

## 2. 配对比较（joint − 对照；正数表示 joint 数值更高）

${metrics.map(metric => `| 对照 | ${metric} 平均差 [95% CI] | 聚类 Bootstrap | d_z | Holm 校正 p | 显著 |\n| --- | --- | --- | --- | --- | --- |\n${STRATEGIES.filter(strategy => strategy !== 'joint').map(other => {
  const value = (paired[metric] as any)[other];
  const holmValue = holmFamilies[metric][other];
  return `| ${other} | ${value.mean_diff} [${value.ci.lower}, ${value.ci.upper}] | [${value.cluster_bootstrap_by_seed.lower}, ${value.cluster_bootstrap_by_seed.upper}] | ${value.cohen_dz} | ${holmValue.adjusted} | ${holmValue.rejected_0_05 ? '是' : '否'} |`;
}).join('\n')}`).join('\n\n')}

## 3. 敏感性与预算

- 相关性参数（benefit / worst risk / detection）：${[0, 0.5, 0.8].map(correlation => `${correlation}: ${(sensitivity as any)[`correlation_${correlation}`].benefit.mean} / ${(sensitivity as any)[`correlation_${correlation}`].worst_final_risk.mean} / ${(sensitivity as any)[`correlation_${correlation}`].detection_accuracy.mean}`).join('；')}。
- 预算 1/2/3（benefit / cost / actions）：${[1, 2, 3].map(budget => `${budget}: ${(sensitivity as any)[`budget_${budget}`].benefit.mean} / ${(sensitivity as any)[`budget_${budget}`].cost.mean} / ${(sensitivity as any)[`budget_${budget}`].actions.mean}`).join('；')}。
- 预算增加会提高收益与成本；不得只引用收益而不引用成本。

## 4. 解释边界

- 真实状态按 0.5 概率共享潜在因子生成；这是**合成相关性**，不是真实人群风险传播规律。
- 联合 VoI 是启发式近似（相关性 + 冗余折扣），不是联合 POMDP 精确解。
- 若 Holm 校正后不显著，只能报告“未发现明确优势”，不能宣称联合 VoI 全面优于现有多区域 VoI。
- 负向或混合结果必须保留；\`joint_voi_rows.json\` 含全部逐 trial 记录。
`;
fs.writeFileSync(path.join(OUT, 'joint_voi_README.md'), report);
fs.writeFileSync(path.join(OUT, 'joint_voi_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  scenario: { id: scenario.scenario_id, version: scenario.version, path: SCENARIO_PATH },
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);

const files = fs.readdirSync(OUT).filter(name => name.startsWith('joint_voi_')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'joint_voi_MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, note: 'V7.2 联合 VoI 实验独立清单。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.2 joint VoI benchmark complete: evaluation/v70/${RUN_ID}/`);
console.log(`joint benefit=${(summary.joint as any).benefit.mean}, multi=${(summary.multi as any).benefit.mean}`);
console.log(`joint worst=${(summary.joint as any).worst_final_risk.mean}, multi=${(summary.multi as any).worst_final_risk.mean}`);
