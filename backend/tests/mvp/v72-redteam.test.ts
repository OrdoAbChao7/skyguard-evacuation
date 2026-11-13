import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../../src/services/safety/network';
import { planEvacuationMpc } from '../../src/services/safety/planning/mpc-planner';
import { solveTimeExpandedPlan } from '../../src/services/safety/planning/strategies';
import { checkPlanCapacity } from '../../src/services/safety/planning/route-stability';
import { solveCommitmentAwarePlan } from '../../src/services/safety/planning/stable-solver';
import { adaptCameraCount } from '../../src/services/safety/calibration/venue-calibration';
import { validateSafetyPlan } from '../../src/services/safety/validator';
import { buildObservation } from '../../src/services/safety/observations';
import type { DensityObservation, SafetyScenario } from '../../src/services/safety/types';

const scenarioPath = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

function cloneScenario(scenario: SafetyScenario): SafetyScenario {
  return JSON.parse(JSON.stringify(scenario)) as SafetyScenario;
}

function observationsFor(scenario: SafetyScenario, demand: Map<string, number>, now: Date): Map<string, DensityObservation> {
  const observations = new Map<string, DensityObservation>();
  for (const region of scenario.regions) {
    const count = demand.get(region.id) ?? 0;
    if (count <= 0) continue;
    observations.set(region.id, buildObservation({
      region,
      count,
      confidence: 0.95,
      source: 'simulation',
      provider: 'redteam',
      modelVersion: 'redteam/1.0.0',
      observedAt: now,
      receivedAt: now,
    }));
  }
  return observations;
}

test('双向通道：随机需求下求解结果不超物理容量并通过独立校验', () => {
  const base = loadSafetyScenario(scenarioPath);
  const scenario = cloneScenario(base);
  for (const corridor of scenario.corridors) {
    if (corridor.capacity_per_min !== null) corridor.direction = 'both';
  }
  const network = resolveEffectiveNetwork(scenario, []);
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const now = new Date('2026-11-10T01:00:00.000Z');
  for (let round = 0; round < 8; round += 1) {
    const demand = new Map<string, number>();
    for (const region of scenario.regions) {
      demand.set(region.id, region.enabled ? 120 + round * 20 + (region.id.length * 17) % 40 : 0);
    }
    const solved = solveTimeExpandedPlan({
      scenario,
      network,
      demandByRegion: demand,
      horizonMinutes: 10,
      versions,
      now,
      holdCostPerMinute: 0.05,
    });
    const violations = checkPlanCapacity(scenario, solved.plan.routes, 0);
    assert.deepEqual(violations, [], `round ${round}: ${JSON.stringify(violations)}`);
    const validation = validateSafetyPlan({
      plan: solved.plan,
      scenario,
      network,
      latestObservations: observationsFor(scenario, demand, now),
      config: scenario.config,
      constraintVersion: 0,
      observationVersion: 0,
      now,
    });
    assert.equal(validation.valid, true, JSON.stringify(validation.violations));
  }
});

test('预测突变：NaN/Infinity/负数/超大值不会污染 MPC 指标', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const demand = new Map(scenario.regions.map(region => [region.id, region.enabled ? 500 : 0]));
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const regionId = scenario.regions.find(region => region.enabled)!.id;
  const result = planEvacuationMpc({
    scenario,
    network,
    initialDemandByRegion: demand,
    versions,
    controlIntervalMinutes: 2,
    planningHorizonMinutes: 10,
    maxExecutionMinutes: 24,
    maxSteps: 24,
    useForecast: true,
    queueFeedback: true,
    predictedArrivals: new Map([[regionId, [
      { offsetMinute: 2, persons: Number.NaN },
      { offsetMinute: Number.POSITIVE_INFINITY, persons: 100 },
      { offsetMinute: 3, persons: -50 },
      { offsetMinute: 4, persons: 1e12 },
    ]]]),
    actualArrivals: new Map([[regionId, [
      { offsetMinute: 3, persons: Number.NaN },
      { offsetMinute: 5, persons: 80 },
    ]]]),
  });
  for (const value of [
    result.total_input_persons, result.completed_persons, result.unserved_persons,
    result.makespan_minute, result.total_queue_person_minutes, result.max_queue_persons,
    result.mean_wait_minutes, result.p95_wait_minutes, result.switch_persons,
    result.max_density_persons_per_m2, result.worst_risk_ratio,
  ]) {
    assert.ok(Number.isFinite(value), `non-finite metric: ${value}`);
  }
  assert.ok(result.unserved_persons >= 0);
});

