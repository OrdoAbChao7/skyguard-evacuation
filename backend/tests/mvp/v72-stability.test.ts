import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../../src/services/safety/network';
import { planEvacuationMpc } from '../../src/services/safety/planning/mpc-planner';
import {
  checkPlanCapacity,
  resolveStabilityConfig,
  shouldUseCommitment,
  DEFAULT_STABILITY,
} from '../../src/services/safety/planning/route-stability';
import { solveCommitmentAwarePlan } from '../../src/services/safety/planning/stable-solver';
import { validateSafetyPlan } from '../../src/services/safety/validator';
import { buildObservation } from '../../src/services/safety/observations';
import type { DensityObservation } from '../../src/services/safety/types';

const scenarioPath = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

function setup(count: number) {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const demand = new Map<string, number>();
  for (const region of scenario.regions) demand.set(region.id, region.enabled ? count : 0);
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  return { scenario, network, demand, versions };
}

function mpcInput(count: number) {
  const { scenario, network, demand, versions } = setup(count);
  return {
    scenario,
    network,
    initialDemandByRegion: demand,
    versions,
    controlIntervalMinutes: 2,
    planningHorizonMinutes: 10,
    maxExecutionMinutes: 24,
    maxSteps: 24,
    useForecast: false,
    queueFeedback: false,
    solver: 'v7' as const,
  };
}

test('承诺窗口降低切换人数，且不增加未疏散', () => {
  const input = mpcInput(700);
  const baseline = planEvacuationMpc({ ...input, stability: { mode: 'none' } });
  const committed = planEvacuationMpc({
    ...input,
    stability: { mode: 'commitment', commitMinutes: 8, hysteresisGap: 0.02 },
  });
  assert.equal(baseline.unserved_persons, 0);
  assert.equal(committed.unserved_persons, 0);
  assert.ok(committed.committed_steps > 0, 'commitment should be applied at least once');
  assert.ok(
    committed.switch_persons < baseline.switch_persons,
    `committed=${committed.switch_persons}, baseline=${baseline.switch_persons}`,
  );
  // 稳定性不是免费的：本场景下完成时间允许变大，但必须有界。
  assert.ok(committed.makespan_minute <= baseline.makespan_minute + 2);
});

test('承诺不会增加未疏散：高需求下仍不劣于无承诺方案', () => {
  const input = mpcInput(1500);
  const baseline = planEvacuationMpc({ ...input, stability: { mode: 'none' } });
  const committed = planEvacuationMpc({
    ...input,
    stability: { mode: 'commitment', commitMinutes: 8, hysteresisGap: 0.02, maxObjectiveDegradation: 0.5 },
  });
  assert.ok(committed.unserved_persons <= baseline.unserved_persons);
});

test('出口中途故障触发紧急覆盖，承诺失效且不再经过故障出口', () => {
  const input = mpcInput(800);
  const result = planEvacuationMpc({
    ...input,
    stability: { mode: 'commitment', commitMinutes: 12, hysteresisGap: 0.02 },
    midRunDisruptions: [{ minute: 2, exit_ids: ['E_NORTH'], description: '测试：运行中出口故障' }],
  });
  assert.equal(result.unserved_persons, 0);
  assert.ok(result.emergency_overrides >= 1, `emergency_overrides=${result.emergency_overrides}`);
  const afterFailure = result.steps
    .filter(step => step.start_minute >= 2)
    .flatMap(step => step.executed_routes);
  assert.ok(!afterFailure.some(route => route.exit_id === 'E_NORTH'), '故障后的执行路线不得使用 E_NORTH');
});

test('承诺式求解结果满足逐分钟容量约束并通过独立校验', () => {
  const { scenario, network, demand, versions } = setup(200);
  const now = new Date();
  const base = solveCommitmentAwarePlan({
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
  assert.equal(base.plan.unresolved_persons, 0, JSON.stringify(base.plan.unresolved));
  assert.deepEqual(checkPlanCapacity(scenario, base.plan.routes, 0), []);
  const observations = new Map<string, DensityObservation>();
  for (const region of scenario.regions) {
    const count = demand.get(region.id) ?? 0;
    if (count <= 0) continue;
    observations.set(region.id, buildObservation({
      region,
      count,
      confidence: 0.95,
      source: 'simulation',
      provider: 'test',
      modelVersion: 'test/1.0.0',
      observedAt: now,
      receivedAt: now,
    }));
  }
  const validation = validateSafetyPlan({
    plan: base.plan,
    scenario,
    network,
    latestObservations: observations,
    config: scenario.config,
    constraintVersion: 0,
    observationVersion: 0,
    now,
  });
  assert.equal(validation.valid, true, JSON.stringify(validation.violations));
});

test('策略选择：迟滞拒绝超过容差的目标劣化，切换惩罚在代价足够大时接受承诺', () => {
  const rejected = shouldUseCommitment({
    mode: 'hysteresis',
    config: { ...DEFAULT_STABILITY, mode: 'hysteresis', hysteresisGap: 0.05 },
    withinCommit: true,
    congested: false,
    baseObjective: 1000,
    committedObjective: 1200,
    baseSwitchPersons: 300,
    committedSwitchPersons: 50,
  });
  assert.equal(rejected.use, false);
  const accepted = shouldUseCommitment({
    mode: 'switch_penalty',
    config: { ...DEFAULT_STABILITY, mode: 'switch_penalty', switchPenaltyPerPerson: 50 },
    withinCommit: false,
    congested: false,
    baseObjective: 1000,
    committedObjective: 1200,
    baseSwitchPersons: 300,
    committedSwitchPersons: 50,
  });
  assert.equal(accepted.use, true);
});

test('稳定性配置对异常输入夹紧，紧急覆盖不可关闭', () => {
  const config = resolveStabilityConfig({
    mode: 'commitment',
    switchPenaltyPerPerson: Number.NaN,
    commitMinutes: -5,
    hysteresisGap: 9,
    adaptiveQueueThreshold: Number.POSITIVE_INFINITY,
    emergencyOverride: false,
  });
  assert.equal(config.switchPenaltyPerPerson, 0);
  assert.equal(config.commitMinutes, 0);
  assert.equal(config.hysteresisGap, 0.5);
  assert.equal(config.emergencyOverride, true);
  assert.equal(resolveStabilityConfig({ mode: 'bogus' as never }).mode, 'none');
});
