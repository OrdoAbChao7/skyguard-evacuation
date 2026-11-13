/** Agent 运行记录的持久化与恢复（G08 的最小可验证部分）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SafetyDecisionService } from '../../src/services/safety/decision-service';
import { MvpService } from '../../src/services/mvp';
import { makeMvpFixture } from './fixtures';

test('Agent 运行记录写入快照并在新服务实例中恢复', async () => {
  const fixture = makeMvpFixture();
  const file = path.join(fixture.dataRoot, 'agent-runs.json');
  process.env.MVP_RUNS_FILE = file;
  try {
    const mvp = new MvpService({ scenario: fixture.scenario, safety: fixture.safety, audit: fixture.audit });
    const run = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'persist_test', runtime: 'local' });
    assert.ok(run.run_id);
    assert.equal(fs.existsSync(file), true);

    const safety2 = new SafetyDecisionService({ scenario: fixture.scenario, audit: fixture.audit });
    const mvp2 = new MvpService({ scenario: fixture.scenario, safety: safety2, audit: fixture.audit });
    const restored = mvp2.listAgentRuns(10);
    assert.equal(restored.length, 1);
    assert.equal(restored[0].run_id, run.run_id);
    assert.equal(restored[0].trigger, 'persist_test');
  } finally {
    delete process.env.MVP_RUNS_FILE;
    fixture.cleanup();
  }
});

test('损坏的运行快照不会阻断启动，并记录审计失败', () => {
  const fixture = makeMvpFixture();
  const file = path.join(fixture.dataRoot, 'agent-runs.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not-json');
  process.env.MVP_RUNS_FILE = file;
  try {
    const mvp = new MvpService({ scenario: fixture.scenario, safety: fixture.safety, audit: fixture.audit });
    assert.equal(mvp.listAgentRuns(10).length, 0);
    const failures = fixture.audit.list(50).filter(entry =>
      (entry as Record<string, unknown>).action === 'agent_runs.persistence_restore_failed');
    assert.equal(failures.length, 1);
  } finally {
    delete process.env.MVP_RUNS_FILE;
    fixture.cleanup();
  }
});
