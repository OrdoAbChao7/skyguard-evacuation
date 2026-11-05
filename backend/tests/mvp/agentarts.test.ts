import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import {
  AgentArtsClient,
  AgentArtsUnavailableError,
  type AgentArtsConfig,
} from '../../src/services/mvp/agentarts';

async function startStub(handler: (req: { url?: string; method?: string; body: string }, res: any) => void): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => handler({ url: req.url, method: req.method, body }, res));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function config(baseUrl: string, overrides: Partial<AgentArtsConfig> = {}): AgentArtsConfig {
  return {
    runtime: 'agentarts',
    baseUrl,
    apiKey: 'test-key',
    agentId: 'agent-123',
    projectId: 'project-1',
    invokePath: '/v1/agents/{agent_id}/invoke',
    healthPath: '/health',
    timeoutMs: 1000,
    healthRetries: 0,
    ...overrides,
  };
}

test('缺少配置时明确保持 LOCAL_DEMO', () => {
  const client = new AgentArtsClient({
    runtime: 'local',
    baseUrl: null,
    apiKey: null,
    agentId: null,
    projectId: null,
    invokePath: '/v1/agents/{agent_id}/invoke',
    healthPath: '/health',
    timeoutMs: 1000,
    healthRetries: 0,
  });
  const status = client.staticStatus();
  assert.equal(status.mode, 'LOCAL_DEMO');
  assert.equal(status.configured, false);
  assert.ok(status.missing_config.includes('AGENTARTS_BASE_URL'));
});

test('健康探测成功才标记 AGENTARTS_CONNECTED', async () => {
  const stub = await startStub((req, res) => {
    assert.equal(req.url, '/health');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
  });
  try {
    const client = new AgentArtsClient(config(stub.baseUrl));
    const status = await client.healthCheck();
    assert.equal(status.mode, 'AGENTARTS_CONNECTED');
    assert.equal(status.http_status, 200);
  } finally {
    stub.server.close();
  }
});

test('健康探测失败不会伪装为已连接', async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(503);
    res.end('unavailable');
  });
  try {
    const client = new AgentArtsClient(config(stub.baseUrl));
    const status = await client.healthCheck();
    assert.equal(status.mode, 'AGENTARTS_UNAVAILABLE');
    assert.equal(status.http_status, 503);
  } finally {
    stub.server.close();
  }
});

test('工具决策契约：接受 decision 包裹与扁平结构', async () => {
  let calls = 0;
  const stub = await startStub((_req, res) => {
    calls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(calls === 1
      ? { decision: { tool: 'get_crowd_status', arguments: { region_id: 'R_EAST_STAND' }, reasoning: '需要态势' } }
      : { tool: 'predict_crowd_trend', arguments: { region_id: 'R_EAST_STAND' } }));
  });
  try {
    const client = new AgentArtsClient(config(stub.baseUrl));
    const first = await client.select({
      regionId: 'R_EAST_STAND',
      trigger: 'test',
      context: {},
      tools: [{ name: 'get_crowd_status', description: '', roles: ['agent'] }],
    });
    assert.equal(first.tool, 'get_crowd_status');
    assert.deepEqual(first.arguments, { region_id: 'R_EAST_STAND' });
    assert.equal(first.reasoning, '需要态势');

    const second = await client.select({ regionId: 'R_EAST_STAND', trigger: 'test', context: {}, tools: [] });
    assert.equal(second.tool, 'predict_crowd_trend');
  } finally {
    stub.server.close();
  }
});

test('HTTP 错误、非 JSON 与超时都显式失败', async () => {
  const httpError = await startStub((_req, res) => {
    res.writeHead(401);
    res.end('unauthorized');
  });
  try {
    const client = new AgentArtsClient(config(httpError.baseUrl));
    await assert.rejects(
      () => client.select({ regionId: 'R', trigger: 't', context: {}, tools: [] }),
      AgentArtsUnavailableError,
    );
  } finally {
    httpError.server.close();
  }

  const badJson = await startStub((_req, res) => {
    res.writeHead(200);
    res.end('not-json');
  });
  try {
    const client = new AgentArtsClient(config(badJson.baseUrl));
    await assert.rejects(
      () => client.select({ regionId: 'R', trigger: 't', context: {}, tools: [] }),
      /不是 JSON/,
    );
  } finally {
    badJson.server.close();
  }

  const slow = await startStub((_req, res) => {
    setTimeout(() => {
      res.writeHead(200);
      res.end(JSON.stringify({ tool: 'get_crowd_status', arguments: {} }));
    }, 200);
  });
  try {
    const client = new AgentArtsClient(config(slow.baseUrl, { timeoutMs: 50 }));
    await assert.rejects(
      () => client.select({ regionId: 'R', trigger: 't', context: {}, tools: [] }),
      /aborted|timeout|Abort/i,
    );
  } finally {
    slow.server.close();
  }
});