test('运行中通道封控：故障后执行路线不再经过关闭通道', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const demand = new Map(scenario.regions.map(region => [region.id, region.enabled ? 700 : 0]));
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const result = planEvacuationMpc({
    scenario,
    network,
    initialDemandByRegion: demand,
    versions,
    controlIntervalMinutes: 2,
    planningHorizonMinutes: 10,
    maxExecutionMinutes: 24,
    maxSteps: 24,
    useForecast: true,
    queueFeedback: true,
    stability: { mode: 'commitment', commitMinutes: 12 },
    midRunDisruptions: [{ minute: 4, corridor_ids: ['C_NE'], description: '红队：运行中通道封控' }],
  });
  assert.equal(result.unserved_persons, 0);
  const after = result.steps.filter(step => step.start_minute >= 4).flatMap(step => step.executed_routes);
  assert.ok(!after.some(route => route.steps.some(step => step.corridor_id === 'C_NE')));
});

test('极速需求下承诺式求解不静默超容量：冲突必须显式报告', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const demand = new Map(scenario.regions.map(region => [region.id, region.enabled ? 2000 : 0]));
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const now = new Date('2026-11-10T01:00:00.000Z');
  const result = solveCommitmentAwarePlan({
    scenario,
    network,
    demandByRegion: demand,
    horizonMinutes: 10,
    baseMinute: 0,
    versions,
    now,
    commitments: new Map([
      ['R_NORTH_STAND', 'E_NORTH'],
      ['R_SOUTH_STAND', 'E_SOUTH'],
      ['R_EAST_STAND', 'E_EAST'],
      ['R_WEST_STAND', 'E_WEST'],
    ]),
  });
  const independent = checkPlanCapacity(scenario, result.plan.routes, 0);
  assert.deepEqual(result.capacity_violations, independent, '容量冲突必须与独立复核一致，不得静默');
  assert.ok(Number.isFinite(result.plan.unresolved_persons));
  assert.ok(result.plan.unresolved_persons >= 0);
});

test('相机离线、未来时间戳与非法接收时间被适配器拒绝', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const region = scenario.regions.find(item => item.enabled)!;
  const now = new Date('2026-11-10T01:00:00.000Z');
  const baseInput = {
    adapter_id: 'redteam',
    region_id: region.id,
    count: 200,
    confidence: 0.95,
    observed_at: new Date(now.getTime() - 5_000).toISOString(),
    received_at: now.toISOString(),
    calibration_version: 'cam-redteam',
    provider: 'redteam',
    model_version: 'redteam/1.0.0',
  };
  const offlineScenario = cloneScenario(scenario);
  offlineScenario.regions.find(item => item.id === region.id)!.camera.status = 'offline';
  const offline = adaptCameraCount(baseInput, offlineScenario, { now, source: 'live_video' });
  assert.equal(offline.rejected_reason, 'camera_offline');

  const future = adaptCameraCount({
    ...baseInput,
    observed_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
  }, scenario, { now, source: 'live_video' });
  assert.equal(future.rejected_reason, 'timestamp_in_future');

  const badReceived = adaptCameraCount({
    ...baseInput,
    received_at: 'not-a-date',
  }, scenario, { now, source: 'live_video' });
  assert.equal(badReceived.rejected_reason, 'invalid_timestamp');
});
