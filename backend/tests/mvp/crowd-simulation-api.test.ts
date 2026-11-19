/**
 * 算法人群仿真 HTTP API 测试。
 *
 * 重点：
 *  - 只有 admin / safety_operator 可以运行；
 *  - 生成的是 simulation 观测，写入后仍由安全内核重新规划与校验；
 *  - 参数非法明确拒绝，不静默使用默认值；
 *  - 不返回任何“真实数据/实机已验证”的暗示。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { SECRET } from '../../src/api/v1/auth';
import { jsonBody, startTestServer } from '../helpers/api-fixtures';

test('HTTP API：管理员可运行算法仿真并写入合成观测', async () => {
  const server = await startTestServer();
  try {
    const adminToken = jwt.sign({ username: 'test-admin', role: 'admin' }, SECRET, { expiresIn: '1h' });
    const operatorToken = jwt.sign({ username: 'test-ops', role: 'safety_operator' }, SECRET, { expiresIn: '1h' });
    const staffToken = jwt.sign(
      { username: 'test-staff', role: 'staff', staff_id: 'STAFF_GATE_04' },
      SECRET,
      { expiresIn: '1h' },
    );
    const agentToken = jwt.sign({ username: 'skyguard-agent', role: 'agent' }, SECRET, { expiresIn: '1h' });
    const adminHeaders = { Authorization: `Bearer ${adminToken}` };
    const operatorHeaders = { Authorization: `Bearer ${operatorToken}` };
    const staffHeaders = { Authorization: `Bearer ${staffToken}` };
    const agentHeaders = { Authorization: `Bearer ${agentToken}` };

    const run = await server.request('/api/v1/mvp/simulation/crowd-flow', {
      ...jsonBody({ minutes: 3, seed: 1, preset: 'normal' }),
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    assert.equal(run.body.summary.algorithm, 'crowd-flow-v1');
    assert.equal(run.body.summary.minutes, 3);
    assert.equal(run.body.summary.conservation_ok, true);
    assert.equal(run.body.summary.initial_total, 18000);
    assert.equal(run.body.observations_ingested, 3 * 44);
    assert.equal(run.body.latest_regions.length, 44);
    assert.ok(['NORMAL', 'REROUTE', 'DEGRADED', 'REJECT'].includes(run.body.state));
    assert.equal(run.body.timeline.length, 3);
    assert.ok(!JSON.stringify(run.body).includes('real_hardware_verified'));

    const byOperator = await server.request('/api/v1/mvp/simulation/crowd-flow', {
      ...jsonBody({ minutes: 2, seed: 2, ingest: false }),
      headers: { ...operatorHeaders, 'Content-Type': 'application/json' },
    });
    assert.equal(byOperator.status, 201, JSON.stringify(byOperator.body));
    assert.equal(byOperator.body.observations_ingested, 0);

    for (const [label, headers] of [['staff', staffHeaders], ['agent', agentHeaders]] as const) {
      const denied = await server.request('/api/v1/mvp/simulation/crowd-flow', {
        ...jsonBody({ minutes: 2 }),
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
      assert.equal(denied.status, 403, `${label} 不应被允许：${JSON.stringify(denied.body)}`);
    }

    const invalid = await server.request('/api/v1/mvp/simulation/crowd-flow', {
      ...jsonBody({ minutes: 0 }),
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));

    const unknownPreset = await server.request('/api/v1/mvp/simulation/crowd-flow', {
      ...jsonBody({ preset: 'real_flight' }),
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    });
    assert.equal(unknownPreset.status, 400, JSON.stringify(unknownPreset.body));
  } finally {
    await server.close();
  }
});
