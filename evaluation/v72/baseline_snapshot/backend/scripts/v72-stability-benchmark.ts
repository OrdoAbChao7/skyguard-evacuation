/**
 * V7.2 路线稳定性与安全 MPC 公平对照实验（A-F）。
 *
 *   npm run benchmark:v72 --prefix backend -- --only=stability
 *
 * 策略：
 *  A legacy_static      ：既有安全规划器，一次规划、不重规划；
 *  B mpc_standard       ：V7 时间扩展 MPC，无稳定性机制；
 *  C mpc_hysteresis     ：迟滞（目标改善不足则保持上一出口集合）；
 *  D mpc_switch_penalty ：切换惩罚（按受影响人数的惩罚后目标选择）；
 *  E mpc_commitment     ：承诺窗口（计划发布后优先保持上一出口）；
 *  F mpc_adaptive       ：自适应混合（拥堵/窗口内承诺，否则切换惩罚）。
 *
 * 场景：baseline_surge / exit_failure / corridor_closure / bidirectional_stress /
 *       multi_zone_surge / midrun_exit_failure（运行中出口故障，检验紧急覆盖）。
 * 30 固定种子；所有策略共享实际入流、执行模型、预算与预测误差模型。
 * 全部为合成数据；不代表真实场馆效果。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../src/services/safety/network';
import { planEvacuation } from '../src/services/safety/planning/evacuation-planner';
import { simulatePlanExecution, simulateRoutesExecution } from '../src/services/safety/planning/congestion';
import { planEvacuationMpc } from '../src/services/safety/planning/mpc-planner';
import { regionDensity, regionRiskRatio } from '../src/services/safety/planning/route-stability';
import type { Incident, SafetyScenario } from '../src/services/safety/types';

const SEEDS = Array.from({ length: 30 }, (_, index) => 20261110 + index);
const RUN_ID = process.env.V72_RUN_ID ?? process.env.V71_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v72', RUN_ID);
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const CONTROL_INTERVAL = 2;
const PLANNING_HORIZON = 10;
const MAX_EXECUTION = 24;

type Strategy = 'legacy_static' | 'mpc_standard' | 'mpc_hysteresis' | 'mpc_switch_penalty' | 'mpc_commitment' | 'mpc_adaptive';
type ScenarioVariant =
  | 'baseline_surge'
  | 'exit_failure'
  | 'corridor_closure'
  | 'bidirectional_stress'
  | 'multi_zone_surge'
  | 'midrun_exit_failure';
const STRATEGIES: Strategy[] = ['legacy_static', 'mpc_standard', 'mpc_hysteresis', 'mpc_switch_penalty', 'mpc_commitment', 'mpc_adaptive'];
const VARIANTS: ScenarioVariant[] = [
  'baseline_surge', 'exit_failure', 'corridor_closure', 'bidirectional_stress', 'multi_zone_surge', 'midrun_exit_failure',
];

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
  incidents: Incident[];
  midRunDisruptions: Array<{ minute: number; exit_ids: string[]; corridor_ids: string[]; description: string }>;
}

function cloneScenario(scenario: SafetyScenario): SafetyScenario {
  return JSON.parse(JSON.stringify(scenario)) as SafetyScenario;
}

function incidentFor(exitIds: string[], corridorIds: string[], suffix: string): Incident {
  const now = new Date().toISOString();
  return {
    id: `INC-V72-${suffix}-${exitIds.join('-')}-${corridorIds.join('-')}`,
    type: 'fire',
    description: '实验场景：出口/通道故障',
    status: 'confirmed',
    severity: 'high',
    affected: { region_ids: [], corridor_ids: corridorIds, exit_ids: exitIds },
    source: 'simulation',
    reported_by: 'v72-bench',
    reported_at: now,
    confirmed_by: 'v72-bench',
    confirmed_at: now,
  };
}

function buildSetup(baseScenario: SafetyScenario, variant: ScenarioVariant, seed: number): ScenarioSetup {
  const rng = mulberry32(seed * 1009 + 31 + VARIANTS.indexOf(variant) * 104_729);
  const scenario = variant === 'bidirectional_stress' ? cloneScenario(baseScenario) : baseScenario;
  if (variant === 'bidirectional_stress') {
    for (const corridor of scenario.corridors) {
      if (corridor.capacity_per_min !== null) corridor.direction = 'both';
    }
  }
  const demand = new Map<string, number>();
  for (const region of scenario.regions) {
    demand.set(region.id, region.enabled ? Math.round(700 + rng() * 400) : 0);
  }
  const regions = scenario.regions.filter(region => region.enabled);
  const inflows: InflowEvent[] = [];
  const eventCount = variant === 'multi_zone_surge' ? 4 : 2 + (rng() < 0.5 ? 1 : 0);
  for (let index = 0; index < eventCount; index += 1) {
    const region = regions[Math.floor(rng() * regions.length)];
    const minute = 2 + Math.floor(rng() * 6);
    const persons = Math.round(180 + rng() * 240);
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
  const incidents: Incident[] = [];
  const midRunDisruptions: ScenarioSetup['midRunDisruptions'] = [];
  if (variant === 'exit_failure') incidents.push(incidentFor(['E_NORTH'], [], 'EXIT'));
  if (variant === 'corridor_closure') incidents.push(incidentFor([], ['C_NE'], 'CORR'));
  if (variant === 'midrun_exit_failure') {
    midRunDisruptions.push({
      minute: 4,
      exit_ids: ['E_NORTH'],
      corridor_ids: [],
      description: '实验场景：第 4 分钟北出口故障（运行中注入）',
    });
  }
  return { scenario, variant, demand, inflows, forecast, incidents, midRunDisruptions };
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
  max_density: number;
  worst_risk_ratio: number;
  switch_persons: number;
  switch_events: number;
  replans: number;
  solve_ms: number;
  committed_steps: number;
  emergency_overrides: number;
  /** 静态策略在运行中故障后仍使用故障出口的路线数（安全性检查）。 */
  failed_exit_routes_after_disruption: number;
  steps: number;
}

