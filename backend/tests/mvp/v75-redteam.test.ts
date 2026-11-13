import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { EmergencyStateMachine } from '../../src/services/safety/emergency/emergency-state';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../../src/services/safety/network';
import { planEvacuationMpc } from '../../src/services/safety/planning/mpc-planner';
import type { SafetyScenario } from '../../src/services/safety/types';

const scenarioPath = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

function run(overrides: Record<string, unknown> = {}, demandPersons = 600) {
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

test('重复的紧急请求不产生重复状态转移（幂等审计）', () => {
  const machine = new EmergencyStateMachine({ minEmergencyTicks: 1, recoveryPersistence: 1 });
  machine.evaluate({ tick: 0, riskRatio: 0.4, planValidated: true });
  const first = machine.evaluate({ tick: 1, riskRatio: 1.5, confirmedIncident: true, planValidated: true });
  assert.equal(first.state, 'EMERGENCY_OVERRIDE');
  const auditAfterFirst = machine.auditEvents.length;
  const repeat = machine.evaluate({ tick: 2, riskRatio: 1.5, confirmedIncident: true, planValidated: true });
  assert.equal(repeat.state, 'EMERGENCY_OVERRIDE');
  assert.equal(repeat.event, null, '重复触发不应产生第二条状态转移事件');
  assert.equal(machine.auditEvents.length, auditAfterFirst);
  assert.equal(repeat.invalidateCommitments, true);
  assert.equal(repeat.mayCommit, false);
});

test('风险在警告阈值附近抖动不会提前退出警告（迟滞）', () => {
  const machine = new EmergencyStateMachine({ warningPersistence: 2, hysteresis: 0.1 });
  machine.evaluate({ tick: 0, riskRatio: 1.05 });
  const warning = machine.evaluate({ tick: 1, riskRatio: 1.05 });
  assert.equal(warning.state, 'RISK_WARNING');
  const dip = machine.evaluate({ tick: 2, riskRatio: 0.95 });
  assert.equal(dip.state, 'RISK_WARNING', '高于 warningRisk - hysteresis 不应累计解除');
  assert.equal(dip.event, null);
  machine.evaluate({ tick: 3, riskRatio: 0.8 });
  const cleared = machine.evaluate({ tick: 4, riskRatio: 0.8 });
  assert.equal(cleared.state, 'NORMAL');
});

test('执行步数/时长被截断时未疏散人数如实上报', () => {
  const truncated = run({ maxSteps: 1, planningHorizonMinutes: 10, maxExecutionMinutes: 10 });
  const full = run();
  assert.equal(truncated.steps.length, 1);
  assert.ok(truncated.unserved_persons > 0, '截断运行必须报告未疏散人数，而不是假装完成');
  assert.ok(full.unserved_persons <= truncated.unserved_persons);
  assert.equal(truncated.capacity_violations, 0);
  assert.ok(truncated.makespan_minute <= 10);
});

test('同一输入重复规划结果确定，且不修改输入场景/需求', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const demand = new Map(scenario.regions.map(region => [region.id, region.enabled ? 500 : 0]));
  const scenarioSnapshot = JSON.stringify(scenario as SafetyScenario);
  const demandSnapshot = [...demand.entries()];
  const base = {
    scenario, network, initialDemandByRegion: demand,
    versions: { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 },
    controlIntervalMinutes: 2, planningHorizonMinutes: 10, maxExecutionMinutes: 24, maxSteps: 24,
    useForecast: true, queueFeedback: true, solver: 'v7' as const,
    stability: { mode: 'adaptive' as const, commitMinutes: 4, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 },
    adaptiveStability: { enabled: true, basePenaltyPerPerson: 10, oscillationPenaltyPerPerson: 20, riskWeightedSwitching: true },
  };
  const first = planEvacuationMpc({ ...base });
  const second = planEvacuationMpc({ ...base });
  assert.equal(second.unserved_persons, first.unserved_persons);
  assert.equal(second.makespan_minute, first.makespan_minute);
  assert.equal(second.total_queue_person_minutes, first.total_queue_person_minutes);
  assert.equal(second.switch_persons, first.switch_persons);
  assert.equal(second.steps.length, first.steps.length);
  assert.equal(JSON.stringify(scenario), scenarioSnapshot, '规划不应修改场景对象');
  assert.deepEqual([...demand.entries()], demandSnapshot, '规划不应修改初始需求映射');
});

test('承诺出口运行中失效时记录紧急覆盖且新计划不再使用该出口', () => {
  const result = run({
    stability: { mode: 'commitment', commitMinutes: 8, hysteresisGap: 0.02 },
    midRunDisruptions: [{ minute: 2, exit_ids: ['E_NORTH'], description: 'test exit failure' }],
  }, 900);
  assert.equal(result.capacity_violations, 0);
  assert.ok(result.emergency_overrides >= 1, '承诺出口不可用必须记录紧急覆盖');
  for (const step of result.steps) {
    if (step.plan_base_minute < 2) continue;
    assert.ok(
      step.plan.routes.every(route => route.exit_id !== 'E_NORTH'),
      `第 ${step.step} 步计划仍使用已失效出口`,
    );
  }
});

test('容量感知承诺的 headroom 越界被夹紧且不产生容量冲突', () => {
  const result = run({
    stability: { mode: 'adaptive', commitMinutes: 4, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 },
    adaptiveStability: { enabled: true, basePenaltyPerPerson: 10, oscillationPenaltyPerPerson: 20, riskWeightedSwitching: true },
    capacityAwareCommitment: { enabled: true, headroomRatio: 0.01 },
  }, 700);
  assert.equal(result.capacity_violations, 0);
  assert.ok(Number.isFinite(result.makespan_minute));
  assert.ok(Number.isFinite(result.switch_persons));
});

test('观测无效/冲突时状态机拒绝发布，且不可发布步数被记录', () => {
  const base = {
    stability: { mode: 'adaptive' as const, commitMinutes: 4, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 },
    adaptiveStability: { enabled: true, basePenaltyPerPerson: 10, oscillationPenaltyPerPerson: 20, riskWeightedSwitching: true },
    emergencyMachine: { enabled: true },
  };
  const invalid = run({ ...base, observationsValid: false }, 700);
  const conflict = run({ ...base, sensorConflict: true }, 700);
  assert.ok(invalid.steps.length > 1);
  assert.ok(invalid.unpublishable_steps >= invalid.steps.length - 1, '观测无效时必须逐步拒绝发布');
  assert.ok(invalid.steps.every(step => step.emergency_publishable !== true));
  assert.ok(conflict.steps.every(step => step.emergency_publishable !== true));
  const valid = run(base, 700);
  assert.equal(valid.unpublishable_steps, 0, '默认有效观测不应被误判为不可发布');
});
