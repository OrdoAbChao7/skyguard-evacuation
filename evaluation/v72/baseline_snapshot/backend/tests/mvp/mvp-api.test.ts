/**
 * MVP HTTP 集成测试：真实鉴权、Agent 运行、审批、工单流转、反馈写回。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { jsonBody, startTestServer } from '../helpers/api-fixtures';

const STADIUM = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');
process.env.SAFETY_SCENARIO_FILE = STADIUM;

async function loginAdmin(server: Awaited<ReturnType<typeof startTestServer>>): Promise<Record<string, string>> {
  const response = await server.request('/api/v1/auth/login', jsonBody({
    username: process.env.SKYGUARD_ADMIN_USERNAME || 'admin',
    password: process.env.SKYGUARD_ADMIN_PASSWORD || 'skyguard2026',
  }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { Authorization: `Bearer ${response.body.access_token}` };
}

async function loginStaff(
  server: Awaited<ReturnType<typeof startTestServer>>,
  staffId: string,
  accessCode: string,
): Promise<Record<string, string>> {
  const response = await server.request('/api/v1/mvp/auth/staff-login', jsonBody({
    staff_id: staffId,
    access_code: accessCode,
  }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { Authorization: `Bearer ${response.body.access_token}` };
}

test('HTTP 闭环：低置信观测 → Agent → 审批 → 派发 → 执行 → 反馈 → 重新评估', async () => {
  const server = await startTestServer();
  try {
    const admin = await loginAdmin(server);

    const reset = await server.request('/api/v1/mvp/reset', {
      method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(reset.status, 200);

    const simulate = await server.request('/api/v1/safety/observations/simulate', {
      ...jsonBody({
        observations: {
          R_NORTH_STAND: { count: 350, confidence: 0.92 },
          R_SOUTH_STAND: { count: 300, confidence: 0.91 },
          R_WEST_STAND: { count: 280, confidence: 0.9 },
          R_NORTH_CONCOURSE: { count: 120, confidence: 0.9 },
          R_SOUTH_CONCOURSE: { count: 110, confidence: 0.9 },
          R_EAST_PLAZA: { count: 60, confidence: 0.88 },
          R_WEST_PLAZA: { count: 55, confidence: 0.88 },
        },
        recompute: true,
      }),
      headers: { ...admin, 'Content-Type': 'application/json' },
    });
    assert.equal(simulate.status, 201, JSON.stringify(simulate.body));

    const observation = await server.request('/api/v1/safety/observations', {
      ...jsonBody({
        region_id: 'R_EAST_STAND',
        count: 900,
        confidence: 0.35,
        source: 'simulation',
        provider: 'http-test',
        model_version: 'http-test/1.0.0',
        recompute: true,
      }),
      headers: { ...admin, 'Content-Type': 'application/json' },
    });
    assert.equal(observation.status, 201, JSON.stringify(observation.body));

    const statusBefore = await server.request('/api/v1/safety/status');
    assert.equal(statusBefore.body.state.state, 'DEGRADED');

    const runResponse = await server.request('/api/v1/mvp/agent/runs', {
      ...jsonBody({ region_id: 'R_EAST_STAND', trigger: 'http_test' }),
      headers: { ...admin, 'Content-Type': 'application/json' },
    });
    assert.equal(runResponse.status, 201, JSON.stringify(runResponse.body));
    const run = runResponse.body;
    assert.equal(run.mode, 'LOCAL_DEMO');
    assert.equal(run.status, 'awaiting_evidence');
    assert.ok(run.work_orders.length >= 2);
    assert.ok(run.trace.some((item: { tool: string }) => item.tool === 'request_uav_observation'));

    const ordersResponse = await server.request('/api/v1/mvp/work-orders?status=PENDING_APPROVAL');
    const pending = ordersResponse.body.work_orders.filter((order: { region_id: string }) => order.region_id === 'R_EAST_STAND');
    assert.ok(pending.length >= 2);

    for (const order of pending) {
      const approve = await server.request(`/api/v1/mvp/work-orders/${order.id}/approve`, {
        ...jsonBody({ note: 'HTTP 集成测试审批' }),
        headers: { ...admin, 'Content-Type': 'application/json' },
      });
      assert.equal(approve.status, 200, JSON.stringify(approve.body));
      assert.equal(approve.body.work_order.status, 'APPROVED');

      const revalidate = await server.request(`/api/v1/mvp/work-orders/${order.id}/revalidate`, {
        ...jsonBody({ note: '反馈更新后重新确认' }),
        headers: { ...admin, 'Content-Type': 'application/json' },
      });
      assert.equal(revalidate.status, 200, JSON.stringify(revalidate.body));
      assert.equal(revalidate.body.work_order.stale, false);

      const assign = await server.request(`/api/v1/mvp/work-orders/${order.id}/assign`, {
        ...jsonBody({}),
        headers: { ...admin, 'Content-Type': 'application/json' },
      });
      assert.equal(assign.status, 200, JSON.stringify(assign.body));
      const staffId = assign.body.work_order.assigned_staff_id as string;
      assert.ok(staffId);

      const accessCode = staffId === 'STF-02' ? '1002' : staffId === 'STF-04' ? '1004' : null;
      assert.ok(accessCode, `unexpected staff ${staffId}`);
      const staff = await loginStaff(server, staffId, accessCode!);

      for (const action of ['accept', 'start']) {
        const response = await server.request(`/api/v1/mvp/work-orders/${order.id}/${action}`, {
          ...jsonBody({}), headers: { ...staff, 'Content-Type': 'application/json' },
        });
        assert.equal(response.status, 200, `${action}: ${JSON.stringify(response.body)}`);
      }
      const complete = await server.request(`/api/v1/mvp/work-orders/${order.id}/complete`, {
        ...jsonBody({
          note: 'HTTP 集成测试现场反馈',
          observation: { count: order.type === 'uav_observation' ? 940 : 920, confidence: 0.95, valid: true },
        }),
        headers: { ...staff, 'Content-Type': 'application/json' },
      });
      assert.equal(complete.status, 200, JSON.stringify(complete.body));
      assert.equal(complete.body.work_order.status, 'COMPLETED');
    }

    const after = await server.request('/api/v1/safety/status');
    const eastObservation = after.body.observations.find((item: { region_id: string }) => item.region_id === 'R_EAST_STAND');
    assert.ok(['field_report', 'uav_observation'].includes(eastObservation.source));
    assert.notEqual(after.body.state.state, 'DEGRADED');

    const dashboard = await server.request('/api/v1/mvp/dashboard');
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.scenario.regions, 8);
    assert.ok(dashboard.body.work_orders.every((order: { status: string }) => ['COMPLETED', 'FAILED', 'REJECTED'].includes(order.status)));
    assert.ok(Array.isArray(dashboard.body.audit));
    assert.ok(dashboard.body.audit.length > 0);

    const audit = await server.request('/api/v1/safety/audit?limit=100');
    assert.ok(audit.body.entries.some((entry: { action: string }) => entry.action === 'tool.get_crowd_status'));
    assert.ok(audit.body.entries.some((entry: { action: string }) => entry.action === 'work_order.completed'));
  } finally {
    await server.close();
  }
});

test('HTTP 权限：未登录不能运行 Agent，staff 不能审批，Agent 不能反馈', async () => {
  const server = await startTestServer();
  try {
    const anonymousRun = await server.request('/api/v1/mvp/agent/runs', jsonBody({ region_id: 'R_EAST_STAND', trigger: 'x' }));
    assert.equal(anonymousRun.status, 401);

    const admin = await loginAdmin(server);
    const reset = await server.request('/api/v1/mvp/reset', {
      method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(reset.status, 200);

    const staff = await loginStaff(server, 'STF-02', '1002');
    const staffApprove = await server.request('/api/v1/mvp/work-orders/WO-NOT-EXIST/approve', {
      ...jsonBody({}), headers: { ...staff, 'Content-Type': 'application/json' },
    });
    assert.equal(staffApprove.status, 403);

    const toolAsAgent = await server.request('/api/v1/mvp/tools/submit_worker_feedback', {
      ...jsonBody({ work_order_id: 'WO-X', note: 'x' }),
      headers: { ...admin, 'Content-Type': 'application/json' },
    });
    // admin 身份调用 staff-only 工具：注册表拒绝
    assert.equal(toolAsAgent.status, 400);
    assert.match(toolAsAgent.body.error, /无权调用/);
  } finally {
    await server.close();
  }
});