function initialDensity(scenario: SafetyScenario, demand: Map<string, number>): { density: number; risk: number } {
  let density = 0;
  let risk = 0;
  for (const [regionId, persons] of demand) {
    density = Math.max(density, regionDensity(scenario, regionId, persons));
    risk = Math.max(risk, regionRiskRatio(scenario, regionId, persons));
  }
  return { density, risk };
}

function runStrategy(
  strategy: Strategy,
  setup: ScenarioSetup,
  seed: number,
  network: ReturnType<typeof resolveEffectiveNetwork>,
  versions: { scenarioVersion: string; constraintVersion: number; observationVersion: number },
): RunResult {
  const totalInput = [...setup.demand.values()].reduce((sum, value) => sum + value, 0)
    + setup.inflows.reduce((sum, item) => sum + item.persons, 0);
  const actualArrivals = new Map<string, Array<{ offsetMinute: number; persons: number }>>();
  for (const event of setup.inflows) {
    const list = actualArrivals.get(event.regionId) ?? [];
    list.push({ offsetMinute: event.minute, persons: event.persons });
    actualArrivals.set(event.regionId, list);
  }
  const disruptionMinute = setup.midRunDisruptions[0]?.minute ?? Number.POSITIVE_INFINITY;
  const disruptedExits = new Set(setup.midRunDisruptions.flatMap(item => item.exit_ids));

  if (strategy === 'legacy_static') {
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
    const failedExitRoutes = plan.routes.filter(route => disruptedExits.has(route.exit_id) && route.depart_minute >= disruptionMinute).length;
    const density = initialDensity(setup.scenario, setup.demand);
    return {
      scenario: setup.variant, strategy, seed, total_input: totalInput,
      completed: metrics.completed_persons, unserved: metrics.unserved_persons,
      completion_ratio: Number((metrics.completed_persons / Math.max(1, totalInput)).toFixed(4)),
      makespan: metrics.makespan_minute, queue_person_minutes: metrics.total_queue_person_minutes,
      max_queue: metrics.max_queue_persons, mean_wait: metrics.mean_wait_minutes, p95_wait: metrics.p95_wait_minutes,
      max_density: Number(density.density.toFixed(4)), worst_risk_ratio: Number(density.risk.toFixed(4)),
      switch_persons: 0, switch_events: 0, replans: 0, solve_ms: solveMs,
      committed_steps: 0, emergency_overrides: 0,
      failed_exit_routes_after_disruption: failedExitRoutes, steps: 0,
    };
  }

  const stability = strategy === 'mpc_standard'
    ? { mode: 'none' as const }
    : strategy === 'mpc_hysteresis'
      ? { mode: 'hysteresis' as const, hysteresisGap: 0.05 }
      : strategy === 'mpc_switch_penalty'
        ? { mode: 'switch_penalty' as const, switchPenaltyPerPerson: 10 }
        : strategy === 'mpc_commitment'
          ? { mode: 'commitment' as const, commitMinutes: 6, hysteresisGap: 0.02 }
          : { mode: 'adaptive' as const, switchPenaltyPerPerson: 10, commitMinutes: 4, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 };
  const planned = planEvacuationMpc({
    scenario: setup.scenario,
    network,
    initialDemandByRegion: setup.demand,
    versions,
    now: new Date(),
    controlIntervalMinutes: CONTROL_INTERVAL,
    planningHorizonMinutes: PLANNING_HORIZON,
    maxExecutionMinutes: MAX_EXECUTION,
    maxSteps: 24,
    solver: 'v7',
    replanPolicy: 'periodic',
    predictedArrivals: setup.forecast,
    actualArrivals,
    useForecast: true,
    queueFeedback: true,
    incidents: setup.incidents,
    midRunDisruptions: setup.midRunDisruptions,
    stability,
  });
  const failedExitRoutes = planned.executed_routes
    .filter(route => disruptedExits.has(route.exit_id) && route.depart_minute >= disruptionMinute)
    .length;
  return {
    scenario: setup.variant, strategy, seed, total_input: planned.total_input_persons,
    completed: planned.completed_persons, unserved: planned.unserved_persons,
    completion_ratio: Number((planned.completed_persons / Math.max(1, planned.total_input_persons)).toFixed(4)),
    makespan: planned.makespan_minute, queue_person_minutes: planned.total_queue_person_minutes,
    max_queue: planned.max_queue_persons, mean_wait: planned.mean_wait_minutes, p95_wait: planned.p95_wait_minutes,
    max_density: planned.max_density_persons_per_m2, worst_risk_ratio: planned.worst_risk_ratio,
    switch_persons: planned.switch_persons, switch_events: planned.switch_events,
    replans: planned.replans, solve_ms: planned.total_solve_ms,
    committed_steps: planned.committed_steps, emergency_overrides: planned.emergency_overrides,
    failed_exit_routes_after_disruption: failedExitRoutes, steps: planned.steps.length,
  };
}

