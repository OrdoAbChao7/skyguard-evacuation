/**
 * 四态状态机纯函数测试：进入/退出条件与优先级。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { decideSafetyState } from '../../src/services/safety/state-machine';
import type { EvacuationPlan, SafetyValidationResult } from '../../src/services/safety/types';

const plan = {
  plan_id: 'P1',
  created_at: '2026-10-01T00:00:00.000Z',
  scenario_version: '1.0.0',
  constraint_version: 0,
  observation_version: 0,
  horizon_minutes: 8,
  status: 'feasible',
  routes: [],
  unresolved: [],
  exit_totals: [],
  corridor_totals: [],
  demand_by_region: [],
  total_persons: 0,
  evacuated_persons: 0,
  unresolved_persons: 0,
  planner: { algorithm: 't', model: 't', notes: [] },
} as EvacuationPlan;

const validResult: SafetyValidationResult = {
  valid: true,
  checked_at: '2026-10-01T00:00:00.000Z',
  plan_id: 'P1',
  violations: [],
  checks_run: [],
  versions: { scenario_version: '1.0.0', constraint_version: 0, observation_version: 0 },
};

const base = {
  hasObservations: true,
  inferenceHealthy: true,
  untrustedRegions: [],
  activeIncidentIds: [],
  plan,
  validation: validResult,
  planInvalidated: false,
  lastValidObservationAt: '2026-10-01T00:00:00.000Z',
};

test('数据可信且方案通过校验 → NORMAL', () => {
  const snapshot = decideSafetyState(base);
  assert.equal(snapshot.state, 'NORMAL');
  assert.equal(snapshot.publishable, true);
  assert.equal(snapshot.validated_route_display_allowed, true);
});

test('无观测 → DEGRADED，且不允许显示已验证路线', () => {
  const snapshot = decideSafetyState({ ...base, hasObservations: false });
  assert.equal(snapshot.state, 'DEGRADED');
  assert.equal(snapshot.validated_route_display_allowed, false);
  assert.equal(snapshot.publishable, false);
});

test('校验发现硬违规 → REJECT，仅允许显示候选方案', () => {
  const snapshot = decideSafetyState({
    ...base,
    plan: { ...plan, status: 'partial' },
    validation: {
      ...validResult,
      valid: false,
      violations: [{ code: 'unresolved_demand', severity: 'hard', message: '容量不足' }],
    },
  });
  assert.equal(snapshot.state, 'REJECT');
  assert.equal(snapshot.publishable, false);
  assert.equal(snapshot.validated_route_display_allowed, false);
  assert.equal(snapshot.candidate_route_display_allowed, true);
  assert.equal(snapshot.requires_operator_action, true);
});

test('存在已确认事件但方案通过校验 → REROUTE 且可发布替代方案', () => {
  const snapshot = decideSafetyState({ ...base, activeIncidentIds: ['INC-1'] });
  assert.equal(snapshot.state, 'REROUTE');
  assert.equal(snapshot.publishable, true);
  assert.equal(snapshot.validated_route_display_allowed, true);
});

test('DEGRADED 优先于 REJECT：数据不可信时不下"不可行"的结论', () => {
  const snapshot = decideSafetyState({
    ...base,
    untrustedRegions: [{ regionId: 'R_MAIN', reasons: ['stale:600s>90s'] }],
    validation: {
      ...validResult,
      valid: false,
      violations: [{ code: 'unresolved_demand', severity: 'hard', message: '容量不足' }],
    },
  });
  assert.equal(snapshot.state, 'DEGRADED');
  assert.equal(snapshot.candidate_route_display_allowed, false);
});

test('仅版本失效 → REROUTE 而非 REJECT', () => {
  const snapshot = decideSafetyState({
    ...base,
    planInvalidated: true,
    validation: {
      ...validResult,
      valid: false,
      violations: [{ code: 'stale_constraints', severity: 'hard', message: '约束已变化' }],
    },
  });
  assert.equal(snapshot.state, 'REROUTE');
  assert.equal(snapshot.publishable, false);
  assert.equal(snapshot.candidate_route_display_allowed, true);
});

test('推理服务异常 → DEGRADED 并携带原因', () => {
  const snapshot = decideSafetyState({ ...base, inferenceHealthy: false, inferenceFailureReason: '进程崩溃' });
  assert.equal(snapshot.state, 'DEGRADED');
  assert.ok(snapshot.reasons.some(reason => reason.code === 'inference_unhealthy'));
  assert.match(snapshot.reasons.map(reason => reason.message).join(' '), /进程崩溃/);
});
