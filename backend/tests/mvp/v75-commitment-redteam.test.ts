import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../../src/services/safety/network';
import { planEvacuationMpc } from '../../src/services/safety/planning/mpc-planner';

const scenarioPath = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

function run(overrides: Record<string, unknown> = {}, demandPersons = 500) {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const demand = new Map(scenario.regions.map(region => [region.id, region.enabled ? demandPersons : 0]));
  return planEvacuationMpc({
    scenario, network, initialDemandByRegion: demand,
    versions: { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 },
    controlIntervalMinutes: 2, planningHorizonMinutes: 10, maxExecutionMinutes: 24, maxSteps: 24,
    useForecast: true, queueFeedback: true, solver: 'v7',
    ...overrides,
  });
}

test('容量感知承诺不产生容量违规，且承诺步数不超过全局承诺', () => {
  const base = run({
    stability: { mode: 'adaptive', commitMinutes: 4, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 },
    adaptiveStability: { enabled: true, basePenaltyPerPerson: 10, oscillationPenaltyPerPerson: 20, riskWeightedSwitching: true },
  });
  const aware = run({
    stability: { mode: 'adaptive', commitMinutes: 4, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 },
    adaptiveStability: { enabled: true, basePenaltyPerPerson: 10, oscillationPenaltyPerPerson: 20, riskWeightedSwitching: true },
    capacityAwareCommitment: { enabled: true, headroomRatio: 0.5 },
  });
  assert.equal(aware.capacity_violations, 0);
  assert.ok(aware.committed_steps <= base.committed_steps);
});

test('区域选择性承诺只保留低风险区域，容量仍为空', () => {
  const selective = run({
    stability: { mode: 'adaptive', commitMinutes: 4, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 },
    adaptiveStability: {
      enabled: true, basePenaltyPerPerson: 10, oscillationPenaltyPerPerson: 20,
      riskWeightedSwitching: true, regionSelectiveRiskThreshold: 1.05,
    },
  });
  assert.equal(selective.capacity_violations, 0);
  assert.ok(Number.isFinite(selective.switch_persons));
});

test('运行中出口故障触发紧急覆盖并产生审计事件', () => {
  const result = run({
    stability: { mode: 'adaptive', commitMinutes: 6, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 },
    adaptiveStability: {
      enabled: true, basePenaltyPerPerson: 10, oscillationPenaltyPerPerson: 20,
      riskWeightedSwitching: true, releaseOnRiskThreshold: 0.5, recommitCooldownMinutes: 2,
    },
    emergencyMachine: { enabled: true, config: { minEmergencyDwell: 1, recoveryPersistence: 2 } },
    midRunDisruptions: [{ minute: 2, exit_ids: ['E_NORTH'], description: 'test' }],
  }, 900);
  assert.equal(result.capacity_violations, 0);
  assert.ok(result.emergency_events.some(event => event.to === 'EMERGENCY_OVERRIDE'));
  assert.ok(result.emergency_events.some(event => event.to === 'RECOVERY'));
  assert.ok(result.emergency_events.every(event => event.tick >= 0 && event.risk >= 0));
  assert.ok(result.commitment_recommits >= 0);
});

test('状态机启用但不满足触发条件时保持 NORMAL，不误释放', () => {
  const result = run({
    stability: { mode: 'adaptive', commitMinutes: 4, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 },
    adaptiveStability: { enabled: true, basePenaltyPerPerson: 10, oscillationPenaltyPerPerson: 20, riskWeightedSwitching: true },
    emergencyMachine: { enabled: true },
  });
  assert.equal(result.emergency_events.length, 0);
  assert.equal(result.commitment_releases, 0);
});