const baseScenario = loadSafetyScenario(SCENARIO_PATH);
fs.mkdirSync(OUT, { recursive: true });
const rows: RunResult[] = [];
for (const variant of VARIANTS) {
  for (const seed of SEEDS) {
    const setup = buildSetup(baseScenario, variant, seed);
    const network = resolveEffectiveNetwork(setup.scenario, setup.incidents);
    const versions = {
      scenarioVersion: setup.scenario.version,
      constraintVersion: setup.incidents.length > 0 ? 1 : 0,
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
  max_density: ci(subset.map(row => row.max_density)),
  worst_risk_ratio: ci(subset.map(row => row.worst_risk_ratio)),
  switch_persons: ci(subset.map(row => row.switch_persons)),
  switch_events: ci(subset.map(row => row.switch_events)),
  replans: ci(subset.map(row => row.replans)),
  solve_ms: ci(subset.map(row => row.solve_ms)),
  committed_steps: ci(subset.map(row => row.committed_steps)),
  emergency_overrides: ci(subset.map(row => row.emergency_overrides)),
  failed_exit_routes_after_disruption: ci(subset.map(row => row.failed_exit_routes_after_disruption)),
  steps: ci(subset.map(row => row.steps)),
});

const summary = Object.fromEntries(VARIANTS.map(variant => [
  variant,
  Object.fromEntries(STRATEGIES.map(strategy => [strategy, summarize(rows.filter(row => row.scenario === variant && row.strategy === strategy))])),
]));
const overall = Object.fromEntries(STRATEGIES.map(strategy => [strategy, summarize(rows.filter(row => row.strategy === strategy))]));

const primaryMetrics = ['unserved', 'makespan', 'queue_person_minutes', 'max_density', 'worst_risk_ratio', 'switch_persons', 'solve_ms'] as const;
const paired: Record<string, unknown> = {};
const holmFamilies: Record<string, Record<string, { raw: number; adjusted: number; rejected_0_05: boolean }>> = {};
for (const reference of ['legacy_static', 'mpc_standard'] as Strategy[]) {
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

const mechanism = {
  stability_switch_reduction: Object.fromEntries(STRATEGIES.filter(strategy => strategy !== 'legacy_static').map(strategy => {
    const values = rows.filter(row => row.strategy === strategy).map((row, index) => {
      const baseline = rows.filter(row => row.strategy === 'mpc_standard')[index];
      return row.switch_persons - baseline.switch_persons;
    });
    return [strategy, ci(values)];
  })),
  stability_makespan_cost: Object.fromEntries(STRATEGIES.filter(strategy => strategy !== 'legacy_static').map(strategy => {
    const values = rows.filter(row => row.strategy === strategy).map((row, index) => {
      const baseline = rows.filter(row => row.strategy === 'mpc_standard')[index];
      return row.makespan - baseline.makespan;
    });
    return [strategy, ci(values)];
  })),
  midrun_safety: Object.fromEntries(STRATEGIES.map(strategy => {
    const subset = rows.filter(row => row.scenario === 'midrun_exit_failure' && row.strategy === strategy);
    return [strategy, {
      failed_exit_routes: ci(subset.map(row => row.failed_exit_routes_after_disruption)),
      emergency_overrides: ci(subset.map(row => row.emergency_overrides)),
      unserved: ci(subset.map(row => row.unserved)),
    }];
  })),
};

const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('stability_rows.json', rows);
write('stability_summary.json', {
  config: {
    seeds: SEEDS,
    strategies: STRATEGIES,
    scenarios: VARIANTS,
    control_interval_minutes: CONTROL_INTERVAL,
    planning_horizon_minutes: PLANNING_HORIZON,
    max_execution_minutes: MAX_EXECUTION,
    stability: {
      hysteresis_gap: 0.05,
      switch_penalty_per_person: 10,
      commitment_minutes: 6,
      adaptive: { switch_penalty_per_person: 10, commit_minutes: 4, queue_threshold: 100 },
      commitment_share: 0.8,
      max_objective_degradation: 0.3,
    },
    bidirectional_model: 'time-expanded solver iteratively shares per-minute capacity between directions (up to 4 rounds).',
    execution_model: '1 分钟 FIFO 队列 + BPR 行程时间放大 + 出口拥挤服务衰减（未标定）。',
    forecast_error_model: '时间 ±1 分钟、人数 ×[0.8,1.2]；显式合成误差。',
    data_nature: '合成场景 + 合成入流；不代表真实场馆效果。',
  },
  summary,
  overall,
  paired,
  holm_families: holmFamilies,
  mechanism,
});

const report = `# V7.2 路线稳定性与安全 MPC 实验（A-F）

> 运行 ID：\`${RUN_ID}\`。**合成场景 + 合成入流**；所有策略共享实际入流、执行模型、预算与预测误差。
> 30 固定种子 × 6 场景 × 6 策略。

## 1. 策略定义

| 代号 | 策略 | 稳定性机制 |
| --- | --- | --- |
| A | legacy_static | 既有安全规划器，一次规划 |
| B | mpc_standard | V7 时间扩展 MPC，无稳定性 |
| C | mpc_hysteresis | 迟滞容差 0.05（目标改善不足则保持上一出口集合） |
| D | mpc_switch_penalty | 切换惩罚 10/人（惩罚后目标比较） |
| E | mpc_commitment | 承诺窗口 6 分钟（80% 在场人数固定到上一出口） |
| F | mpc_adaptive | 拥堵/窗口内承诺，否则切换惩罚 |

所有 MPC 策略使用相同预测注入、出口队列反馈、控制步（2 分钟）与规划展望（10 分钟）。
双向通道容量由两方向按需求比例共享（求解器迭代 4 轮），与执行/校验口径一致。

## 2. 总体结果（180 个场景-种子组合）

| 策略 | 未疏散 | 完成时间 | 队列人·分钟 | 最大密度 | 最坏风险比 | 切换人数 | 求解总耗时(ms) | 承诺步数 | 紧急覆盖 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${STRATEGIES.map(strategy => {
  const value = (overall as any)[strategy];
  return `| ${strategy} | ${value.unserved.mean} | ${value.makespan.mean} | ${value.queue_person_minutes.mean} | ${value.max_density.mean} | ${value.worst_risk_ratio.mean} | ${value.switch_persons.mean} | ${value.solve_ms.mean} | ${value.committed_steps.mean} | ${value.emergency_overrides.mean} |`;
}).join('\n')}

## 3. 分场景结果

${VARIANTS.map(variant => `### ${variant}\n\n| 策略 | 未疏散 | 完成时间 | 队列人·分钟 | P95 等待 | 切换人数 | 求解耗时(ms) | 承诺步数 | 紧急覆盖 | 故障后使用故障出口路线 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${STRATEGIES.map(strategy => {
  const value = (summary as any)[variant][strategy];
  return `| ${strategy} | ${value.unserved.mean} | ${value.makespan.mean} | ${value.queue_person_minutes.mean} | ${value.p95_wait.mean} | ${value.switch_persons.mean} | ${value.solve_ms.mean} | ${value.committed_steps.mean} | ${value.emergency_overrides.mean} | ${value.failed_exit_routes_after_disruption.mean} |`;
}).join('\n')}`).join('\n\n')}

## 4. 配对比较（vs mpc_standard）

| 指标 | 对照 | 平均差 [95% CI] | Bootstrap | d_z | Holm p | 显著 |
| --- | --- | --- | --- | --- | --- | --- |
${primaryMetrics.flatMap(metric => STRATEGIES.filter(strategy => strategy !== 'mpc_standard').map(strategy => {
  const value = (paired as any).mpc_standard[metric][strategy];
  const holmValue = holmFamilies[`mpc_standard|${metric}`][strategy];
  return `| ${metric} | ${strategy} | ${value.mean_diff} [${value.ci.lower}, ${value.ci.upper}] | [${value.bootstrap.lower}, ${value.bootstrap.upper}] | ${value.cohen_dz} | ${holmValue.adjusted} | ${holmValue.rejected_0_05 ? '是' : '否'} |`;
}).join('\n')).join('\n')}

## 5. 机理问题（直接回答）

- **稳定性是否降低切换？** 相对 B 的切换人数差见第 4 节；承诺/惩罚的降低幅度与完成时间代价必须同时引用。
- **代价是什么？** 完成时间、队列人·分钟与最大密度的配对差见第 4 节；若 CI 跨零则不得宣称无代价。
- **运行中出口故障是否安全？** 见 midrun_exit_failure 场景：MPC 策略的 \`failed_exit_routes_after_disruption\` 与 \`emergency_overrides\`。
- **复杂算法何时不如简单基线？** 若某稳定性策略的队列/完成时间显著劣化而切换未显著下降，应判定为负结果。

## 6. 解释边界

- 合成场景与未标定拥堵参数；BPR/服务衰减/预测误差均为启发式；
- 承诺式求解是逐区域贪心多商品近似，不是联合最优；
- 双向共享容量采用迭代比例分配，不保证全局最优；
- 负向/混合结果保留在 \`stability_rows.json\`，不得只引用有利指标。
`;
fs.writeFileSync(path.join(OUT, 'stability_README.md'), report);
fs.writeFileSync(path.join(OUT, 'stability_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);

const files = fs.readdirSync(OUT).filter(name => name.startsWith('stability_')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'stability_MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, note: 'V7.2 路线稳定性与安全 MPC 实验独立清单。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.2 stability benchmark complete: evaluation/v72/${RUN_ID}/`);
console.log(`overall unserved: ${STRATEGIES.map(strategy => `${strategy}=${(overall as any)[strategy].unserved.mean}`).join(', ')}`);
console.log(`overall switch: ${STRATEGIES.map(strategy => `${strategy}=${(overall as any)[strategy].switch_persons.mean}`).join(', ')}`);
console.log(`overall makespan: ${STRATEGIES.map(strategy => `${strategy}=${(overall as any)[strategy].makespan.mean}`).join(', ')}`);
