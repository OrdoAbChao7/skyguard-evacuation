import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyEvidence,
  decideInvestigation,
  entropy,
  fixedPriorityChoice,
  priorBelief,
} from '../../src/services/mvp/voi';
import { makeMvpFixture } from './fixtures';

function policy() {
  const fixture = makeMvpFixture();
  try {
    const investigation = fixture.scenario.investigation;
    assert.ok(investigation, 'stadium scenario must define investigation policy');
    return investigation;
  } finally {
    fixture.cleanup();
  }
}

test('先验概率归一且熵大于 0', () => {
  const p = policy();
  const belief = priorBelief(p);
  const sum = belief.reduce((acc, item) => acc + item.probability, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(entropy(belief) > 1.4);
});

test('全部动作可用时按 VoI 排序并给出可解释分解', () => {
  const p = policy();
  const decision = decideInvestigation(p, null);
  assert.equal(decision.engine_version, '1.0.0');
  assert.equal(decision.should_investigate, true);
  assert.ok(decision.recommended_action_id);
  assert.ok(decision.evaluations.every(item => item.score !== null));
  const ranked = decision.evaluations
    .filter(item => item.available)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  assert.deepEqual(decision.ranked_action_ids, ranked.map(item => item.action_id));
  for (const evaluation of decision.evaluations) {
    assert.ok(evaluation.information_gain_bits >= 0);
    assert.ok(evaluation.risk_reduction >= -1e-9);
    assert.ok(evaluation.score_breakdown !== null);
  }
});

test('所有动作不可用时停止调查并给出原因', () => {
  const p = policy();
  const availability = Object.fromEntries(
    p.actions.map(action => [action.id, { available: false, reason: '测试：不可用' }]),
  );
  const decision = decideInvestigation(p, null, { availability });
  assert.equal(decision.should_investigate, false);
  assert.equal(decision.recommended_action_id, null);
  assert.equal(decision.stop_reason, 'no_available_action');
  assert.ok(decision.evaluations.every(item => item.available === false));
});

test('达到最大调查轮次后停止', () => {
  const p = policy();
  const decision = decideInvestigation(p, null, { investigationsUsed: p.max_investigations });
  assert.equal(decision.should_investigate, false);
  assert.equal(decision.stop_reason, 'max_investigations_reached');
});

test('阈值提高后低收益调查被停止', () => {
  const p = { ...policy(), stop_threshold: 10 };
  const decision = decideInvestigation(p, null);
  assert.equal(decision.should_investigate, false);
  assert.equal(decision.stop_reason, 'voi_below_threshold');
});

test('拥堵证据按贝叶斯更新提高高危假设后验', () => {
  const p = policy();
  const before = priorBelief(p);
  const after = applyEvidence(p, before, 'camera_query', 'signal_congested');
  const beforeCritical = before.find(item => item.hypothesis_id === 'H_CRITICAL')!.probability;
  const afterCritical = after.find(item => item.hypothesis_id === 'H_CRITICAL')!.probability;
  assert.ok(afterCritical > beforeCritical);
  assert.ok(entropy(after) < entropy(before));
  const sum = after.reduce((acc, item) => acc + item.probability, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('固定优先级策略按配置顺序选择首个可用动作', () => {
  const p = policy();
  assert.equal(fixedPriorityChoice(p).action_id, 'A_CAMERA');
  const withoutCamera = fixedPriorityChoice(p, {
    A_CAMERA: { available: false, reason: '摄像头离线' },
  });
  assert.equal(withoutCamera.action_id, 'A_STAFF');
});
