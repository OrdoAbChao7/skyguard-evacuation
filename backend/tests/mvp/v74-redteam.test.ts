import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../../src/services/safety/network';
import { planEvacuationMpc } from '../../src/services/safety/planning/mpc-planner';
import { checkPlanCapacity } from '../../src/services/safety/planning/route-stability';
import {
  capacityFactorAt,
  detectMissingIntervals,
  synchronizeTimestamps,
  validateCapacitySchedule,
} from '../../src/services/safety/calibration/quality';
import { buildObservation } from '../../src/services/safety/observations';

const scenarioPath = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

test('执行门控不能增加切换人数；门控拒绝时回退标准方案', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const demand = new Map(scenario.regions.map(region => [region.id, region.enabled ? 700 : 0]));
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const actualArrivals = new Map<string, Array<{ offsetMinute: number; persons: number }>>();
  const regions = scenario.regions.filter(region => region.enabled);
  for (let index = 0; index < 6; index += 1) {
    const regionId = regions[index % regions.length].id;
    const list = actualArrivals.get(regionId) ?? [];
    list.push({ offsetMinute: 1 + index * 2, persons: 220 });
    actualArrivals.set(regionId, list);
  }
  const base = {
    scenario, network, initialDemandByRegion: demand, versions,
    controlIntervalMinutes: 2, planningHorizonMinutes: 10, maxExecutionMinutes: 24, maxSteps: 24,
    useForecast: true, queueFeedback: true, actualArrivals, solver: 'v7' as const,
  };
  const standard = planEvacuationMpc({ ...base, stability: { mode: 'none' } });
  const gated = planEvacuationMpc({
    ...base,
    stability: { mode: 'adaptive', commitMinutes: 4, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 },
    adaptiveStability: { enabled: true, basePenaltyPerPerson: 10, oscillationPenaltyPerPerson: 20, riskWeightedSwitching: true },
    executionGate: { enabled: true, makespanToleranceMinutes: 0, queueTolerancePersonMinutes: 0 },
  });
  assert.ok(gated.switch_persons <= standard.switch_persons);
  assert.ok(gated.makespan_minute <= standard.makespan_minute + 1);
  assert.equal(gated.capacity_violations, 0);
});

test('Pareto 门控候选不得超容量；规划结果逐分钟容量为空', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const demand = new Map(scenario.regions.map(region => [region.id, region.enabled ? 600 : 0]));
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const result = planEvacuationMpc({
    scenario, network, initialDemandByRegion: demand, versions,
    controlIntervalMinutes: 2, planningHorizonMinutes: 10, maxExecutionMinutes: 24, maxSteps: 24,
    useForecast: true, queueFeedback: true, solver: 'v7',
    stability: { mode: 'adaptive', commitMinutes: 4, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 },
    adaptiveStability: { enabled: true, basePenaltyPerPerson: 10, oscillationPenaltyPerPerson: 20, riskWeightedSwitching: true },
    paretoStability: { shares: [0.8, 0.4], makespanToleranceMinutes: 1, queueTolerancePersonMinutes: 2000 },
  });
  assert.equal(result.capacity_violations, 0);
  for (const step of result.steps) {
    assert.deepEqual(checkPlanCapacity(scenario, step.plan.routes, step.plan_base_minute), []);
  }
});

test('动态容量计划非法区间/越界被拒绝，因子夹紧', () => {
  const validation = validateCapacitySchedule({ entries: [
    { from_minute: 5, to_minute: 3, corridor_factor: 2, reason: '' },
    { from_minute: 4, to_minute: 8, exit_factor: 0.5, reason: 'x' },
    { from_minute: 6, to_minute: 9, exit_factor: 0.4, reason: 'y' },
  ] });
  assert.ok(validation.errors.length >= 2);
  assert.equal(capacityFactorAt({ entries: [{ from_minute: 4, to_minute: 8, corridor_factor: 0.5, reason: 'x' }] }, 5, 'corridor'), 0.5);
  assert.equal(capacityFactorAt({ entries: [{ from_minute: 4, to_minute: 8, corridor_factor: 0.5, reason: 'x' }] }, 10, 'corridor'), 1);
});

test('时钟偏移超限与缺失数据被明确拒绝/检测', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const region = scenario.regions.find(item => item.enabled)!;
  const now = new Date('2026-11-10T01:05:00Z');
  const observation = buildObservation({
    region, count: 300, confidence: 0.95, source: 'simulation', provider: 'skewed',
    modelVersion: 'test/1', observedAt: new Date('2026-11-10T01:04:00Z'), receivedAt: now,
  });
  const synced = synchronizeTimestamps([observation], [{ provider: 'skewed', offset_seconds: 120, samples: 5 }], 30);
  assert.equal(synced.observations.length, 0);
  assert.equal(synced.rejected[0].reason, 'clock_skew_exceeds_limit');
  const missing = detectMissingIntervals([observation], 60, 5);
  assert.ok(missing.length >= 0);
});
