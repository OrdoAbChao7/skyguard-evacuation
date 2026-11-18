/**
 * 无人机派发桥接测试。
 *
 * 重点：
 *  - Agent / staff 不能生成派发包；
 *  - 只有已审批、已指派给具备 uav_operation 技能的 uav_observation 工单可以派发；
 *  - 默认 outbox 不发送网络请求，HTTP 模式只发送观察任务请求；
 *  - 幂等、单位占用、失败不冒充成功、工单状态不被桥接修改。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import jwt from 'jsonwebtoken';
import { SECRET } from '../../src/api/v1/auth';
import { DroneBridgeError } from '../../src/services/mvp/drone-bridge';
import { jsonBody, startTestServer } from '../helpers/api-fixtures';
import { ADMIN, makeMvpFixture, staffActor } from './fixtures';

const BRIDGE_ENV_KEYS = [
  'SKYGUARD_DRONE_BRIDGE_MODE',
  'SKYGUARD_DRONE_BRIDGE_URL',
  'SKYGUARD_DRONE_BRIDGE_TOKEN',
  'SKYGUARD_DRONE_BRIDGE_TIMEOUT_MS',
  'SKYGUARD_DRONE_BRIDGE_TTL_MINUTES',
  'SKYGUARD_DRONE_BRIDGE_SIMULATED',
  'SKYGUARD_DRONE_BRIDGE_FILE',
] as const;
const originalEnv = Object.fromEntries(BRIDGE_ENV_KEYS.map(key => [key, process.env[key]]));

beforeEach(() => {
  for (const key of BRIDGE_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of BRIDGE_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function createUavOrder(
  fixture: ReturnType<typeof makeMvpFixture>,
  overrides: Partial<Parameters<typeof fixture.mvp.ops.createWorkOrder>[1]> = {},
) {
  return fixture.mvp.ops.createWorkOrder(ADMIN, {
    type: 'uav_observation',
    title: '无人机补充观察',
    description: '核实 S04 滩顶平台人流',
    priority: 'high',
    region_id: 'R_S04_L1_CREST',
    required_skills: ['uav_operation'],
    evidence: [],
    submit: true,
    ...overrides,
  });
}

function readyUavOrder(
  fixture: ReturnType<typeof makeMvpFixture>,
  overrides: Partial<Parameters<typeof fixture.mvp.ops.createWorkOrder>[1]> = {},
) {
  const order = createUavOrder(fixture, overrides);
  fixture.mvp.ops.approve(order.id, ADMIN, '同意无人机观察');
  return fixture.mvp.ops.assignStaff(order.id, ADMIN);
}

test('默认 outbox：生成派发包但不发送网络请求，且不修改工单状态', async () => {
  const fixture = makeMvpFixture();
  try {
    const order = readyUavOrder(fixture);
    const result = await fixture.mvp.droneBridge.dispatch(order.id, ADMIN);

    assert.equal(result.dispatch.status, 'QUEUED');
    assert.equal(result.dispatch.effective_status, 'QUEUED');
    assert.equal(result.dispatch.transport, 'outbox');
    assert.equal(result.dispatch.delivered, false);
    assert.equal(result.dispatch.simulated, true);
    assert.equal(result.dispatch.uav_unit.verified, false);
    assert.equal(result.dispatch.assigned_operator.staff_id, order.assigned_staff_id);

    const after = fixture.mvp.ops.getWorkOrder(order.id);
    assert.equal(after?.status, 'ASSIGNED', '桥接不得替工作人员接单或开始执行');

    const status = fixture.mvp.droneBridge.status();
    assert.equal(status.mode, 'outbox');
    assert.equal(status.pending_dispatches, 1);
    assert.equal(status.active_units, 1);
    assert.equal(status.real_hardware_verified, false);
    assert.equal(status.verified_on_this_host, false);
    assert.equal(status.uav_units.filter(unit => unit.active).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('Agent 与 staff 不能生成派发包，只有管理员可以', async () => {
  const fixture = makeMvpFixture();
  try {
    const order = readyUavOrder(fixture);
    await assert.rejects(
      () => fixture.mvp.droneBridge.dispatch(order.id, { username: 'skyguard-agent', role: 'agent', kind: 'agent' }),
      (error: unknown) => error instanceof DroneBridgeError && error.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => fixture.mvp.droneBridge.dispatch(order.id, staffActor(fixture, 'STAFF_GATE_04')),
      (error: unknown) => error instanceof DroneBridgeError && error.code === 'FORBIDDEN',
    );
    assert.equal(fixture.mvp.droneBridge.list().length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('拒绝非无人机工单、未就绪工单和未指派工单', async () => {
  const fixture = makeMvpFixture();
  try {
    const normal = fixture.mvp.ops.createWorkOrder(ADMIN, {
      type: 'scene_verification',
      title: '普通现场核查',
      description: '核查通道',
      region_id: 'R_S04_L1_CREST',
      required_skills: ['crowd_check'],
    });
    fixture.mvp.ops.approve(normal.id, ADMIN);
    fixture.mvp.ops.assignStaff(normal.id, ADMIN);
    await assert.rejects(
      () => fixture.mvp.droneBridge.dispatch(normal.id, ADMIN),
      (error: unknown) => error instanceof DroneBridgeError && error.code === 'WORK_ORDER_NOT_UAV',
    );

    const pending = createUavOrder(fixture);
    await assert.rejects(
      () => fixture.mvp.droneBridge.dispatch(pending.id, ADMIN),
      (error: unknown) => error instanceof DroneBridgeError && error.code === 'WORK_ORDER_NOT_READY',
    );

    fixture.mvp.ops.approve(pending.id, ADMIN);
    await assert.rejects(
      () => fixture.mvp.droneBridge.dispatch(pending.id, ADMIN),
      (error: unknown) => error instanceof DroneBridgeError && error.code === 'WORK_ORDER_NOT_READY',
    );
  } finally {
    fixture.cleanup();
  }
});

test('拒绝未具备 uav_operation 技能的操作员', async () => {
  const fixture = makeMvpFixture();
  try {
    const order = createUavOrder(fixture);
    fixture.mvp.ops.approve(order.id, ADMIN);
    fixture.mvp.ops.assignStaff(order.id, ADMIN, 'STAFF_GATE_01');
    await assert.rejects(
      () => fixture.mvp.droneBridge.dispatch(order.id, ADMIN),
      (error: unknown) => error instanceof DroneBridgeError && error.code === 'OPERATOR_NOT_QUALIFIED',
    );
  } finally {
    fixture.cleanup();
  }
});

test('没有可用无人机单位时明确拒绝，不生成虚假派发包', async () => {
  const fixture = makeMvpFixture();
  try {
    const order = readyUavOrder(fixture);
    fixture.scenario.venue!.uav_units = fixture.scenario.venue!.uav_units.map(unit => ({
      ...unit,
      status: 'offline' as const,
    }));
    await assert.rejects(
      () => fixture.mvp.droneBridge.dispatch(order.id, ADMIN),
      (error: unknown) => error instanceof DroneBridgeError && error.code === 'NO_UAV_AVAILABLE',
    );
    assert.equal(fixture.mvp.droneBridge.list().length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('同一幂等键返回同一派发包；不同键不能重复占用同一工单', async () => {
  const fixture = makeMvpFixture();
  try {
    const order = readyUavOrder(fixture);
    const first = await fixture.mvp.droneBridge.dispatch(order.id, ADMIN, { idempotency_key: 'dispatch-once' });
    const second = await fixture.mvp.droneBridge.dispatch(order.id, ADMIN, { idempotency_key: 'dispatch-once' });
    assert.equal(second.duplicate, true);
    assert.equal(second.dispatch.dispatch_id, first.dispatch.dispatch_id);
    await assert.rejects(
      () => fixture.mvp.droneBridge.dispatch(order.id, ADMIN, { idempotency_key: 'dispatch-again' }),
      (error: unknown) => error instanceof DroneBridgeError && error.code === 'DISPATCH_CONFLICT',
    );
    assert.equal(fixture.mvp.droneBridge.list().length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('HTTP 模式发送观察任务请求并记录外部确认，不泄漏 token', async () => {
  const received: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, external_id: 'uav-ext-001' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not expose a port');

  process.env.SKYGUARD_DRONE_BRIDGE_MODE = 'http';
  process.env.SKYGUARD_DRONE_BRIDGE_URL = `http://127.0.0.1:${address.port}/dispatch`;
  process.env.SKYGUARD_DRONE_BRIDGE_TOKEN = 'bridge-test-token';
  process.env.SKYGUARD_DRONE_BRIDGE_SIMULATED = 'true';

  const fixture = makeMvpFixture();
  try {
    const order = readyUavOrder(fixture);
    const result = await fixture.mvp.droneBridge.dispatch(order.id, ADMIN, { idempotency_key: 'http-once' });

    assert.equal(result.dispatch.status, 'SENT');
    assert.equal(result.dispatch.delivered, true);
    assert.equal(result.dispatch.external_id, 'uav-ext-001');
    assert.equal(received.length, 1);
    assert.equal(received[0].headers.authorization, 'Bearer bridge-test-token');
    assert.equal(received[0].headers['idempotency-key'], 'http-once');
    assert.equal(received[0].body.schema, 'skyguard.drone-dispatch/v1');
    assert.equal(received[0].body.safety.human_approved, true);
    assert.equal(received[0].body.safety.no_autonomous_flight, true);
    assert.equal(received[0].body.safety.simulated, true);
    assert.ok(!('waypoints' in received[0].body));
    assert.ok(!('velocity' in received[0].body));
    assert.ok(!JSON.stringify(result).includes('bridge-test-token'));
    assert.equal(fixture.mvp.ops.getWorkOrder(order.id)?.status, 'ASSIGNED');
  } finally {
    fixture.cleanup();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('HTTP 失败时记录 FAILED，不冒充已送达', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: false, message: 'platform unavailable' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not expose a port');

  process.env.SKYGUARD_DRONE_BRIDGE_MODE = 'http';
  process.env.SKYGUARD_DRONE_BRIDGE_URL = `http://127.0.0.1:${address.port}/dispatch`;

  const fixture = makeMvpFixture();
  try {
    const order = readyUavOrder(fixture);
    const result = await fixture.mvp.droneBridge.dispatch(order.id, ADMIN);
    assert.equal(result.dispatch.status, 'FAILED');
    assert.equal(result.dispatch.delivered, false);
    assert.match(result.dispatch.error ?? '', /http_500/);
    assert.equal(fixture.mvp.ops.getWorkOrder(order.id)?.status, 'ASSIGNED');
  } finally {
    fixture.cleanup();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('派发记录可持久化，重启后仍可查询且不会重复发送', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-drone-bridge-'));
  process.env.SKYGUARD_DRONE_BRIDGE_FILE = path.join(dir, 'dispatches.json');
  const fixture = makeMvpFixture();
  try {
    const order = readyUavOrder(fixture);
    const first = await fixture.mvp.droneBridge.dispatch(order.id, ADMIN);
    assert.equal(first.dispatch.status, 'QUEUED');

    const reloaded = new (await import('../../src/services/mvp/drone-bridge')).DroneBridgeService({
      scenario: fixture.scenario,
      ops: fixture.mvp.ops,
      audit: fixture.audit,
    });
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.list()[0].dispatch_id, first.dispatch.dispatch_id);
    assert.equal(reloaded.status().pending_dispatches, 1);
  } finally {
    fixture.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP API：管理员可派发，staff/agent 被拒绝，读接口不泄漏端点凭据', async () => {
  process.env.SKYGUARD_DRONE_BRIDGE_MODE = 'outbox';
  const server = await startTestServer();
  try {
    const adminToken = jwt.sign({ username: 'test-admin', role: 'admin' }, SECRET, { expiresIn: '1h' });
    const staffToken = jwt.sign(
      { username: 'test-staff', role: 'staff', staff_id: 'STAFF_GATE_04' },
      SECRET,
      { expiresIn: '1h' },
    );
    const agentToken = jwt.sign({ username: 'skyguard-agent', role: 'agent' }, SECRET, { expiresIn: '1h' });
    const adminHeaders = { Authorization: `Bearer ${adminToken}` };
    const staffHeaders = { Authorization: `Bearer ${staffToken}` };
    const agentHeaders = { Authorization: `Bearer ${agentToken}` };

    const create = await server.request('/api/v1/mvp/work-orders', {
      ...jsonBody({
        type: 'uav_observation',
        title: 'HTTP 无人机观察',
        description: '核实 S04 人流',
        region_id: 'R_S04_L1_CREST',
        required_skills: ['uav_operation'],
      }),
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const orderId = create.body.work_order.id;

    const approve = await server.request(`/api/v1/mvp/work-orders/${orderId}/approve`, {
      ...jsonBody({ note: '同意' }),
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));

    const assign = await server.request(`/api/v1/mvp/work-orders/${orderId}/assign`, {
      ...jsonBody({}),
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));

    const dispatch = await server.request('/api/v1/mvp/drone-bridge/dispatches', {
      ...jsonBody({ work_order_id: orderId }),
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    });
    assert.equal(dispatch.status, 201, JSON.stringify(dispatch.body));
    assert.equal(dispatch.body.dispatch.status, 'QUEUED');
    assert.equal(dispatch.body.dispatch.transport, 'outbox');

    const staffDispatch = await server.request('/api/v1/mvp/drone-bridge/dispatches', {
      ...jsonBody({ work_order_id: orderId }),
      headers: { ...staffHeaders, 'Content-Type': 'application/json' },
    });
    assert.equal(staffDispatch.status, 403, JSON.stringify(staffDispatch.body));

    const agentDispatch = await server.request('/api/v1/mvp/drone-bridge/dispatches', {
      ...jsonBody({ work_order_id: orderId }),
      headers: { ...agentHeaders, 'Content-Type': 'application/json' },
    });
    assert.equal(agentDispatch.status, 403, JSON.stringify(agentDispatch.body));

    const status = await server.request('/api/v1/mvp/drone-bridge/status');
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.mode, 'outbox');
    assert.equal(status.body.pending_dispatches, 1);
    assert.equal(status.body.real_hardware_verified, false);
    assert.ok(!JSON.stringify(status.body).includes('bridge-test-token'));

    const list = await server.request('/api/v1/mvp/drone-bridge/dispatches');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.dispatches.length, 1);
    assert.ok(!JSON.stringify(list.body).includes('bridge-test-token'));
  } finally {
    await server.close();
  }
});
