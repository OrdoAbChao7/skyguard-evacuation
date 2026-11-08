/**
 * VoI 公平性复跑（G06）。
 *
 * 与 V6.2 冻结实验的区别（只做必要修正，不改写旧的 V6.2 结果）：
 *  1. 所有策略执行同一物理动作时获得相同的动作覆盖区域
 *     （V6.2 中 `single` 策略被限制为只看目标区域，UAV 的 neighbors 覆盖被抹掉）；
 *  2. 观测结果按 `P(outcome | hypothesis, action)` 采样，
 *     而不是直接取最大似然标签；
 *  3. 预算准入使用统一的 `used + candidate <= max` 检查。
 *
 * 输出到 `evaluation/voi-v2/<run-id>/`，不覆盖 `evaluation/v62/`。
 * 全部为合成数据；结论只适用于该实验条件。
 *
 *   npm run benchmark:voi-v2 --prefix backend
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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

const SEEDS = Array.from({ length: 30 }, (_, index) => 20261105 + index);
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/voi-v2', RUN_ID);
const scenario: SafetyScenario = loadSafetyScenario(SCENARIO_PATH);
const policy = scenario.investigation;
if (!policy) throw new Error('缺少 investigation 策略');
fs.mkdirSync(OUT, { recursive: true });

type Strategy = 'single' | 'multi' | 'fixed' | 'random' | 'heuristic';

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
    thresholds: { watch_density: 1, high_density: 2, critical_density: 3, rise_rate_watch: 0.5, source: 'synthetic-voi-v2' },
    thresholdsSource: 'synthetic-voi-v2',
  };
}

/** 按 P(outcome | true hypothesis, action) 采样，而不是取最大似然标签。 */
function sampleOutcome(kind: string, trueH: string, rng: () => number): InvestigationOutcome {
  const row = policy!.likelihoods[kind as keyof typeof policy!.likelihoods]?.[trueH] ?? {};
  const probabilities = policy!.outcomes.map(outcome => row[outcome] ?? 0);
  return policy!.outcomes[sampleIndex(probabilities, rng)];
}

/** 物理动作的覆盖区域：与策略无关（G06 的核心修正）。 */
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
  for (const region of scenario.regions) {
    trueByRegion.set(region.id, policy!.hypotheses[sampleIndex(policy!.hypotheses.map(h => h.prior), rng)].id);
  }
  const risks = scenario.regions.map(region => makeRisk(region.id, trueByRegion.get(region.id)!, rng() < quality));
  return { trueByRegion, risks, beliefs: priorBeliefsForRegions(policy!, risks) };
}

function runTrial(seed: number, trial: number, strategy: Strategy, budget: number, quality: number) {
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
    // 相同物理动作 => 相同覆盖，不因策略名称缩减信息权限。
    const covered = coverageFor(action.id, target, graph);
    for (const regionId of covered) {
      const trueH = setup.trueByRegion.get(regionId)!;
      const rng = mulberry32(seed * 7_919 + trial * 104_729 + round * 1_009 + regionId.length * 31 + action.id.length);
      const outcome = sampleOutcome(action.kind, trueH, rng);
      beliefs.set(regionId, applyEvidence(policy!, beliefs.get(regionId) ?? priorBelief(policy!), action.kind, outcome));
      coverageCount.set(regionId, (coverageCount.get(regionId) ?? 0) + 1);
    }
    recordAttempt(session, action, { success: true, outcome: 'inconclusive' });
    actions += 1; cost += action.resource_cost; elapsed += action.time_cost_minutes;
  }

  const perRegionFinal = scenario.regions.map(region => expectedRisk(policy!, beliefs.get(region.id) ?? priorBelief(policy!)));
  const finalRisk = perRegionFinal.reduce((a, b) => a + b, 0);
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

const rows: Array<Record<string, unknown> & { strategy: Strategy; seed: number; trial: number; benefit: number; cost: number }> = [];
const strategies: Strategy[] = ['single', 'multi', 'fixed', 'random', 'heuristic'];
for (const seed of SEEDS) {
  for (let trial = 0; trial < 40; trial += 1) {
    for (const strategy of strategies) rows.push(runTrial(seed, trial, strategy, 2, 0.6));
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
  return { seed: row.seed, diff: row.benefit - other.benefit, cost_diff: row.cost - other.cost };
});
const diffs = paired.map(item => item.diff);
const seedMeans = SEEDS.map(seed => mean(paired.filter(item => item.seed === seed).map(item => item.diff)));
const groups = SEEDS.map(seed => paired.filter(item => item.seed === seed).map(item => item.diff));
const efficiencyDiffs = multi.map((row, index) =>
  row.benefit / Math.max(1e-6, row.cost) - single[index].benefit / Math.max(1e-6, single[index].cost));

