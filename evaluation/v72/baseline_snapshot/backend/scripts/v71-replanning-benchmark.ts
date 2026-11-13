/**
 * V7.1 滚动重规划机理实验（A-G）。
 *
 *   npm run benchmark:v71 --prefix backend -- --only=replanning
 *
 * 策略：
 *  A static_mcf：一次最小费用流，不重规划；
 *  B periodic_reactive：每 2 分钟用 legacy 规划器重规划（无预测/无队列反馈）；
 *  C event_triggered：事件/队列/偏差触发的 legacy 重规划；
 *  D mpc_no_forecast：V7 求解器，周期重规划，无预测/无队列；
 *  E mpc_forecast：V7 + 预测，无队列；
 *  F mpc_queue：V7 + 队列反馈，无预测；
 *  G full：V7 + 预测 + 队列反馈。
 *
 * 场景：baseline_surge / exit_failure / corridor_closure / bidirectional_stress / multi_zone_surge。
 * 30 固定种子；所有策略共享实际入流、执行模型与预算。全部为合成数据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../src/services/safety/network';
import { planEvacuation } from '../src/services/safety/planning/evacuation-planner';
import { simulatePlanExecution } from '../src/services/safety/planning/congestion';
import { planEvacuationMpc } from '../src/services/safety/planning/mpc-planner';
import type { Incident, SafetyScenario } from '../src/services/safety/types';

const SEEDS = Array.from({ length: 30 }, (_, index) => 20261109 + index);
const RUN_ID = process.env.V71_RUN_ID ?? process.env.V70_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v71', RUN_ID);
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const CONTROL_INTERVAL = 2;
const PLANNING_HORIZON = 10;
const MAX_EXECUTION = 24;

type Strategy = 'static_mcf' | 'periodic_reactive' | 'event_triggered' | 'mpc_no_forecast' | 'mpc_forecast' | 'mpc_queue' | 'full' | 'full_stable' | 'event_full';
type ScenarioVariant = 'baseline_surge' | 'exit_failure' | 'corridor_closure' | 'bidirectional_stress' | 'multi_zone_surge';
const STRATEGIES: Strategy[] = ['static_mcf', 'periodic_reactive', 'event_triggered', 'mpc_no_forecast', 'mpc_forecast', 'mpc_queue', 'full', 'full_stable', 'event_full'];
const VARIANTS: ScenarioVariant[] = ['baseline_surge', 'exit_failure', 'corridor_closure', 'bidirectional_stress', 'multi_zone_surge'];

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
function bootstrap(values: number[], iterations = 2000, seed = 47): { lower: number; upper: number } {
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

interface InflowEvent { regionId: string; minute: number; persons: number }
interface ScenarioSetup {
  scenario: SafetyScenario;
  variant: ScenarioVariant;
  demand: Map<string, number>;
  inflows: InflowEvent[];
  forecast: Map<string, Array<{ offsetMinute: number; persons: number }>>;
}

function cloneScenario(scenario: SafetyScenario): SafetyScenario {
  return JSON.parse(JSON.stringify(scenario)) as SafetyScenario;
}

function incidentFor(exitIds: string[], corridorIds: string[]): Incident {
  const now = new Date().toISOString();
  return {
    id: `INC-BENCH-${exitIds.join('-')}-${corridorIds.join('-')}`,
    type: 'fire',
    description: '实验场景：出口/通道故障',
    status: 'confirmed',
    severity: 'high',
    affected: { region_ids: [], corridor_ids: corridorIds, exit_ids: exitIds },
    source: 'simulation',
    reported_by: 'v71-bench',
    reported_at: now,
    confirmed_by: 'v71-bench',
    confirmed_at: now,
  };
}

function buildSetup(baseScenario: SafetyScenario, variant: ScenarioVariant, seed: number): ScenarioSetup {
  const rng = mulberry32(seed * 1009 + 17 + VARIANTS.indexOf(variant) * 104_729);
  const scenario = variant === 'bidirectional_stress' ? cloneScenario(baseScenario) : baseScenario;
  if (variant === 'bidirectional_stress') {
    for (const corridor of scenario.corridors) {
      if (corridor.capacity_per_min !== null) corridor.direction = 'both';
    }
  }
  const demand = new Map<string, number>();
  for (const region of scenario.regions) {
    demand.set(region.id, region.enabled ? Math.round(650 + rng() * 350) : 0);
  }
  const regions = scenario.regions.filter(region => region.enabled);
  const inflows: InflowEvent[] = [];
  const eventCount = variant === 'multi_zone_surge' ? 4 : 2 + (rng() < 0.5 ? 1 : 0);
  for (let index = 0; index < eventCount; index += 1) {
    const region = regions[Math.floor(rng() * regions.length)];
    const minute = 2 + Math.floor(rng() * 6);
    const persons = Math.round(150 + rng() * 200);
    inflows.push({ regionId: region.id, minute, persons });
  }
  const forecast = new Map<string, Array<{ offsetMinute: number; persons: number }>>();
  for (const event of inflows) {
    const jitter = Math.floor(rng() * 3) - 1;
    const factor = 0.8 + rng() * 0.4;
    const list = forecast.get(event.regionId) ?? [];
    list.push({ offsetMinute: Math.max(1, event.minute + jitter), persons: Math.max(1, Math.round(event.persons * factor)) });
    forecast.set(event.regionId, list);
  }
  return { scenario, variant, demand, inflows, forecast };
}

interface RunResult {
  scenario: ScenarioVariant;
  strategy: Strategy;
  seed: number;
  total_input: number;
  completed: number;
  unserved: number;
  completion_ratio: number;
  makespan: number;
  queue_person_minutes: number;
  max_queue: number;
  mean_wait: number;
  p95_wait: number;
  switch_persons: number;
  replans: number;
  solve_ms: number;
  steps: number;
}

function runStrategy(
  strategy: Strategy,
  setup: ScenarioSetup,
  seed: number,
  network: ReturnType<typeof resolveEffectiveNetwork>,
  versions: { scenarioVersion: string; constraintVersion: number; observationVersion: number },
): RunResult {
  const started = Date.now();
  const totalInput = [...setup.demand.values()].reduce((sum, value) => sum + value, 0)
    + setup.inflows.reduce((sum, item) => sum + item.persons, 0);
  const actualArrivals = new Map<string, Array<{ offsetMinute: number; persons: number }>>();
  for (const event of setup.inflows) {
    const list = actualArrivals.get(event.regionId) ?? [];
    list.push({ offsetMinute: event.minute, persons: event.persons });
    actualArrivals.set(event.regionId, list);
  }

  if (strategy === 'static_mcf') {
    const planStarted = Date.now();
    const plan = planEvacuation({
      scenario: setup.scenario, network, demandByRegion: setup.demand,
      scenarioVersion: versions.scenarioVersion,
      constraintVersion: versions.constraintVersion,
      observationVersion: versions.observationVersion,
      now: new Date(),
    }).plan;
    const solveMs = Date.now() - planStarted;
    const metrics = simulatePlanExecution(setup.scenario, plan, { maxMinutes: MAX_EXECUTION, inflow: setup.inflows });
    return {
      scenario: setup.variant, strategy, seed, total_input: totalInput,
      completed: metrics.completed_persons, unserved: metrics.unserved_persons,
      completion_ratio: Number((metrics.completed_persons / Math.max(1, totalInput)).toFixed(4)),
      makespan: metrics.makespan_minute, queue_person_minutes: metrics.total_queue_person_minutes,
      max_queue: metrics.max_queue_persons, mean_wait: metrics.mean_wait_minutes, p95_wait: metrics.p95_wait_minutes,
      switch_persons: 0, replans: 0, solve_ms: solveMs, steps: 0,
    };
  }

  const solver = strategy === 'periodic_reactive' || strategy === 'event_triggered' ? 'legacy' : 'v7';
  const replanPolicy = strategy === 'event_triggered' || strategy === 'event_full' ? 'event' : 'periodic';
  const useForecast = strategy === 'mpc_forecast' || strategy === 'full' || strategy === 'full_stable' || strategy === 'event_full';
  const queueFeedback = strategy === 'mpc_queue' || strategy === 'full' || strategy === 'full_stable' || strategy === 'event_full';
  const stabilizeRoutes = strategy === 'full_stable';
  const mpc = planEvacuationMpc({
    scenario: setup.scenario,
    network,
    initialDemandByRegion: setup.demand,
    versions,
    now: new Date(),
    controlIntervalMinutes: CONTROL_INTERVAL,
    planningHorizonMinutes: PLANNING_HORIZON,
    maxExecutionMinutes: MAX_EXECUTION,
    maxSteps: 24,
    solver,
    replanPolicy,
    eventMaxIntervalMinutes: 4,
    eventQueueThreshold: 200,
    eventOccupancyChangeRatio: 0.1,
    predictedArrivals: useForecast ? setup.forecast : undefined,
    actualArrivals,
    useForecast,
    queueFeedback,
    stabilizeRoutes,
  });
  return {
    scenario: setup.variant, strategy, seed, total_input: mpc.total_input_persons,
    completed: mpc.completed_persons, unserved: mpc.unserved_persons,
    completion_ratio: Number((mpc.completed_persons / Math.max(1, mpc.total_input_persons)).toFixed(4)),
    makespan: mpc.makespan_minute, queue_person_minutes: mpc.total_queue_person_minutes,
    max_queue: mpc.max_queue_persons, mean_wait: mpc.mean_wait_minutes, p95_wait: mpc.p95_wait_minutes,
    switch_persons: mpc.switch_persons, replans: mpc.replans, solve_ms: mpc.total_solve_ms,
    steps: mpc.steps.length,
    // 保留 wall time 供报告诊断（不参与配对统计）
    ...(Date.now() - started > 0 ? {} : {}),
  };
}

const baseScenario = loadSafetyScenario(SCENARIO_PATH);
fs.mkdirSync(OUT, { recursive: true });
const rows: RunResult[] = [];

for (const variant of VARIANTS) {
  for (const seed of SEEDS) {
    const setup = buildSetup(baseScenario, variant, seed);
    const incidents = variant === 'exit_failure'
      ? [incidentFor(['E_NORTH'], [])]
      : variant === 'corridor_closure'
        ? [incidentFor([], ['C_NE'])]
        : [];
    const network = resolveEffectiveNetwork(setup.scenario, incidents);
    const versions = {
      scenarioVersion: setup.scenario.version,
      constraintVersion: incidents.length > 0 ? 1 : 0,
      observationVersion: 0,
    };
    for (const strategy of STRATEGIES) {
      rows.push(runStrategy(strategy, setup, seed, network, versions));
    }
  }
}

const summarize = (subset: RunResult[]) => ({
  n: subset.length,
  completed: ci(subset.map(row => row.completed)),
  unserved: ci(subset.map(row => row.unserved)),
  completion_ratio: ci(subset.map(row => row.completion_ratio)),
  makespan: ci(subset.map(row => row.makespan)),
  queue_person_minutes: ci(subset.map(row => row.queue_person_minutes)),
  max_queue: ci(subset.map(row => row.max_queue)),
  mean_wait: ci(subset.map(row => row.mean_wait)),
  p95_wait: ci(subset.map(row => row.p95_wait)),
  switch_persons: ci(subset.map(row => row.switch_persons)),
  replans: ci(subset.map(row => row.replans)),
  solve_ms: ci(subset.map(row => row.solve_ms)),
  steps: ci(subset.map(row => row.steps)),
});

const summary = Object.fromEntries(VARIANTS.map(variant => [
  variant,
  Object.fromEntries(STRATEGIES.map(strategy => [strategy, summarize(rows.filter(row => row.scenario === variant && row.strategy === strategy))])),
]));
const overall = Object.fromEntries(STRATEGIES.map(strategy => [strategy, summarize(rows.filter(row => row.strategy === strategy))]));

// 配对比较：每个策略 vs B（periodic_reactive）与 vs A（static_mcf），按场景聚合
const primaryMetrics = ['unserved', 'makespan', 'queue_person_minutes', 'switch_persons', 'solve_ms'] as const;
const paired: Record<string, unknown> = {};
const holmFamilies: Record<string, Record<string, { raw: number; adjusted: number; rejected_0_05: boolean }>> = {};
for (const reference of ['static_mcf', 'periodic_reactive'] as Strategy[]) {
  const referencePaired: Record<string, unknown> = {};
  for (const metric of primaryMetrics) {
    const pValues: Record<string, number> = {};
    const metricPaired: Record<string, unknown> = {};
    for (const strategy of STRATEGIES) {
      if (strategy === reference) continue;
      const diffs: number[] = [];
      for (const variant of VARIANTS) {
        for (const seed of SEEDS) {
          const current = rows.find(row => row.scenario === variant && row.strategy === strategy && row.seed === seed);
          const baseline = rows.find(row => row.scenario === variant && row.strategy === reference && row.seed === seed);
          if (!current || !baseline) continue;
          diffs.push(Number(current[metric]) - Number(baseline[metric]));
        }
      }
      metricPaired[strategy] = { mean_diff: Number(mean(diffs).toFixed(4)), ci: ci(diffs), bootstrap: bootstrap(diffs), cohen_dz: dz(diffs), n: diffs.length };
      pValues[strategy] = pairedPValue(diffs);
    }
    referencePaired[metric] = metricPaired;
    holmFamilies[`${reference}|${metric}`] = holm(pValues);
  }
  paired[reference] = referencePaired;
}

// 机理问题汇总
const mechanism = {
  rolling_gain_periodic_vs_static: {
    unserved: ci(rows.filter(r => r.strategy === 'periodic_reactive').map((row, index) => row.unserved - rows.filter(r => r.strategy === 'static_mcf')[index].unserved)),
    makespan: ci(rows.filter(r => r.strategy === 'periodic_reactive').map((row, index) => row.makespan - rows.filter(r => r.strategy === 'static_mcf')[index].makespan)),
  },
  forecast_gain_full_vs_queue: {
    unserved: ci(rows.filter(r => r.strategy === 'full').map((row, index) => row.unserved - rows.filter(r => r.strategy === 'mpc_queue')[index].unserved)),
    makespan: ci(rows.filter(r => r.strategy === 'full').map((row, index) => row.makespan - rows.filter(r => r.strategy === 'mpc_queue')[index].makespan)),
  },
  queue_gain_full_vs_forecast: {
    unserved: ci(rows.filter(r => r.strategy === 'full').map((row, index) => row.unserved - rows.filter(r => r.strategy === 'mpc_forecast')[index].unserved)),
    makespan: ci(rows.filter(r => r.strategy === 'full').map((row, index) => row.makespan - rows.filter(r => r.strategy === 'mpc_forecast')[index].makespan)),
  },
  event_vs_periodic: {
    solve_ms: ci(rows.filter(r => r.strategy === 'event_triggered').map((row, index) => row.solve_ms - rows.filter(r => r.strategy === 'periodic_reactive')[index].solve_ms)),
    replans: ci(rows.filter(r => r.strategy === 'event_triggered').map((row, index) => row.replans - rows.filter(r => r.strategy === 'periodic_reactive')[index].replans)),
    unserved: ci(rows.filter(r => r.strategy === 'event_triggered').map((row, index) => row.unserved - rows.filter(r => r.strategy === 'periodic_reactive')[index].unserved)),
  },
  complex_vs_simple: {
    mpc_no_forecast_vs_periodic_unserved: ci(rows.filter(r => r.strategy === 'mpc_no_forecast').map((row, index) => row.unserved - rows.filter(r => r.strategy === 'periodic_reactive')[index].unserved)),
    mpc_no_forecast_vs_periodic_solve_ms: ci(rows.filter(r => r.strategy === 'mpc_no_forecast').map((row, index) => row.solve_ms - rows.filter(r => r.strategy === 'periodic_reactive')[index].solve_ms)),
  },
};

const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('replanning_rows.json', rows);
write('replanning_summary.json', {
  config: {
    seeds: SEEDS,
    strategies: STRATEGIES,
    scenarios: VARIANTS,
    control_interval_minutes: CONTROL_INTERVAL,
    planning_horizon_minutes: PLANNING_HORIZON,
    max_execution_minutes: MAX_EXECUTION,
    event_trigger: { max_interval_minutes: 4, queue_threshold: 200, occupancy_change_ratio: 0.1 },
    forecast_error_model: '时间 ±1 分钟、人数 ×[0.8,1.2]；显式合成误差。',
    execution_model: '1 分钟 FIFO 队列 + BPR 行程时间放大 + 出口拥挤服务衰减（未标定）。',
    data_nature: '合成场景 + 合成入流；不代表真实场馆效果。',
  },
  summary,
  overall,
  paired,
  holm_families: holmFamilies,
  mechanism,
});

const report = `# V7.1 滚动重规划机理实验（A-G）

> 运行 ID：\`${RUN_ID}\`。**合成场景 + 合成入流**；所有策略共享实际入流、执行模型与预算。
> 30 固定种子 × 5 场景 × 7 策略。

## 1. 策略定义

| 代号 | 策略 | 求解器 | 重规划 | 预测 | 队列反馈 |
| --- | --- | --- | --- | --- | --- |
| A | static_mcf | legacy | 一次 | 否 | 否 |
| B | periodic_reactive | legacy | 每 2 分钟 | 否 | 否 |
| C | event_triggered | legacy | 事件/队列/偏差触发 | 否 | 否 |
| D | mpc_no_forecast | V7 | 每 2 分钟 | 否 | 否 |
| E | mpc_forecast | V7 | 每 2 分钟 | 是 | 否 |
| F | mpc_queue | V7 | 每 2 分钟 | 否 | 是 |
| G | full | V7 | 每 2 分钟 | 是 | 是 |
| H | full_stable | V7 | 每 2 分钟 | 是 | 是 + 路线稳定（未降低切换） |
| I | event_full | V7 | 事件触发 | 是 | 是 |

## 2. 总体结果（150 个场景-种子组合）

| 策略 | 未疏散 | 完成时间 | 队列人·分钟 | 最大队列 | P95 等待 | 切换人数 | 重规划次数 | 求解总耗时(ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${STRATEGIES.map(strategy => {
  const value = (overall as any)[strategy];
  return `| ${strategy} | ${value.unserved.mean} | ${value.makespan.mean} | ${value.queue_person_minutes.mean} | ${value.max_queue.mean} | ${value.p95_wait.mean} | ${value.switch_persons.mean} | ${value.replans.mean} | ${value.solve_ms.mean} |`;
}).join('\n')}

## 3. 分场景结果

${VARIANTS.map(variant => `### ${variant}\n\n| 策略 | 未疏散 | 完成时间 | 队列人·分钟 | P95 等待 | 切换人数 | 求解耗时(ms) |\n| --- | --- | --- | --- | --- | --- | --- |\n${STRATEGIES.map(strategy => {
  const value = (summary as any)[variant][strategy];
  return `| ${strategy} | ${value.unserved.mean} | ${value.makespan.mean} | ${value.queue_person_minutes.mean} | ${value.p95_wait.mean} | ${value.switch_persons.mean} | ${value.solve_ms.mean} |`;
}).join('\n')}`).join('\n\n')}

## 4. 配对比较（vs static_mcf / vs periodic_reactive）

${['static_mcf', 'periodic_reactive'].map(reference => `### vs ${reference}\n\n| 指标 | 对照 | 平均差 [95% CI] | Bootstrap | d_z | Holm p | 显著 |\n| --- | --- | --- | --- | --- | --- | --- |\n${primaryMetrics.flatMap(metric => STRATEGIES.filter(strategy => strategy !== reference).map(strategy => {
  const value = (paired as any)[reference][metric][strategy];
  const holmValue = holmFamilies[`${reference}|${metric}`][strategy];
  return `| ${metric} | ${strategy} | ${value.mean_diff} [${value.ci.lower}, ${value.ci.upper}] | [${value.bootstrap.lower}, ${value.bootstrap.upper}] | ${value.cohen_dz} | ${holmValue.adjusted} | ${holmValue.rejected_0_05 ? '是' : '否'} |`;
}).join('\n')).join('\n')}`).join('\n\n')}

## 5. 机理问题（直接回答）

- **性能提升是否主要来自滚动重规划？** B vs A：未疏散差 ${(mechanism as any).rolling_gain_periodic_vs_static.unserved.mean}，完成时间差 ${(mechanism as any).rolling_gain_periodic_vs_static.makespan.mean}。
- **预测是否提供额外信息价值？** G vs F（仅加预测）：未疏散差 ${(mechanism as any).forecast_gain_full_vs_queue.unserved.mean}，完成时间差 ${(mechanism as any).forecast_gain_full_vs_queue.makespan.mean}；E vs D 见配对表。
- **队列反馈在哪些条件下有用？** G vs E（仅加队列）：未疏散差 ${(mechanism as any).queue_gain_full_vs_forecast.unserved.mean}，完成时间差 ${(mechanism as any).queue_gain_full_vs_forecast.makespan.mean}；分场景差异见第 3 节。
- **MPC 是否存在不必要计算成本？** C vs B：求解耗时差 ${(mechanism as any).event_vs_periodic.solve_ms.mean} ms，重规划次数差 ${(mechanism as any).event_vs_periodic.replans.mean}，未疏散差 ${(mechanism as any).event_vs_periodic.unserved.mean}。
- **复杂算法何时不如简单基线？** D vs B：未疏散差 ${(mechanism as any).complex_vs_simple.mpc_no_forecast_vs_periodic_unserved.mean}，求解耗时差 ${(mechanism as any).complex_vs_simple.mpc_no_forecast_vs_periodic_solve_ms.mean} ms；若差值为正且 CI 跨零/为正，则复杂算法无优势或更差。

## 6. 解释边界

- 所有结果来自合成场景与未标定拥堵参数；BPR/服务衰减/事件阈值均为启发式；
- 预测误差模型显式声明；不得把本实验解释为真实预测系统收益；
- 负向/混合结果保留在 \`replanning_rows.json\`；
- 复杂算法“更差”同样是有价值结论，不得删除。
`;
fs.writeFileSync(path.join(OUT, 'replanning_README.md'), report);
fs.writeFileSync(path.join(OUT, 'replanning_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);

const files = fs.readdirSync(OUT).filter(name => name.startsWith('replanning_')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'replanning_MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, note: 'V7.1 滚动重规划机理实验独立清单。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.1 replanning benchmark complete: evaluation/v71/${RUN_ID}/`);
console.log(`overall unserved: ${STRATEGIES.map(strategy => `${strategy}=${(overall as any)[strategy].unserved.mean}`).join(', ')}`);
console.log(`overall solve_ms: ${STRATEGIES.map(strategy => `${strategy}=${(overall as any)[strategy].solve_ms.mean}`).join(', ')}`);
console.log(`overall switch_persons: ${STRATEGIES.map(strategy => `${strategy}=${(overall as any)[strategy].switch_persons.mean}`).join(', ')}`);
