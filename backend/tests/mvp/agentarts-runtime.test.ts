/**
 * AgentArts 运行时接线的集成测试：用本地 HTTP stub 模拟平台，
 * 验证 MvpService 只在健康探测成功后才进入 AGENTARTS_CONNECTED，并执行平台返回的工具。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { makeMvpFixture } from './fixtures';
import { MvpService } from '../../src/services/mvp';

async function withStub(
  healthStatus: number,
  decisionTool: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(healthStatus, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.url?.includes('/invoke')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        decision: {
          tool: decisionTool,
          arguments: { region_id: 'R_EAST_STAND' },
          reasoning: 'stub 平台决策',
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function setAgentArtsEnv(baseUrl: string): void {
  process.env.AGENT_RUNTIME = 'agentarts';
  process.env.AGENTARTS_BASE_URL = baseUrl;
  process.env.AGENTARTS_API_KEY = 'test-key';
  process.env.AGENTARTS_AGENT_ID = 'agent-123';
  process.env.AGENTARTS_HEALTH_PATH = '/health';
  process.env.AGENTARTS_INVOKE_PATH = '/v1/agents/{agent_id}/invoke';
}

function clearAgentArtsEnv(): void {
  for (const key of [
    'AGENTARTS_BASE_URL', 'AGENTARTS_API_KEY', 'AGENTARTS_AGENT_ID',
    'AGENTARTS_PROJECT_ID', 'AGENTARTS_HEALTH_PATH', 'AGENTARTS_INVOKE_PATH',
    'AGENTARTS_TIMEOUT_MS', 'AGENT_RUNTIME',
  ]) delete process.env[key];
}

test('健康探测成功后 AgentArts 模式执行平台选择的工具', async () => {
  const stub = await withStub(200, 'get_crowd_status');
  const fixture = makeMvpFixture();
  try {
    setAgentArtsEnv(stub.baseUrl);
    const mvp = new MvpService({ scenario: fixture.scenario, safety: fixture.safety, audit: fixture.audit });
    const run = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'agentarts_test', runtime: 'agentarts' });
    assert.equal(run.mode, 'AGENTARTS_CONNECTED');
    assert.equal(run.status, 'completed');
    assert.equal(run.trace[0]?.tool, 'get_crowd_status');
    assert.match(run.runtime_detail, /AgentArts/);
  } finally {
    clearAgentArtsEnv();
    await stub.close();
    fixture.cleanup();
  }
});

test('健康探测失败时明确失败，不回退伪装为已连接', async () => {
  const stub = await withStub(503, 'get_crowd_status');
  const fixture = makeMvpFixture();
  try {
    setAgentArtsEnv(stub.baseUrl);
    const mvp = new MvpService({ scenario: fixture.scenario, safety: fixture.safety, audit: fixture.audit });
    const run = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'agentarts_test', runtime: 'agentarts' });
    assert.equal(run.mode, 'AGENTARTS_UNAVAILABLE');
    assert.equal(run.status, 'failed');
    assert.equal(run.trace.length, 0);
    assert.match(run.summary, /AgentArts 不可用/);
  } finally {
    clearAgentArtsEnv();
    await stub.close();
    fixture.cleanup();
  }
});
