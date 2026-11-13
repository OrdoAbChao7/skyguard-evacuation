/**
 * V7.3 Phase 3：Shadow Mode 运营验证（历史回放 + 故障/冲突/并发注入）。
 *
 *   npm run benchmark:v73 --prefix backend -- --only=shadow
 *
 * 10 种子 × 8 用例；V7 永不发布；Shadow 默认关闭。
 * 全部为合成场景/观测。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../src/services/safety/network';
import { planEvacuation } from '../src/services/safety/planning/evacuation-planner';
import { runShadowComparison, type ShadowComparison } from '../src/services/safety/planning/v7-adapter';
import { ObservationStore } from '../src/services/safety/observations';
import { buildObservation } from '../src/services/safety/observations';
import { regionRiskRatio } from '../src/services/safety/planning/route-stability';
import type { DensityObservation, Incident, SafetyScenario } from '../src/services/safety/types';

const RUN_ID = process.env.V73_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v73', RUN_ID);
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const SEEDS = Array.from({ length: 10 }, (_, index) => 20261111 + index);
const CASES = [
  'historical_replay',
  'sensor_failure',
  'sudden_surge',
  'corridor_closure',
  'exit_failure',
  'conflicting_observations',
  'stale_snapshot',
  'concurrent_events',
] as const;
type CaseName = (typeof CASES)[number];

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

function incidentFor(type: 'fire' | 'sensor_failure', exitIds: string[], corridorIds: string[], regionIds: string[], suffix: string): Incident {
  const now = new Date().toISOString();
  return {
    id: `INC-V73-SHADOW-${suffix}`,
    type,
    description: `Shadow 运营验证：${suffix}`,
    status: 'confirmed',
    severity: 'high',
    affected: { region_ids: regionIds, corridor_ids: corridorIds, exit_ids: exitIds },
    source: 'simulation',
    reported_by: 'v73-shadow',
    reported_at: now,
    confirmed_by: 'v73-shadow',
    confirmed_at: now,
  };
}

interface Setup {
  case: CaseName;
  seed: number;
  scenario: SafetyScenario;
  network: ReturnType<typeof resolveEffectiveNetwork>;
  demand: Map<string, number>;
  observations: Map<string, DensityObservation>;
  versions: { scenarioVersion: string; constraintVersion: number; observationVersion: number };
  now: Date;
  legacyPlan: ReturnType<typeof planEvacuation>['plan'];
  legacySolveMs: number;
  conflicts: Array<{ region_id: string; count: number }>;
  snapshotCapturedAt?: Date;
}

function buildSetup(base: SafetyScenario, caseName: CaseName, seed: number): Setup {
  const rng = mulberry32(seed * 1009 + 61 + CASES.indexOf(caseName) * 104_729);
  const now = new Date('2026-11-10T01:00:00.000Z');
  const incidents: Incident[] = [];
  if (caseName === 'sensor_failure') {
    incidents.push(incidentFor('sensor_failure', [], [], [base.regions.find(region => region.enabled)!.id], 'SENSOR'));
  }
  if (caseName === 'corridor_closure') incidents.push(incidentFor('fire', [], ['C_NE'], [], 'CORR'));
  if (caseName === 'exit_failure') incidents.push(incidentFor('fire', ['E_NORTH'], [], [], 'EXIT'));
  if (caseName === 'concurrent_events') {
    incidents.push(incidentFor('fire', ['E_NORTH'], [], [], 'EXIT'));
    incidents.push(incidentFor('fire', [], ['C_NE'], [], 'CORR'));
  }
  const network = resolveEffectiveNetwork(base, incidents);
  const surge = caseName === 'sudden_surge' ? 350 : 0;
  const demand = new Map<string, number>();
  for (const region of base.regions) {
    demand.set(region.id, region.enabled ? Math.round(240 + rng() * 80 + (region.id.length * 11) % 50 + surge) : 0);
  }
  const observations = new Map<string, DensityObservation>();
  for (const region of base.regions) {
    const count = demand.get(region.id) ?? 0;
    if (count <= 0) continue;
    observations.set(region.id, buildObservation({
      region, count, confidence: 0.95, source: 'simulation', provider: 'shadow-v73',
      modelVersion: 'shadow-v73/1.0.0', observedAt: now, receivedAt: now,
    }));
  }
  const conflicts: Setup['conflicts'] = [];
  if (caseName === 'conflicting_observations') {
    const store = new ObservationStore();
    const region = base.regions.find(item => item.enabled)!;
    const first = buildObservation({
      region, count: 320, confidence: 0.95, source: 'simulation', provider: 'provider-a',
      modelVersion: 'a/1.0.0', observedAt: now, receivedAt: now,
    });
    const second = buildObservation({
      region, count: 80, confidence: 0.95, source: 'simulation', provider: 'provider-b',
      modelVersion: 'b/1.0.0', observedAt: now, receivedAt: now,
    });
    store.ingest(first);
    store.ingest(second);
    const detected = store.conflicts(region.id, 300, 0.5, now);
    for (const conflict of detected) {
      conflicts.push({ region_id: region.id, count: conflict.counts[0] });
    }
    // 快照使用 provider-a 的最新观测；冲突本身由报告标记，不得声称已被解决。
    observations.set(region.id, first);
  }
  const versions = {
    scenarioVersion: base.version,
    constraintVersion: incidents.length,
    observationVersion: caseName === 'historical_replay' ? 2 : 0,
  };
  const built = planEvacuation({ scenario: base, network, demandByRegion: demand, ...versions, now });
  return {
    case: caseName,
    seed,
    scenario: base,
    network,
    demand,
    observations,
    versions,
    now,
    legacyPlan: built.plan,
    legacySolveMs: built.solveMs,
    conflicts,
    snapshotCapturedAt: caseName === 'stale_snapshot' ? new Date(now.getTime() - 60_000) : now,
  };
}

interface Row {
  case: CaseName;
  seed: number;
  decision: ShadowComparison['decision'];
  fallback_reason: string | null;
  legacy_valid: boolean | null;
  v7_valid: boolean | null;
  snapshot_stale: boolean;
  snapshot_hash: string;
  route_switch_regions: number | null;
  route_switch_persons: number | null;
  conflicts_detected: number;
  evacuated_delta: number | null;
  makespan_delta: number | null;
  deterministic: boolean;
}

function runOnce(setup: Setup): { row: Row; comparison: ShadowComparison } {
  const comparison = runShadowComparison({
    scenario: setup.scenario,
    network: setup.network,
    demandByRegion: setup.demand,
    versions: setup.versions,
    latestObservations: setup.observations,
    config: setup.scenario.config,
    legacyPlan: setup.legacyPlan,
    legacySolveMs: setup.legacySolveMs,
    now: setup.now,
    snapshotCapturedAt: setup.snapshotCapturedAt,
    configOverride: {
      enabled: true,
      strategy: 'solver',
      maxSolveMs: 500,
      maxComparisons: 20,
      maxSnapshotAgeMs: 5000,
      source: 'shadow-v73',
    },
  });
  return {
    comparison,
    row: {
      case: setup.case,
      seed: setup.seed,
      decision: comparison.decision,
      fallback_reason: comparison.fallback_reason,
      legacy_valid: comparison.legacy.validation_valid,
      v7_valid: comparison.v7?.validation_valid ?? null,
      snapshot_stale: comparison.snapshot.stale,
      snapshot_hash: comparison.snapshot.hash.slice(0, 12),
      route_switch_regions: comparison.route_switch_comparison?.changed_regions ?? null,
      route_switch_persons: comparison.route_switch_comparison?.affected_persons ?? null,
      conflicts_detected: setup.conflicts.length,
      evacuated_delta: comparison.comparison.evacuated_delta,
      makespan_delta: comparison.comparison.projected_makespan_delta,
      deterministic: false,
    },
  };
}

const base = loadSafetyScenario(SCENARIO_PATH);
fs.mkdirSync(OUT, { recursive: true });
const rows: Row[] = [];
for (const caseName of CASES) {
  for (const seed of SEEDS) {
    const setup = buildSetup(base, caseName, seed);
    const first = runOnce(setup);
    const second = runOnce(setup);
    const deterministic = first.comparison.snapshot.hash === second.comparison.snapshot.hash
      && first.comparison.decision === second.comparison.decision
      && first.comparison.fallback_reason === second.comparison.fallback_reason
      && first.comparison.legacy.plan_id === second.comparison.legacy.plan_id;
    rows.push({ ...first.row, deterministic });
  }
}

const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const byCase = Object.fromEntries(CASES.map(caseName => {
  const subset = rows.filter(row => row.case === caseName);
  return [caseName, {
    n: subset.length,
    decisions: subset.reduce((acc, row) => { acc[row.decision] = (acc[row.decision] ?? 0) + 1; return acc; }, {} as Record<string, number>),
    fallbacks: subset.reduce((acc, row) => { const key = row.fallback_reason ?? 'none'; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {} as Record<string, number>),
    legacy_valid_rate: Number((subset.filter(row => row.legacy_valid === true).length / Math.max(1, subset.length)).toFixed(4)),
    v7_valid_rate: Number((subset.filter(row => row.v7_valid === true).length / Math.max(1, subset.length)).toFixed(4)),
    stale_snapshots: subset.filter(row => row.snapshot_stale).length,
    conflicts_detected: subset.reduce((sum, row) => sum + row.conflicts_detected, 0),
    route_switch_regions_mean: Number(mean(subset.map(row => row.route_switch_regions ?? 0)).toFixed(4)),
    route_switch_persons_mean: Number(mean(subset.map(row => row.route_switch_persons ?? 0)).toFixed(4)),
    evacuated_delta_mean: Number(mean(subset.map(row => row.evacuated_delta ?? 0)).toFixed(4)),
    deterministic_mismatches: subset.filter(row => row.deterministic === false).length,
  }];
}));

const summary = {
  config: {
    seeds: SEEDS, cases: CASES,
    note: 'Shadow 适配器层运营验证；V7 永不发布；全部为合成场景/观测。',
  },
  total_runs: rows.length,
  by_case: byCase,
  deterministic_mismatches: rows.filter(row => row.deterministic === false).length,
  decisions: rows.reduce((acc, row) => { acc[row.decision] = (acc[row.decision] ?? 0) + 1; return acc; }, {} as Record<string, number>),
};

const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('shadow_ops_rows.json', rows);
write('shadow_ops_summary.json', summary);

const report = `# V7.3 Shadow Mode 运营验证

> 运行 ID：\`${RUN_ID}\`。10 种子 × 8 用例；**Shadow 默认关闭，V7 永不发布**；全部为合成场景/观测。

## 1. 用例

| 用例 | 预期 |
| --- | --- |
| historical_replay | 版本化快照重复回放，确定性 |
| sensor_failure | 传感器故障区域不可信 |
| sudden_surge | 需求突增时 legacy/V7 同快照比较 |
| corridor_closure | 通道封控后规划避开 |
| exit_failure | 出口故障后规划避开 |
| conflicting_observations | 不同 provider 冲突被标记 |
| stale_snapshot | 快照过期 → \`snapshot_stale\` 回退 |
| concurrent_events | 多事件同时生效，版本一致 |

## 2. 结果

| 用例 | legacy 校验率 | V7 校验率 | 决策分布 | 回退原因 | 冲突数 | 切换区域/人数 | 确定性不一致 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${CASES.map(caseName => {
  const value = (byCase as any)[caseName];
  return `| ${caseName} | ${value.legacy_valid_rate} | ${value.v7_valid_rate} | ${JSON.stringify(value.decisions)} | ${JSON.stringify(value.fallbacks)} | ${value.conflicts_detected} | ${value.route_switch_regions_mean}/${value.route_switch_persons_mean} | ${value.deterministic_mismatches} |`;
}).join('\n')}

## 3. 结论

- 确定性不一致：${summary.deterministic_mismatches}；
- 过期快照：${CASES.includes('stale_snapshot') ? (byCase as any).stale_snapshot.stale_snapshots : 0} 次被标记并回退；
- 冲突观测：${(byCase as any).conflicting_observations.conflicts_detected} 次检测；适配器不解决冲突，只标记；
- V7 从未发布：适配器只返回比较记录，发布路径不读取 Shadow。

## 4. 边界

- 适配器层回放，不覆盖真实 HTTP 并发/持久化；
- 冲突检测只比较不同 provider 的近期观测；
- 合成场景/观测；不代表真实运营。
`;
fs.writeFileSync(path.join(OUT, 'shadow_ops_README.md'), report);
fs.writeFileSync(path.join(OUT, 'shadow_ops_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(), run_id: RUN_ID,
  node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);

const files = fs.readdirSync(OUT).filter(name => name.startsWith('shadow_ops_')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'shadow_ops_MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, note: 'V7.3 Shadow 运营验证清单（合成）。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.3 shadow ops complete: evaluation/v73/${RUN_ID}/`);
console.log(`runs=${rows.length}, determinism_mismatches=${summary.deterministic_mismatches}`);
console.log(`decisions=${JSON.stringify(summary.decisions)}`);
