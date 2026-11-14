import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { jsonBody, startTestServer, type TestServer } from '../helpers/api-fixtures';
import { getSafetyService, resetSafetyServiceForTests } from '../../src/services/safety';
import { resetMvpServiceForTests } from '../../src/services/mvp';
import { SECRET } from '../../src/api/v1/auth';

const REPO_SCENARIO = path.resolve(__dirname, '../../../data/scenarios/hankou-mvp.json');

async function startServer(): Promise<TestServer> {
  resetSafetyServiceForTests();
  resetMvpServiceForTests();
  const server = await startTestServer();
  const scenarioDir = path.join(server.dataRoot, 'scenarios');
  fs.mkdirSync(scenarioDir, { recursive: true });
  for (const file of ['hankou-mvp.json', 'hankou-marshland-v752-base.json']) {
    fs.copyFileSync(path.join(path.dirname(REPO_SCENARIO), file), path.join(scenarioDir, file));
  }
  delete process.env.SAFETY_SCENARIO_FILE;
  return server;
}

async function adminHeaders(server: TestServer): Promise<Record<string, string>> {
  const response = await server.request('/api/v1/auth/login', jsonBody({
    username: process.env.SKYGUARD_ADMIN_USERNAME || 'admin',
    password: process.env.SKYGUARD_ADMIN_PASSWORD || 'skyguard2026',
  }));
  assert.equal(response.status, 200);
  return {
    Authorization: `Bearer ${response.body.access_token}`,
    'Content-Type': 'application/json',
  };
}

async function step(server: TestServer, headers: Record<string, string>) {
  const response = await server.request('/api/v1/mvp/simulation/step', { ...jsonBody({}), headers });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

test('时间轴仿真按剧本推进，并在人工审批处暂停', async () => {
  const server = await startServer();
  try {
    const headers = await adminHeaders(server);

    // 写接口必须要求操作员身份。
    const anonymous = await server.request('/api/v1/mvp/simulation/start', jsonBody({ autoplay: false }));
    assert.equal(anonymous.status, 401);

    const start = await server.request('/api/v1/mvp/simulation/start', {
      ...jsonBody({ autoplay: false }),
      headers,
    });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    assert.equal(start.body.available, true);
    assert.equal(start.body.paused, true);
    assert.equal(start.body.running, false);
    assert.equal(start.body.step_total, 9);
    assert.match(start.body.notice, /合成/);

    const observedStates: string[] = [];
    let observedEvents: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const status = await step(server, headers);
      observedStates.push(status.state);
      observedEvents = status.events.map((event: { title: string }) => event.title);
      if (index === 6) {
        assert.equal(status.awaiting_human, true);
        assert.equal(status.paused, false);
        assert.ok(status.counts.pending_work_orders >= 1, JSON.stringify(status.counts));
        assert.equal(status.next_actions.length, 3);
        assert.equal(status.current?.action, 'await_human');
      }
    }

    assert.deepEqual(observedStates, [
      'DEGRADED', // 冷启动：没有观测，fail-closed
      'NORMAL', // 基线观测 + 规划通过校验
      'NORMAL', // 客流上升
      'REROUTE', // 出口关闭后重新规划通过校验
      'DEGRADED', // 低置信观测，停止发布
      'DEGRADED', // Agent 只调查，不改变可信度
      'DEGRADED', // 等待人工
    ]);
    assert.ok(observedEvents.some(title => title.includes('写入 44 个区域基线观测')));
    assert.ok(observedEvents.some(title => title.includes('安全状态 NORMAL → REROUTE')));
    assert.ok(observedEvents.some(title => title.includes('安全状态 REROUTE → DEGRADED')));
    assert.ok(observedEvents.some(title => title.includes('创建') && title.includes('待审批工单')));

    // Agent 创建的工单必须停在待审批，仿真不能替人审批/派发。
    const pending = await server.request('/api/v1/mvp/work-orders?status=PENDING_APPROVAL');
    assert.ok(pending.body.work_orders.length >= 1);
    assert.ok(pending.body.work_orders.every((order: { status: string }) => order.status === 'PENDING_APPROVAL'));

    // 仿真写入的观测必须带合成来源与仿真提供方，不能伪装成真实数据。
    const scenario = await server.request('/api/v1/mvp/scenario');
    const gate = scenario.body.regions.find((region: { id: string }) => region.id === 'R_GATE_04_PLAZA');
    assert.ok(gate);
    const dashboard = await server.request('/api/v1/mvp/dashboard');
    const observation = dashboard.body.safety.observations.find(
      (item: { region_id: string }) => item.region_id === 'R_GATE_04_PLAZA',
    );
    assert.equal(observation.source, 'simulation');
    assert.equal(observation.provider, 'sim-live');
    assert.equal(observation.evidence.synthetic, true);

    // 全局重置必须终止仿真并清空剧本状态。
    const reset = await server.request('/api/v1/mvp/reset', { ...jsonBody({}), headers });
    assert.equal(reset.status, 200);
    const afterReset = await server.request('/api/v1/mvp/simulation');
    assert.equal(afterReset.body.running, false);
    assert.equal(afterReset.body.step_index, 0);
    assert.deepEqual(afterReset.body.events, []);
  } finally {
    await server.close();
  }
});

