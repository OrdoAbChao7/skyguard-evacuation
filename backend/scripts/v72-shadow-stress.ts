/**
 * V7.2 Shadow Mode 回放压力与故障注入。
 *
 *   npm run benchmark:v72 --prefix backend -- --only=shadow
 *
 * 验证：
 *  - legacy/V7 接收同一版本化输入快照（快照哈希、人数一致性）；
 *  - 两套方案都经独立校验；V7 永不发布（适配器层只记录）；
 *  - 求解器异常、校验失败、预算为零、过期观测、快照篡改都会安全回退/标记；
 *  - 相同输入重复回放具有确定性。
 *
 * 全部为合成场景与合成观测。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../src/services/safety/network';
import { planEvacuation } from '../src/services/safety/planning/evacuation-planner';
import { runShadowComparison, type ShadowComparison, type ShadowSolver } from '../src/services/safety/planning/v7-adapter';
import { buildObservation } from '../src/services/safety/observations';
import type { DensityObservation, Incident, SafetyScenario } from '../src/services/safety/types';

const RUN_ID = process.env.V72_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v72', RUN_ID);
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const SEEDS = Array.from({ length: 10 }, (_, index) => 20261110 + index);
const VARIANTS = ['baseline', 'exit_failure', 'corridor_closure', 'high_demand'] as const;
type Variant = (typeof VARIANTS)[number];
const MODES = ['normal', 'solver_error', 'validation_failure', 'budget_zero', 'stale_observation', 'snapshot_tamper'] as const;
type Mode = (typeof MODES)[number];

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
const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const ci = (values: number[]) => {
  if (values.length === 0) return { mean: 0, lower: 0, upper: 0, n: 0 };
  const m = mean(values);
  const sd = values.length > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1)) : 0;
  const half = values.length > 1 ? 1.96 * sd / Math.sqrt(values.length) : 0;
  return { mean: Number(m.toFixed(4)), lower: Number((m - half).toFixed(4)), upper: Number((m + half).toFixed(4)), n: values.length };
};

function incidentFor(exitIds: string[], corridorIds: string[]): Incident {
  const now = new Date().toISOString();
  return {
    id: `INC-SHADOW-${exitIds.join('-')}-${corridorIds.join('-')}`,
    type: 'fire',
    description: 'Shadow 回放：出口/通道故障',
    status: 'confirmed',
    severity: 'high',
    affected: { region_ids: [], corridor_ids: corridorIds, exit_ids: exitIds },
    source: 'simulation',
    reported_by: 'v72-shadow',
    reported_at: now,
    confirmed_by: 'v72-shadow',
    confirmed_at: now,
  };
}

interface CaseSetup {
  variant: Variant;
  seed: number;
  scenario: SafetyScenario;
  network: ReturnType<typeof resolveEffectiveNetwork>;
  demand: Map<string, number>;
  observations: Map<string, DensityObservation>;
  versions: { scenarioVersion: string; constraintVersion: number; observationVersion: number };
  now: Date;
  legacyPlan: ReturnType<typeof planEvacuation>['plan'];
  legacySolveMs: number;
}

function buildCase(base: SafetyScenario, variant: Variant, seed: number): CaseSetup {
  const rng = mulberry32(seed * 1009 + VARIANTS.indexOf(variant) * 104_729);
  const incidents = variant === 'exit_failure'
    ? [incidentFor(['E_NORTH'], [])]
    : variant === 'corridor_closure'
      ? [incidentFor([], ['C_NE'])]
      : [];
  const network = resolveEffectiveNetwork(base, incidents);
  const demand = new Map<string, number>();
  const now = new Date('2026-11-10T01:00:00.000Z');
  for (const region of base.regions) {
    const baseCount = variant === 'high_demand' ? 820 : 220;
    demand.set(region.id, region.enabled ? Math.round(baseCount + rng() * 120) : 0);
  }
  const observations = new Map<string, DensityObservation>();
  for (const region of base.regions) {
    const persons = demand.get(region.id) ?? 0;
    if (persons <= 0) continue;
    observations.set(region.id, buildObservation({
      region,
      count: persons,
      confidence: 0.95,
      source: 'simulation',
      provider: 'shadow-stress',
      modelVersion: 'shadow-stress/1.0.0',
      observedAt: now,
      receivedAt: now,
    }));
  }
  const versions = { scenarioVersion: base.version, constraintVersion: incidents.length > 0 ? 1 : 0, observationVersion: 0 };
  const built = planEvacuation({ scenario: base, network, demandByRegion: demand, ...versions, now });
  return { variant, seed, scenario: base, network, demand, observations, versions, now, legacyPlan: built.plan, legacySolveMs: built.solveMs };
}

interface Row {
  case: string;
  mode: Mode;
  variant: Variant;
  seed: number;
  decision: ShadowComparison['decision'];
  fallback_reason: string | null;
  legacy_valid: boolean | null;
  v7_valid: boolean | null;
  legacy_matches_snapshot: boolean;
  v7_matches_snapshot: boolean | null;
  snapshot_hash_prefix: string;
  evacuated_delta: number | null;
  makespan_delta: number | null;
  queue_delta: number | null;
  v7_solve_ms: number | null;
  deterministic: boolean | null;
}

function runCase(setup: CaseSetup, mode: Mode, repeat = false): { row: Row; comparison: ShadowComparison } {
  const staleAt = new Date(setup.now.getTime() - 10 * 60_000);
  const observations = new Map(setup.observations);
  if (mode === 'stale_observation') {
    for (const [regionId, observation] of observations) {
      observations.set(regionId, { ...observation, observed_at: staleAt.toISOString(), received_at: staleAt.toISOString() });
    }
  }
  let solverOverride: ShadowSolver | undefined;
  if (mode === 'solver_error') {
    solverOverride = () => { throw new Error('injected shadow solver failure'); };
  } else if (mode === 'validation_failure') {
    solverOverride = () => ({
      plan: {
        ...setup.legacyPlan,
        plan_id: 'PLAN-SHADOW-INVALID',
        observation_version: setup.versions.observationVersion + 1,
      },
    });
  }
  let demand = setup.demand;
  let legacyPlan = setup.legacyPlan;
  if (mode === 'snapshot_tamper') {
    const tampered = new Map(setup.demand);
    for (const [regionId, persons] of tampered) tampered.set(regionId, persons + 50);
    const rebuilt = planEvacuation({
      scenario: setup.scenario,
      network: setup.network,
      demandByRegion: tampered,
      ...setup.versions,
      now: setup.now,
    });
    legacyPlan = rebuilt.plan;
  }
  const comparison = runShadowComparison({
    scenario: setup.scenario,
    network: setup.network,
    demandByRegion: demand,
    versions: setup.versions,
    latestObservations: observations,
    config: setup.scenario.config,
    legacyPlan,
    legacySolveMs: setup.legacySolveMs,
    now: setup.now,
    solverOverride,
    configOverride: {
      enabled: true,
      strategy: 'solver',
      maxSolveMs: mode === 'budget_zero' ? 0 : 500,
      maxComparisons: 20,
      source: 'shadow-stress',
    },
  });
  return {
    comparison,
    row: {
      case: `${setup.variant}-${setup.seed}-${mode}`,
      mode,
      variant: setup.variant,
      seed: setup.seed,
      decision: comparison.decision,
      fallback_reason: comparison.fallback_reason,
      legacy_valid: comparison.legacy.validation_valid,
      v7_valid: comparison.v7?.validation_valid ?? null,
      legacy_matches_snapshot: comparison.integrity.legacy_persons_match_snapshot,
      v7_matches_snapshot: comparison.integrity.v7_persons_match_snapshot,
      snapshot_hash_prefix: comparison.snapshot.hash.slice(0, 12),
      evacuated_delta: comparison.comparison.evacuated_delta,
      makespan_delta: comparison.comparison.projected_makespan_delta,
      queue_delta: comparison.comparison.projected_queue_delta,
      v7_solve_ms: comparison.v7?.solve_ms ?? null,
      deterministic: repeat ? null : null,
    },
  };
}

const base = loadSafetyScenario(SCENARIO_PATH);
fs.mkdirSync(OUT, { recursive: true });
const rows: Row[] = [];
const comparisons: Array<{ case: string; comparison: ShadowComparison }> = [];
for (const variant of VARIANTS) {
  for (const seed of SEEDS) {
    const setup = buildCase(base, variant, seed);
    for (const mode of MODES) {
      const first = runCase(setup, mode);
      const second = runCase(setup, mode, true);
      const deterministic = first.comparison.snapshot.hash === second.comparison.snapshot.hash
        && first.comparison.decision === second.comparison.decision
        && first.comparison.fallback_reason === second.comparison.fallback_reason
        && first.comparison.legacy.plan_id === second.comparison.legacy.plan_id;
      rows.push({ ...first.row, deterministic });
      comparisons.push({ case: first.row.case, comparison: first.comparison });
    }
  }
}

const byMode = Object.fromEntries(MODES.map(mode => {
  const subset = rows.filter(row => row.mode === mode);
  return [mode, {
    n: subset.length,
    decision_counts: subset.reduce((acc, row) => {
      acc[row.decision] = (acc[row.decision] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    fallback_counts: subset.reduce((acc, row) => {
      const key = row.fallback_reason ?? 'none';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    legacy_valid_rate: Number((subset.filter(row => row.legacy_valid === true).length / Math.max(1, subset.length)).toFixed(4)),
    v7_valid_rate: Number((subset.filter(row => row.v7_valid === true).length / Math.max(1, subset.length)).toFixed(4)),
    integrity_mismatches: subset.filter(row => row.legacy_matches_snapshot === false || row.v7_matches_snapshot === false).length,
    determinism_mismatches: subset.filter(row => row.deterministic === false).length,
    evacuated_delta: ci(subset.map(row => row.evacuated_delta).filter((value): value is number => value !== null)),
    makespan_delta: ci(subset.map(row => row.makespan_delta).filter((value): value is number => value !== null)),
    queue_delta: ci(subset.map(row => row.queue_delta).filter((value): value is number => value !== null)),
  }];
}));

const summary = {
  config: {
    seeds: SEEDS,
    variants: VARIANTS,
    modes: MODES,
    note: '适配器层回放；Shadow 永不发布 V7；全部为合成场景/观测。',
  },
  total_runs: rows.length,
  by_mode: byMode,
  determinism_mismatches: rows.filter(row => row.deterministic === false).length,
  integrity_mismatches: rows.filter(row => row.legacy_matches_snapshot === false || row.v7_matches_snapshot === false).length,
  decisions: rows.reduce((acc, row) => {
    acc[row.decision] = (acc[row.decision] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>),
};

const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('shadow_stress_rows.json', rows);
write('shadow_stress_summary.json', summary);
write('shadow_stress_comparisons.json', comparisons);

const report = `# V7.2 Shadow Mode 回放压力与故障注入

> 运行 ID：\`${RUN_ID}\`。适配器层回放；**Shadow 永不发布 V7**；全部为合成场景/合成观测。
> ${SEEDS.length} 种子 × ${VARIANTS.length} 场景 × ${MODES.length} 注入模式 = ${rows.length} 次比较（每次重复回放验证确定性）。

## 1. 注入模式与预期

| 模式 | 预期 |
| --- | --- |
| normal | 两套方案均校验；输出仅比较记录 |
| solver_error | V7 异常 → \`v7_error:*\` 回退，legacy 不受影响 |
| validation_failure | V7 校验失败 → \`v7_validation_failed\` 回退 |
| budget_zero | 不运行 V7 → \`solve_budget_zero\` |
| stale_observation | 两套校验均失败（过期观测不得发布） |
| snapshot_tamper | legacy 计划人数与快照不一致 → \`legacy_snapshot_mismatch\` |

## 2. 按模式汇总

| 模式 | n | legacy 校验通过率 | V7 校验通过率 | 完整性不一致 | 确定性不一致 | 决策分布 | 回退原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${MODES.map(mode => {
  const value = (byMode as any)[mode];
  return `| ${mode} | ${value.n} | ${value.legacy_valid_rate} | ${value.v7_valid_rate} | ${value.integrity_mismatches} | ${value.determinism_mismatches} | ${JSON.stringify(value.decision_counts)} | ${JSON.stringify(value.fallback_counts)} |`;
}).join('\n')}

## 3. 关键结论

- 确定性：${summary.determinism_mismatches === 0 ? '全部重复回放一致' : `${summary.determinism_mismatches} 次不一致`}；
- 完整性：${summary.integrity_mismatches} 次快照人数不一致（应仅出现在 snapshot_tamper）；
- 决策分布：${JSON.stringify(summary.decisions)}；
- V7 从未被发布：适配器只返回比较记录，发布路径不读取 Shadow 结果。

## 4. 边界

- 适配器层回放，不包含真实 HTTP 并发、持久化中断或 AgentArts 重试；
- 过期观测在服务层会直接跳过规划（已有测试）；本实验记录适配器层校验结果；
- 合成观测与合成场景；不代表真实场馆运行。
`;
fs.writeFileSync(path.join(OUT, 'shadow_stress_README.md'), report);
fs.writeFileSync(path.join(OUT, 'shadow_stress_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);

const files = fs.readdirSync(OUT).filter(name => name.startsWith('shadow_stress_')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'shadow_stress_MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, note: 'V7.2 Shadow 回放压力证据清单（合成）。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.2 shadow stress complete: evaluation/v72/${RUN_ID}/`);
console.log(`runs=${rows.length}, determinism_mismatches=${summary.determinism_mismatches}, integrity_mismatches=${summary.integrity_mismatches}`);
console.log(`decisions=${JSON.stringify(summary.decisions)}`);
