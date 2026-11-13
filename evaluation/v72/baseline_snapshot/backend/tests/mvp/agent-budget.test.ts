import assert from 'node:assert/strict';
import test from 'node:test';
import { MvpService } from '../../src/services/mvp';
import { makeMvpFixture, ADMIN } from './fixtures';

test('本地 Agent 遵守调查动作预算：max_actions=1 只执行一轮', async () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const tightScenario = {
      ...fixture.scenario,
      investigation: {
        ...policy,
        budget: { max_actions: 1, max_total_cost: policy.budget?.max_total_cost ?? 1.2, max_total_time_minutes: 8 },
      },
    };
    // 制造信息缺口（不可信观测），使 Agent 进入调查流程。
    fixture.safety.ingestObservation({
      regionId: 'R_EAST_STAND',
      count: 800,
      confidence: 0.2,
      source: 'simulation',
      provider: 'budget-test',
      modelVersion: 'test/1.0.0',
      observedAt: new Date(),
      valid: false,
      invalidReason: '测试构造不可信观测',
    }, ADMIN);

    const mvp = new MvpService({ scenario: tightScenario, safety: fixture.safety, audit: fixture.audit });
    const run = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'budget_test', runtime: 'local' });
    const selected = run.investigation.rounds.filter(round => round.selected_action_id);
    assert.equal(selected.length, 1);
    // 第二轮应因预算无法准入而停止。
    const last = run.investigation.rounds[run.investigation.rounds.length - 1];
    assert.equal(last.selected_action_id, null);
    assert.equal(last.decision.stop_reason, 'no_available_action');
  } finally {
    fixture.cleanup();
  }
});
