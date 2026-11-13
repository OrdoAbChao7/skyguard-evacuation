/**
 * V7.1 动态疏散规划对照实验。
 *
 *   npm run benchmark:v70 --prefix backend -- --only=planning
 *
 * 场景：合成体育场网络 + 随机初始需求 + 时间变化入流（surge）。
 * 策略：
 *   static_mcf（一次最小费用流）、shortest_path（容量盲）、max_flow、
 *   milp_restricted（受限二进制出口分配精确枚举）、
 *   reactive_mcf（每控制步重规划，无预测）、
 *   mpc_forecast（预测 + 无队列反馈）、mpc_queue（预测 + 队列反馈，提出方案）。
 *
 * 所有策略面对**相同**的实际入流与执行模型；只有 mpc_* 使用带误差的预测。
 * 执行模型：1 分钟离散 FIFO 队列 + BPR 行程时间放大（未标定启发式）。
 * 指标：完成时间、未疏散、队列人·分钟、最大队列、平均/P95 等待、出口利用、切换成本。
 *
 * 全部为合成数据；不代表真实场馆疏散效果。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../src/services/safety/network';
import { planEvacuation } from '../src/services/safety/planning/evacuation-planner';
import { simulatePlanExecution, simulateRoutesExecution, plannedCompletion } from '../src/services/safety/planning/congestion';
import { planEvacuationMpc } from '../src/services/safety/planning/mpc-planner';
import { planMaxFlow, planRestrictedMilp, planShortestPath } from '../src/services/safety/planning/strategies';
import { validateSafetyPlan } from '../src/services/safety/validator';
import { buildObservation } from '../src/services/safety/observations';
import type { DensityObservation, SafetyScenario } from '../src/services/safety/types';

const SEEDS = Array.from({ length: 30 }, (_, index) => 20261109 + index);
const RUN_ID = process.env.V70_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v70', RUN_ID);
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const CONTROL_INTERVAL = 2;
const PLANNING_HORIZON = 10;
const MAX_EXECUTION = 24;

type Strategy = 'static_mcf' | 'shortest_path' | 'max_flow' | 'milp_restricted' | 'reactive_mcf' | 'mpc_forecast' | 'mpc_queue';
const STRATEGIES: Strategy[] = ['static_mcf', 'shortest_path', 'max_flow', 'milp_restricted', 'reactive_mcf', 'mpc_forecast', 'mpc_queue'];

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
function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  const v = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function bootstrap(values: number[], iterations = 2000, seed = 31): { lower: number; upper: number } {
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

interface InflowEvent {
  regionId: string;
  minute: number;
  persons: number;
}

function generateScenario(seed: number, scenario: SafetyScenario): {
  demand: Map<string, number>;
  inflows: InflowEvent[];
  forecast: Map<string, Array<{ offsetMinute: number; persons: number }>>;
} {
  const rng = mulberry32(seed * 1_009 + 17);
  const demand = new Map<string, number>();
  for (const region of scenario.regions) {
    // 容量受压场景：初始需求接近出口/通道能力上限，便于比较动态规划。
    demand.set(region.id, region.enabled ? Math.round(650 + rng() * 350) : 0);
  }
  const regions = scenario.regions.filter(region => region.enabled);
  const inflows: InflowEvent[] = [];
  const forecast = new Map<string, Array<{ offsetMinute: number; persons: number }>>();
  const eventCount = 2 + (rng() < 0.5 ? 1 : 0);
  for (let index = 0; index < eventCount; index += 1) {
    const region = regions[Math.floor(rng() * regions.length)];
    const minute = 2 + Math.floor(rng() * 6);
    const persons = Math.round(150 + rng() * 200);
    inflows.push({ regionId: region.id, minute, persons });
    // 预测误差模型：时间 ±1 分钟、人数 ×[0.8, 1.2]；这是显式声明的合成预测误差。
    const jitter = Math.floor(rng() * 3) - 1;
    const factor = 0.8 + rng() * 0.4;
    const list = forecast.get(region.id) ?? [];
    list.push({ offsetMinute: Math.max(1, minute + jitter), persons: Math.max(1, Math.round(persons * factor)) });
    forecast.set(region.id, list);
  }
  return { demand, inflows, forecast };
}

function observationsFor(scenario: SafetyScenario, demand: Map<string, number>, now: Date): Map<string, DensityObservation> {
  const map = new Map<string, DensityObservation>();
  for (const region of scenario.regions) {
    const count = demand.get(region.id) ?? 0;
    if (count <= 0) continue;
    map.set(region.id, buildObservation({
      region, count, confidence: 0.95, source: 'simulation', provider: 'v70-bench',
      modelVersion: 'v70/1.0.0', observedAt: now, receivedAt: now,
    }));
  }
  return map;
}

interface RunResult {
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
  runtime_ms: number;
  plan_unresolved: number;
  validator_valid: boolean | null;
  validator_codes: string[];
}

function runStrategy(
  strategy: Strategy,
  seed: number,
  scenario: SafetyScenario,
  network: ReturnType<typeof resolveEffectiveNetwork>,
  setup: ReturnType<typeof generateScenario>,
): RunResult {
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const now = new Date();
  const started = Date.now();
  const totalInput = [...setup.demand.values()].reduce((sum, value) => sum + value, 0)
    + setup.inflows.reduce((sum, item) => sum + item.persons, 0);
  let completed = 0;
  let unserved = 0;
  let makespan = 0;
  let queuePersonMinutes = 0;
  let maxQueue = 0;
  let meanWait = 0;
  let p95Wait = 0;
  let switchPersons = 0;
  let planUnresolved = 0;
  let validatorValid: boolean | null = null;
  let validatorCodes: string[] = [];

  const validate = (plan: ReturnType<typeof planEvacuation>['plan']) => {
    const validation = validateSafetyPlan({
      plan, scenario, network,
      latestObservations: observationsFor(scenario, setup.demand, now),
      config: scenario.config,
      constraintVersion: 0,
      observationVersion: 0,
      now,
    });
    validatorValid = validation.valid;
    validatorCodes = validation.violations.map(item => item.code);
  };

  if (strategy === 'static_mcf' || strategy === 'shortest_path' || strategy === 'max_flow' || strategy === 'milp_restricted') {
    let plan;
    if (strategy === 'static_mcf') plan = planEvacuation({ scenario, network, demandByRegion: setup.demand, ...versions, now }).plan;
    else if (strategy === 'shortest_path') plan = planShortestPath({ scenario, network, demandByRegion: setup.demand, versions, now }).plan;
    else if (strategy === 'max_flow') plan = planMaxFlow({ scenario, network, demandByRegion: setup.demand, versions, now }).plan;
    else plan = planRestrictedMilp({ scenario, network, demandByRegion: setup.demand, versions, now }).plan;
    planUnresolved = plan.unresolved_persons;
    validate(plan);
    const metrics = simulatePlanExecution(scenario, plan, { maxMinutes: MAX_EXECUTION, inflow: setup.inflows });
    completed = metrics.completed_persons;
    unserved = metrics.unserved_persons;
    makespan = metrics.makespan_minute;
    queuePersonMinutes = metrics.total_queue_person_minutes;
    maxQueue = metrics.max_queue_persons;
    meanWait = metrics.mean_wait_minutes;
    p95Wait = metrics.p95_wait_minutes;
  } else {
    const mpc = planEvacuationMpc({
      scenario, network, initialDemandByRegion: setup.demand, versions, now,
      controlIntervalMinutes: CONTROL_INTERVAL,
      planningHorizonMinutes: PLANNING_HORIZON,
      maxExecutionMinutes: MAX_EXECUTION,
      maxSteps: 20,
      predictedArrivals: strategy === 'reactive_mcf' ? undefined : setup.forecast,
      actualArrivals: new Map(Object.entries(
        setup.inflows.reduce((acc, event) => {
          const list = acc[event.regionId] ?? [];
          list.push({ offsetMinute: event.minute, persons: event.persons });
          acc[event.regionId] = list;
          return acc;
        }, {} as Record<string, Array<{ offsetMinute: number; persons: number }>>),
      )),
      useForecast: strategy !== 'reactive_mcf',
      queueFeedback: strategy !== 'mpc_forecast',
    });
    completed = mpc.completed_persons;
    unserved = mpc.unserved_persons;
    makespan = mpc.makespan_minute;
    queuePersonMinutes = mpc.total_queue_person_minutes;
    maxQueue = mpc.max_queue_persons;
    meanWait = mpc.mean_wait_minutes;
    p95Wait = mpc.p95_wait_minutes;
    switchPersons = mpc.switch_persons;
    planUnresolved = mpc.steps[0]?.plan.unresolved_persons ?? 0;
    // 只有第一步且第一步内没有实际入流时，才可对照当前观测做独立校验；
    // 否则需求包含尚未观测到的到达，属于条件投影。
    const arrivalsDueInFirstStep = setup.inflows.some(event => event.minute <= CONTROL_INTERVAL);
    if (strategy === 'reactive_mcf' && mpc.steps[0] && !arrivalsDueInFirstStep) validate(mpc.steps[0].plan);
    else validatorValid = null;
  }

  return {
    strategy, seed,
    total_input: totalInput,
    completed,
    unserved,
    completion_ratio: Number((completed / Math.max(1, totalInput)).toFixed(4)),
    makespan,
    queue_person_minutes: queuePersonMinutes,
    max_queue: maxQueue,
    mean_wait: meanWait,
    p95_wait: p95Wait,
    switch_persons: switchPersons,
    runtime_ms: Date.now() - started,
    plan_unresolved: planUnresolved,
    validator_valid: validatorValid,
    validator_codes: validatorCodes,
  };
}

function summarize(rows: RunResult[], strategy: Strategy) {
  const subset = rows.filter(row => row.strategy === strategy);
  const metric = (key: keyof RunResult) => ci(subset.map(row => Number(row[key])));
  return {
    n: subset.length,
    completed: metric('completed'),
    unserved: metric('unserved'),
    completion_ratio: metric('completion_ratio'),
    makespan: metric('makespan'),
    queue_person_minutes: metric('queue_person_minutes'),
    max_queue: metric('max_queue'),
    mean_wait: metric('mean_wait'),
    p95_wait: metric('p95_wait'),
    switch_persons: metric('switch_persons'),
    runtime_ms: metric('runtime_ms'),
    validator_valid_rate: Number((subset.filter(row => row.validator_valid === true).length / Math.max(1, subset.filter(row => row.validator_valid !== null).length)).toFixed(4)),
    plan_unresolved: metric('plan_unresolved'),
  };
}

const scenario = loadSafetyScenario(SCENARIO_PATH);
const network = resolveEffectiveNetwork(scenario, []);
fs.mkdirSync(OUT, { recursive: true });

const rows: RunResult[] = [];
for (const seed of SEEDS) {
  const setup = generateScenario(seed, scenario);
  console.error(`[v70-planning] seed ${seed}`);
  for (const strategy of STRATEGIES) {
    const started = Date.now();
    rows.push(runStrategy(strategy, seed, scenario, network, setup));
    console.error(`[v70-planning]   ${strategy} ${Date.now() - started}ms`);
  }
}

const summary = Object.fromEntries(STRATEGIES.map(strategy => [strategy, summarize(rows, strategy)]));

// 配对比较：每个策略 vs static_mcf 与 vs reactive_mcf（主指标：未疏散、完成时间、队列人·分钟）
const primaryMetrics: Array<keyof RunResult> = ['unserved', 'makespan', 'queue_person_minutes'];
const paired: Record<string, unknown> = {};
const holmFamilies: Record<string, Record<string, { raw: number; adjusted: number; rejected_0_05: boolean }>> = {};
for (const reference of ['static_mcf', 'reactive_mcf'] as Strategy[]) {
  paired[reference] = {};
  for (const metric of primaryMetrics) {
    const pValues: Record<string, number> = {};
    const metricPaired: Record<string, unknown> = {};
    for (const strategy of STRATEGIES) {
      if (strategy === reference) continue;
      const diffs = SEEDS.map(seed => {
        const current = rows.find(row => row.strategy === strategy && row.seed === seed)!;
        const baseline = rows.find(row => row.strategy === reference && row.seed === seed)!;
        return Number(current[metric]) - Number(baseline[metric]);
      });
      metricPaired[strategy] = {
        mean_diff: Number(mean(diffs).toFixed(4)),
        ci: ci(diffs),
        bootstrap: bootstrap(diffs),
        cohen_dz: dz(diffs),
      };
      pValues[strategy] = pairedPValue(diffs);
    }
    (paired[reference] as Record<string, unknown>)[metric] = metricPaired;
    holmFamilies[`${reference}|${metric}`] = holm(pValues);
  }
}

// 拥堵模型敏感性：同一静态方案在 scheduled / queue_nominal / queue_bpr 下；以及 mpc_queue。
const congestionModels = ['scheduled', 'queue_nominal', 'queue_bpr', 'mpc_queue'] as const;
const congestionSensitivity = Object.fromEntries(congestionModels.map(model => [model, {
  makespan: [] as number[],
  queue_person_minutes: [] as number[],
  unserved: [] as number[],
  completed: [] as number[],
}]));
for (const seed of SEEDS) {
  const setup = generateScenario(seed, scenario);
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const now = new Date();
  const plan = planEvacuation({ scenario, network, demandByRegion: setup.demand, ...versions, now }).plan;
  const totalInput = [...setup.demand.values()].reduce((sum, value) => sum + value, 0)
    + setup.inflows.reduce((sum, item) => sum + item.persons, 0);
  const planned = plannedCompletion(plan);
  congestionSensitivity.scheduled.makespan.push(planned.planned_makespan_minute);
  congestionSensitivity.scheduled.queue_person_minutes.push(0);
  congestionSensitivity.scheduled.unserved.push(totalInput - plan.evacuated_persons);
  congestionSensitivity.scheduled.completed.push(plan.evacuated_persons);
  const nominal = simulatePlanExecution(scenario, plan, { maxMinutes: MAX_EXECUTION, inflow: setup.inflows, bprA: 0 });
  congestionSensitivity.queue_nominal.makespan.push(nominal.makespan_minute);
  congestionSensitivity.queue_nominal.queue_person_minutes.push(nominal.total_queue_person_minutes);
  congestionSensitivity.queue_nominal.unserved.push(nominal.unserved_persons);
  congestionSensitivity.queue_nominal.completed.push(nominal.completed_persons);
  const bpr = simulatePlanExecution(scenario, plan, { maxMinutes: MAX_EXECUTION, inflow: setup.inflows, bprA: 0.15 });
  congestionSensitivity.queue_bpr.makespan.push(bpr.makespan_minute);
  congestionSensitivity.queue_bpr.queue_person_minutes.push(bpr.total_queue_person_minutes);
  congestionSensitivity.queue_bpr.unserved.push(bpr.unserved_persons);
  congestionSensitivity.queue_bpr.completed.push(bpr.completed_persons);
  const mpc = rows.find(row => row.strategy === 'mpc_queue' && row.seed === seed)!;
  congestionSensitivity.mpc_queue.makespan.push(mpc.makespan);
  congestionSensitivity.mpc_queue.queue_person_minutes.push(mpc.queue_person_minutes);
  congestionSensitivity.mpc_queue.unserved.push(mpc.unserved);
  congestionSensitivity.mpc_queue.completed.push(mpc.completed);
}
const congestionSummary = Object.fromEntries(Object.entries(congestionSensitivity).map(([model, values]) => [
  model,
  {
    makespan: ci(values.makespan),
    queue_person_minutes: ci(values.queue_person_minutes),
    unserved: ci(values.unserved),
    completed: ci(values.completed),
    note: model === 'scheduled'
      ? '计划口径：不考虑拥堵与队列，仅用于下界诊断；queue_person_minutes 未建模，记为 0。'
      : model === 'queue_nominal'
        ? '执行口径：显式 FIFO 队列，BPR 系数 a=0（无行程时间放大）。'
        : model === 'queue_bpr'
          ? '执行口径：显式 FIFO 队列 + BPR 行程时间放大（a=0.15, b=2）。'
          : 'MPC+Queue：预测 + 队列反馈 + 滚动重规划；执行口径同 queue_bpr。',
  },
]));

// 失败案例：mpc_queue 未疏散最多的 5 个种子；static_mcf 未疏散最多的 5 个种子。
const worstMpc = [...rows.filter(row => row.strategy === 'mpc_queue')].sort((a, b) => b.unserved - a.unserved).slice(0, 5);
const worstStatic = [...rows.filter(row => row.strategy === 'static_mcf')].sort((a, b) => b.unserved - a.unserved).slice(0, 5);

const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('planning_rows.json', rows);
write('planning_summary.json', {
  config: {
    seeds: SEEDS,
    strategies: STRATEGIES,
    control_interval_minutes: CONTROL_INTERVAL,
    planning_horizon_minutes: PLANNING_HORIZON,
    max_execution_minutes: MAX_EXECUTION,
    forecast_error_model: '时间 ±1 分钟、人数 ×[0.8,1.2]；显式合成误差，仅用于策略比较。',
    execution_model: '1 分钟离散 FIFO 队列 + BPR 行程时间放大（a=0.15, b=2，未标定）。',
    data_nature: '合成场景 + 合成入流；不代表真实场馆疏散效果。',
  },
  summary,
  paired,
  holm_families: holmFamilies,
  congestion_model_sensitivity: congestionSummary,
  worst_cases: { mpc_queue: worstMpc, static_mcf: worstStatic },
});

const report = `# V7.1 动态疏散规划对照实验

> 运行 ID：\`${RUN_ID}\`。**合成场景 + 合成入流**；所有策略面对相同实际入流与执行模型。
> 执行模型：1 分钟离散 FIFO 队列 + BPR 行程时间放大（a=0.15, b=2，未标定启发式）。

## 1. 主结果（30 种子，均值 [95% CI]）

| 策略 | 完成率 | 未疏散 | 完成时间(min) | 队列人·分钟 | 最大队列 | 平均等待 | P95 等待 | 切换人数 | 规划未解决 | 校验通过率 | 运行时间(ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${STRATEGIES.map(strategy => {
  const value = summary[strategy] as any;
  return `| ${strategy} | ${value.completion_ratio.mean} [${value.completion_ratio.lower}, ${value.completion_ratio.upper}] | ${value.unserved.mean} | ${value.makespan.mean} | ${value.queue_person_minutes.mean} | ${value.max_queue.mean} | ${value.mean_wait.mean} | ${value.p95_wait.mean} | ${value.switch_persons.mean} | ${value.plan_unresolved.mean} | ${value.validator_valid_rate} | ${value.runtime_ms.mean} |`;
}).join('\n')}

- 校验通过率只统计可以对应当前观测的方案（static/shortest/maxflow/milp/reactive 第一步）；带预测的 MPC 步骤是条件投影，不声明“已验证”。
- 静态策略只看到初始需求；入流到达后没有重规划，未疏散人数因此包含无法响应的新增人群。这是策略差异，不是执行模型缺陷。

## 2. 配对比较（30 个种子；主指标）

### 2.1 vs static_mcf（正数 = 该策略数值更高）

${primaryMetrics.map(metric => `| 策略 | ${metric} 平均差 [95% CI] | Bootstrap | d_z | Holm 校正 p | 显著 |\n| --- | --- | --- | --- | --- | --- |\n${STRATEGIES.filter(strategy => strategy !== 'static_mcf').map(strategy => {
  const value = (paired.static_mcf as any)[metric][strategy];
  const holmValue = holmFamilies[`static_mcf|${metric}`][strategy];
  return `| ${strategy} | ${value.mean_diff} [${value.ci.lower}, ${value.ci.upper}] | [${value.bootstrap.lower}, ${value.bootstrap.upper}] | ${value.cohen_dz} | ${holmValue.adjusted} | ${holmValue.rejected_0_05 ? '是' : '否'} |`;
}).join('\n')}`).join('\n\n')}

### 2.2 vs reactive_mcf（正数 = 该策略数值更高）

${primaryMetrics.map(metric => `| 策略 | ${metric} 平均差 [95% CI] | Bootstrap | d_z | Holm 校正 p | 显著 |\n| --- | --- | --- | --- | --- | --- |\n${STRATEGIES.filter(strategy => strategy !== 'reactive_mcf').map(strategy => {
  const value = (paired.reactive_mcf as any)[metric][strategy];
  const holmValue = holmFamilies[`reactive_mcf|${metric}`][strategy];
  return `| ${strategy} | ${value.mean_diff} [${value.ci.lower}, ${value.ci.upper}] | [${value.bootstrap.lower}, ${value.bootstrap.upper}] | ${value.cohen_dz} | ${holmValue.adjusted} | ${holmValue.rejected_0_05 ? '是' : '否'} |`;
}).join('\n')}`).join('\n\n')}

## 3. 拥堵模型敏感性（同一静态方案）

| 模型 | 完成时间 | 队列人·分钟 | 未疏散 | 已疏散 | 说明 |
| --- | --- | --- | --- | --- | --- |
${Object.entries(congestionSummary).map(([model, value]: [string, any]) => `| ${model} | ${value.makespan.mean} | ${value.queue_person_minutes.mean} | ${value.unserved.mean} | ${value.completed.mean} | ${value.note} |`).join('\n')}

- scheduled 是**计划口径下界**，不建模拥堵，不能与队列模型直接比较“效率”；表中保留是为了显示忽略拥堵会低估完成时间/排队。
- queue_nominal 与 queue_bpr 的差异说明：行程时间放大本身会改变绝对指标；策略排序是否稳定必须看第 2 节，而不是只看绝对值。

## 4. 失败案例（保留，不剔除）

- mpc_queue 未疏散最多的种子：${worstMpc.map(row => `seed ${row.seed}（未疏散 ${row.unserved}，完成率 ${row.completion_ratio}）`).join('；')}。
- static_mcf 未疏散最多的种子：${worstStatic.map(row => `seed ${row.seed}（未疏散 ${row.unserved}）`).join('；')}。
- 完整逐种子记录见 \`planning_rows.json\`。

## 5. 解释边界

- 预测误差模型是显式声明的合成误差（时间 ±1 分钟、人数 ×[0.8,1.2]），不代表真实预测系统；更强的预测误差会削弱 mpc_forecast/mpc_queue 的优势。
- MILP 是**受限候选出口集合上的精确枚举**（仅竞争最激烈的 ≤5 个区域参与二进制选择），不是全局 MILP 求解器；限制见 \`planning_summary.json\` 与代码注释。
- 结果只说明在给定合成网络、执行模型与参数下的相对表现，不证明真实场馆效果。
- 任何策略的“更好”都必须同时满足：Holm 校正后显著、且未以安全约束为代价（校验器通过率、未疏散人数）。
`;
fs.writeFileSync(path.join(OUT, 'planning_README.md'), report);

fs.writeFileSync(path.join(OUT, 'planning_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  scenario: { id: scenario.scenario_id, version: scenario.version, path: SCENARIO_PATH },
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);

const files = fs.readdirSync(OUT).filter(name => name.startsWith('planning_')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'planning_MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, note: 'V7.1 规划实验独立清单。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.1 planning benchmark complete: evaluation/v70/${RUN_ID}/`);
console.log(`static_mcf unserved=${(summary.static_mcf as any).unserved.mean}, mpc_queue unserved=${(summary.mpc_queue as any).unserved.mean}`);
console.log(`static_mcf makespan=${(summary.static_mcf as any).makespan.mean}, mpc_queue makespan=${(summary.mpc_queue as any).makespan.mean}`);
