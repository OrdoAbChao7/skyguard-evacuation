import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../../src/services/safety/network';
import { planEvacuation } from '../../src/services/safety/planning/evacuation-planner';
import { runShadowComparison } from '../../src/services/safety/planning/v7-adapter';
import { buildObservation, ObservationStore } from '../../src/services/safety/observations';
import { makeMvpFixture, ADMIN } from './fixtures';
import type { DensityObservation } from '../../src/services/safety/types';

const scenarioPath = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

function setup(count = 240) {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const now = new Date('2026-11-10T01:00:00.000Z');
  const demand = new Map<string, number>();
  const observations = new Map<string, DensityObservation>();
  for (const region of scenario.regions) {
    const persons = region.enabled ? count : 0;
    demand.set(region.id, persons);
    if (persons > 0) {
      observations.set(region.id, buildObservation({
        region, count: persons, confidence: 0.95, source: 'simulation',
        provider: 'shadow-v73-test', modelVersion: 'test/1.0.0', observedAt: now, receivedAt: now,
      }));
    }
  }
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const built = planEvacuation({ scenario, network, demandByRegion: demand, ...versions, now });
  return { scenario, network, demand, observations, versions, now, legacyPlan: built.plan, legacySolveMs: built.solveMs };
}

test('过期快照被标记并回退，不运行 V7', () => {
  const base = setup();
  const comparison = runShadowComparison({
    scenario: base.scenario,
    network: base.network,
    demandByRegion: base.demand,
    versions: base.versions,
    latestObservations: base.observations,
    config: base.scenario.config,
    legacyPlan: base.legacyPlan,
    legacySolveMs: base.legacySolveMs,
    now: base.now,
    snapshotCapturedAt: new Date(base.now.getTime() - 60_000),
    configOverride: { enabled: true, strategy: 'solver', maxSolveMs: 500, maxComparisons: 20, maxSnapshotAgeMs: 5000, source: 'test' },
  });
  assert.equal(comparison.snapshot.stale, true);
  assert.equal(comparison.v7, null);
  assert.equal(comparison.decision, 'legacy_only');
  assert.equal(comparison.fallback_reason, 'snapshot_stale');
});

test('Shadow 记录 legacy 与 V7 的出口改派比较', () => {
  const base = setup();
  const comparison = runShadowComparison({
    scenario: base.scenario,
    network: base.network,
    demandByRegion: base.demand,
    versions: base.versions,
    latestObservations: base.observations,
    config: base.scenario.config,
    legacyPlan: base.legacyPlan,
    legacySolveMs: base.legacySolveMs,
    now: base.now,
    configOverride: { enabled: true, strategy: 'solver', maxSolveMs: 500, maxComparisons: 20, maxSnapshotAgeMs: 5000, source: 'test' },
  });
  assert.ok(comparison.route_switch_comparison);
  assert.ok(comparison.route_switch_comparison!.changed_regions >= 0);
  assert.ok(comparison.route_switch_comparison!.affected_persons >= 0);
  assert.ok(Array.isArray(comparison.route_switch_comparison!.regions));
});

test('ObservationStore 检测不同 provider 的冲突，但不误报同一 provider 的连续更新', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const region = scenario.regions.find(item => item.enabled)!;
  const now = new Date('2026-11-10T01:00:00.000Z');
  const store = new ObservationStore();
  store.ingest(buildObservation({ region, count: 300, confidence: 0.95, source: 'simulation', provider: 'a', modelVersion: 'a/1', observedAt: now, receivedAt: now }));
  store.ingest(buildObservation({ region, count: 310, confidence: 0.95, source: 'simulation', provider: 'a', modelVersion: 'a/1', observedAt: new Date(now.getTime() + 5000), receivedAt: now }));
  assert.equal(store.conflicts(region.id, 300, 0.5, now).length, 0);
  store.ingest(buildObservation({ region, count: 80, confidence: 0.95, source: 'simulation', provider: 'b', modelVersion: 'b/1', observedAt: new Date(now.getTime() + 6000), receivedAt: now }));
  const conflicts = store.conflicts(region.id, 300, 0.5, new Date(now.getTime() + 6000));
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].providers.sort(), ['a', 'b']);
});

test('冲突观测使决策服务跳过规划并保持不可信状态', () => {
  const fixture = makeMvpFixture();
  try {
    const now = new Date();
    for (const region of fixture.scenario.regions) {
      if (!region.enabled) continue;
      fixture.safety.ingestObservation({
        regionId: region.id, count: 300, confidence: 0.95, source: 'simulation',
        provider: 'provider-a', modelVersion: 'a/1.0.0', observedAt: now,
      }, ADMIN);
    }
    const region = fixture.scenario.regions.find(item => item.enabled)!;
    fixture.safety.ingestObservation({
      regionId: region.id, count: 40, confidence: 0.95, source: 'simulation',
      provider: 'provider-b', modelVersion: 'b/1.0.0', observedAt: new Date(now.getTime() - 1000),
    }, ADMIN);
    const result = fixture.safety.recompute(ADMIN, 'v73:conflict');
    assert.equal(result.plan, undefined);
    const planning = result.trace.stages.find(stage => stage.stage === 'planning');
    assert.ok(planning);
    assert.equal(planning!.status, 'skipped');
    assert.ok(String((planning!.detail as Record<string, unknown>)?.reason).includes('untrusted_observations'));
    assert.ok(result.trace.stages.some(stage => stage.stage === 'observation_assessment' && stage.status === 'warning'));
  } finally {
    fixture.cleanup();
  }
});
