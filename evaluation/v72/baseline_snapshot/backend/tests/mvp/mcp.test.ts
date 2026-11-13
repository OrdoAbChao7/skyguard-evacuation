/**
 * MCP 协议集成测试：用官方 SDK Client 通过 stdio 连接真实 MCP Server。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const STADIUM = path.resolve(BACKEND_ROOT, '../data/scenarios/stadium-evacuation.json');
const TSX_CLI = path.resolve(BACKEND_ROOT, 'node_modules/tsx/dist/cli.mjs');

test('MCP Server 暴露 15 个工具并执行权限校验', { timeout: 60_000 }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-mcp-test-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, path.resolve(BACKEND_ROOT, 'src/mcp/server.ts')],
    cwd: BACKEND_ROOT,
    env: {
      ...(process.env as Record<string, string>),
      DATA_ROOT: dataRoot,
      SAFETY_SCENARIO_FILE: STADIUM,
      MCP_ACTOR_ROLE: 'agent',
      SECRET_KEY: 'mcp-test-secret',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'skyguard-test-client', version: '0.1.0' });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 15);
    const names = tools.tools.map(tool => tool.name).sort();
    for (const required of [
      'get_crowd_status',
      'get_region_trend',
      'get_camera_status',
      'request_supplemental_observation',
      'request_uav_observation',
      'get_venue_information',
      'get_venue_rules',
      'predict_crowd_trend',
      'evaluate_region_risk',
      'recommend_staff',
      'calculate_candidate_plan',
      'validate_candidate_plan',
      'create_candidate_work_order',
      'get_work_order_status',
      'submit_worker_feedback',
    ]) {
      assert.ok(names.includes(required), `missing tool ${required}`);
    }

    const status = await client.callTool({ name: 'get_crowd_status', arguments: {} });
    assert.equal(status.isError, false);
    const statusPayload = JSON.parse((status.content as Array<{ type: string; text: string }>)[0].text);
    assert.equal(statusPayload.ok, true);
    assert.equal(statusPayload.data.regions.length, 8);

    const denied = await client.callTool({
      name: 'submit_worker_feedback',
      arguments: { work_order_id: 'WO-X', note: 'agent 不应能提交' },
    });
    assert.equal(denied.isError, true);
    const deniedPayload = JSON.parse((denied.content as Array<{ type: string; text: string }>)[0].text);
    assert.match(deniedPayload.error, /无权调用/);
    assert.equal(deniedPayload.error_code, 'FORBIDDEN');

    const orderArgs = {
      type: 'scene_verification',
      title: 'MCP 测试工单',
      description: '由 MCP 客户端创建',
      region_id: 'R_EAST_STAND',
      required_skills: ['crowd_check'],
      idempotency_key: 'mcp-idem-001',
    };
    const order = await client.callTool({ name: 'create_candidate_work_order', arguments: orderArgs });
    assert.equal(order.isError, false);
    const orderPayload = JSON.parse((order.content as Array<{ type: string; text: string }>)[0].text);
    assert.equal(orderPayload.data.work_order.status, 'PENDING_APPROVAL');

    // 幂等：同一键重复调用不应产生第二个工单
    const duplicate = await client.callTool({ name: 'create_candidate_work_order', arguments: orderArgs });
    const duplicatePayload = JSON.parse((duplicate.content as Array<{ type: string; text: string }>)[0].text);
    assert.equal(duplicatePayload.data.work_order.id, orderPayload.data.work_order.id);

    // 工具调用回放：同参数重复读取应稳定
    const replayA = await client.callTool({ name: 'get_crowd_status', arguments: { region_id: 'R_EAST_STAND' } });
    const replayB = await client.callTool({ name: 'get_crowd_status', arguments: { region_id: 'R_EAST_STAND' } });
    const payloadA = JSON.parse((replayA.content as Array<{ type: string; text: string }>)[0].text);
    const payloadB = JSON.parse((replayB.content as Array<{ type: string; text: string }>)[0].text);
    assert.deepEqual(payloadA.data.regions[0].region_id, payloadB.data.regions[0].region_id);
  } finally {
    await client.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
