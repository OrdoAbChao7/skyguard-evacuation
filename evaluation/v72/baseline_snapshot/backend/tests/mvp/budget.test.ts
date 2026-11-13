import assert from 'node:assert/strict';
import test from 'node:test';
import { allCandidatesBlocked, checkCandidateBudget } from '../../src/services/mvp/budget';
import { makeMvpFixture } from './fixtures';

test('候选成本必须计入预算：0.9 + 1.0 在 1.0 上限下被拒绝', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const action = policy.actions.find(item => item.id === 'A_CAMERA')!;
    const decision = checkCandidateBudget(policy, { ...action, resource_cost: 1.0 }, {
      used_actions: 0,
      used_cost: 0.9,
      used_time_minutes: 0,
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason_code, 'COST_BUDGET_EXCEEDED');
  } finally {
    fixture.cleanup();
  }
});

test('恰好等于预算上限允许执行（浮点容差内）', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const action = policy.actions.find(item => item.id === 'A_CAMERA')!;
    const max = policy.budget!.max_total_cost;
    const decision = checkCandidateBudget(policy, { ...action, resource_cost: 0.5 }, {
      used_actions: 0,
      used_cost: max - 0.5,
      used_time_minutes: 0,
    });
    assert.equal(decision.eligible, true);
    assert.equal(decision.reason_code, 'OK');
  } finally {
    fixture.cleanup();
  }
});

test('动作数、时间与资源预留都参与准入判定', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const action = policy.actions.find(item => item.id === 'A_CAMERA')!;

    const actionBound = checkCandidateBudget(policy, action, {
      used_actions: policy.budget!.max_actions,
      used_cost: 0,
      used_time_minutes: 0,
    });
    assert.equal(actionBound.eligible, false);
    assert.equal(actionBound.reason_code, 'ACTION_BUDGET_EXCEEDED');

    const timeBound = checkCandidateBudget(policy, action, {
      used_actions: 0,
      used_cost: 0,
      used_time_minutes: policy.budget!.max_total_time_minutes,
    });
    assert.equal(timeBound.eligible, false);
    assert.equal(timeBound.reason_code, 'TIME_BUDGET_EXCEEDED');

    const reserved = checkCandidateBudget(policy, action, {
      used_actions: 0,
      used_cost: 0,
      used_time_minutes: 0,
      reserved_cost: policy.budget!.max_total_cost,
    });
    assert.equal(reserved.eligible, false);
    assert.equal(reserved.reason_code, 'COST_BUDGET_EXCEEDED');
  } finally {
    fixture.cleanup();
  }
});

test('非法用量或候选成本被拒绝，不会当作 0 放行', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const action = policy.actions.find(item => item.id === 'A_CAMERA')!;
    assert.equal(checkCandidateBudget(policy, action, {
      used_actions: 0,
      used_cost: Number.NaN,
      used_time_minutes: 0,
    }).reason_code, 'INVALID_USAGE');
    assert.equal(checkCandidateBudget(policy, { ...action, resource_cost: Number.POSITIVE_INFINITY }, {
      used_actions: 0,
      used_cost: 0,
      used_time_minutes: 0,
    }).reason_code, 'INVALID_CANDIDATE');
  } finally {
    fixture.cleanup();
  }
});

test('单个贵动作超限不等于整体预算耗尽', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const expensive = policy.actions.find(item => item.id === 'A_UAV')!;
    const tight = { ...policy, budget: { max_actions: 3, max_total_cost: 0.4, max_total_time_minutes: 8 } };
    const usage = { used_actions: 0, used_cost: 0.2, used_time_minutes: 1 };
    assert.equal(checkCandidateBudget(tight, expensive, usage).eligible, false);
    assert.equal(allCandidatesBlocked(tight, usage), false);
    assert.equal(allCandidatesBlocked(tight, { used_actions: 0, used_cost: 0.39, used_time_minutes: 1 }), true);
  } finally {
    fixture.cleanup();
  }
});
