import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../../src/services/safety/audit';
import { OpsService, IdempotencyConflictError, ResourceUnavailableError } from '../../src/services/mvp/ops';
import { makeMvpFixture, ADMIN, staffActor } from './fixtures';

const BASE = {
  type: 'scene_verification' as const,
  title: '资源预留测试工单',
  description: '验证人员与预算预留生命周期',
  region_id: 'R_EAST_STAND',
  required_skills: ['crowd_check'],
};

test('创建工单时软预留人员与预算，预检本身不占用资源', () => {
  const fixture = makeMvpFixture();
  try {
    const ops = fixture.mvp.ops;
    const preview = ops.previewReservation({
      ...BASE,
      resource_request: { staff_id: 'STF-02', budget_units: 0.4, person_minutes: 2 },
    });
    assert.equal(preview.eligible, true);
    assert.equal(preview.staff_id, 'STF-02');
    assert.equal(ops.getStaff('STF-02')?.runtime_status, 'available');

    const order = ops.createWorkOrder(ADMIN, {
      ...BASE,
      resource_request: { staff_id: 'STF-02', budget_units: 0.4, person_minutes: 2 },
    });
    assert.equal(order.status, 'PENDING_APPROVAL');
    assert.equal(order.reservation?.state, 'HELD');
    assert.equal(order.reservation?.staff_id, 'STF-02');
    assert.equal(ops.getStaff('STF-02')?.runtime_status, 'reserved');
    const budget = ops.getBudgetStatus();
    assert.equal(budget.reserved.actions, 1);
    assert.equal(budget.reserved.cost, 0.4);
    assert.equal(budget.reserved.person_minutes, 2);
  } finally {
    fixture.cleanup();
  }
});

test('拒绝、取消、执行失败都会释放人员与预留；完成会结算预算', () => {
  const fixture = makeMvpFixture();
  try {
    const ops = fixture.mvp.ops;
    const create = (title: string, staffId: string) => ops.createWorkOrder(ADMIN, {
      ...BASE,
      title,
      resource_request: { staff_id: staffId, budget_units: 0.2, person_minutes: 1 },
    });

    const rejected = create('拒绝工单', 'STF-01');
    ops.reject(rejected.id, ADMIN, '不需要');
    assert.equal(ops.getWorkOrder(rejected.id)?.reservation?.state, 'RELEASED');
    assert.equal(ops.getStaff('STF-01')?.runtime_status, 'available');

    const cancelled = create('取消工单', 'STF-02');
    ops.cancel(cancelled.id, ADMIN, '任务取消');
    assert.equal(ops.getWorkOrder(cancelled.id)?.status, 'CANCELLED');
    assert.equal(ops.getWorkOrder(cancelled.id)?.reservation?.state, 'RELEASED');
    assert.equal(ops.getStaff('STF-02')?.runtime_status, 'available');

    const failed = create('失败工单', 'STF-03');
    ops.approve(failed.id, ADMIN);
    assert.equal(ops.getWorkOrder(failed.id)?.reservation?.state, 'CONFIRMED');
    ops.assignStaff(failed.id, ADMIN, 'STF-03');
    const staff = staffActor(fixture, 'STF-03');
    ops.accept(failed.id, staff);
    ops.start(failed.id, staff);
    ops.fail(failed.id, staff, '现场无法到达');
    assert.equal(ops.getWorkOrder(failed.id)?.reservation?.state, 'RELEASED');
    assert.equal(ops.getStaff('STF-03')?.runtime_status, 'available');
    assert.equal(ops.getBudgetStatus().settled.actions, 0);

    const completed = create('完成工单', 'STF-04');
    ops.approve(completed.id, ADMIN);
    ops.assignStaff(completed.id, ADMIN, 'STF-04');
    const staff4 = staffActor(fixture, 'STF-04');
    ops.accept(completed.id, staff4);
    ops.start(completed.id, staff4);
    ops.complete(completed.id, staff4, { note: '已核查', observation: { count: 400, confidence: 0.9 } });
    assert.equal(ops.getWorkOrder(completed.id)?.reservation?.state, 'RELEASED');
    assert.equal(ops.getStaff('STF-04')?.runtime_status, 'available');
    const budget = ops.getBudgetStatus();
    assert.equal(budget.settled.actions, 1);
    assert.equal(budget.settled.cost, 0.2);
    assert.equal(budget.settled.person_minutes, 1);
  } finally {
    fixture.cleanup();
  }
});