const result = {
  config: {
    seeds: SEEDS,
    trials_per_seed: 40,
    strategies,
    budget_actions: 2,
    trusted_observation_rate: 0.6,
    design_corrections: [
      '所有策略对同一物理动作获得相同覆盖区域（V6.2 的 single 策略只覆盖目标区域）',
      '观测结果从似然分布采样，不使用最大似然标签',
      '预算准入使用 used + candidate <= max',
    ],
    target_policy: 'rotate（每轮依次选择下一个优先级区域）',
    data_nature: '合成数据；不代表真实人群行为或场馆效果。',
  },
  summary: Object.fromEntries(strategies.map(strategy => [strategy, summarize(strategy)])),
  paired: {
    trial_level: { mean: Number(mean(diffs).toFixed(4)), ci: ci(diffs), bootstrap: bootstrap(diffs), cohen_dz: dz(diffs), n: diffs.length },
    seed_level: { mean: Number(mean(seedMeans).toFixed(4)), ci: ci(seedMeans), n: seedMeans.length, values: seedMeans.map(value => Number(value.toFixed(4))) },
    cluster_bootstrap_by_seed: clusterBootstrap(groups),
    efficiency_diff: ci(efficiencyDiffs),
    cost_diff: ci(paired.map(item => item.cost_diff)),
  },
  raw: rows,
};
write('experiment_a_fair.json', result);

const frozenPath = path.resolve(__dirname, '../../evaluation/v62/experiment_a_multi_region_30seeds.json');
let frozen: { summary?: Record<string, { benefit?: { mean: number } }> } | null = null;
if (fs.existsSync(frozenPath)) {
  try { frozen = JSON.parse(fs.readFileSync(frozenPath, 'utf8')); } catch { frozen = null; }
}

const report = `# VoI 公平性复跑（G06 修正）

> 由 \`npm run benchmark:voi-v2 --prefix backend\` 生成；运行 ID：\`${RUN_ID}\`。
> **全部为合成数据**；本报告不覆盖 V6.2 冻结结果。

## 修正内容

1. 所有策略对同一物理动作获得**相同覆盖区域**；V6.2 中 \`single\` 只覆盖目标区域，UAV 的 neighbors 覆盖被抹掉。
2. 观测结果从 \`P(outcome | hypothesis, action)\` **采样**，不再取最大似然标签。
3. 预算准入统一为 \`used + candidate <= max\`。

## 结果（30 种子 × 40 trial = 1200 对）

| 策略 | 风险降低 [95% CI] | 成本 | 效率 | 覆盖区域 |
| --- | --- | --- | --- | --- |
${strategies.map(strategy => {
  const summary = summarize(strategy);
  return `| ${strategy} | ${summary.benefit.mean} [${summary.benefit.lower}, ${summary.benefit.upper}] | ${summary.cost.mean} | ${summary.efficiency.mean} | ${summary.unique_covered.mean} |`;
}).join('\n')}

- 多区域 vs 单区域配对差：${result.paired.trial_level.mean} [${result.paired.trial_level.ci.lower}, ${result.paired.trial_level.ci.upper}]，d_z=${result.paired.trial_level.cohen_dz}
- 按 seed 聚类 Bootstrap： [${result.paired.cluster_bootstrap_by_seed.lower}, ${result.paired.cluster_bootstrap_by_seed.upper}]
- 成本差（多 − 单）：${result.paired.cost_diff.mean} [${result.paired.cost_diff.lower}, ${result.paired.cost_diff.upper}]
- 效率差（多 − 单）：${result.paired.efficiency_diff.mean} [${result.paired.efficiency_diff.lower}, ${result.paired.efficiency_diff.upper}]

## 与 V6.2 冻结结果的关系

${frozen?.summary
  ? `V6.2 冻结结果（多区域/单区域风险降低）：${frozen.summary.multi?.benefit?.mean} / ${frozen.summary.single?.benefit?.mean}。本次修正了信息权限与采样方式，数值不会与 V6.2 相同；两套结果必须并列报告，不能用本次结果替换 V6.2 或反之。`
  : '未找到 V6.2 冻结结果；本报告独立成立。'}

## 解释边界

- 本实验只检验“相同动作、相同信息权限、相同预算”下的策略差异；参数仍是未标定的合成先验/似然/损失。
- 区间跨零时只能报告“未发现明确优势”，不能解释为等效或更优。
- 旧 V6.1/V6.2 报告与原始数据保留；本报告不修改冻结清单。
`;
fs.writeFileSync(path.join(OUT, 'README.md'), report);
write('run_metadata.json', {
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  seeds: SEEDS,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  scenario: { id: scenario.scenario_id, version: scenario.version, path: SCENARIO_PATH },
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
  data_nature: '全部为合成/模拟数据；不含真实人群、视频、无人机、昇腾或 AgentArts 实测。',
});

// 独立清单：不写入 evaluation/MANIFEST.json，避免改写 V6.2 冻结清单。
const manifestFiles = fs.readdirSync(OUT)
  .filter(name => name !== 'MANIFEST.json')
  .sort()
  .map(name => {
    const bytes = fs.readFileSync(path.join(OUT, name));
    return {
      path: name,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  });
fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), `${JSON.stringify({
  version: 1,
  run_id: RUN_ID,
  generated_at: new Date().toISOString(),
  note: 'voi-v2 独立证据清单；根 evaluation/MANIFEST.json（V6.2）保持冻结。',
  file_count: manifestFiles.length,
  files: manifestFiles,
}, null, 2)}\n`);
fs.writeFileSync(path.resolve(__dirname, '../../evaluation/voi-v2/LATEST.txt'), `${RUN_ID}\n`);

console.log(`VoI 公平性复跑完成：evaluation/voi-v2/${RUN_ID}/`);
console.log(`multi − single 配对差：${result.paired.trial_level.mean} [${result.paired.trial_level.ci.lower}, ${result.paired.trial_level.ci.upper}]`);
