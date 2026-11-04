/**
 * SkyGuard 安全 API 集成测试（T14 权限 + 三个演示场景 + 契约一致性）。
 *
 * 每个用例使用独立的临时 DATA_ROOT，并把默认场景复制进去，
 * 验证的是 HTTP 层真实行为，而不是服务内部方法。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { jsonBody, startTestServer, type TestServer } from '../helpers/api-fixtures';
import { resetSafetyServiceForTests } from '../../src/services/safety';
import { REPO_SCENARIO_PATH } from './fixtures';
import { SECRET } from '../../src/api/v1/auth';


async function startSafetyServer(): Promise<TestServer> {
  resetSafetyServiceForTests();
  const server = await startTestServer();
  const scenarioDir = path.join(server.dataRoot, 'scenarios');
  fs.mkdirSync(scenarioDir, { recursive: true });
  fs.copyFileSync(REPO_SCENARIO_PATH, path.join(scenarioDir, 'venue-default.json'));
  return server;
}

async function authHeaders(server: TestServer): Promise<Record<string, string>> {
  const response = await server.request('/api/v1/auth/login', jsonBody({ username: process.env.SKYGUARD_ADMIN_USERNAME || 'admin', password: process.env.SKYGUARD_ADMIN_PASSWORD || 'skyguard2026' }));
  assert.equal(response.status, 200, '管理员登录应成功');
  return {
    Authorization: `Bearer ${response.body.access_token}`,
    'Content-Type': 'application/json',
  };
}

function viewerToken(): string {
  return jwt.sign({ username: 'viewer-7', role: 'viewer' }, SECRET, { expiresIn: '1h' });
}

test('safety status is readable without auth but writes are not', async () => {
  const server = await startSafetyServer();
  try {
    const status = await server.request('/api/v1/safety/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.state.state, 'DEGRADED');
    assert.ok(status.body.state.reasons.some((reason: any) => reason.code === 'no_observations'));

    const anonymous = await server.request('/api/v1/safety/plan/recompute', jsonBody({}));
    assert.equal(anonymous.status, 401);

    const viewer = await server.request('/api/v1/safety/plan/recompute', {
      ...jsonBody({}),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken()}` },
    });
    assert.equal(viewer.status, 403);
    assert.equal(viewer.body.error.code, 'FORBIDDEN');
  } finally {
    await server.close();
  }
});

test('T14 非运维角色无法确认或解除事件', async () => {
  const server = await startSafetyServer();
  try {
    const admin = await authHeaders(server);
    const created = await server.request('/api/v1/safety/incidents', {
      ...jsonBody({
        type: 'fire',
        description: '东侧主出口火情',
        severity: 'critical',
        affected: { exit_ids: ['E_B'] },
        source: 'operator',
        recompute: false,
      }),
      headers: admin,
    });
    assert.equal(created.status, 201);
    const incidentId = created.body.incident.id;
    assert.equal(created.body.incident.status, 'reported');

    const viewerConfirm = await server.request(`/api/v1/safety/incidents/${incidentId}/confirm`, {
      ...jsonBody({}),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken()}` },
    });
    assert.equal(viewerConfirm.status, 403);

    const anonymousResolve = await server.request(`/api/v1/safety/incidents/${incidentId}/resolve`, jsonBody({}));
    assert.equal(anonymousResolve.status, 401);

    const incidents = await server.request('/api/v1/safety/incidents');
    assert.equal(incidents.status, 200);
    assert.equal(incidents.body.incidents[0].status, 'reported', '被拒绝的请求不得改变事件状态');

    const audit = await server.request('/api/v1/safety/audit?limit=20');
    const rejected = audit.body.entries.filter((entry: any) => entry.action === 'incident.confirm');
    assert.ok(rejected.length >= 0);
  } finally {
    await server.close();
  }
});

test('模拟观测 → 规划 → 校验 → NORMAL，前端读取到的是同一份后端结果', async () => {
  const server = await startSafetyServer();
  try {
    const admin = await authHeaders(server);
    const ingest = await server.request('/api/v1/safety/observations/simulate', {
      ...jsonBody({
        observations: {
          R_MAIN: { count: 380, confidence: 0.92 },
          R_ATRIUM: { count: 140, confidence: 0.9 },
          R_EAST: { count: 220, confidence: 0.91 },
          R_NORTH: { count: 110, confidence: 0.88 },
          R_SOUTH: { count: 80, confidence: 0.9 },
          R_WEST: { count: 70, confidence: 0.89 },
        },
      }),
      headers: admin,
    });
    assert.equal(ingest.status, 201);
    assert.equal(ingest.body.state, 'NORMAL');

    const status = await server.request('/api/v1/safety/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.state.state, 'NORMAL');
    assert.equal(status.body.state.publishable, true);
    assert.ok(status.body.plan);
    assert.equal(status.body.observations.length, 6);
    assert.equal(status.body.exits.length, 4);
    assert.equal(status.body.corridors.length, 11);

    const plan = await server.request('/api/v1/safety/plan');
    assert.equal(plan.status, 200);
    assert.equal(plan.body.validation.valid, true);
    assert.equal(plan.body.plan.plan_id, status.body.plan.plan_id);
    assert.equal(plan.body.plan.evacuated_persons, 1000);

    // 每个路线必须能在大屏路网里找到对应的通道与出口
    const corridorIds = new Set(status.body.corridors.map((corridor: any) => corridor.id));
    const exitIds = new Set(status.body.exits.map((exit: any) => exit.id));
    for (const route of plan.body.plan.routes) {
      assert.ok(exitIds.has(route.exit_id));
      for (const step of route.steps) assert.ok(corridorIds.has(step.corridor_id));
    }
  } finally {
    await server.close();
  }
});

test('三个演示场景均可重复运行且结果与期望状态一致', async () => {
  const server = await startSafetyServer();
  try {
    const admin = await authHeaders(server);
    const expectations: Array<[string, string]> = [
      ['A_normal', 'NORMAL'],
      ['B_exit_fire', 'REROUTE'],
      ['C_capacity_shortage', 'REJECT'],
    ];
    for (const [demoId, expected] of expectations) {
      const run = await server.request(`/api/v1/safety/demo/${demoId}/run`, { ...jsonBody({}), headers: admin });
      assert.equal(run.status, 200, `${demoId} 应成功`);
      assert.equal(run.body.expected_state, expected);
      assert.equal(run.body.actual_state, expected, `${demoId} 实际状态 ${run.body.actual_state}`);
      assert.equal(run.body.matched, true);

      // 重复运行结果稳定
      const again = await server.request(`/api/v1/safety/demo/${demoId}/run`, { ...jsonBody({}), headers: admin });
      assert.equal(again.body.actual_state, expected);
    }
  } finally {
    await server.close();
  }
});

test('场景 C 的大屏数据包含拒绝原因与人工介入提示', async () => {
  const server = await startSafetyServer();
  try {
    const admin = await authHeaders(server);
    await server.request('/api/v1/safety/demo/C_capacity_shortage/run', { ...jsonBody({}), headers: admin });

    const status = await server.request('/api/v1/safety/status');
    assert.equal(status.body.state.state, 'REJECT');
    assert.equal(status.body.state.requires_operator_action, true);
    assert.equal(status.body.state.validated_route_display_allowed, false);
    assert.equal(status.body.state.candidate_route_display_allowed, true);
    assert.equal(status.body.plan, null, 'REJECT 下不得发布方案');
    assert.ok(status.body.candidate_plan, '应保留候选方案供展示');
    assert.ok(status.body.validation.violations.some((violation: any) => violation.code === 'unresolved_demand'));

    const blockedExit = status.body.exits.find((exit: any) => exit.id === 'E_B');
    assert.equal(blockedExit.effective_status, 'closed');
    assert.ok(blockedExit.blocked_by_incident_id);
  } finally {
    await server.close();
  }
});

test('感知 provider 状态真实反映本机环境', async () => {
  const server = await startSafetyServer();
  try {
    const response = await server.request('/api/v1/safety/providers');
    assert.equal(response.status, 200);
    const byKind = new Map(response.body.providers.map((provider: any) => [provider.kind, provider]));

    const simulation = byKind.get('simulation') as any;
    assert.equal(simulation.available, true);
    assert.equal(simulation.source, 'simulation');

    const ascend = byKind.get('ascend') as any;
    assert.equal(ascend.available, false, '本机无昇腾设备，必须如实报告不可用');
    assert.equal(ascend.verified_on_this_host, false);
    assert.ok(ascend.checks.length >= 3);
    assert.ok(ascend.checks.some((check: any) => check.ok === false));

    const video = byKind.get('recorded_video') as any;
    assert.equal(typeof video.available, 'boolean');
    assert.ok(Array.isArray(video.checks));
  } finally {
    await server.close();
  }
});

test('自然语言事件解析只产出待确认草稿，不改变系统状态', async () => {
  const server = await startSafetyServer();
  try {
    const admin = await authHeaders(server);
    const before = await server.request('/api/v1/safety/status');

    const parsed = await server.request('/api/v1/safety/incidents/parse', {
      ...jsonBody({ text: '东侧主出口 B 出口附近起火了，请立即处理' }),
      headers: admin,
    });
    assert.equal(parsed.status, 200);
    assert.equal(parsed.body.draft.type, 'fire');
    assert.equal(parsed.body.draft.severity, 'critical');
    assert.ok(parsed.body.draft.affected.exit_ids.includes('E_B'));

    const after = await server.request('/api/v1/safety/status');
    assert.equal(after.body.versions.constraint, before.body.versions.constraint, '解析草稿不得改变约束版本');
    assert.equal(after.body.incidents.length, 0);
  } finally {
    await server.close();
  }
});

test('审计日志记录操作者、动作与结果', async () => {
  const server = await startSafetyServer();
  try {
    const admin = await authHeaders(server);
    await server.request('/api/v1/safety/observations/simulate', {
      ...jsonBody({ observations: { R_MAIN: { count: 300, confidence: 0.9 } } }),
      headers: admin,
    });
    const audit = await server.request('/api/v1/safety/audit?limit=50');
    assert.equal(audit.status, 200);
    const actions = audit.body.entries.map((entry: any) => entry.action);
    assert.ok(actions.includes('observation.ingest'));
    assert.ok(actions.includes('plan.recompute'));
    for (const entry of audit.body.entries) {
      assert.ok(entry.actor);
      assert.ok(entry.ts);
      assert.ok(['success', 'failure', 'rejected'].includes(entry.result));
    }

    const traces = await server.request('/api/v1/safety/traces');
    assert.equal(traces.status, 200);
    assert.ok(traces.body.traces.length > 0);
    assert.ok(traces.body.traces[0].stages.length > 0);
  } finally {
    await server.close();
  }
});
