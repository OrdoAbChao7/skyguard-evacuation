import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OpsService, WorkOrderTransitionError } from '../../src/services/mvp/ops';
import { ADMIN, makeMvpFixture, staffActor } from './fixtures';

test('人员推荐按技能、状态与通道距离排序', () => {
  const fixture = makeMvpFixture();
  try {
    const result = fixture.mvp.ops.recommendStaff({
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
    });
    assert.ok(result.recommended);
    assert.equal(result.recommended?.staff_id, 'STF-02');
    assert.ok(result.candidates.every(item => item.status !== 'off_duty' || item.score === null));
    assert.ok(result.candidates.every(item => item.score === null || item.travel_seconds !== null));
    assert.match(result.reason, /推荐/);
  } finally {
    fixture.cleanup();
  }
});

test('员工不足时明确返回 shortage 而不是伪造推荐', () => {
  const fixture = makeMvpFixture();
  try {
    const result = fixture.mvp.ops.recommendStaff({
      region_id: 'R_NORTH_STAND',
      required_skills: ['不存在的技能'],
    });
    assert.equal(result.recommended, null);
    assert.equal(result.shortage, true);
    assert.match(result.reason, /没有/);
  } finally {
    fixture.cleanup();
  }
});

test('Agent 不能审批工单，只有管理员可以', () => {
  const fixture = makeMvpFixture();
  try {
    const order = fixture.mvp.ops.createWorkOrder(
      { username: 'skyguard-agent', role: 'agent', kind: 'agent' },
      {
        type: 'scene_verification',
        title: '测试工单',
        description: '测试',
        region_id: 'R_EAST_STAND',
        required_skills: ['crowd_check'],
      },
    );
    assert.equal(order.status, 'PENDING_APPROVAL');
    assert.throws(
      () => fixture.mvp.ops.approve(order.id, { username: 'skyguard-agent', role: 'agent' }),
      WorkOrderTransitionError,
    );
    const approved = fixture.mvp.ops.approve(order.id, ADMIN, '同意');
    assert.equal(approved.status, 'APPROVED');
  } finally {
    fixture.cleanup();
  }
});

test('工单状态机拒绝跳跃，并完整走到 COMPLETED', () => {
  const fixture = makeMvpFixture();
  try {
    const order = fixture.mvp.ops.createWorkOrder(ADMIN, {
      type: 'scene_verification',
      title: '现场核查',
      description: '核查东看台',
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
    });
    assert.throws(() => fixture.mvp.ops.accept(order.id, staffActor(fixture, 'STF-02')), WorkOrderTransitionError);

    fixture.mvp.ops.approve(order.id, ADMIN);
    const assigned = fixture.mvp.ops.assignStaff(order.id, ADMIN);
    assert.equal(assigned.status, 'ASSIGNED');
    assert.equal(assigned.assigned_staff_id, 'STF-02');

    const actor = staffActor(fixture, 'STF-02');
    assert.equal(fixture.mvp.ops.accept(order.id, actor).status, 'ACCEPTED');
    assert.equal(fixture.mvp.ops.start(order.id, actor).status, 'IN_PROGRESS');
    const completed = fixture.mvp.ops.complete(order.id, actor, {
      note: '现场核查完成',
      observation: { count: 920, confidence: 0.95, valid: true },
    });
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.feedback?.observation?.count, 920);

    const observation = fixture.safety.getObservationStore().latest('R_EAST_STAND');
    assert.equal(observation?.source, 'field_report');
    assert.equal(observation?.estimated_count, 920);

    const staff = fixture.mvp.ops.getStaff('STF-02');
    assert.equal(staff?.runtime_status, 'available');
  } finally {
    fixture.cleanup();
  }
});

test('工作人员只能操作指派给本人的工单', () => {
  const fixture = makeMvpFixture();
  try {
    const order = fixture.mvp.ops.createWorkOrder(ADMIN, {
      type: 'scene_verification',
      title: '现场核查',
      description: '核查',
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
    });
    fixture.mvp.ops.approve(order.id, ADMIN);
    fixture.mvp.ops.assignStaff(order.id, ADMIN, 'STF-02');
    assert.throws(
      () => fixture.mvp.ops.accept(order.id, staffActor(fixture, 'STF-03')),
      WorkOrderTransitionError,
    );
  } finally {
    fixture.cleanup();
  }
});

