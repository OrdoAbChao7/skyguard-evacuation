import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../../src/services/safety/audit';
import { SafetyDecisionService } from '../../src/services/safety/decision-service';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { MvpService } from '../../src/services/mvp';
import { PersistentStateStore } from '../../src/services/state/persistent-store';
import { productionAuthConfigErrors } from '../../src/api/v1/auth';
import { loadDisplayPackage } from '../../src/services/perception/display';
import { adaptDisplayFrame, ingestPerceptionDraft } from '../../src/services/perception/adapter';
import { ADMIN } from './fixtures';

const SCENARIO_PATH = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

function service(dir: string) {
  const scenario = loadSafetyScenario(SCENARIO_PATH);
  const audit = new AuditLog(path.join(dir, `audit-${Math.random().toString(36).slice(2)}`));
  const safety = new SafetyDecisionService({ scenario, auditLog: audit });
  const mvp = new MvpService({ scenario, safety, audit });
  return { scenario, audit, safety, mvp };
}

test('P0-1 恢复选择最高 revision：primary 缺失时使用较新的 temp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-p0-recovery-'));
  const file = path.join(dir, 'state.json');
  try {
    const store = new PersistentStateStore<{ v: number }>(file, 1);
    store.save({ v: 1 }, 0);
    store.save({ v: 2 }, 1);
    fs.renameSync(file, `${file}.tmp`); // primary 尚未改名，temp=rev2，backup=rev1
    const loaded = new PersistentStateStore<{ v: number }>(file, 1).load();
    assert.equal(loaded?.source, 'temp');
    assert.equal(loaded?.revision, 2);
    assert.equal(loaded?.payload.v, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-2 反馈写入失败时回滚工单完成、预留与预算', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-p0-rollback-'));
  const file = path.join(dir, 'state.json');
  process.env.MVP_STATE_FILE = file;
  try {
    const { scenario, safety, mvp } = service(dir);
    const order = mvp.ops.createWorkOrder(ADMIN, {
      type: 'scene_verification',
      title: 'rollback',
      description: 'rollback',
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
      resource_request: { staff_id: 'STF-02', budget_units: 0.2, person_minutes: 1 },
    });
    mvp.ops.approve(order.id, ADMIN);
    mvp.ops.assignStaff(order.id, ADMIN, 'STF-02');
    const member = mvp.ops.getStaff('STF-02')!;
    const staff = { username: member.name, role: 'staff' as const, staff_id: member.id };
    mvp.ops.accept(order.id, staff);
    mvp.ops.start(order.id, staff);
    const before = mvp.ops.getWorkOrder(order.id)!;
    assert.equal(before.status, 'IN_PROGRESS');
    (safety as unknown as { ingestObservation: () => never }).ingestObservation = () => {
      throw new Error('injected feedback failure');
    };
    assert.throws(
      () => mvp.ops.complete(order.id, staff, { note: 'should fail', observation: { count: 100, confidence: 0.9 } }),
      /injected feedback failure/,
    );
    const after = mvp.ops.getWorkOrder(order.id)!;
    assert.equal(after.status, 'IN_PROGRESS');
    assert.equal(after.feedback, null);
    assert.equal(after.reservation?.state, 'CONFIRMED');
    assert.equal(mvp.ops.getStaff('STF-02')?.runtime_status, 'busy');
    assert.equal(mvp.ops.getBudgetStatus().settled.actions, 0);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const savedOrder = saved.payload.ops.workOrders.find((item: { id: string }) => item.id === order.id);
    assert.equal(savedOrder.status, 'IN_PROGRESS');
  } finally {
    delete process.env.MVP_STATE_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-3 状态写入失败后不返回未持久化工单，幂等重试被只读拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-p0-readonly-'));
  const file = path.join(dir, 'state.json');
  process.env.MVP_STATE_FILE = file;
  try {
    const { mvp } = service(dir);
    const store = (mvp as unknown as { stateStore: { save: (...args: unknown[]) => never } }).stateStore;
    store.save = () => { throw new Error('disk full'); };
    const input = {
      type: 'scene_verification' as const,
      title: 'readonly',
      description: 'readonly',
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
      idempotency_key: 'p0-readonly-key',
    };
    assert.throws(() => mvp.ops.createWorkOrder(ADMIN, input), /disk full|状态写入失败/);
    assert.equal(mvp.getStateStoreHealth().writable, false);
    assert.equal(mvp.ops.listWorkOrders({}).length, 0);
    assert.throws(() => mvp.ops.createWorkOrder(ADMIN, input), /不可写|READ_ONLY/);
  } finally {
    delete process.env.MVP_STATE_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-4 伪造/未签名的感知草稿不能进入安全域', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-p0-perception-'));
  process.env.MVP_STATE_FILE = path.join(dir, 'state.json');
  try {
    const { scenario, safety } = service(dir);
    const region = scenario.regions.find(item => item.id === 'R_EAST_STAND')!;
    const loaded = loadDisplayPackage('citystreet-display');
    const original = adaptDisplayFrame(loaded, loaded.frames[0])[0];
    const forged = {
      ...original,
      region_id: region.id,
      area_m2: region.area_m2,
      confidence: 0.9,
      valid_for_safety: true,
      quality: { ...original.quality, calibrated: true, status: 'ok', reasons: [] },
      attestation: 'forged',
    };
    const result = ingestPerceptionDraft(safety, forged, ADMIN);
    assert.equal(result.observation?.valid, false);
    assert.match(result.observation?.invalid_reason ?? '', /unattested_or_tampered_draft/);

    const mapped = adaptDisplayFrame(loaded, loaded.frames[0], {
      mappings: [{ region_id: region.id, zone_id: 'N', area_m2: region.area_m2, calibration: 'surveyed', source: 'p0-test' }],
    }).find(item => item.region_id === region.id)!;
    assert.equal(mapped.valid_for_safety, false);
    const mappedResult = ingestPerceptionDraft(safety, mapped, ADMIN);
    assert.equal(mappedResult.observation?.valid, false);
    assert.match(mappedResult.observation?.invalid_reason ?? '', /derived_display_source_not_allowed/);
  } finally {
    delete process.env.MVP_STATE_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-5 生产环境缺少强 SECRET/管理员口令时拒绝启动配置', () => {
  assert.ok(productionAuthConfigErrors({ NODE_ENV: 'production' } as NodeJS.ProcessEnv).length >= 2);
  assert.deepEqual(
    productionAuthConfigErrors({
      NODE_ENV: 'production',
      SECRET_KEY: 'a-strong-production-secret-123',
      SKYGUARD_ADMIN_PASSWORD: 'strong-admin-password',
    } as NodeJS.ProcessEnv),
    [],
  );
  assert.deepEqual(productionAuthConfigErrors({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), []);
});
