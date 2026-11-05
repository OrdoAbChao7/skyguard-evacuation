import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionAvailability,
  applyEvidenceWithConflict,
  budgetExhausted,
  createInvestigationSession,
  detectEvidenceConflict,
  recordAttempt,
} from '../../src/services/mvp/investigation-session';
import { applyEvidence, entropy } from '../../src/services/mvp/voi';
import { makeMvpFixture } from './fixtures';

test('失败后进入冷却，冷却结束可重试，达到最大次数后不可用', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const action = policy.actions.find(item => item.id === 'A_CAMERA')!;
    const session = createInvestigationSession('R_EAST_STAND');
    const t0 = new Date('2026-11-05T10:00:00.000Z');

    assert.equal(actionAvailability(policy, action, session, t0).available, true);
    recordAttempt(session, action, { success: false, outcome: 'unavailable' }, t0);

    const cooling = actionAvailability(policy, action, session, new Date(t0.getTime() + 10_000));
    assert.equal(cooling.available, false);
    assert.match(cooling.reason ?? '', /冷却/);
    assert.ok(cooling.nextAvailableAt);

    const ready = actionAvailability(policy, action, session, new Date(t0.getTime() + 60_000));
    assert.equal(ready.available, true);

    recordAttempt(session, action, { success: false, outcome: 'unavailable' }, new Date(t0.getTime() + 60_000));
    const exhausted = actionAvailability(policy, action, session, new Date(t0.getTime() + 600_000));
    assert.equal(exhausted.available, false);
    assert.match(exhausted.reason ?? '', /最大尝试次数/);
  } finally {
    fixture.cleanup();
  }
});

test('调查预算耗尽后所有动作不可用', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const tight = { ...policy, budget: { ...(policy.budget ?? { max_actions: 1, max_total_cost: 10, max_total_time_minutes: 10 }), max_actions: 1 } };
    const session = createInvestigationSession('R_EAST_STAND');
    const action = tight.actions[0];
    recordAttempt(session, action, { success: true, outcome: 'signal_normal' }, new Date());
    assert.equal(budgetExhausted(tight, session), true);
    const availability = actionAvailability(tight, tight.actions[1], session, new Date());
    assert.equal(availability.available, false);
    assert.match(availability.reason ?? '', /预算/);
  } finally {
    fixture.cleanup();
  }
});

test('相反证据触发冲突，并以折扣方式更新信念', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const action = policy.actions.find(item => item.kind === 'staff_check')!;
    const session = createInvestigationSession('R_EAST_STAND');
    const now = new Date('2026-11-05T10:00:00.000Z');
    recordAttempt(session, action, { success: true, outcome: 'signal_normal' }, now);

    const conflict = detectEvidenceConflict(session, 'staff_check', 'signal_congested', new Date(now.getTime() + 60_000));
    assert.equal(conflict.detected, true);
    assert.equal(conflict.previous, 'signal_normal');

    const prior = require('../../src/services/mvp/voi').priorBelief(policy) as Array<{ hypothesis_id: string; label: string; probability: number }>;
    const plain = applyEvidence(policy, prior, 'staff_check', 'signal_congested');
    const blended = applyEvidenceWithConflict(policy, prior, 'staff_check', 'signal_congested', conflict);
    assert.ok(entropy(blended.belief) >= entropy(plain));
    assert.ok(Math.abs(blended.belief.reduce((sum, item) => sum + item.probability, 0) - 1) < 1e-9);
  } finally {
    fixture.cleanup();
  }
});