test('拒绝工单必须填写审批意见', () => {
  const fixture = makeMvpFixture();
  try {
    const order = fixture.mvp.ops.createWorkOrder(ADMIN, {
      type: 'crowd_control',
      title: '疏导',
      description: '测试',
      region_id: 'R_EAST_STAND',
    });
    assert.throws(() => fixture.mvp.ops.reject(order.id, ADMIN, '  '), /审批意见/);
    const rejected = fixture.mvp.ops.reject(order.id, ADMIN, '当前资源不足');
    assert.equal(rejected.status, 'REJECTED');
  } finally {
    fixture.cleanup();
  }
});

test('不可用人员不会被派发', () => {
  const fixture = makeMvpFixture();
  try {
    const order = fixture.mvp.ops.createWorkOrder(ADMIN, {
      type: 'scene_verification',
      title: '现场核查',
      description: '测试',
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
    });
    fixture.mvp.ops.approve(order.id, ADMIN);
    assert.throws(() => fixture.mvp.ops.assignStaff(order.id, ADMIN, 'STF-06'), /不可派发/);
  } finally {
    fixture.cleanup();
  }
});

test('工单幂等键避免 Agent 重试产生重复任务', () => {
  const fixture = makeMvpFixture();
  try {
    const input = {
      type: 'scene_verification' as const,
      title: '幂等测试',
      description: '同一幂等键只应创建一个工单',
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
      idempotency_key: 'idem-001',
    };
    const first = fixture.mvp.ops.createWorkOrder(ADMIN, input);
    const second = fixture.mvp.ops.createWorkOrder(ADMIN, input);
    assert.equal(first.id, second.id);
    assert.equal(fixture.mvp.ops.listWorkOrders().length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('审批后观测变化使工单过期，必须重新确认才能派发', () => {
  const fixture = makeMvpFixture();
  try {
    const order = fixture.mvp.ops.createWorkOrder(ADMIN, {
      type: 'scene_verification',
      title: '上下文失效测试',
      description: '审批后环境变化',
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
    });
    fixture.mvp.ops.approve(order.id, ADMIN);
    fixture.safety.ingestObservation({
      regionId: 'R_EAST_STAND',
      count: 900,
      confidence: 0.95,
      source: 'simulation',
      provider: 'test',
      modelVersion: 'test/1.0.0',
      observedAt: new Date(),
    }, ADMIN);

    const stale = fixture.mvp.ops.getWorkOrder(order.id);
    assert.equal(stale?.stale, true);
    assert.match(stale?.stale_reason ?? '', /观测版本/);
    assert.throws(() => fixture.mvp.ops.assignStaff(order.id, ADMIN), /上下文已变化/);

    const revalidated = fixture.mvp.ops.revalidate(order.id, ADMIN, '确认最新观测');
    assert.equal(revalidated.stale, false);
    const assigned = fixture.mvp.ops.assignStaff(order.id, ADMIN);
    assert.equal(assigned.status, 'ASSIGNED');
  } finally {
    fixture.cleanup();
  }
});

test('可选持久化：工单与幂等键在重启后恢复', () => {
  const fixture = makeMvpFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-ops-persist-'));
  const file = path.join(dir, 'ops-state.json');
  try {
    const first = new OpsService(fixture.scenario, fixture.audit, undefined, undefined, file);
    const order = first.createWorkOrder(ADMIN, {
      type: 'scene_verification',
      title: '持久化测试',
      description: '重启后应恢复',
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
      idempotency_key: 'persist-001',
    });
    assert.ok(fs.existsSync(file));

    const second = new OpsService(fixture.scenario, fixture.audit, undefined, undefined, file);
    assert.equal(second.getWorkOrder(order.id)?.title, '持久化测试');
    const duplicate = second.createWorkOrder(ADMIN, {
      type: 'scene_verification',
      title: '持久化测试',
      description: '重启后应恢复',
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
      idempotency_key: 'persist-001',
    });
    assert.equal(duplicate.id, order.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fixture.cleanup();
  }
});
