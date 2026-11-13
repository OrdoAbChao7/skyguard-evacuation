import assert from 'node:assert/strict';
import test from 'node:test';
import { makeMvpFixture, ADMIN } from './fixtures';
import { resolveEffectiveNetwork } from '../../src/services/safety/network';
import { planEvacuation } from '../../src/services/safety/planning/evacuation-planner';
import { planEvacuationMpc } from '../../src/services/safety/planning/mpc-planner';
import { validateSafetyPlan } from '../../src/services/safety/validator';
import { buildObservation } from '../../src/services/safety/observations';
import { ensembleForecast } from '../../src/services/mvp/forecast-advanced';
import type { Incident } from '../../src/services/safety/types';

function incident(overrides: { exitIds?: string[]; corridorIds?: string[] }): Incident {
  const now = new Date().toISOString();
  return {
    id: 'INC-TEST-V71',
    type: 'fire',
    description: '测试：出口/通道故障',
    status: 'confirmed',
    severity: 'high',
    affected: { region_ids: [], corridor_ids: overrides.corridorIds ?? [], exit_ids: overrides.exitIds ?? [] },
    source: 'simulation',
    reported_by: 'test',
    reported_at: now,
    confirmed_by: 'test',
    confirmed_at: now,
  };
}

test('事件触发策略不会增加重规划次数，且完成疏散', () => {
  const fixture = makeMvpFixture();
  try {
    const network = resolveEffectiveNetwork(fixture.scenario, []);
    const demand = new Map<string, number>();
    for (const region of fixture.scenario.regions) demand.set(region.id, region.enabled ? 700 : 0);
    const versions = { scenarioVersion: fixture.scenario.version, constraintVersion: 0, observationVersion: 0 };
    const periodic = planEvacuationMpc({
      scenario: fixture.scenario, network, initialDemandByRegion: demand, versions,
      controlIntervalMinutes: 2, planningHorizonMinutes: 10, maxExecutionMinutes: 24, maxSteps: 20,
      useForecast: false, queueFeedback: false, replanPolicy: 'periodic', solver: 'v7',
    });
    const event = planEvacuationMpc({
      scenario: fixture.scenario, network, initialDemandByRegion: demand, versions,
      controlIntervalMinutes: 2, planningHorizonMinutes: 10, maxExecutionMinutes: 24, maxSteps: 20,
      useForecast: false, queueFeedback: false, replanPolicy: 'event', solver: 'v7',
      eventMaxIntervalMinutes: 4, eventQueueThreshold: 100_000,
    });
    assert.equal(periodic.unserved_persons, 0);
    assert.equal(event.unserved_persons, 0);
    assert.ok(event.replans <= periodic.replans, `event=${event.replans}, periodic=${periodic.replans}`);
    assert.ok(event.total_solve_ms <= periodic.total_solve_ms + 5, `event=${event.total_solve_ms}ms, periodic=${periodic.total_solve_ms}ms`);
  } finally {
    fixture.cleanup();
  }
});

test('出口故障时规划避开关闭出口并通过独立校验', () => {
  const fixture = makeMvpFixture();
  try {
    const network = resolveEffectiveNetwork(fixture.scenario, [incident({ exitIds: ['E_NORTH'] })]);
    const demand = new Map<string, number>();
    const observations = new Map();
    const now = new Date();
    for (const region of fixture.scenario.regions) {
      const count = region.enabled ? 300 : 0;
      demand.set(region.id, count);
      if (count > 0) {
        observations.set(region.id, buildObservation({
          region, count, confidence: 0.95, source: 'simulation', provider: 'test',
          modelVersion: 'test/1.0.0', observedAt: now, receivedAt: now,
        }));
      }
    }
    const plan = planEvacuation({
      scenario: fixture.scenario, network, demandByRegion: demand,
      scenarioVersion: fixture.scenario.version, constraintVersion: 1, observationVersion: 0, now,
    }).plan;
    assert.ok(!plan.routes.some(route => route.exit_id === 'E_NORTH'));
    const validation = validateSafetyPlan({
      plan, scenario: fixture.scenario, network,
      latestObservations: observations as Map<string, any>,
      config: fixture.scenario.config, constraintVersion: 1, observationVersion: 0, now,
    });
    assert.equal(validation.valid, true, JSON.stringify(validation.violations));
  } finally {
    fixture.cleanup();
  }
});

test('通道局部封控时规划不经过关闭通道并通过独立校验', () => {
  const fixture = makeMvpFixture();
  try {
    const network = resolveEffectiveNetwork(fixture.scenario, [incident({ corridorIds: ['C_NE'] })]);
    const demand = new Map<string, number>();
    const observations = new Map();
    const now = new Date();
    for (const region of fixture.scenario.regions) {
      const count = region.enabled ? 260 : 0;
      demand.set(region.id, count);
      if (count > 0) {
        observations.set(region.id, buildObservation({
          region, count, confidence: 0.95, source: 'simulation', provider: 'test',
          modelVersion: 'test/1.0.0', observedAt: now, receivedAt: now,
        }));
      }
    }
    const plan = planEvacuation({
      scenario: fixture.scenario, network, demandByRegion: demand,
      scenarioVersion: fixture.scenario.version, constraintVersion: 1, observationVersion: 0, now,
    }).plan;
    assert.ok(!plan.routes.some(route => route.steps.some(step => step.corridor_id === 'C_NE')));
    const validation = validateSafetyPlan({
      plan, scenario: fixture.scenario, network,
      latestObservations: observations as Map<string, any>,
      config: fixture.scenario.config, constraintVersion: 1, observationVersion: 0, now,
    });
    assert.equal(validation.valid, true, JSON.stringify(validation.violations));
  } finally {
    fixture.cleanup();
  }
});

test('预测输入含 NaN/异常值时仍返回有限结果并标记不可靠', () => {
  const samples = Array.from({ length: 30 }, (_, index) => ({
    x: index,
    y: index === 10 ? Number.NaN : index === 20 ? 1e9 : 300 + index,
  }));
  const result = ensembleForecast(samples, { horizonMinutes: 5, seed: 1 });
  assert.ok(Number.isFinite(result.predicted));
  assert.ok(result.interval90.lower <= result.interval90.upper);
  assert.ok(['ok', 'warning', 'failed'].includes(result.reliability.status));
});

test('过期观测时 recompute 跳过规划，Shadow 不运行', () => {
  const fixture = makeMvpFixture();
  const previous = process.env.V7_SHADOW_MODE;
  try {
    process.env.V7_SHADOW_MODE = '1';
    const staleAt = new Date(Date.now() - 10 * 60_000);
    for (const region of fixture.scenario.regions) {
      if (!region.enabled) continue;
      fixture.safety.ingestObservation({
        regionId: region.id,
        count: 300,
        confidence: 0.95,
        source: 'simulation',
        provider: 'test',
        modelVersion: 'test/1.0.0',
        observedAt: staleAt,
      }, ADMIN);
    }
    const result = fixture.safety.recompute(ADMIN, 'test:stale-shadow');
    assert.equal(result.plan, undefined);
    assert.equal(fixture.safety.getShadowComparisons().length, 0);
  } finally {
    if (previous === undefined) delete process.env.V7_SHADOW_MODE;
    else process.env.V7_SHADOW_MODE = previous;
    fixture.cleanup();
  }
});
