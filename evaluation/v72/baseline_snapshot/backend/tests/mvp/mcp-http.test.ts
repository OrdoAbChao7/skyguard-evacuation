/**
 * HTTP MCP 集成测试（G03）：Streamable HTTP 端点与网页共用一个 MvpService 单例，
 * 通过 MCP 创建工单后，网页侧读接口能看到同一工单。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const STADIUM = path.resolve(BACKEND_ROOT, '../data/scenarios/stadium-evacuation.json');

test('HTTP MCP 与网页共享同一业务状态', { timeout: 30_000 }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-mcp-http-'));
  process.env.DATA_ROOT = dataRoot;
  process.env.SAFETY_SCENARIO_FILE = STADIUM;
  process.env.MCP_ACTOR_ROLE = 'agent';
  process.env.SECRET_KEY = 'mcp-http-test-secret';
  const { app } = await import('../../src/app');
  const { getMvpService } = await import('../../src/services/mvp');
  const server = app.listen(0, '127.0.0.1');
  const client = new Client({ name: 'skyguard-http-test-client', version: '0.1.0' });
  try {
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    await client.connect(transport);

    const tools = await client.listTools();
    assert.ok(tools.tools.length >= 15);

    const orderArgs = {
      type: 'scene_verification',
      title: 'HTTP MCP 共享状态工单',
      description: '通过 /mcp 创建，应从网页服务读到同一工单',
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
      idempotency_key: 'mcp-http-shared-001',
    };
    const order = await client.callTool({ name: 'create_candidate_work_order', arguments: orderArgs });
    assert.equal(order.isError, false);
    const payload = JSON.parse((order.content as Array<{ type: string; text: string }>)[0].text);
    const orderId = payload.data.work_order.id as string;
    assert.match(orderId, /^WO-/);

    // 同一进程内的网页服务单例应看到该工单（而不是 stdio 的另一个进程状态）。
    const webVisible = getMvpService().ops.listWorkOrders({}).find(item => item.id === orderId);
    assert.ok(webVisible);
    assert.equal(webVisible?.status, 'PENDING_APPROVAL');

    // 可选 Bearer token：配置后无令牌请求被拒绝，带令牌请求可进入 MCP 处理。
    process.env.MCP_HTTP_TOKEN = 'mcp-http-secret';
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const denied = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 401);
    const allowed = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer mcp-http-secret' },
      body: '{}',
    });
    assert.notEqual(allowed.status, 401);
    delete process.env.MCP_HTTP_TOKEN;

    await client.close();
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dataRoot, { recursive: true, force: true });
    for (const key of ['DATA_ROOT', 'SAFETY_SCENARIO_FILE', 'MCP_ACTOR_ROLE', 'SECRET_KEY']) delete process.env[key];
  }
});
