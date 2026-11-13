import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../../src/services/safety/network';
import { planEvacuation } from '../../src/services/safety/planning/evacuation-planner';
import { runShadowComparison } from '../../src/services/safety/planning/v7-adapter';
import { buildObservation } from '../../src/services/safety/observations';
import type { DensityObservation } from '../../src/services/safety/types';

const scenarioPath = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

function setup(count = 260) {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const demand = new Map<string, number>();
  const observations = new Map<string, DensityObservation>();
  const now = new Date('2026-11-10T01:00:00.000Z');
  for (const region of scenario.regions) {
    const persons = region.enabled ? count : 0;
    demand.set(region.id, persons);
    if (persons > 0) {
      observations.set(region.id, buildObservation({
        region,
        count: persons,
        confidence: 0.95,
        source: 'simulation',
        provider: 'test',
        modelVersion: 'test/1.0.0',
        observedAt: now,
        receivedAt: now,
      }));
    }
  }
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const built = planEvacuation({ scenario, network, demandByRegion: demand, ...versions, now });
  return { scenario, network, demand, observations, versions, now, legacyPlan: built.plan, legacySolveMs: built.solveMs };
}

function shadowInput(base: ReturnType<typeof setup>, overrides: Record<string, unknown> = {}) {
  return {
    scenario: base.scenario,
    network: base.network,
    demandByRegion: base.demand,
    versions: base.versions,
    latestObservations: base.observations,
    config: base.scenario.config,
    legacyPlan: base.legacyPlan,
    legacySolveMs: base.legacySolveMs,
    now: base.now,
    configOverride: { enabled: true, strategy: 'solver' as const, maxSolveMs: 500, maxComparisons: 20, source: 'test' },
    ...overrides,
  };
}

test('Shadow 求解器异常时回退 legacy，且 legacy 校验不受影响', () => {
  const base = setup();
  const comparison = runShadowComparison(shadowInput(base, {
    solverOverride: () => { throw new Error('injected solver failure'); },
  }));
  assert.equal(comparison.v7, null);
  assert.ok(comparison.fallback_reason?.startsWith('v7_error:'));
  assert.equal(comparison.decision, 'legacy_only');
  assert.equal(comparison.legacy.validation_valid, true);
  assert.equal(comparison.snapshot.hash.length, 64);
});

test('相同输入快照哈希一致；需求变化会改变快照哈希', () => {
  const base = setup();
  const first = runShadowComparison(shadowInput(base));
  const second = runShadowComparison(shadowInput(base));
  assert.equal(first.snapshot.hash, second.snapshot.hash);
  assert.equal(first.legacy.plan_id, second.legacy.plan_id);

  const changed = new Map(base.demand);
  const regionId = base.scenario.regions.find(region => region.enabled)!.id;
  changed.set(regionId, (changed.get(regionId) ?? 0) + 50);
  const rebuilt = planEvacuation({
    scenario: base.scenario,
    network: base.network,
    demandByRegion: changed,
    ...base.versions,
    now: base.now,
  });
  const third = runShadowComparison(shadowInput(base, { demandByRegion: changed, legacyPlan: rebuilt.plan }));
  assert.notEqual(third.snapshot.hash, first.snapshot.hash);
});

test('V7 方案校验失败时回退 legacy，并记录失败原因', () => {
  const base = setup();
  const comparison = runShadowComparison(shadowInput(base, {
    solverOverride: () => ({
      plan: {
        ...base.legacyPlan,
        plan_id: 'PLAN-INVALID-VERSION',
        observation_version: base.versions.observationVersion + 1,
      },
    }),
  }));
  assert.ok(comparison.v7);
  assert.equal(comparison.v7!.validation_valid, false);
  assert.equal(comparison.decision, 'legacy_only');
  assert.equal(comparison.fallback_reason, 'v7_validation_failed');
  assert.equal(comparison.legacy.validation_valid, true);
});

test('预算为零立即回退，不调用注入求解器', () => {
  const base = setup();
  let called = false;
  const comparison = runShadowComparison(shadowInput(base, {
    configOverride: { enabled: true, strategy: 'solver', maxSolveMs: 0, maxComparisons: 20, source: 'test' },
    solverOverride: () => { called = true; throw new Error('must not run'); },
  }));
  assert.equal(called, false);
  assert.equal(comparison.fallback_reason, 'solve_budget_zero');
  assert.equal(comparison.decision, 'legacy_only');
});
