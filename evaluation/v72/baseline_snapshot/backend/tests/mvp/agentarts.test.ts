import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import {
  AgentArtsClient,
  AgentArtsUnavailableError,
  type AgentArtsConfig,
} from '../../src/services/mvp/agentarts';

async function startStub(handler: (req: { url?: string; method?: string; body: string; headers: Record<string, string | string[] | undefined> }, res: any) => void): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => handler({ url: req.url, method: req.method, body, headers: req.headers as Record<string, string | string[] | undefined> }, res));
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
    contract: 'template',
    runtimeName: 'agent-123',
    invokeMode: null,
    sessionHeader: 'x-hw-agentarts-session-id',
    invokePath: '/v1/agents/{agent_id}/invoke',
    healthPath: '/health',
    timeoutMs: 1000,
    healthRetries: 0,
    invokeRetries: 0,
    retryBaseMs: 10,
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
    contract: 'template',
    runtimeName: '',
    invokeMode: null,
    sessionHeader: 'x-hw-agentarts-session-id',
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

test('健康探测成功只证明可达，不升级业务闭环状态', async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
  });
  try {
    const client = new AgentArtsClient(config(stub.baseUrl));
    const status = await client.healthCheck();
    assert.equal(status.connectivity, 'reachable');
    assert.equal(status.mode, 'AGENTARTS_CONNECTED');
    assert.equal(status.business_closure.verified, false);
    assert.equal(status.business_closure.verified_at, null);
    assert.match(status.business_closure.note, /未验证/);
  } finally {
    stub.server.close();
  }
});

test('本地模式/缺配置时可达性状态明确区分', () => {
  const local = new AgentArtsClient({
    runtime: 'local', baseUrl: null, apiKey: null, agentId: null, projectId: null,
    contract: 'template', runtimeName: '', invokeMode: null, sessionHeader: 'x-hw-agentarts-session-id',
    invokePath: '/v1/agents/{agent_id}/invoke', healthPath: '/health', timeoutMs: 1000, healthRetries: 0,
    invokeRetries: 0, retryBaseMs: 10,
  });
  assert.equal(local.status().connectivity, 'not_requested');

  const misconfigured = new AgentArtsClient({
    runtime: 'agentarts', baseUrl: 'http://127.0.0.1:9', apiKey: null, agentId: null, projectId: null,
    contract: 'official', runtimeName: '', invokeMode: null, sessionHeader: 'x-hw-agentarts-session-id',
    invokePath: '/runtimes/{runtime_name}/invocations', healthPath: '/health', timeoutMs: 100, healthRetries: 0,
    invokeRetries: 0, retryBaseMs: 10,
  });
  assert.equal(misconfigured.status().connectivity, 'misconfigured');
});

test('成功调用记录最近成功时间，但不改变业务闭环结论', async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tool: 'get_crowd_status', arguments: {} }));
  });
  try {
    const client = new AgentArtsClient(config(stub.baseUrl));
    assert.equal(client.status().last_successful_call_at, null);
    await client.select({ regionId: 'R', trigger: 't', context: {}, tools: [] });
    const status = client.status();
    assert.ok(status.last_successful_call_at);
    assert.equal(status.business_closure.verified, false);
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
      /JSON/,
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

test('官方运行时契约：路径、会话头、query/inputs 与 data.text 决策解析', async () => {
  const stub = await startStub((req, res) => {
    assert.equal(req.url, '/runtimes/rt-42/invocations');
    assert.equal(req.headers['authorization'], 'Bearer test-key');
    assert.ok(req.headers['x-hw-agentarts-session-id']);
    const body = JSON.parse(req.body);
    assert.ok(typeof body.query === 'string' && body.query.length > 0);
    assert.equal(body.inputs.region_id, 'R_EAST_STAND');
    assert.equal(body.inputs.scenario_id, 'stadium-evacuation-v1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      event: 'message',
      data: {
        text: JSON.stringify({
          tool: 'get_crowd_status',
          arguments: { region_id: 'R_EAST_STAND' },
          reasoning: '官方契约测试',
        }),
        node_id: 'node_end',
        node_type: 'End',
      },
      createdTime: Date.now(),
    }));
  });
  try {
    const client = new AgentArtsClient(config(stub.baseUrl, {
      contract: 'official',
      runtimeName: 'rt-42',
      invokePath: '/runtimes/{runtime_name}/invocations',
    }));
    const decision = await client.select({
      scenarioId: 'stadium-evacuation-v1',
      regionId: 'R_EAST_STAND',
      trigger: 'contract_test',
      traceId: 'RUN-CONTRACT-1',
      context: {},
      tools: [],
    });
    assert.equal(decision.tool, 'get_crowd_status');
    assert.deepEqual(decision.arguments, { region_id: 'R_EAST_STAND' });
  } finally {
    stub.server.close();
  }
});

test('官方运行时只返回文本时成功调用但不伪造工具决策', async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      event: 'message',
      data: { text: '当前没有需要执行的工具，建议人工确认。' },
      createdTime: Date.now(),
    }));
  });
  try {
    const client = new AgentArtsClient(config(stub.baseUrl, {
      contract: 'official',
      runtimeName: 'rt-42',
      invokePath: '/runtimes/{runtime_name}/invocations',
    }));
    const decision = await client.select({
      scenarioId: 's', regionId: 'R', trigger: 't', traceId: 'RUN-TEXT-1', context: {}, tools: [],
    });
    assert.equal(decision.tool, '');
    assert.match(decision.text ?? '', /人工确认/);
    assert.ok(client.status().last_successful_call_at);
  } finally {
    stub.server.close();
  }
});