test('仿真暂停后继续，仍保持人工闭环边界', async () => {
  const server = await startServer();
  try {
    const headers = await adminHeaders(server);
    await server.request('/api/v1/mvp/simulation/start', { ...jsonBody({ autoplay: false }), headers });
    for (let index = 0; index < 7; index += 1) await step(server, headers);

    const paused = await server.request('/api/v1/mvp/simulation/pause', { ...jsonBody({}), headers });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.awaiting_human, true);

    // 未完成人工反馈前继续：系统应保持 DEGRADED，不得自动恢复。
    const resumed = await server.request('/api/v1/mvp/simulation/resume', { ...jsonBody({}), headers });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.state, 'DEGRADED');
    const latest = resumed.body.events[resumed.body.events.length - 1];
    assert.match(String(latest?.title ?? ''), /保留|补采|安全状态/);
    assert.equal(resumed.body.counts.pending_work_orders >= 1, true);

    // 结束仿真不产生审批动作。
    const stopped = await server.request('/api/v1/mvp/simulation/stop', { ...jsonBody({}), headers });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.running, false);
    const orders = await server.request('/api/v1/mvp/work-orders');
    assert.ok(orders.body.work_orders.every((order: { status: string }) =>
      order.status === 'PENDING_APPROVAL'));
  } finally {
    await server.close();
  }
});

test('补采基线只刷新过期的仿真观测，不覆盖低置信与真实来源', async () => {
  const server = await startServer();
  try {
    const headers = await adminHeaders(server);
    await server.request('/api/v1/mvp/simulation/start', { ...jsonBody({ autoplay: false }), headers });
    for (let index = 0; index < 7; index += 1) await step(server, headers);

    // 把所有观测改到 10 分钟前：全部过期，但只有洞庭门是低置信。
    const store = getSafetyService().getObservationStore();
    const state = store.exportState();
    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    for (const [, list] of state.history) {
      for (const observation of list) observation.observed_at = staleAt;
    }
    store.restoreState(state);

    // 真实 provider 的过期观测也不能被合成基线覆盖。
    const realObservedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const injected = await server.request('/api/v1/safety/observations', {
      ...jsonBody({
        region_id: 'R_S01_L1_CREST',
        count: 1700,
        confidence: 0.95,
        source: 'recorded_video',
        provider: 'opencv-mog2',
        model_version: 'opencv-mog2/1.0.0',
        observed_at: realObservedAt,
        recompute: false,
      }),
      headers,
    });
    assert.equal(injected.status, 201, JSON.stringify(injected.body));

    const refreshed = await step(server, headers);
    assert.ok(
      refreshed.events.some((event: { step_id: string }) => event.step_id === 'revalidate'),
      '第 8 步应执行 revalidate',
    );
    const refill = refreshed.events
      .map((event: { title: string }) => event.title)
      .find((title: string) => title.includes('补采'));
    assert.ok(refill, '缺少补采事件');
    // 42 个过期但可信的仿真区域被补采；低置信观测与真实 provider 观测必须保留。
    assert.match(refill, /补采 42 个区域基线；保留 2 个/);

    const gate = store.latest('R_GATE_04_PLAZA');
    assert.equal(gate?.confidence, 0.35);
    assert.equal(gate?.observed_at, staleAt);
    const real = store.latest('R_S01_L1_CREST');
    assert.equal(real?.provider, 'opencv-mog2');
    assert.equal(real?.observed_at, realObservedAt);
    const untouched = store.latest('R_S01_L3_RIVER');
    assert.ok(untouched && untouched.observed_at !== staleAt, '过期区域应被重新写入基线');
    assert.equal(refreshed.state, 'DEGRADED');
  } finally {
    await server.close();
  }
});

test('仿真接口使用真实 JWT 角色而不是请求体自报身份', async () => {
  const server = await startServer();
  try {
    const forged = jwt.sign({ username: 'attacker', role: 'viewer' }, SECRET, { expiresIn: '1h' });
    const response = await server.request('/api/v1/mvp/simulation/start', {
      ...jsonBody({ autoplay: false }),
      headers: { Authorization: `Bearer ${forged}`, 'Content-Type': 'application/json' },
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FORBIDDEN');
  } finally {
    await server.close();
  }
});