test('预算边界：恰好等于允许，超出拒绝；动作数也受限', () => {
  const fixture = makeMvpFixture();
  try {
    const ops = fixture.mvp.ops;
    const first = ops.createWorkOrder(ADMIN, {
      ...BASE, title: '预算 1', resource_request: { budget_units: 1.0, person_minutes: 0 },
    });
    const second = ops.createWorkOrder(ADMIN, {
      ...BASE, title: '预算 2', resource_request: { budget_units: 0.2, person_minutes: 0 },
    });
    assert.ok(first.id && second.id);
    assert.throws(() => ops.createWorkOrder(ADMIN, {
      ...BASE, title: '预算 3', resource_request: { budget_units: 0.01, person_minutes: 0 },
    }), ResourceUnavailableError);

    // 动作数上限 3：已预留 2 个，再建 1 个允许，第 4 个拒绝。
    ops.createWorkOrder(ADMIN, { ...BASE, title: '预算 4', resource_request: { budget_units: 0, person_minutes: 0 } });
    assert.throws(() => ops.createWorkOrder(ADMIN, {
      ...BASE, title: '预算 5', resource_request: { budget_units: 0, person_minutes: 0 },
    }), ResourceUnavailableError);
  } finally {
    fixture.cleanup();
  }
});

test('幂等键同参返回同一工单，同键异参拒绝', () => {
  const fixture = makeMvpFixture();
  try {
    const ops = fixture.mvp.ops;
    const input = { ...BASE, idempotency_key: 'res-idem-1', resource_request: { staff_id: 'STF-02', budget_units: 0.1 } };
    const first = ops.createWorkOrder(ADMIN, input);
    const second = ops.createWorkOrder(ADMIN, input);
    assert.equal(first.id, second.id);
    assert.equal(ops.listWorkOrders({}).length, 1);
    assert.throws(
      () => ops.createWorkOrder(ADMIN, { ...input, title: '不同标题' }),
      IdempotencyConflictError,
    );
    // 只保留一份预留。
    assert.equal(ops.getBudgetStatus().reserved.actions, 1);
  } finally {
    fixture.cleanup();
  }
});

test('并发创建同一人员只成功一个', async () => {
  const fixture = makeMvpFixture();
  try {
    const ops = fixture.mvp.ops;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => ops.createWorkOrder(ADMIN, {
        ...BASE, title: '并发 A', resource_request: { staff_id: 'STF-02', budget_units: 0 },
      })),
      Promise.resolve().then(() => ops.createWorkOrder(ADMIN, {
        ...BASE, title: '并发 B', resource_request: { staff_id: 'STF-02', budget_units: 0 },
      })),
    ]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(results.filter(item => item.status === 'rejected').length, 1);
    assert.equal(ops.getStaff('STF-02')?.runtime_status, 'reserved');
  } finally {
    fixture.cleanup();
  }
});

test('预留过期自动释放，审批被拒绝；重新确认后恢复', async () => {
  const fixture = makeMvpFixture();
  try {
    const ops = fixture.mvp.ops;
    const order = ops.createWorkOrder(ADMIN, {
      ...BASE,
      resource_request: { staff_id: 'STF-02', budget_units: 0.1, ttl_minutes: 0.001 },
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    const reloaded = ops.getWorkOrder(order.id)!;
    assert.equal(reloaded.reservation?.state, 'EXPIRED');
    assert.equal(ops.getStaff('STF-02')?.runtime_status, 'available');
    assert.throws(() => ops.approve(order.id, ADMIN), ResourceUnavailableError);

    ops.revalidate(order.id, ADMIN, '重新预留');
    const revalidated = ops.getWorkOrder(order.id)!;
    assert.equal(revalidated.reservation?.state, 'HELD');
    assert.equal(revalidated.reservation?.staff_id, 'STF-02');
    assert.equal(ops.getStaff('STF-02')?.runtime_status, 'reserved');
    ops.approve(order.id, ADMIN);
    assert.equal(ops.getWorkOrder(order.id)?.reservation?.state, 'CONFIRMED');
  } finally {
    fixture.cleanup();
  }
});

test('派发前校验场景版本；重新确认后可派发', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-res-version-'));
  try {
    const fixture = makeMvpFixture();
    let scenarioVersion = fixture.scenario.version;
    const ops = new OpsService(
      fixture.scenario,
      new AuditLog(path.join(dir, 'audit')),
      undefined,
      () => ({ observation: 0, constraint: 0, scenario: scenarioVersion }),
    );
    const order = ops.createWorkOrder(ADMIN, {
      ...BASE, resource_request: { staff_id: 'STF-02', budget_units: 0.1 },
    });
    ops.approve(order.id, ADMIN);
    scenarioVersion = '9.9.9';
    assert.equal(ops.getWorkOrder(order.id)?.stale, true);
    assert.throws(() => ops.assignStaff(order.id, ADMIN, 'STF-02'));
    ops.revalidate(order.id, ADMIN, '场景版本已确认');
    assert.equal(ops.getWorkOrder(order.id)?.stale, false);
    const assigned = ops.assignStaff(order.id, ADMIN, 'STF-02');
    assert.equal(assigned.status, 'ASSIGNED');
    assert.equal(ops.getStaff('STF-02')?.runtime_status, 'busy');
    fixture.cleanup();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
