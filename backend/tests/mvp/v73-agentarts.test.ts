import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AgentArtsClient, type AgentArtsConfig } from '../../src/services/mvp/agentarts';

async function withStub(handler: (requestCount: number, req: import('node:http').IncomingMessage) => { status: number; body: string }) {
  let requests = 0;
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const server = createServer((req, res) => {
    requests += 1;
    headers.push(req.headers);
    const result = handler(requests, req);
    res.writeHead(result.status, { 'Content-Type': result.status === 200 ? 'text/event-stream' : 'application/json' });
    res.end(result.body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    headers,
    get requests() { return requests; },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function config(baseUrl: string, retries = 1): AgentArtsConfig {
  return {
    runtime: 'agentarts',
    baseUrl,
    apiKey: 'stub-key',
    agentId: 'agent-stub',
    projectId: null,
    contract: 'official',
    runtimeName: 'agent-stub',
    invokeMode: 'published',
    sessionHeader: 'x-hw-agentarts-session-id',
    idempotencyHeader: 'x-idempotency-key',
    invokePath: '/runtimes/{runtime_name}/invocations',
    healthPath: '/health',
    timeoutMs: 3000,
    healthRetries: 0,
    invokeRetries: retries,
    retryBaseMs: 10,
  };
}

function decisionBody(): string {
  const decision = JSON.stringify({ tool: 'camera_query', arguments: { region_id: 'R_NORTH_STAND' }, reasoning: 'stub' });
  return `data: ${JSON.stringify({ event: 'message', data: { text: decision } })}\n\n`;
}

const selectInput = (traceId: string) => ({
  regionId: 'R_NORTH_STAND',
  trigger: 'v73:test',
  traceId,
  sessionId: 'session-v73',
  query: '选择调查工具',
  context: {},
  tools: [{ name: 'camera_query', description: 'camera', roles: ['admin'] }],
});

test('AgentArts 重试复用同一幂等键；不同 trace 使用不同键', async () => {
  const stub = await withStub(requestCount => (requestCount === 1
    ? { status: 500, body: '{"error":"transient"}' }
    : { status: 200, body: decisionBody() }));
  try {
    const client = new AgentArtsClient(config(stub.baseUrl, 1));
    const decision = await client.select(selectInput('trace-a'));
    assert.equal(decision.tool, 'camera_query');
    assert.equal(stub.requests, 2);
    const keys = stub.headers.map(header => header['x-idempotency-key']);
    assert.equal(keys[0], keys[1], 'retry must reuse the same idempotency key');
    assert.ok(typeof keys[0] === 'string' && keys[0].length > 10);

    const second = await client.select(selectInput('trace-b'));
    assert.equal(second.tool, 'camera_query');
    const keyB = stub.headers[2]['x-idempotency-key'];
    assert.notEqual(keyB, keys[0], 'different trace should use a different idempotency key');
  } finally {
    await stub.close();
  }
});

test('显式幂等键被透传', async () => {
  const stub = await withStub(() => ({ status: 200, body: decisionBody() }));
  try {
    const client = new AgentArtsClient(config(stub.baseUrl, 0));
    await client.select({ ...selectInput('trace-c'), idempotencyKey: 'fixed-key-v73' });
    assert.equal(stub.headers[0]['x-idempotency-key'], 'fixed-key-v73');
  } finally {
    await stub.close();
  }
});

test('重试耗尽后显式失败，后续调用可恢复', async () => {
  let fail = true;
  const stub = await withStub(() => (fail
    ? { status: 503, body: '{"error":"unavailable"}' }
    : { status: 200, body: decisionBody() }));
  try {
    const client = new AgentArtsClient(config(stub.baseUrl, 0));
    await assert.rejects(() => client.select(selectInput('trace-fail')), /AgentArts 调用失败/);
    fail = false;
    const decision = await client.select(selectInput('trace-recover'));
    assert.equal(decision.tool, 'camera_query');
  } finally {
    await stub.close();
  }
});

test('V7.4 trace 关联头随请求发送', async () => {
  const stub = await withStub(() => ({ status: 200, body: decisionBody() }));
  try {
    const client = new AgentArtsClient(config(stub.baseUrl, 0));
    await client.select({ ...selectInput('trace-v74'), idempotencyKey: 'trace-v74-key' });
    assert.equal(stub.headers[0]['x-skyguard-trace-id'], 'trace-v74');
  } finally {
    await stub.close();
  }
});