test('5xx 与超时按有界重试恢复；4xx 不重试', async () => {
  let flakyCalls = 0;
  const flaky = await startStub((_req, res) => {
    flakyCalls += 1;
    if (flakyCalls === 1) {
      res.writeHead(503);
      res.end('busy');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tool: 'get_crowd_status', arguments: {} }));
  });
  try {
    const client = new AgentArtsClient(config(flaky.baseUrl, { invokeRetries: 2, retryBaseMs: 10 }));
    const decision = await client.select({ regionId: 'R', trigger: 't', traceId: 'RUN-RETRY', context: {}, tools: [] });
    assert.equal(decision.tool, 'get_crowd_status');
    assert.equal(flakyCalls, 2);
  } finally {
    flaky.server.close();
  }

  let timeoutCalls = 0;
  const slowThenFast = await startStub((_req, res) => {
    timeoutCalls += 1;
    if (timeoutCalls === 1) {
      setTimeout(() => {
        res.writeHead(200);
        res.end(JSON.stringify({ tool: 'get_crowd_status', arguments: {} }));
      }, 120);
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ tool: 'get_crowd_status', arguments: {} }));
  });
  try {
    const client = new AgentArtsClient(config(slowThenFast.baseUrl, {
      timeoutMs: 30, invokeRetries: 1, retryBaseMs: 10,
    }));
    const decision = await client.select({ regionId: 'R', trigger: 't', traceId: 'RUN-TIMEOUT', context: {}, tools: [] });
    assert.equal(decision.tool, 'get_crowd_status');
    assert.ok(timeoutCalls >= 2);
  } finally {
    slowThenFast.server.close();
  }

  let unauthorizedCalls = 0;
  const unauthorized = await startStub((_req, res) => {
    unauthorizedCalls += 1;
    res.writeHead(401);
    res.end('unauthorized');
  });
  try {
    const client = new AgentArtsClient(config(unauthorized.baseUrl, { invokeRetries: 2, retryBaseMs: 10 }));
    await assert.rejects(() => client.select({ regionId: 'R', trigger: 't', traceId: 'RUN-401', context: {}, tools: [] }));
    assert.equal(unauthorizedCalls, 1);
  } finally {
    unauthorized.server.close();
  }
});

test('SSE 响应可解析；截断的 SSE 显式失败', async () => {
  const sse = await startStub((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end([
      'event: message',
      `data: ${JSON.stringify({ event: 'message', data: { text: JSON.stringify({ tool: 'get_crowd_status', arguments: {} }) } })}`,
      '',
      '',
    ].join('\n'));
  });
  try {
    const client = new AgentArtsClient(config(sse.baseUrl, {
      contract: 'official', runtimeName: 'rt-42', invokePath: '/runtimes/{runtime_name}/invocations',
    }));
    const decision = await client.select({
      scenarioId: 's', regionId: 'R', trigger: 't', traceId: 'RUN-SSE', context: {}, tools: [],
    });
    assert.equal(decision.tool, 'get_crowd_status');
  } finally {
    sse.server.close();
  }

  const truncated = await startStub((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"event":"message","data":{"text":');
  });
  try {
    const client = new AgentArtsClient(config(truncated.baseUrl, {
      contract: 'official', runtimeName: 'rt-42', invokePath: '/runtimes/{runtime_name}/invocations',
    }));
    await assert.rejects(
      () => client.select({ scenarioId: 's', regionId: 'R', trigger: 't', traceId: 'RUN-SSE-BAD', context: {}, tools: [] }),
      /SSE|JSON/,
    );
  } finally {
    truncated.server.close();
  }
});

test('同一次运行的所有步骤共用会话头，步骤 trace_id 不同', async () => {
  const headers: string[] = [];
  const traces: string[] = [];
  const stub = await startStub((req, res) => {
    headers.push(String(req.headers['x-hw-agentarts-session-id'] ?? ''));
    const body = JSON.parse(req.body);
    traces.push(String(body.inputs.trace_id));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tool: 'get_crowd_status', arguments: {} }));
  });
  try {
    const client = new AgentArtsClient(config(stub.baseUrl, {
      contract: 'official', runtimeName: 'rt-42', invokePath: '/runtimes/{runtime_name}/invocations',
    }));
    await client.select({ scenarioId: 's', regionId: 'R', trigger: 't', traceId: 'RUN-TRACE-S1', sessionId: 'SESSION-X', context: {}, tools: [] });
    await client.select({ scenarioId: 's', regionId: 'R', trigger: 't', traceId: 'RUN-TRACE-S2', sessionId: 'SESSION-X', context: {}, tools: [] });
    assert.deepEqual(headers, ['SESSION-X', 'SESSION-X']);
    assert.deepEqual(traces, ['RUN-TRACE-S1', 'RUN-TRACE-S2']);
  } finally {
    stub.server.close();
  }
});
