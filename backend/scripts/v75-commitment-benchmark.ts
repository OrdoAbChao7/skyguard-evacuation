/**
 * V7.5 Track B/C：区域选择性承诺、容量感知承诺与紧急恢复公平实验。
 *
 *   npm run benchmark:v75 --prefix backend -- --only=commitment
 *
 * A legacy_static / B mpc_standard / C mpc_adaptive_v73 /
 * D mpc_risk_adaptive / E mpc_emergency_release / F mpc_pareto_gate。
 *
 * 30 固定种子 × 8 场景；所有 MPC 共享预测、队列反馈、控制步、动态容量因子。
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
import { checkPlanCapacity, regionDensity, regionRiskRatio } from '../src/services/safety/planning/route-stability';
import type { Incident, SafetyScenario } from '../src/services/safety/types';

const SEEDS = Array.from({ length: 30 }, (_, index) => 20261111 + index);
const RUN_ID = process.env.V75_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v75', RUN_ID);
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const CONTROL_INTERVAL = 2;
const PLANNING_HORIZON = 10;
const MAX_EXECUTION = 24;

type Strategy =
  | 'legacy_static'
  | 'mpc_standard'
  | 'mpc_global_commitment'
  | 'mpc_adaptive_v73'
  | 'mpc_region_selective'
  | 'mpc_risk_adaptive_commit'
  | 'mpc_capacity_aware'
  | 'mpc_emergency_release'
  | 'mpc_emergency_recovery'
  | 'mpc_pareto_gate';
type ScenarioVariant =
  | 'baseline_surge'
  | 'exit_failure'
  | 'corridor_closure'
  | 'bidirectional_stress'
  | 'multi_zone_surge'
  | 'midrun_exit_failure'
  | 'dynamic_capacity'
  | 'oscillation_stress';
const STRATEGIES: Strategy[] = [
  'legacy_static', 'mpc_standard', 'mpc_global_commitment', 'mpc_adaptive_v73',
  'mpc_region_selective', 'mpc_risk_adaptive_commit', 'mpc_capacity_aware',
  'mpc_emergency_release', 'mpc_emergency_recovery', 'mpc_pareto_gate',
];
const VARIANTS: ScenarioVariant[] = [
  'baseline_surge', 'exit_failure', 'corridor_closure', 'bidirectional_stress',
  'multi_zone_surge', 'midrun_exit_failure', 'dynamic_capacity', 'oscillation_stress',
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
  corridorFactor?: (corridorId: string, absoluteMinute: number) => number;
  exitFactor?: (exitId: string, absoluteMinute: number) => number;
}

function cloneScenario(scenario: SafetyScenario): SafetyScenario {
  return JSON.parse(JSON.stringify(scenario)) as SafetyScenario;
}

function incidentFor(exitIds: string[], corridorIds: string[], suffix: string): Incident {
  const now = new Date().toISOString();
  return {
    id: `INC-V75-${suffix}-${exitIds.join('-')}-${corridorIds.join('-')}`,
    type: 'fire',
    description: '实验场景：出口/通道故障',
    status: 'confirmed',
    severity: 'high',
    affected: { region_ids: [], corridor_ids: corridorIds, exit_ids: exitIds },
    source: 'simulation',
    reported_by: 'v75-bench',
    reported_at: now,
    confirmed_by: 'v75-bench',
    confirmed_at: now,
  };
}

function buildSetup(baseScenario: SafetyScenario, variant: ScenarioVariant, seed: number): ScenarioSetup {
  const rng = mulberry32(seed * 1009 + 41 + VARIANTS.indexOf(variant) * 104_729);
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
  const eventCount = variant === 'oscillation_stress'
    ? 6
    : variant === 'multi_zone_surge'
      ? 4
      : 2 + (rng() < 0.5 ? 1 : 0);
  for (let index = 0; index < eventCount; index += 1) {
    const region = variant === 'oscillation_stress'
      ? regions[index % regions.length]
      : regions[Math.floor(rng() * regions.length)];
    const minute = variant === 'oscillation_stress' ? 1 + index * 2 : 2 + Math.floor(rng() * 6);
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
  const corridorFactor = variant === 'dynamic_capacity'
    ? (corridorId: string, absoluteMinute: number) => (absoluteMinute >= 4 && (corridorId === 'C_NE' || corridorId === 'C_NW') ? 0.5 : 1)
    : undefined;
  const exitFactor = variant === 'dynamic_capacity'
    ? (exitId: string, absoluteMinute: number) => (absoluteMinute >= 5 && exitId === 'E_NORTH' ? 0.7 : 1)
    : undefined;
  return { scenario, variant, demand, inflows, forecast, incidents, midRunDisruptions, corridorFactor, exitFactor };
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
  oscillation_events: number;
  oscillation_persons: number;
  capacity_violations: number;
  safety_violations: number;
  replans: number;
  solve_ms: number;
  committed_steps: number;
  emergency_overrides: number;
  adaptive_penalty_avg: number;
  pareto_candidates: number;
  gate_rejections: number;
  commitment_releases: number;
  commitment_recommits: number;
  emergency_events: number;
  emergency_response_delay: number | null;
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
    const metrics = simulatePlanExecution(setup.scenario, plan, {
      maxMinutes: MAX_EXECUTION,
      inflow: setup.inflows,
      corridorCapacityFactor: setup.corridorFactor,
      exitCapacityFactor: setup.exitFactor,
    });
    const violations = checkPlanCapacity(setup.scenario, plan.routes, 0, {
      corridorCapacityFactor: setup.corridorFactor,
      exitCapacityFactor: setup.exitFactor,
    });
    const density = initialDensity(setup.scenario, setup.demand);
    return {
      scenario: setup.variant, strategy, seed, total_input: totalInput,
      completed: metrics.completed_persons, unserved: metrics.unserved_persons,
      completion_ratio: Number((metrics.completed_persons / Math.max(1, totalInput)).toFixed(4)),
      makespan: metrics.makespan_minute, queue_person_minutes: metrics.total_queue_person_minutes,
      max_queue: metrics.max_queue_persons, mean_wait: metrics.mean_wait_minutes, p95_wait: metrics.p95_wait_minutes,
      max_density: Number(density.density.toFixed(4)), worst_risk_ratio: Number(density.risk.toFixed(4)),
      switch_persons: 0, switch_events: 0, oscillation_events: 0, oscillation_persons: 0,
      capacity_violations: violations.length, safety_violations: violations.length + (metrics.unserved_persons > 0 ? 1 : 0),
      replans: 0, solve_ms: solveMs, committed_steps: 0, emergency_overrides: 0, adaptive_penalty_avg: 0, pareto_candidates: 0, gate_rejections: 0, commitment_releases: 0, commitment_recommits: 0, emergency_events: 0, emergency_response_delay: null, steps: 0,
    };
  }

  const adaptiveMode = strategy !== 'mpc_standard' && strategy !== 'mpc_global_commitment';
  const stability = strategy === 'mpc_standard'
    ? { mode: 'none' as const }
    : strategy === 'mpc_global_commitment'
      ? { mode: 'commitment' as const, commitMinutes: 8, hysteresisGap: 0.02 }
      : strategy === 'mpc_emergency_release'
        ? { mode: 'commitment' as const, commitMinutes: 8, hysteresisGap: 0.02 }
        : { mode: 'adaptive' as const, switchPenaltyPerPerson: 10, commitMinutes: 4, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 };
  const adaptiveStability = strategy === 'mpc_standard'
    ? undefined
    : {
      enabled: adaptiveMode,
      basePenaltyPerPerson: 10,
      oscillationPenaltyPerPerson: 20,
      riskWeightedSwitching: true,
      ...(strategy === 'mpc_region_selective' ? { regionSelectiveRiskThreshold: 0.9 } : {}),
      ...(strategy === 'mpc_risk_adaptive_commit' ? { regionSelectiveRiskThreshold: 0.95, releaseOnRiskThreshold: 0.6 } : {}),
      ...(strategy === 'mpc_capacity_aware' ? { regionSelectiveRiskThreshold: 1.0 } : {}),
      ...(strategy === 'mpc_emergency_release' ? { releaseOnRiskThreshold: 0.5 } : {}),
      ...(strategy === 'mpc_emergency_recovery' ? { releaseOnRiskThreshold: 1.0, recommitCooldownMinutes: 4 } : {}),
    };
  const executionGate = strategy === 'mpc_pareto_gate'
    ? { enabled: true, makespanToleranceMinutes: 1, queueTolerancePersonMinutes: 2000 }
    : undefined;
  const paretoStability = strategy === 'mpc_pareto_gate'
    ? { shares: [0.8, 0.6, 0.4, 0.2], makespanToleranceMinutes: 1, queueTolerancePersonMinutes: 2000 }
    : undefined;
  const capacityAwareCommitment = strategy === 'mpc_capacity_aware'
    ? { enabled: true, headroomRatio: 0.9 }
    : undefined;
  const emergencyMachineEnabled = strategy === 'mpc_emergency_recovery' || strategy === 'mpc_emergency_release';
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
    adaptiveStability,
    executionGate,
    paretoStability,
    capacityAwareCommitment,
    emergencyMachine: emergencyMachineEnabled
      ? { enabled: true, config: { minEmergencyDwell: 1, recoveryPersistence: 2 } }
      : undefined,
    corridorCapacityFactor: setup.corridorFactor,
    exitCapacityFactor: setup.exitFactor,
  });
  const firstEmergency = planned.emergency_events.find(event => event.to === 'EMERGENCY_OVERRIDE');
  const disruptionMinute = setup.midRunDisruptions.length > 0
    ? Math.min(...setup.midRunDisruptions.map(item => item.minute))
    : null;
  const emergencyResponseDelay = firstEmergency && disruptionMinute !== null
    ? Math.max(0, firstEmergency.tick - disruptionMinute)
    : null;
  return {
    scenario: setup.variant, strategy, seed, total_input: planned.total_input_persons,
    completed: planned.completed_persons, unserved: planned.unserved_persons,
    completion_ratio: Number((planned.completed_persons / Math.max(1, planned.total_input_persons)).toFixed(4)),
    makespan: planned.makespan_minute, queue_person_minutes: planned.total_queue_person_minutes,
    max_queue: planned.max_queue_persons, mean_wait: planned.mean_wait_minutes, p95_wait: planned.p95_wait_minutes,
    max_density: planned.max_density_persons_per_m2, worst_risk_ratio: planned.worst_risk_ratio,
    switch_persons: planned.switch_persons, switch_events: planned.switch_events,
    oscillation_events: planned.oscillation_events, oscillation_persons: planned.oscillation_persons,
    capacity_violations: planned.capacity_violations,
    safety_violations: planned.capacity_violations + (planned.unserved_persons > 0 ? 1 : 0),
    replans: planned.replans, solve_ms: planned.total_solve_ms,
    committed_steps: planned.committed_steps, emergency_overrides: planned.emergency_overrides,
    adaptive_penalty_avg: planned.adaptive_penalty_avg, pareto_candidates: planned.pareto_candidates, gate_rejections: planned.gate_rejections, commitment_releases: planned.commitment_releases, commitment_recommits: planned.commitment_recommits, emergency_events: planned.emergency_events.length, emergency_response_delay: emergencyResponseDelay, steps: planned.steps.length,
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
  oscillation_events: ci(subset.map(row => row.oscillation_events)),
  oscillation_persons: ci(subset.map(row => row.oscillation_persons)),
  capacity_violations: ci(subset.map(row => row.capacity_violations)),
  safety_violations: ci(subset.map(row => row.safety_violations)),
  replans: ci(subset.map(row => row.replans)),
  solve_ms: ci(subset.map(row => row.solve_ms)),
  committed_steps: ci(subset.map(row => row.committed_steps)),
  emergency_overrides: ci(subset.map(row => row.emergency_overrides)),
  adaptive_penalty_avg: ci(subset.map(row => row.adaptive_penalty_avg)),
  pareto_candidates: ci(subset.map(row => row.pareto_candidates)),
  gate_rejections: ci(subset.map(row => row.gate_rejections)),
  commitment_releases: ci(subset.map(row => row.commitment_releases)),
  commitment_recommits: ci(subset.map(row => row.commitment_recommits)),
  emergency_events: ci(subset.map(row => row.emergency_events)),
  steps: ci(subset.map(row => row.steps)),
});

const summary = Object.fromEntries(VARIANTS.map(variant => [
  variant,
  Object.fromEntries(STRATEGIES.map(strategy => [strategy, summarize(rows.filter(row => row.scenario === variant && row.strategy === strategy))])),
]));
const overall = Object.fromEntries(STRATEGIES.map(strategy => [strategy, summarize(rows.filter(row => row.strategy === strategy))]));

const primaryMetrics = [
  'unserved', 'makespan', 'queue_person_minutes', 'max_density', 'worst_risk_ratio',
  'switch_persons', 'oscillation_persons', 'capacity_violations', 'safety_violations', 'solve_ms',
  'commitment_recommits', 'emergency_events',
] as const;
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
  oscillation_gain_adaptive_vs_commitment: {
    events: ci(rows.filter(row => row.strategy === 'mpc_adaptive_v73').map((row, index) => row.oscillation_events - rows.filter(row => row.strategy === 'mpc_emergency_release')[index].oscillation_events)),
    persons: ci(rows.filter(row => row.strategy === 'mpc_adaptive_v73').map((row, index) => row.oscillation_persons - rows.filter(row => row.strategy === 'mpc_emergency_release')[index].oscillation_persons)),
  },
  dynamic_capacity: Object.fromEntries(STRATEGIES.map(strategy => {
    const subset = rows.filter(row => row.scenario === 'dynamic_capacity' && row.strategy === strategy);
    return [strategy, {
      capacity_violations: ci(subset.map(row => row.capacity_violations)),
      safety_violations: ci(subset.map(row => row.safety_violations)),
      unserved: ci(subset.map(row => row.unserved)),
      makespan: ci(subset.map(row => row.makespan)),
    }];
  })),
  midrun_safety: Object.fromEntries(STRATEGIES.map(strategy => {
    const subset = rows.filter(row => row.scenario === 'midrun_exit_failure' && row.strategy === strategy);
    return [strategy, {
      emergency_overrides: ci(subset.map(row => row.emergency_overrides)),
      unserved: ci(subset.map(row => row.unserved)),
      safety_violations: ci(subset.map(row => row.safety_violations)),
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
      adaptive_v73: {
        base_penalty_per_person: 10,
        queue_threshold: 100,
        risk_discount: 0.5,
        oscillation_penalty_per_person: 20,
        risk_weighted_switching: true,
        weights: { arrival: 1, makespan: 0.5, queueProxy: 0.25, exposure: 0.05, switching: 0.02 },
      },
    },
    dynamic_capacity: {
      corridors: 'C_NE/C_NW ×0.5 after minute 4',
      exits: 'E_NORTH ×0.7 after minute 5',
    },
    bidirectional_model: 'time-expanded solver iteratively shares per-minute capacity between directions.',
    execution_model: '1 分钟 FIFO + BPR + 出口服务衰减 + 动态容量因子（未标定）。',
    forecast_error_model: '时间 ±1 分钟、人数 ×[0.8,1.2]。',
    data_nature: '合成场景 + 合成入流；不代表真实场馆效果。',
  },
  summary,
  overall,
  paired,
  holm_families: holmFamilies,
  mechanism,
});

const report = `# V7.5 稳定性—效率 Pareto 实验（A-F）

> 运行 ID：\`${RUN_ID}\`。**合成场景 + 合成入流**；30 种子 × 8 场景 × 6 策略。
> 不得表述为真实场馆效果。

## 1. 策略

| 代号 | 策略 | 稳定性 |
| --- | --- | --- |
| A | legacy_static | 一次规划 |
| B | mpc_standard | 无 |
| C | mpc_adaptive_v73 | V7.3 自适应（无执行门控） |
| D | mpc_risk_adaptive | 风险敏感惩罚（riskDiscount 0.9） |
| E | mpc_emergency_release | 高风险自动释放承诺（阈值 0.5） |
| F | mpc_pareto_gate | 执行门控 + 承诺份额 Pareto（1min/2000人·min） |

## 2. 总体结果

| 策略 | 未疏散 | 完成时间 | 队列人·分钟 | 最大密度 | 切换人数 | 振荡人数 | 容量冲突 | 安全违规 | 求解(ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${STRATEGIES.map(strategy => {
  const value = (overall as any)[strategy];
  return `| ${strategy} | ${value.unserved.mean} | ${value.makespan.mean} | ${value.queue_person_minutes.mean} | ${value.max_density.mean} | ${value.switch_persons.mean} | ${value.oscillation_persons.mean} | ${value.capacity_violations.mean} | ${value.safety_violations.mean} | ${value.solve_ms.mean} |`;
}).join('\n')}

> 求解耗时为单机测量，存在 ±1–2ms 波动。

## 3. 分场景结果

${VARIANTS.map(variant => `### ${variant}\n\n| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${STRATEGIES.map(strategy => {
  const value = (summary as any)[variant][strategy];
  return `| ${strategy} | ${value.unserved.mean} | ${value.makespan.mean} | ${value.queue_person_minutes.mean} | ${value.switch_persons.mean} | ${value.oscillation_persons.mean} | ${value.capacity_violations.mean} | ${value.safety_violations.mean} |`;
}).join('\n')}`).join('\n\n')}

## 4. 配对比较（vs B）

| 指标 | 对照 | 平均差 [95% CI] | d_z | Holm p | 显著 |
| --- | --- | --- | --- | --- | --- |
${primaryMetrics.flatMap(metric => STRATEGIES.filter(strategy => strategy !== 'mpc_standard').map(strategy => {
  const value = (paired as any).mpc_standard[metric][strategy];
  const holmValue = holmFamilies[`mpc_standard|${metric}`][strategy];
  return `| ${metric} | ${strategy} | ${value.mean_diff} [${value.ci.lower}, ${value.ci.upper}] | ${value.cohen_dz} | ${holmValue.adjusted} | ${holmValue.rejected_0_05 ? '是' : '否'} |`;
}).join('\n')).join('\n')}

## 5. 机理

- **自适应 F 是否降低振荡？** 相对 E 的振荡事件/人数差见 \`mechanism.oscillation_gain_adaptive_vs_commitment\`；
- **动态容量下是否安全？** 见 \`dynamic_capacity\`：容量冲突、安全违规、未疏散、完成时间；
- **运行中出口故障？** 见 \`midrun_safety\`：紧急覆盖、未疏散、安全违规；
- **切换代价？** 见第 4 节 switch_persons / makespan / queue 的配对差。

## 6. 边界

- 合成场景、未标定 BPR/服务衰减/动态容量因子；
- 自适应惩罚与权重是启发式，不是最优控制；
- 安全违规 = 容量冲突 + 未疏散标记，不是独立 Validator 的完整结论；
- 负向/混合结果保留在 rows/summary，不得只引用有利指标。
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
  version: 1, run_id: RUN_ID, note: 'V7.5 稳定性—效率 Pareto 实验清单（合成）。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.5 commitment benchmark complete: evaluation/v75/${RUN_ID}/`);
console.log(`overall unserved: ${STRATEGIES.map(strategy => `${strategy}=${(overall as any)[strategy].unserved.mean}`).join(', ')}`);
console.log(`overall switch: ${STRATEGIES.map(strategy => `${strategy}=${(overall as any)[strategy].switch_persons.mean}`).join(', ')}`);
console.log(`overall oscillation: ${STRATEGIES.map(strategy => `${strategy}=${(overall as any)[strategy].oscillation_persons.mean}`).join(', ')}`);
console.log(`overall safety_violations: ${STRATEGIES.map(strategy => `${strategy}=${(overall as any)[strategy].safety_violations.mean}`).join(', ')}`);
