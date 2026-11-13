import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { jsonBody, startTestServer, type TestServer } from '../helpers/api-fixtures';
import { resetSafetyServiceForTests } from '../../src/services/safety';
import { resetMvpServiceForTests } from '../../src/services/mvp';
import { SECRET } from '../../src/api/v1/auth';

const REPO_SCENARIO = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

async function startServer(): Promise<TestServer> {
  resetSafetyServiceForTests();
  resetMvpServiceForTests();
  const server = await startTestServer();
  const scenarioDir = path.join(server.dataRoot, 'scenarios');
  fs.mkdirSync(scenarioDir, { recursive: true });
  fs.copyFileSync(REPO_SCENARIO, path.join(scenarioDir, 'stadium-evacuation.json'));
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

async function seedObservations(server: TestServer, headers: Record<string, string>) {
  const scenario = (await server.request('/api/v1/safety/scenario')).body;
  const now = Date.now();
  for (const region of scenario.regions) {
    if (!region.enabled) continue;
    const points = region.id === 'R_NORTH_STAND' ? 6 : 1;
    for (let index = 0; index < points; index += 1) {
      const observedAt = new Date(now - (points - 1 - index) * 60_000).toISOString();
      const response = await server.request('/api/v1/safety/observations', {
        ...jsonBody({
          region_id: region.id,
          count: 300 + index * 4,
          confidence: 0.95,
          source: 'simulation',
          observed_at: observedAt,
          recompute: false,
        }),
        headers,
      });
      assert.equal(response.status, 201, `写入观测失败：${JSON.stringify(response.body)}`);
    }
  }
  const recompute = await server.request('/api/v1/safety/plan/recompute', { ...jsonBody({}), headers });
  assert.equal(recompute.status, 200);
}

test('V7 预测/联合 VoI/MPC/拥堵预览只读可用', async () => {
  const server = await startServer();
  try {
    const headers = await adminHeaders(server);
    await seedObservations(server, headers);

    const forecast = await server.request('/api/v1/mvp/v70/forecast/R_NORTH_STAND?horizon_minutes=5');
    assert.equal(forecast.status, 200);
    assert.equal(forecast.body.available, true, JSON.stringify(forecast.body));
    assert.ok(forecast.body.result.interval95.lower <= forecast.body.result.interval95.upper);
    assert.ok(['ok', 'warning', 'failed'].includes(forecast.body.result.reliability.status));

    const joint = await server.request('/api/v1/mvp/v70/joint-investigation?region_id=R_NORTH_STAND');
    assert.equal(joint.status, 200);
    assert.equal(joint.body.available, true, JSON.stringify(joint.body));
    assert.ok(joint.body.decision.selected.length <= joint.body.decision.config.max_sequence);
    assert.equal(joint.body.decision.config.source, 'scenario');

    const mpc = await server.request('/api/v1/safety/v70/mpc-preview?use_forecast=0&queue_feedback=0');
    assert.equal(mpc.status, 200);
    assert.equal(mpc.body.available, true, JSON.stringify(mpc.body));
    assert.ok(mpc.body.steps.length >= 1);
    assert.equal(mpc.body.steps[0].validation.performed, true);
    assert.equal(mpc.body.steps[0].validation.valid, true, JSON.stringify(mpc.body.steps[0].validation));
    assert.ok(mpc.body.projection.completed_persons + mpc.body.projection.unserved_persons === mpc.body.projection.total_input_persons);

    const congestion = await server.request('/api/v1/safety/v70/congestion-preview');
    assert.equal(congestion.status, 200);
    assert.equal(congestion.body.available, true, JSON.stringify(congestion.body));
    assert.ok(congestion.body.metrics.total_persons > 0);

    // 只读：预览不改变安全状态版本或审计记录数量。
    const before = await server.request('/api/v1/safety/status');
    await server.request('/api/v1/mvp/v70/joint-investigation?region_id=R_NORTH_STAND');
    await server.request('/api/v1/safety/v70/mpc-preview?use_forecast=0');
    const after = await server.request('/api/v1/safety/status');
    assert.deepEqual(after.body.versions, before.body.versions);
    assert.equal(after.body.audit, undefined);
  } finally {
    await server.close();
    resetSafetyServiceForTests();
    resetMvpServiceForTests();
  }
});

test('观测不可信时 MPC 预览 fail closed，预测不回退伪造', async () => {
  const server = await startServer();
  try {
    const headers = await adminHeaders(server);
    await seedObservations(server, headers);
    const scenario = (await server.request('/api/v1/safety/scenario')).body;
    const target = scenario.regions.find((region: any) => region.enabled && region.id !== 'R_NORTH_STAND');
    const invalid = await server.request('/api/v1/safety/observations', {
      ...jsonBody({
        region_id: target.id,
        count: 0,
        confidence: 0,
        source: 'simulation',
        valid: false,
        invalid_reason: '测试：传感器不可信',
        recompute: false,
      }),
      headers,
    });
    assert.equal(invalid.status, 201);

    const mpc = await server.request('/api/v1/safety/v70/mpc-preview');
    assert.equal(mpc.status, 200);
    assert.equal(mpc.body.available, false);
    assert.match(mpc.body.reason, /观测不可信/);

    const forecast = await server.request(`/api/v1/mvp/v70/forecast/${target.id}`);
    assert.equal(forecast.status, 200);
    assert.equal(forecast.body.available, false);
  } finally {
    await server.close();
    resetSafetyServiceForTests();
    resetMvpServiceForTests();
  }
});

test('V7 预览接口拒绝未知区域且不需要写权限', async () => {
  const server = await startServer();
  try {
    const viewer = jwt.sign({ username: 'viewer-v70', role: 'viewer' }, SECRET, { expiresIn: '1h' });
    const unknownForecast = await server.request('/api/v1/mvp/v70/forecast/NOT_A_REGION', {
      headers: { Authorization: `Bearer ${viewer}` },
    });
    assert.equal(unknownForecast.status, 200);
    assert.equal(unknownForecast.body.available, false);

    const missingRegion = await server.request('/api/v1/mvp/v70/joint-investigation');
    assert.equal(missingRegion.status, 400);
    assert.equal(missingRegion.body.error.code, 'INVALID_INPUT');

    const congestion = await server.request('/api/v1/safety/v70/congestion-preview');
    assert.equal(congestion.status, 200);
    assert.equal(congestion.body.available, false);

    // 参数上限：异常大的 horizon / max_steps 必须被钳制，不能造成无界计算。
    const hugeForecast = await server.request('/api/v1/mvp/v70/forecast/NOT_A_REGION?horizon_minutes=100000');
    assert.equal(hugeForecast.status, 200);
    assert.ok(hugeForecast.body.horizon_minutes <= 30);
    const hugeMpc = await server.request('/api/v1/safety/v70/mpc-preview?max_steps=100000&planning_horizon=100000');
    assert.equal(hugeMpc.status, 200);
    assert.ok((hugeMpc.body.steps?.length ?? 0) <= 40);
  } finally {
    await server.close();
    resetSafetyServiceForTests();
    resetMvpServiceForTests();
  }
});


test('Shadow Mode API 只读返回比较记录，且不发布 V7 方案', async () => {
  const server = await startServer();
  const previous = process.env.V7_SHADOW_MODE;
  try {
    process.env.V7_SHADOW_MODE = '1';
    process.env.V7_SHADOW_MAX_SOLVE_MS = '500';
    const headers = await adminHeaders(server);
    await seedObservations(server, headers);
    const shadow = await server.request('/api/v1/safety/v70/shadow');
    assert.equal(shadow.status, 200);
    assert.equal(shadow.body.enabled, true);
    assert.equal(shadow.body.comparisons.length, 1);
    assert.equal(shadow.body.comparisons[0].snapshot.hash.length, 64);
    const plan = await server.request('/api/v1/safety/plan');
    assert.equal(plan.status, 200);
    assert.equal(plan.body.plan.plan_id, shadow.body.comparisons[0].legacy.plan_id);
    assert.notEqual(plan.body.plan.plan_id, shadow.body.comparisons[0].v7?.plan_id ?? 'none');
  } finally {
    if (previous === undefined) delete process.env.V7_SHADOW_MODE;
    else process.env.V7_SHADOW_MODE = previous;
    delete process.env.V7_SHADOW_MAX_SOLVE_MS;
    await server.close();
    resetSafetyServiceForTests();
    resetMvpServiceForTests();
  }
});
