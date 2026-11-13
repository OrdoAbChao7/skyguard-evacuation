import assert from 'node:assert/strict';
import test from 'node:test';
import { EmergencyStateMachine, replayEmergencySequence } from '../../src/services/safety/emergency/emergency-state';

const tick = (index: number, risk: number, extra: Record<string, unknown> = {}) => ({
  tick: index,
  riskRatio: risk,
  observationsValid: true,
  planValidated: true,
  ...extra,
});

test('风险持续升高进入警告，硬触发进入紧急覆盖并失效承诺', () => {
  const machine = new EmergencyStateMachine({ warningPersistence: 2, minEmergencyDwell: 1 });
  assert.equal(machine.evaluate(tick(0, 1.05)).state, 'NORMAL');
  assert.equal(machine.evaluate(tick(1, 1.06)).state, 'RISK_WARNING');
  const emergency = machine.evaluate(tick(2, 0.8, { unusableExit: true }));
  assert.equal(emergency.state, 'EMERGENCY_OVERRIDE');
  assert.equal(emergency.invalidateCommitments, true);
  assert.equal(emergency.mayCommit, false);
  assert.ok(machine.auditEvents.some(event => event.to === 'EMERGENCY_OVERRIDE'));
});

test('紧急覆盖必须持续到恢复条件满足，并经过 RECOVERY', () => {
  const machine = new EmergencyStateMachine({ recoveryPersistence: 2, minEmergencyDwell: 1, recoveryRisk: 0.9 });
  machine.evaluate(tick(0, 0.5));
  machine.evaluate(tick(1, 1.4));
  assert.equal(machine.current, 'EMERGENCY_OVERRIDE');
  assert.equal(machine.evaluate(tick(2, 0.8)).state, 'EMERGENCY_OVERRIDE');
  assert.equal(machine.evaluate(tick(3, 0.8)).state, 'RECOVERY');
  assert.equal(machine.evaluate(tick(4, 0.7)).state, 'RECOVERY');
  const normal = machine.evaluate(tick(5, 0.7));
  assert.equal(normal.state, 'NORMAL');
  assert.equal(normal.mayCommit, true);
});

test('恢复阶段独立校验失败时不得回到 NORMAL', () => {
  const machine = new EmergencyStateMachine({ recoveryPersistence: 1, minEmergencyDwell: 1 });
  machine.evaluate(tick(0, 1.5));
  machine.evaluate(tick(1, 0.7));
  assert.equal(machine.current, 'RECOVERY');
  const blocked = machine.evaluate(tick(2, 0.7, { planValidated: false }));
  assert.equal(blocked.state, 'RECOVERY');
  assert.equal(blocked.publishable, false);
  assert.equal(blocked.mayCommit, false);
});

test('过期/冲突观测不可发布，即使风险较低', () => {
  const machine = new EmergencyStateMachine();
  for (let index = 0; index < 22; index += 1) machine.evaluate(tick(index, 0.4));
  const stale = machine.evaluate(tick(22, 0.4, { stale: true }));
  assert.equal(stale.publishable, false);
  const conflict = machine.evaluate(tick(23, 0.4, { sensorConflict: true }));
  assert.equal(conflict.publishable, false);
});

test('重复紧急事件重新进入覆盖，活动工单被记录', () => {
  const machine = new EmergencyStateMachine({ recoveryPersistence: 1, minEmergencyDwell: 1 });
  machine.evaluate(tick(0, 0.4));
  machine.evaluate(tick(1, 1.5, { activeWorkOrders: 2 }));
  machine.evaluate(tick(2, 0.7));
  assert.equal(machine.current, 'RECOVERY');
  const repeat = machine.evaluate(tick(3, 1.6, { confirmedIncident: true, activeWorkOrders: 1 }));
  assert.equal(repeat.state, 'EMERGENCY_OVERRIDE');
  assert.equal(repeat.event?.activeWorkOrders, 1);
});

test('确定性回放：无事件时保持 NORMAL', () => {
  const outcomes = replayEmergencySequence(Array.from({ length: 6 }, (_, index) => tick(index, 0.5)));
  assert.ok(outcomes.every(outcome => outcome.state === 'NORMAL'));
  assert.deepEqual(outcomes.map(outcome => outcome.publishable), [true, true, true, true, true, true]);
});
