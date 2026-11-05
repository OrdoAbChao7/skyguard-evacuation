/** 一键推演 HTTP 接口回归（UI 按钮对应的真实后端路径）。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonBody, startTestServer } from '../helpers/api-fixtures';

async function adminHeaders(server: Awaited<ReturnType<typeof startTestServer>>): Promise<Record<string, string>> {
  const response = await server.request('/api/v1/auth/login', jsonBody({
    username: process.env.SKYGUARD_ADMIN_USERNAME || 'admin',
    password: process.env.SKYGUARD_ADMIN_PASSWORD || 'skyguard2026',
  }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { Authorization: `Bearer ${response.body.access_token}` };
}

test('一键推演 A：正常散场进入 NORMAL 且不建单', async () => {
  const server = await startTestServer();
  try {
    const admin = await adminHeaders(server);
    const response = await server.request('/api/v1/mvp/demo/run', {
      ...jsonBody({ scenario: 'A_normal' }),
      headers: { ...admin, 'Content-Type': 'application/json' },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.state.state, 'NORMAL');
    assert.equal(response.body.run.status, 'completed');
    assert.equal(response.body.run.work_orders.length, 0);
  } finally {
    await server.close();
  }
});

test('一键推演 B：低置信观测生成待审批工单', async () => {
  const server = await startTestServer();
  try {
    const admin = await adminHeaders(server);
    const response = await server.request('/api/v1/mvp/demo/run', {
      ...jsonBody({ scenario: 'B_surge' }),
      headers: { ...admin, 'Content-Type': 'application/json' },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.run.status, 'awaiting_evidence');
    const types = new Set(response.body.run.work_orders.map((order: { type: string }) => order.type));
    assert.ok(types.has('scene_verification'));
    assert.ok(types.has('uav_observation'));
  } finally {
    await server.close();
  }
});

test('一键推演 C：DEGRADED → REJECT 且禁止发布', async () => {
  const server = await startTestServer();
  try {
    const admin = await adminHeaders(server);
    const response = await server.request('/api/v1/mvp/demo/run', {
      ...jsonBody({ scenario: 'C_untrusted' }),
      headers: { ...admin, 'Content-Type': 'application/json' },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.state.state, 'REJECT');
    assert.equal(response.body.state.publishable, false);
    assert.equal(response.body.state.validated_route_display_allowed, false);
  } finally {
    await server.close();
  }
});
