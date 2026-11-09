import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN, ingestObservation, makeMvpFixture, staffActor } from './fixtures';
import type { WorkOrder } from '../../src/services/mvp/ops';

function completeOrder(fixture: ReturnType<typeof makeMvpFixture>, order: WorkOrder, count: number) {
  fixture.mvp.ops.approve(order.id, ADMIN);
  if (fixture.mvp.ops.getWorkOrder(order.id)?.stale) {
    fixture.mvp.ops.revalidate(order.id, ADMIN, '反馈更新后重新确认');
  }
  const assigned = fixture.mvp.ops.assignStaff(order.id, ADMIN);
  const staffId = assigned.assigned_staff_id!;
  const actor = staffActor(fixture, staffId);
  fixture.mvp.ops.accept(order.id, actor);
  fixture.mvp.ops.start(order.id, actor);
  return fixture.mvp.ops.complete(order.id, actor, {
    note: `测试反馈 ${order.type}`,
    observation: { count, confidence: 0.95, valid: true },
  });
}

test('信息缺口下 Agent 通过 VoI 创建现场核查与无人机请求', async () => {
  const fixture = makeMvpFixture();
  try {
    ingestObservation(fixture, 'R_EAST_STAND', 900, 0.35);
    const run = await fixture.mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'crowd_surge_alert' });

    assert.equal(run.mode, 'LOCAL_DEMO');
    assert.equal(run.status, 'awaiting_evidence');
    assert.equal(run.investigation.required, true);
    assert.ok(run.investigation.rounds.length >= 1);
    assert.ok(run.investigation.rounds.some(round => round.decision.ranked_action_ids.length > 0));
    assert.ok(run.trace.some(item => item.tool === 'request_supplemental_observation'));
    assert.ok(run.trace.some(item => item.tool === 'request_uav_observation'));

    const types = new Set(run.work_orders.map(order => order.type));
    assert.ok(types.has('scene_verification'));
    assert.ok(types.has('uav_observation'));
    assert.ok(run.work_orders.every(order => order.status === 'PENDING_APPROVAL'));

    assert.ok(fixture.audit.list(200).some(entry => entry.action === 'tool.request_supplemental_observation'));
    assert.ok(fixture.audit.list(200).some(entry => entry.action === 'agent.run'));
  } finally {
    fixture.cleanup();
  }
});

test('人工反馈写回观测后 Agent 不再重复调查，并生成疏导工单', async () => {
  const fixture = makeMvpFixture();
  try {
    for (const [regionId, item] of Object.entries(fixture.scenario.simulation_baseline ?? {})) {
      if (regionId === 'R_EAST_STAND') continue;
      ingestObservation(fixture, regionId, item.count, item.confidence);
    }
    ingestObservation(fixture, 'R_EAST_STAND', 900, 0.35);
    const run = await fixture.mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'initial' });
    const pending = fixture.mvp.ops.listWorkOrders().filter(order => order.status === 'PENDING_APPROVAL');
    assert.ok(pending.length >= 2);

    completeOrder(fixture, pending.find(order => order.type === 'scene_verification')!, 920);
    completeOrder(fixture, pending.find(order => order.type === 'uav_observation')!, 940);

    const observation = fixture.safety.getObservationStore().latest('R_EAST_STAND');
    assert.ok(['field_report', 'uav_observation'].includes(observation?.source ?? ''));

    const run2 = await fixture.mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'staff_feedback' });
    assert.equal(run2.investigation.required, false);
    assert.ok(run2.work_orders.some(order => order.type === 'crowd_control'));
    assert.equal(run2.status, 'awaiting_approval');
  } finally {
    fixture.cleanup();
  }
});

test('正常数据下 Agent 不发起调查也不创建工单', async () => {
  const fixture = makeMvpFixture();
  try {
    const baseline = fixture.scenario.simulation_baseline ?? {};
    for (const [regionId, item] of Object.entries(baseline)) {
      ingestObservation(fixture, regionId, item.count, item.confidence);
      fixture.safety.ingestObservation({
        regionId,
        count: item.count,
        confidence: item.confidence,
        source: 'simulation',
        provider: 'test',
        modelVersion: 'test',
        observedAt: new Date(Date.now() - 60_000),
      }, ADMIN);
    }
    const run = await fixture.mvp.runAgent({ regionId: 'R_NORTH_STAND', trigger: 'normal' });
    assert.equal(run.investigation.required, false);
    assert.equal(run.work_orders.length, 0);
    assert.ok(run.trace.every(item => !item.tool.startsWith('request_')));
  } finally {
    fixture.cleanup();
  }
});

test('工具注册表强制角色权限与参数校验', async () => {
  const fixture = makeMvpFixture();
  try {
    const agent = { username: 'skyguard-agent', role: 'agent', kind: 'agent' as const };
    const result = await fixture.mvp.registry.invoke('submit_worker_feedback', {
      work_order_id: 'WO-NOT-EXIST',
      note: 'test',
    }, agent);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /无权调用/);

    const invalid = await fixture.mvp.registry.invoke('predict_crowd_trend', {}, agent);
    assert.equal(invalid.ok, false);
    assert.match(invalid.error ?? '', /参数校验失败/);

    const unknown = await fixture.mvp.registry.invoke('no_such_tool', {}, agent);
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? '', /unknown tool/);

    const read = await fixture.mvp.registry.invoke('get_venue_information', {}, agent);
    assert.equal(read.ok, true);
  } finally {
    fixture.cleanup();
  }
});

test('摄像头降级但未离线时，Agent 仍会先尝试摄像头查询', async () => {
  const fixture = makeMvpFixture();
  try {
    for (const [regionId, item] of Object.entries(fixture.scenario.simulation_baseline ?? {})) {
      if (regionId === 'R_EAST_STAND') continue;
      ingestObservation(fixture, regionId, item.count, item.confidence);
    }
    ingestObservation(fixture, 'R_EAST_STAND', 900, 0.35);
    const run = await fixture.mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'camera_retry' });
    assert.ok(run.investigation.rounds.length >= 1);
    assert.equal(run.investigation.rounds[0].selected_action_id, 'A_CAMERA');
    assert.equal(run.investigation.rounds[0].pending, false);
  } finally {
    fixture.cleanup();
  }
});

test('agent 无权通过工具发布方案（D8）', async () => {
  const fixture = makeMvpFixture();
  try {
    const agent = { username: 'skyguard-agent', role: 'agent', kind: 'agent' } as const;
    const result = await fixture.mvp.registry.invoke('calculate_candidate_plan', { trigger: 'tool_test' }, agent);
    assert.equal(result.ok, false);
    assert.equal(result.error_code, 'FORBIDDEN');
  } finally {
    fixture.cleanup();
  }
});

test('超大工具参数被拒绝且审计字段有界（D2/D22）', async () => {
  const fixture = makeMvpFixture();
  try {
    const agent = { username: 'skyguard-agent', role: 'agent', kind: 'agent' } as const;
    const huge = 'x'.repeat(200_000);
    const result = await fixture.mvp.registry.invoke('get_crowd_status', { region_id: huge }, agent);
    assert.equal(result.ok, false);
    assert.equal(result.error_code, 'INVALID_ARGUMENT');
    const entry = fixture.audit.list(10).find(item => item.action === 'tool.get_crowd_status');
    assert.ok(entry);
    const serialized = JSON.stringify(entry);
    assert.ok(Buffer.byteLength(serialized, 'utf8') < 10_000);
  } finally {
    fixture.cleanup();
  }
});
