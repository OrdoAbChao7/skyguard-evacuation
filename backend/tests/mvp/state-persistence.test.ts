import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../../src/services/safety/audit';
import { SafetyDecisionService } from '../../src/services/safety/decision-service';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { MvpService } from '../../src/services/mvp';
import { PersistentStateStore, StateStoreError } from '../../src/services/state/persistent-store';
import { ADMIN } from './fixtures';

const SCENARIO_PATH = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

function newService(file: string, dir: string) {
  const scenario = loadSafetyScenario(SCENARIO_PATH);
  const audit = new AuditLog(path.join(dir, `audit-${Math.random().toString(36).slice(2)}`));
  const safety = new SafetyDecisionService({ scenario, auditLog: audit });
  const mvp = new MvpService({ scenario, safety, audit });
  return { scenario, audit, safety, mvp, file };
}

test('统一状态跨业务恢复：证据、事件、工单/预留、预算、Agent 运行与审计', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-state-'));
  const file = path.join(dir, 'mvp-state.json');
  process.env.MVP_STATE_FILE = file;
  try {
    const first = newService(file, dir);
    for (const region of first.scenario.regions) {
      first.safety.ingestObservation({
        regionId: region.id,
        count: 120,
        confidence: 0.9,
        source: 'simulation',
        provider: 'state-test',
        modelVersion: 'test/1.0.0',
        observedAt: new Date(),
      }, ADMIN);
    }
    first.safety.recompute(ADMIN, 'state_test');
    const incident = first.safety.createIncident({
      type: 'corridor_closure',
      description: '状态恢复测试事件',
      severity: 'high',
      affected: { exit_ids: ['E_EAST'] },
      source: 'operator',
      actor: ADMIN.username,
    });
    first.safety.confirmIncident(incident.id, ADMIN);

    const order = first.mvp.ops.createWorkOrder(ADMIN, {
      type: 'scene_verification',
      title: '状态恢复工单',
      description: '验证跨业务恢复',
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
      idempotency_key: 'state-idem-1',
      resource_request: { staff_id: 'STF-02', budget_units: 0.2, person_minutes: 1 },
    });
    first.mvp.ops.approve(order.id, ADMIN);
    first.mvp.ops.assignStaff(order.id, ADMIN, 'STF-02');
    const member = first.mvp.ops.getStaff('STF-02')!;
    const staff = { username: member.name, role: 'staff' as const, staff_id: member.id };
    first.mvp.ops.accept(order.id, staff);
    first.mvp.ops.start(order.id, staff);
    first.mvp.ops.complete(order.id, staff, {
      note: '现场核查完成',
      observation: { count: 150, confidence: 0.95 },
    });
    const run = await first.mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'state_test', runtime: 'local' });
    const beforeHealth = first.mvp.getStateStoreHealth();
    const beforeStatus = first.safety.getStatus();
    assert.ok(beforeHealth.revision >= 2);
    assert.equal(beforeHealth.writable, true);
    assert.equal(fs.existsSync(file), true);

    // 模拟进程重启：新服务实例从同一状态文件恢复。
    const second = newService(file, dir);
    const afterHealth = second.mvp.getStateStoreHealth();
    assert.equal(afterHealth.revision, beforeHealth.revision);
    assert.equal(second.safety.getVersions().observation, beforeStatus.versions.observation);
    assert.equal(second.safety.getVersions().constraint, beforeStatus.versions.constraint);
    assert.equal(second.safety.getStatus().state.state, beforeStatus.state.state);
    assert.ok(second.safety.getObservationStore().window(
      'R_EAST_STAND',
      new Date(Date.now() - 86_400_000),
      new Date(Date.now() + 60_000),
    ).some(item => item.estimated_count === 150));
    assert.equal(second.safety.getIncidentStore().list().some(item => item.id === incident.id), true);

    const restoredOrder = second.mvp.ops.getWorkOrder(order.id);
    assert.ok(restoredOrder);
    assert.equal(restoredOrder?.status, 'COMPLETED');
    assert.equal(restoredOrder?.reservation?.state, 'RELEASED');
    assert.equal(second.mvp.ops.getStaff('STF-02')?.runtime_status, 'available');
    const budget = second.mvp.ops.getBudgetStatus();
    assert.equal(budget.settled.actions, 1);
    assert.equal(budget.settled.cost, 0.2);
    assert.equal(second.mvp.listAgentRuns(10).some(item => item.run_id === run.run_id), true);
    assert.ok(second.audit.list(200).some(entry => entry.action === 'system.state_restored'));
    assert.ok(second.audit.list(200).some(entry => entry.action === 'work_order.completed'));

    // 幂等重放：同一键同参返回同一工单，不新增预留。
    const replay = second.mvp.ops.createWorkOrder(ADMIN, {
      type: 'scene_verification',
      title: '状态恢复工单',
      description: '验证跨业务恢复',
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
      idempotency_key: 'state-idem-1',
      resource_request: { staff_id: 'STF-02', budget_units: 0.2, person_minutes: 1 },
    });
    assert.equal(replay.id, order.id);
    assert.equal(second.mvp.ops.getBudgetStatus().reserved.actions, 0);
  } finally {
    delete process.env.MVP_STATE_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('主状态损坏时从 backup 恢复；全部损坏时 fail closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-state-corrupt-'));
  const file = path.join(dir, 'mvp-state.json');
  try {
    const store = new PersistentStateStore<{ value: number }>(file, 1);
    assert.equal(store.save({ value: 1 }, 0), 1);
    assert.equal(store.save({ value: 2 }, 1), 2);
    assert.equal(fs.existsSync(`${file}.bak`), true);
    fs.writeFileSync(file, '{"broken":');
    const recovered = store.load();
    assert.ok(recovered);
    assert.equal(recovered?.source, 'backup');
    assert.equal(recovered?.payload.value, 1);

    fs.writeFileSync(`${file}.bak`, '{"also":"broken"');
    if (fs.existsSync(`${file}.tmp`)) fs.unlinkSync(`${file}.tmp`);
    assert.throws(() => new PersistentStateStore<{ value: number }>(file, 1).load(), StateStoreError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未完成写入留下的 temp 可被校验恢复；revision 冲突被拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-state-temp-'));
  const file = path.join(dir, 'mvp-state.json');
  try {
    const store = new PersistentStateStore<{ value: number }>(file, 1);
    store.save({ value: 7 }, 0);
    // 模拟：primary 尚未改名成功，但 temp 已完整落盘。
    fs.renameSync(file, `${file}.tmp`);
    const loaded = new PersistentStateStore<{ value: number }>(file, 1).load();
    assert.equal(loaded?.source, 'temp');
    assert.equal(loaded?.payload.value, 7);
    assert.throws(() => store.save({ value: 8 }, 99), StateStoreError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('schema_version 超前时拒绝启动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-state-version-'));
  const file = path.join(dir, 'mvp-state.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      schema_version: 2,
      revision: 1,
      saved_at: new Date().toISOString(),
      checksum_algorithm: 'sha256',
      checksum: 'x',
      payload: {},
    }));
    assert.throws(() => new PersistentStateStore(file, 1).load(), /schema_version=2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('跨实例写入做磁盘 revision CAS，后写者拒绝覆盖（P1-7）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-state-cas-'));
  const file = path.join(dir, 'mvp-state.json');
  try {
    const seed = new PersistentStateStore<{ owner: string }>(file, 1);
    assert.equal(seed.save({ owner: 'seed' }, 0), 1);

    const first = new PersistentStateStore<{ owner: string }>(file, 1);
    const second = new PersistentStateStore<{ owner: string }>(file, 1);
    assert.equal(first.load()?.revision, 1);
    assert.equal(second.load()?.revision, 1);

    assert.equal(first.save({ owner: 'A' }, 1), 2);
    assert.throws(
      () => second.save({ owner: 'B' }, 1),
      (error: unknown) => error instanceof StateStoreError && error.code === 'STATE_REVISION_CONFLICT',
    );
    const reloaded = new PersistentStateStore<{ owner: string }>(file, 1).load();
    assert.equal(reloaded?.revision, 2);
    assert.equal(reloaded?.payload.owner, 'A');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
