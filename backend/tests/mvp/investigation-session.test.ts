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
    assert.equal(blended.blend_source, 'scenario');
    assert.equal(blended.blend_prior, policy.conflict!.blend_prior);
  } finally {
    fixture.cleanup();
  }
});

test('候选动作自身成本超预算时不可用，便宜动作仍可用', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const tight = { ...policy, budget: { max_actions: 3, max_total_cost: 0.1, max_total_time_minutes: 8 } };
    const session = createInvestigationSession('R_EAST_STAND');
    session.spentCost = 0.06;
    const camera = tight.actions.find(item => item.id === 'A_CAMERA')!;
    const history = tight.actions.find(item => item.id === 'A_HISTORY')!;
    const cameraStatus = actionAvailability(tight, camera, session);
    assert.equal(cameraStatus.available, false);
    assert.match(cameraStatus.reason ?? '', /预算/);
    assert.equal(actionAvailability(tight, history, session).available, true);
    assert.equal(budgetExhausted(tight, session), false);
  } finally {
    fixture.cleanup();
  }
});

test('冲突时间窗与混合系数来自场景配置', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = {
      ...fixture.scenario.investigation!,
      conflict: { window_minutes: 3, blend_prior: 0.8 },
    };
    const action = policy.actions.find(item => item.kind === 'staff_check')!;
    const session = createInvestigationSession('R_EAST_STAND');
    const now = new Date('2026-11-05T10:00:00.000Z');
    recordAttempt(session, action, { success: true, outcome: 'signal_normal' }, now);
    // 4 分钟后：默认 10 分钟窗口会命中，但场景配置 3 分钟窗口不应命中。
    const conflict = detectEvidenceConflict(
      session,
      'staff_check',
      'signal_congested',
      new Date(now.getTime() + 4 * 60_000),
      policy.conflict.window_minutes,
    );
    assert.equal(conflict.detected, false);
  } finally {
    fixture.cleanup();
  }
});
