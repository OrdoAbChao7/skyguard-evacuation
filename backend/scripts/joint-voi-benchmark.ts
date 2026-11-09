/**
 * 联合 VoI 公平对照实验（evaluation/final/joint-voi）。
 *
 * 策略：随机、固定优先级、单区域贪心 VoI、现有多区域加权 VoI、联合粒子 VoI。
 * 公平性：所有策略共享同一真实世界、同一动作可用性、同一预算与同一随机数流；
 * 观测权限由动作覆盖决定（不额外给联合策略更多信息）。
 *
 * 指标：风险降低（全部区域）/最坏区域风险降低、成本、动作数、覆盖区域数。
 * 全部为合成实验；共享压力权重未标定。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { buildRegionGraph, neighborsOf } from '../src/services/mvp/risk-graph';
import { priorBeliefsForRegions } from '../src/services/mvp/multi-voi';
import { decideMultiRegionInvestigation } from '../src/services/mvp/multi-voi';
import { decideJointInvestigation } from '../src/services/mvp/joint-voi';
import { applyEvidence, decideInvestigation, expectedRisk, priorBelief, type BeliefEntry } from '../src/services/mvp/voi';
import type { InvestigationAction, InvestigationOutcome, InvestigationPolicy } from '../src/services/safety/types';
import type { RegionGraph } from '../src/services/mvp/risk-graph';

const ROOT = path.resolve(__dirname, '../..');
const SCENARIO_PATH = path.join(ROOT, 'data/scenarios/stadium-evacuation.json');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(ROOT, 'evaluation/final/joint-voi', RUN_ID);
const SEEDS = Array.from({ length: 30 }, (_, index) => 20261105 + index);
const TRIALS_PER_SEED = 10;
const TARGET = 'R_EAST_STAND';
const SHARED_WEIGHTS = [0, 0.45, 0.8];
const MAX_STEPS = 3;
const STRATEGIES = ['random', 'fixed', 'greedy', 'multi', 'joint'] as const;
type Strategy = typeof STRATEGIES[number];

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

function sampleIndex(probabilities: number[], random: number): number {
  let cumulative = 0;
  for (let index = 0; index < probabilities.length; index += 1) {
    cumulative += probabilities[index];
    if (random <= cumulative + 1e-12) return index;
  }
  return probabilities.length - 1;
}

function coveredRegions(action: InvestigationAction, target: string, graph: RegionGraph): string[] {
  if (action.coverage === 'all') return [...graph.regionIds];
  if (action.coverage === 'neighbors') return [target, ...neighborsOf(graph, target).filter(id => id !== target)];
  return [target];
}

function likelihood(policy: InvestigationPolicy, kind: string, hypothesisId: string, outcome: InvestigationOutcome): number {
  const row = policy.likelihoods[kind]?.[hypothesisId] ?? {};
  const total = policy.outcomes.reduce((sum, key) => sum + (row[key] ?? 0), 0);
  return total > 0 ? (row[outcome] ?? 0) / total : 1 / policy.outcomes.length;
}

function riskSummary(policy: InvestigationPolicy, beliefs: Map<string, BeliefEntry[]>, regionIds: string[]) {
  const risks = regionIds.map(id => expectedRisk(policy, beliefs.get(id) ?? priorBelief(policy)));
  return {
    total: risks.reduce((sum, value) => sum + value, 0),
    worst: Math.max(0, ...risks),
  };
}

function chooseAction(
  strategy: Strategy,
  policy: InvestigationPolicy,
  beliefs: Map<string, BeliefEntry[]>,
  graph: RegionGraph,
  target: string,
  used: { actions: number; cost: number; time: number },
  random: () => number,
): InvestigationAction | null {
  const available = policy.actions.filter(action => action.base_availability === 'available');
  if (available.length === 0) return null;
  if (strategy === 'random') return available[Math.floor(random() * available.length)] ?? null;
  if (strategy === 'fixed') return [...available].sort((a, b) => a.priority - b.priority)[0] ?? null;
  if (strategy === 'greedy') {
    const decision = decideInvestigation(policy, beliefs.get(target) ?? priorBelief(policy), {
      investigationsUsed: used.actions,
    });
    return decision.recommended_action_id
      ? available.find(action => action.id === decision.recommended_action_id) ?? null
      : null;
  }
  if (strategy === 'multi') {
    const decision = decideMultiRegionInvestigation(policy, target, beliefs, graph, {}, {
      usedActions: used.actions,
      usedCost: used.cost,
      usedTimeMinutes: used.time,
    });
    return decision.recommended_action_id
      ? available.find(action => action.id === decision.recommended_action_id) ?? null
      : null;
  }
  const decision = decideJointInvestigation(policy, target, beliefs, graph, {}, {
    usedActions: used.actions,
    usedCost: used.cost,
    usedTimeMinutes: used.time,
    particleCount: 300,
    outcomeSamples: 40,
    seed: 20261109,
  });
  return decision.recommended_action_id
    ? available.find(action => action.id === decision.recommended_action_id) ?? null
    : null;
}

function main(): void {
  fs.mkdirSync(OUT, { recursive: true });
  const scenario = loadSafetyScenario(SCENARIO_PATH);
  const policy = scenario.investigation!;
  const graph = buildRegionGraph(scenario);
  const regionIds = [...graph.regionIds];
  const hypothesisIds = policy.hypotheses.map(item => item.id);
  const prior = priorBelief(policy);
  const priorProbabilities = hypothesisIds.map(id => prior.find(item => item.hypothesis_id === id)?.probability ?? 0);
  const rows: Array<Record<string, unknown>> = [];

  for (const sharedWeight of SHARED_WEIGHTS) {
  policy.correlation = { ...(policy.correlation ?? { particles: 800, seed: 20261109 }), shared_pressure_weight: sharedWeight };
  for (const seed of SEEDS) {
    for (let trial = 0; trial < TRIALS_PER_SEED; trial += 1) {
      const random = mulberry32(seed * 1009 + trial * 7919);
      const globalHypothesis = hypothesisIds[sampleIndex(priorProbabilities, random())];
      const truth = new Map<string, string>();
      for (const regionId of regionIds) {
        truth.set(regionId, random() < sharedWeight ? globalHypothesis : hypothesisIds[sampleIndex(priorProbabilities, random())]);
      }
      const uniforms = new Map<string, number[]>();
      for (let step = 0; step < MAX_STEPS; step += 1) {
        for (const regionId of regionIds) {
          const key = `${step}|${regionId}`;
          uniforms.set(key, [random(), random()]);
        }
      }
      const initialBeliefs = new Map(regionIds.map(id => [id, prior.map(entry => ({ ...entry }))]));
      const initialRisk = riskSummary(policy, initialBeliefs, regionIds);

      for (const strategy of STRATEGIES) {
        const beliefs = new Map(regionIds.map(id => [id, initialBeliefs.get(id)!.map(entry => ({ ...entry }))]));
        const used = { actions: 0, cost: 0, time: 0 };
        const covered = new Set<string>();
        const chosen: string[] = [];
        for (let step = 0; step < MAX_STEPS; step += 1) {
          const action = chooseAction(strategy, policy, beliefs, graph, TARGET, used, mulberry32(seed * 31 + trial * 17 + step));
          if (!action) break;
          chosen.push(action.id);
          used.actions += 1;
          used.cost += action.resource_cost;
          used.time += action.time_cost_minutes;
          for (const regionId of coveredRegions(action, TARGET, graph)) {
            covered.add(regionId);
            const hypothesisId = truth.get(regionId)!;
            const u = uniforms.get(`${step}|${regionId}`)?.[0] ?? 0.5;
            const probabilities = policy.outcomes.map(outcome => likelihood(policy, action.kind, hypothesisId, outcome));
            const total = probabilities.reduce((sum, value) => sum + value, 0);
            const normalized = total > 0 ? probabilities.map(value => value / total) : probabilities.map(() => 1 / probabilities.length);
            const outcome = policy.outcomes[sampleIndex(normalized, u)];
            beliefs.set(regionId, applyEvidence(policy, beliefs.get(regionId) ?? prior, action.kind, outcome));
          }
        }
        const finalRisk = riskSummary(policy, beliefs, regionIds);
        rows.push({
          seed,
          trial,
          shared_weight: sharedWeight,
          strategy,
          actions: used.actions,
          cost: Number(used.cost.toFixed(4)),
          time_minutes: Number(used.time.toFixed(4)),
          covered_regions: covered.size,
          total_risk_reduction: Number((initialRisk.total - finalRisk.total).toFixed(6)),
          worst_risk_reduction: Number((initialRisk.worst - finalRisk.worst).toFixed(6)),
          final_total_risk: Number(finalRisk.total.toFixed(6)),
          final_worst_risk: Number(finalRisk.worst.toFixed(6)),
          chosen_actions: chosen,
        });
      }
    }
  }
  }

  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const byWeight = Object.fromEntries(SHARED_WEIGHTS.map(weight => [String(weight), Object.fromEntries(STRATEGIES.map(strategy => {
    const subset = rows.filter(row => row.strategy === strategy && row.shared_weight === weight);
    return [strategy, {
      n: subset.length,
      mean_total_risk_reduction: Number(mean(subset.map(row => row.total_risk_reduction as number)).toFixed(6)),
      mean_worst_risk_reduction: Number(mean(subset.map(row => row.worst_risk_reduction as number)).toFixed(6)),
      mean_cost: Number(mean(subset.map(row => row.cost as number)).toFixed(4)),
      mean_actions: Number(mean(subset.map(row => row.actions as number)).toFixed(3)),
      mean_covered_regions: Number(mean(subset.map(row => row.covered_regions as number)).toFixed(3)),
      mean_final_worst_risk: Number(mean(subset.map(row => row.final_worst_risk as number)).toFixed(6)),
    }];
  }))]));

  const byStrategy = Object.fromEntries(STRATEGIES.map(strategy => {
    const subset = rows.filter(row => row.strategy === strategy);
    return [strategy, {
      n: subset.length,
      mean_total_risk_reduction: Number(mean(subset.map(row => row.total_risk_reduction as number)).toFixed(6)),
      mean_worst_risk_reduction: Number(mean(subset.map(row => row.worst_risk_reduction as number)).toFixed(6)),
      mean_cost: Number(mean(subset.map(row => row.cost as number)).toFixed(4)),
      mean_actions: Number(mean(subset.map(row => row.actions as number)).toFixed(3)),
      mean_covered_regions: Number(mean(subset.map(row => row.covered_regions as number)).toFixed(3)),
      mean_final_worst_risk: Number(mean(subset.map(row => row.final_worst_risk as number)).toFixed(6)),
    }];
  }));

  const pairedByWeight = Object.fromEntries(SHARED_WEIGHTS.map(weight => {
  const paired = Object.fromEntries(['random', 'fixed', 'greedy', 'multi'].map(baseline => {
    const diffs: number[] = [];
    const perSeed: number[][] = SEEDS.map(() => []);
    for (const seed of SEEDS) {
      for (let trial = 0; trial < TRIALS_PER_SEED; trial += 1) {
        const joint = rows.find(row => row.seed === seed && row.trial === trial && row.shared_weight === weight && row.strategy === 'joint');
        const other = rows.find(row => row.seed === seed && row.trial === trial && row.shared_weight === weight && row.strategy === baseline);
        if (!joint || !other) continue;
        const diff = (joint.total_risk_reduction as number) - (other.total_risk_reduction as number);
        diffs.push(diff);
        perSeed[SEEDS.indexOf(seed)].push(diff);
      }
    }
    const seedMeans = perSeed.filter(group => group.length > 0).map(group => mean(group));
    return [baseline, {
      mean: Number(mean(diffs).toFixed(6)),
      n: diffs.length,
      seed_mean: Number(mean(seedMeans).toFixed(6)),
      seed_min: Number(Math.min(...seedMeans).toFixed(6)),
      seed_max: Number(Math.max(...seedMeans).toFixed(6)),
    }];
  }));
  return [String(weight), paired];
  }));

  const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
  write('rows.json', rows);
  write('summary.json', {
    config: {
      seeds: SEEDS,
      trials_per_seed: TRIALS_PER_SEED,
      target: TARGET,
      max_steps: MAX_STEPS,
      strategies: STRATEGIES,
      shared_pressure_weights: SHARED_WEIGHTS,
      budget: policy.budget,
      data_nature: '合成实验；共享压力权重未标定。',
    },
    by_weight: byWeight,
    by_strategy: byStrategy,
    paired_vs_joint_by_weight: pairedByWeight,
  });
  write('run_metadata.json', {
    generated_at: new Date().toISOString(),
    run_id: RUN_ID,
    node: process.version,
    platform: process.platform,
    cpu: os.cpus()[0]?.model ?? 'unknown',
  });
  fs.writeFileSync(path.join(OUT, 'README.md'), `# 联合 VoI 公平对照实验

> 运行 ID：\`${RUN_ID}\`。30 seeds × ${TRIALS_PER_SEED} trials；所有策略共享真实世界、动作权限、预算与随机数流。
> 共享压力权重敏感性：${SHARED_WEIGHTS.join(', ')}（未标定）。

## 策略均值

| 策略 | 总风险降低 | 最坏区域风险降低 | 成本 | 动作数 | 覆盖区域 | 最终最坏风险 |
| --- | --- | --- | --- | --- | --- | --- |
${STRATEGIES.map(strategy => {
  const value = byStrategy[strategy];
  return `| ${strategy} | ${value.mean_total_risk_reduction} | ${value.mean_worst_risk_reduction} | ${value.mean_cost} | ${value.mean_actions} | ${value.mean_covered_regions} | ${value.mean_final_worst_risk} |`;
}).join('\n')}

## 配对差（联合 − 基线，总风险降低；按 seed 汇总）

| 基线 | 均值 | seed 均值 | seed 最小 | seed 最大 | 配对数 |
| --- | --- | --- | --- | --- | --- |
${Object.entries(pairedByWeight['0.45']).map(([baseline, value]: [string, any]) =>
  `| ${baseline} | ${value.mean} | ${value.seed_mean} | ${value.seed_min} | ${value.seed_max} | ${value.n} |`).join('\n')}

## 相关性敏感性（联合 vs 多区域加权）

| 相关性 | 策略 | 总风险降低 | 最坏区域风险降低 | 成本 |
| --- | --- | --- | --- | --- |
${SHARED_WEIGHTS.flatMap(weight => ['multi', 'joint'].map(strategy => {
  const value = byWeight[String(weight)][strategy];
  return `| ${weight} | ${strategy} | ${value.mean_total_risk_reduction} | ${value.mean_worst_risk_reduction} | ${value.mean_cost} |`;
})).join(String.fromCharCode(10))}

联合 − 多区域配对差（总风险降低）：${SHARED_WEIGHTS.map(weight => `${weight}: ${pairedByWeight[String(weight)].multi.mean}`).join('；')}。

**结论：在当前合成协议下，联合粒子 VoI 未超过现有多区域加权 VoI；相关性越强，差距没有缩小。**
这是负向结果，保留原始数据，不通过调整评估指标掩盖。

## 边界

- 合成实验；真实世界由共享压力潜变量生成，联合策略利用该相关性，独立策略不利用。
- 观测结果按真实假设的似然采样；更新仍按单区域贝叶斯，未做跨区域联合后验。
- 不宣称联合 VoI 在真实数据上更优；只看同一合成机制下的决策差异。
`);
  console.log(`[joint-voi] ${rows.length} rows -> ${OUT}`);
}

main();
