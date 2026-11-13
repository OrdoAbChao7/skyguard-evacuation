/**
 * V7.5 Track D：多目标（完成时间/未疏散/队列/切换/响应）实验。
 *
 *   npm run benchmark:v75 --prefix backend -- --only=multiobjective
 *
 * 30 种子 × 8 场景 × 6 权重配置；离线计算 Pareto 前沿与膝点。
 * 重要边界：膝点选择使用同一实例的候选结果，属于离线分析/上界，
 * 不是在线可部署的选择器；在线部署仍需单次规划与独立校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../src/services/safety/network';
import { planEvacuation } from '../src/services/safety/planning/evacuation-planner';
import { simulatePlanExecution } from '../src/services/safety/planning/congestion';
import { planEvacuationMpc } from '../src/services/safety/planning/mpc-planner';
import { checkPlanCapacity, regionDensity } from '../src/services/safety/planning/route-stability';
import {
  paretoFront, selectConstrained, selectKnee,
  type ObjectiveVector, type ParetoCandidate, type Priority,
} from '../src/services/safety/planning/multi-objective';
import type { Incident, SafetyScenario } from '../src/services/safety/types';

const RUN_ID = process.env.V75_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v75', RUN_ID);
const SEEDS = Array.from({ length: 30 }, (_, index) => 20261111 + index);
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const CONTROL_INTERVAL = 2;
const PLANNING_HORIZON = 10;
const MAX_EXECUTION = 24;

const VARIANTS = [
  'baseline_surge', 'exit_failure', 'corridor_closure', 'bidirectional_stress',
  'multi_zone_surge', 'midrun_exit_failure', 'dynamic_capacity', 'oscillation_stress',
] as const;
type ScenarioVariant = (typeof VARIANTS)[number];

const PROFILES = {
  balanced: { arrival: 1, makespan: 0.5, queueProxy: 0.25, exposure: 0.05, switching: 0.02 },
  efficiency: { arrival: 1, makespan: 1.5, queueProxy: 0.5, exposure: 0.02, switching: 0.005 },
  stability: { arrival: 0.5, makespan: 0.25, queueProxy: 0.1, exposure: 0.05, switching: 0.5 },
  safety: { arrival: 0.5, makespan: 0.25, queueProxy: 0.2, exposure: 0.5, switching: 0.02 },
  queue: { arrival: 1, makespan: 0.4, queueProxy: 1, exposure: 0.02, switching: 0.01 },
  emergency: { arrival: 0.8, makespan: 0.2, queueProxy: 0.05, exposure: 0.8, switching: 0.01 },
} as const;
type Profile = keyof typeof PROFILES;
type CandidateId = Profile | 'no_commitment' | 'global_commitment' | 'region_selective' | 'emergency_release';
const CANDIDATES: CandidateId[] = [...(Object.keys(PROFILES) as Profile[]), 'no_commitment', 'global_commitment', 'region_selective', 'emergency_release'];

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

function incidentFor(exitIds: string[], corridorIds: string[], suffix: string): Incident {
  const now = new Date().toISOString();
  return {
    id: `INC-V75-${suffix}-${exitIds.join('-')}-${corridorIds.join('-')}`,
    type: 'fire', description: '实验场景：出口/通道故障', status: 'confirmed', severity: 'high',
    affected: { region_ids: [], corridor_ids: corridorIds, exit_ids: exitIds },
    source: 'simulation', reported_by: 'v75-mo', reported_at: now, confirmed_by: 'v75-mo', confirmed_at: now,
  };
}

function buildSetup(baseScenario: SafetyScenario, variant: ScenarioVariant, seed: number): ScenarioSetup {
  const rng = mulberry32(seed * 1009 + 41 + VARIANTS.indexOf(variant) * 104_729);
  const scenario = variant === 'bidirectional_stress' ? JSON.parse(JSON.stringify(baseScenario)) as SafetyScenario : baseScenario;
  if (variant === 'bidirectional_stress') {
    for (const corridor of scenario.corridors) {
      if (corridor.capacity_per_min !== null) corridor.direction = 'both';
    }
  }
  const demand = new Map<string, number>();
  for (const region of scenario.regions) demand.set(region.id, region.enabled ? Math.round(700 + rng() * 400) : 0);
  const regions = scenario.regions.filter(region => region.enabled);
  const flows: InflowEvent[] = [];
  const eventCount = variant === 'oscillation_stress' ? 6 : variant === 'multi_zone_surge' ? 4 : 2 + (rng() < 0.5 ? 1 : 0);
  for (let index = 0; index < eventCount; index += 1) {
    const region = variant === 'oscillation_stress' ? regions[index % regions.length] : regions[Math.floor(rng() * regions.length)];
    const minute = variant === 'oscillation_stress' ? 1 + index * 2 : 2 + Math.floor(rng() * 6);
    flows.push({ regionId: region.id, minute, persons: Math.round(180 + rng() * 240) });
  }
  const forecast = new Map<string, Array<{ offsetMinute: number; persons: number }>>();
  for (const event of flows) {
    const list = forecast.get(event.regionId) ?? [];
    list.push({ offsetMinute: Math.max(1, event.minute + Math.floor(rng() * 3) - 1), persons: Math.max(1, Math.round(event.persons * (0.8 + rng() * 0.4))) });
    forecast.set(event.regionId, list);
  }
  const incidents: Incident[] = [];
  const midRunDisruptions: ScenarioSetup['midRunDisruptions'] = [];
  if (variant === 'exit_failure') incidents.push(incidentFor(['E_NORTH'], [], 'EXIT'));
  if (variant === 'corridor_closure') incidents.push(incidentFor([], ['C_NE'], 'CORR'));
  if (variant === 'midrun_exit_failure') midRunDisruptions.push({ minute: 4, exit_ids: ['E_NORTH'], corridor_ids: [], description: '第 4 分钟北出口故障' });
  const corridorFactor = variant === 'dynamic_capacity'
    ? (id: string, minute: number) => (minute >= 4 && (id === 'C_NE' || id === 'C_NW') ? 0.5 : 1)
    : undefined;
  const exitFactor = variant === 'dynamic_capacity'
    ? (id: string, minute: number) => (minute >= 5 && id === 'E_NORTH' ? 0.7 : 1)
    : undefined;
  return { scenario, variant, demand, inflows: flows, forecast, incidents, midRunDisruptions, corridorFactor, exitFactor };
}

interface RunResult {
  scenario: ScenarioVariant;
  profile: CandidateId;
  seed: number;
  unserved: number;
  makespan: number;
  queue_person_minutes: number;
  switch_persons: number;
  max_density: number;
  capacity_violations: number;
  solve_ms: number;
}

function initialDensity(scenario: SafetyScenario, demand: Map<string, number>): number {
  let density = 0;
  for (const [regionId, persons] of demand) density = Math.max(density, regionDensity(scenario, regionId, persons));
  return density;
}

function runProfile(profile: CandidateId, setup: ScenarioSetup, seed: number, network: ReturnType<typeof resolveEffectiveNetwork>, versions: { scenarioVersion: string; constraintVersion: number; observationVersion: number }): RunResult {
  const actualArrivals = new Map<string, Array<{ offsetMinute: number; persons: number }>>();
  for (const event of setup.inflows) {
    const list = actualArrivals.get(event.regionId) ?? [];
    list.push({ offsetMinute: event.minute, persons: event.persons });
    actualArrivals.set(event.regionId, list);
  }
  const planned = planEvacuationMpc({
    scenario: setup.scenario, network, initialDemandByRegion: setup.demand, versions, now: new Date(),
    controlIntervalMinutes: CONTROL_INTERVAL, planningHorizonMinutes: PLANNING_HORIZON,
    maxExecutionMinutes: MAX_EXECUTION, maxSteps: 24, solver: 'v7', replanPolicy: 'periodic',
    predictedArrivals: setup.forecast, actualArrivals, useForecast: true, queueFeedback: true,
    incidents: setup.incidents, midRunDisruptions: setup.midRunDisruptions,
    stability: profile === 'no_commitment'
      ? { mode: 'none' }
      : profile === 'global_commitment'
        ? { mode: 'commitment', commitMinutes: 8, hysteresisGap: 0.02 }
        : { mode: 'adaptive', switchPenaltyPerPerson: 10, commitMinutes: 4, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 },
    adaptiveStability: profile === 'no_commitment'
      ? undefined
      : {
        enabled: true, basePenaltyPerPerson: 10, oscillationPenaltyPerPerson: 20, riskWeightedSwitching: true,
        ...(profile === 'region_selective' ? { regionSelectiveRiskThreshold: 0.9 } : {}),
        ...(profile === 'emergency_release' ? { releaseOnRiskThreshold: 0.5 } : {}),
        ...(profile in PROFILES ? { weights: PROFILES[profile as Profile] } : {}),
      },
    corridorCapacityFactor: setup.corridorFactor, exitCapacityFactor: setup.exitFactor,
  });
  return {
    scenario: setup.variant, profile, seed,
    unserved: planned.unserved_persons, makespan: planned.makespan_minute,
    queue_person_minutes: planned.total_queue_person_minutes, switch_persons: planned.switch_persons,
    max_density: planned.max_density_persons_per_m2, capacity_violations: planned.capacity_violations,
    solve_ms: planned.total_solve_ms,
  };
}

// 基线（legacy）仅用于报告相对变化，不参与 Pareto 选择。
function runLegacy(setup: ScenarioSetup, seed: number, network: ReturnType<typeof resolveEffectiveNetwork>, versions: { scenarioVersion: string; constraintVersion: number; observationVersion: number }): RunResult {
  const plan = planEvacuation({
    scenario: setup.scenario, network, demandByRegion: setup.demand,
    scenarioVersion: versions.scenarioVersion, constraintVersion: versions.constraintVersion,
    observationVersion: versions.observationVersion, now: new Date(),
  }).plan;
  const metrics = simulatePlanExecution(setup.scenario, plan, {
    maxMinutes: MAX_EXECUTION, inflow: setup.inflows,
    corridorCapacityFactor: setup.corridorFactor, exitCapacityFactor: setup.exitFactor,
  });
  return {
    scenario: setup.variant, profile: 'balanced', seed,
    unserved: metrics.unserved_persons, makespan: metrics.makespan_minute,
    queue_person_minutes: metrics.total_queue_person_minutes, switch_persons: 0,
    max_density: initialDensity(setup.scenario, setup.demand), capacity_violations: checkPlanCapacity(setup.scenario, plan.routes, 0).length,
    solve_ms: 0,
  };
}

const baseScenario = loadSafetyScenario(SCENARIO_PATH);
fs.mkdirSync(OUT, { recursive: true });
const rows: RunResult[] = [];
const legacyRows: RunResult[] = [];
for (const variant of VARIANTS) {
  for (const seed of SEEDS) {
    const setup = buildSetup(baseScenario, variant, seed);
    const network = resolveEffectiveNetwork(setup.scenario, setup.incidents);
    const versions = { scenarioVersion: setup.scenario.version, constraintVersion: setup.incidents.length > 0 ? 1 : 0, observationVersion: 0 };
    legacyRows.push(runLegacy(setup, seed, network, versions));
    for (const profile of CANDIDATES) {
      rows.push(runProfile(profile, setup, seed, network, versions));
    }
  }
}

const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const toVector = (row: RunResult): ObjectiveVector => ({
  unresolved: row.unserved, makespan: row.makespan, queuePersonMinutes: row.queue_person_minutes,
  switchPersons: row.switch_persons, emergencyDelay: 0,
});

interface SelectedRow {
  scenario: ScenarioVariant; seed: number; method: string; profile: CandidateId;
  vector: ObjectiveVector; unserved: number; makespan: number; queue: number; switch_persons: number; density: number;
}
const selected: SelectedRow[] = [];
const frontSizes: number[] = [];
let instancesWithTradeoff = 0;
const priorities: Priority[] = ['efficiency', 'stability', 'safety', 'balanced'];

for (const variant of VARIANTS) {
  for (const seed of SEEDS) {
    const subset = rows.filter(row => row.scenario === variant && row.seed === seed);
    const candidates: Array<ParetoCandidate<RunResult>> = subset.map(row => ({ id: row.profile, vector: toVector(row), payload: row }));
    const front = paretoFront(candidates);
    frontSizes.push(front.length);
    if (front.length > 1) instancesWithTradeoff += 1;
    for (const priority of priorities) {
      const knee = selectKnee(front, priority);
      if (knee) {
        selected.push({ scenario: variant, seed, method: `pareto_${priority}`, profile: knee.id as CandidateId, vector: knee.vector, unserved: knee.payload.unserved, makespan: knee.payload.makespan, queue: knee.payload.queue_person_minutes, switch_persons: knee.payload.switch_persons, density: knee.payload.max_density });
      }
    }
    const minMakespan = Math.min(...subset.map(row => row.makespan));
    const minQueue = Math.min(...subset.map(row => row.queue_person_minutes));
    const constrained = selectConstrained(candidates, {
      maxUnresolved: 0, maxMakespan: minMakespan + 0.75, maxQueuePersonMinutes: minQueue + 1500,
    }, 'stability') ?? candidates.find(candidate => candidate.id === 'balanced')!;
    selected.push({ scenario: variant, seed, method: 'constrained', profile: constrained.id as CandidateId, vector: constrained.vector, unserved: constrained.payload.unserved, makespan: constrained.payload.makespan, queue: constrained.payload.queue_person_minutes, switch_persons: constrained.payload.switch_persons, density: constrained.payload.max_density });
  }
}

const profileSummary = Object.fromEntries(CANDIDATES.map(profile => {
  const subset = rows.filter(row => row.profile === profile);
  return [profile, {
    n: subset.length,
    unserved: Number(mean(subset.map(row => row.unserved)).toFixed(4)),
    makespan: Number(mean(subset.map(row => row.makespan)).toFixed(4)),
    queue_person_minutes: Number(mean(subset.map(row => row.queue_person_minutes)).toFixed(2)),
    switch_persons: Number(mean(subset.map(row => row.switch_persons)).toFixed(2)),
    max_density: Number(mean(subset.map(row => row.max_density)).toFixed(4)),
    capacity_violations: Number(mean(subset.map(row => row.capacity_violations)).toFixed(4)),
    solve_ms: Number(mean(subset.map(row => row.solve_ms)).toFixed(2)),
  }];
}));

const selectionSummary = Object.fromEntries(priorities.map(priority => {
  const subset = selected.filter(row => row.method === `pareto_${priority}`);
  const counts: Record<string, number> = {};
  for (const row of subset) counts[row.profile] = (counts[row.profile] ?? 0) + 1;
  return [`pareto_${priority}`, {
    n: subset.length,
    unserved: Number(mean(subset.map(row => row.unserved)).toFixed(4)),
    makespan: Number(mean(subset.map(row => row.makespan)).toFixed(4)),
    queue_person_minutes: Number(mean(subset.map(row => row.queue)).toFixed(2)),
    switch_persons: Number(mean(subset.map(row => row.switch_persons)).toFixed(2)),
    max_density: Number(mean(subset.map(row => row.density)).toFixed(4)),
    profile_counts: counts,
  }];
}));
const constrainedSubset = selected.filter(row => row.method === 'constrained');
const constrainedSummary = {
  n: constrainedSubset.length,
  unserved: Number(mean(constrainedSubset.map(row => row.unserved)).toFixed(4)),
  makespan: Number(mean(constrainedSubset.map(row => row.makespan)).toFixed(4)),
  queue_person_minutes: Number(mean(constrainedSubset.map(row => row.queue)).toFixed(2)),
  switch_persons: Number(mean(constrainedSubset.map(row => row.switch_persons)).toFixed(2)),
  max_density: Number(mean(constrainedSubset.map(row => row.density)).toFixed(4)),
  profile_counts: constrainedSubset.reduce<Record<string, number>>((acc, row) => {
    acc[row.profile] = (acc[row.profile] ?? 0) + 1;
    return acc;
  }, {}),
};

const legacySummary = {
  unserved: Number(mean(legacyRows.map(row => row.unserved)).toFixed(4)),
  makespan: Number(mean(legacyRows.map(row => row.makespan)).toFixed(4)),
  queue_person_minutes: Number(mean(legacyRows.map(row => row.queue_person_minutes)).toFixed(2)),
  max_density: Number(mean(legacyRows.map(row => row.max_density)).toFixed(4)),
  capacity_violations: Number(mean(legacyRows.map(row => row.capacity_violations)).toFixed(4)),
};

fs.writeFileSync(path.join(OUT, 'multiobjective_rows.json'), `${JSON.stringify({
  profile_rows: rows, legacy_rows: legacyRows, selected,
}, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'multiobjective_summary.json'), `${JSON.stringify({
  config: {
    seeds: SEEDS, scenarios: VARIANTS, profiles: PROFILES, priorities,
    data_nature: 'synthetic；膝点为离线选择上界，不是在线部署算法。',
  },
  profile_summary: profileSummary,
  selection_summary: selectionSummary,
  constrained: constrainedSummary,
  legacy: legacySummary,
  pareto: {
    instances: VARIANTS.length * SEEDS.length,
    mean_front_size: Number(mean(frontSizes).toFixed(3)),
    max_front_size: Math.max(...frontSizes),
    instances_with_tradeoff: instancesWithTradeoff,
  },
}, null, 2)}\n`);

const report = `# V7.5 Track D 多目标实验

> 运行 ID：\`${RUN_ID}\`。30 种子 × 8 场景 × 6 权重配置；合成数据。
> **膝点选择使用同一实例的候选结果，属于离线分析/上界，不是在线部署算法。**

## 权重配置（总体）

| 配置 | 未疏散 | 完成 | 队列 | 切换 | 密度 | 容量冲突 |
| --- | --- | --- | --- | --- | --- | --- |
${(Object.entries(profileSummary) as Array<[string, any]>).map(([profile, value]) => `| ${profile} | ${value.unserved} | ${value.makespan} | ${value.queue_person_minutes} | ${value.switch_persons} | ${value.max_density} | ${value.capacity_violations} |`).join('\n')}

## 选择方法

| 方法 | 未疏散 | 完成 | 队列 | 切换 | 密度 | 配置分布 |
| --- | --- | --- | --- | --- | --- | --- |
${(Object.entries(selectionSummary) as Array<[string, any]>).map(([name, value]) => `| ${name} | ${value.unserved} | ${value.makespan} | ${value.queue_person_minutes} | ${value.switch_persons} | ${value.max_density} | ${JSON.stringify(value.profile_counts)} |`).join('\n')}
| constrained | ${constrainedSummary.unserved} | ${constrainedSummary.makespan} | ${constrainedSummary.queue_person_minutes} | ${constrainedSummary.switch_persons} | ${constrainedSummary.max_density} | ${JSON.stringify(constrainedSummary.profile_counts)} |

## Pareto 统计

- 实例数：${VARIANTS.length * SEEDS.length}；平均前沿大小 ${mean(frontSizes).toFixed(3)}，最大 ${Math.max(...frontSizes)}；
- 存在多目标权衡（前沿 >1）的实例：${instancesWithTradeoff}。

## 边界

- 权重配置是预先定义的，不是通过测试集反复调参得到；
- 膝点选择是离线上界，部署时必须单次规划并经过独立校验；
- 不得把离线选择结果表述为在线性能。
`;
fs.writeFileSync(path.join(OUT, 'multiobjective_README.md'), report);

const files = fs.readdirSync(OUT).filter(name => name.startsWith('multiobjective_')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'multiobjective_MANIFEST.json'), `${JSON.stringify({ version: 1, run_id: RUN_ID, note: 'V7.5 Track D 多目标证据（合成）。', file_count: manifest.length, files: manifest }, null, 2)}\n`);

console.log(`V7.5 multi-objective benchmark complete: evaluation/v75/${RUN_ID}/`);
console.log('profiles', JSON.stringify(profileSummary));
console.log('pareto', JSON.stringify({ mean_front_size: mean(frontSizes), instances_with_tradeoff: instancesWithTradeoff }));
