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
  process.env.AGENTARTS_RUNTIME_NAME = 'agent-123';
  process.env.AGENTARTS_CONTRACT = 'template';
  process.env.AGENTARTS_HEALTH_PATH = '/health';
  process.env.AGENTARTS_INVOKE_PATH = '/v1/agents/{agent_id}/invoke';
}

function clearAgentArtsEnv(): void {
  for (const key of [
    'AGENTARTS_BASE_URL', 'AGENTARTS_API_KEY', 'AGENTARTS_AGENT_ID',
    'AGENTARTS_PROJECT_ID', 'AGENTARTS_HEALTH_PATH', 'AGENTARTS_INVOKE_PATH',
    'AGENTARTS_TIMEOUT_MS', 'AGENT_RUNTIME', 'AGENTARTS_CONTRACT',
    'AGENTARTS_RUNTIME_NAME', 'AGENTARTS_INVOKE_MODE', 'AGENTARTS_SESSION_HEADER',
    'AGENTARTS_MAX_STEPS', 'AGENTARTS_AUTO_CONTINUE',
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

interface CapturedCall {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

async function withSequenceStub(decisions: Array<Record<string, unknown>>): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  calls: () => number;
  requests: CapturedCall[];
}> {
  let invokeCalls = 0;
  const requests: CapturedCall[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      if (req.url?.includes('/invoke')) {
        let body: any = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        requests.push({ url: req.url, headers: req.headers, body });
        const decision = decisions[Math.min(invokeCalls, decisions.length - 1)];
        invokeCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
    calls: () => invokeCalls,
    requests,
  };
}

test('平台连续选择工具时有界多步执行，创建工单后等待人工审批', async () => {
  const stub = await withSequenceStub([
    { tool: 'get_crowd_status', arguments: { region_id: 'R_EAST_STAND' }, reasoning: '先读取态势' },
    {
      tool: 'create_candidate_work_order',
      arguments: {
        type: 'scene_verification',
        title: '平台连续决策创建的核查工单',
        description: 'AgentArts 多步决策测试',
        region_id: 'R_EAST_STAND',
        required_skills: ['crowd_check'],
      },
      reasoning: '需要现场核查',
    },
    { tool: 'get_crowd_status', arguments: { region_id: 'R_EAST_STAND' }, reasoning: '不应执行到第三步' },
  ]);
  const fixture = makeMvpFixture();
  try {
    setAgentArtsEnv(stub.baseUrl);
    const mvp = new MvpService({ scenario: fixture.scenario, safety: fixture.safety, audit: fixture.audit });
    const run = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'agentarts_multistep', runtime: 'agentarts' });
    assert.equal(run.status, 'awaiting_approval');
    assert.equal(run.trace.length, 2);
    assert.equal(run.trace[0].tool, 'get_crowd_status');
    assert.equal(run.trace[1].tool, 'create_candidate_work_order');
    assert.match(String(run.trace[1].args.idempotency_key ?? ''), /^agentarts:RUN-/);
    assert.equal(run.investigation.pending_work_order_ids.length, 1);
    assert.equal(run.investigation.stopped_reason, 'awaiting_human_approval');
    assert.equal(stub.calls(), 2);
    const orderId = run.investigation.pending_work_order_ids[0];
    assert.ok(fixture.mvp.ops.getWorkOrder(orderId) || mvp.ops.getWorkOrder(orderId));
  } finally {
    clearAgentArtsEnv();
    await stub.close();
    fixture.cleanup();
  }
});

test('平台重复返回同一调用且上下文未变时停止循环', async () => {
  const stub = await withSequenceStub([
    { tool: 'get_crowd_status', arguments: { region_id: 'R_EAST_STAND' }, reasoning: '重复调用' },
  ]);
  const fixture = makeMvpFixture();
  try {
    setAgentArtsEnv(stub.baseUrl);
    const mvp = new MvpService({ scenario: fixture.scenario, safety: fixture.safety, audit: fixture.audit });
    const run = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'agentarts_repeat', runtime: 'agentarts' });
    assert.equal(run.trace.length, 1);
    assert.equal(run.investigation.stopped_reason, 'no_progress_repeated_call');
    assert.equal(stub.calls(), 2);
  } finally {
    clearAgentArtsEnv();
    await stub.close();
    fixture.cleanup();
  }
});

test('平台越权工具被本地权限阻断，且不产生反馈副作用', async () => {
  const stub = await withSequenceStub([
    {
      tool: 'submit_worker_feedback',
      arguments: { work_order_id: 'WO-X', note: '平台不应直接提交反馈' },
      reasoning: '越权测试',
    },
  ]);
  const fixture = makeMvpFixture();
  try {
    setAgentArtsEnv(stub.baseUrl);
    const mvp = new MvpService({ scenario: fixture.scenario, safety: fixture.safety, audit: fixture.audit });
    const run = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'agentarts_forbidden', runtime: 'agentarts' });
    assert.equal(run.status, 'failed');
    assert.equal(run.trace.length, 1);
    assert.equal(run.trace[0].ok, false);
    assert.equal(mvp.ops.listWorkOrders({}).length, 0);
  } finally {
    clearAgentArtsEnv();
    await stub.close();
    fixture.cleanup();
  }
});

test('人工反馈后自动续接平台运行（AGENTARTS_AUTO_CONTINUE=true）', async () => {
  const stub = await withSequenceStub([
    { tool: 'get_crowd_status', arguments: { region_id: 'R_EAST_STAND' }, reasoning: '读取态势' },
    {
      tool: 'create_candidate_work_order',
      arguments: {
        type: 'scene_verification',
        title: '续接测试工单',
        description: '反馈后应触发平台续接',
        region_id: 'R_EAST_STAND',
        required_skills: ['crowd_check'],
      },
      reasoning: '需要现场核查',
    },
    { tool: 'get_crowd_status', arguments: { region_id: 'R_EAST_STAND' }, reasoning: '续接读取最新态势' },
  ]);
  const fixture = makeMvpFixture();
  try {
    setAgentArtsEnv(stub.baseUrl);
    process.env.AGENTARTS_AUTO_CONTINUE = 'true';
    process.env.AGENTARTS_MAX_STEPS = '2';
    const mvp = new MvpService({ scenario: fixture.scenario, safety: fixture.safety, audit: fixture.audit });
    const first = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'agentarts_continue', runtime: 'agentarts' });
    assert.equal(first.status, 'awaiting_approval');
    const orderId = first.investigation.pending_work_order_ids[0];
    assert.ok(orderId);

    const member = fixture.scenario.staff.find(item => item.skills.includes('crowd_check'))!;
    const admin = { username: 'test-admin', role: 'admin' } as const;
    const staff = { username: member.name, role: 'staff', staff_id: member.id } as const;
    mvp.ops.approve(orderId, admin);
    mvp.ops.assignStaff(orderId, admin, member.id);
    mvp.ops.accept(orderId, staff);
    mvp.ops.start(orderId, staff);
    mvp.ops.complete(orderId, staff, {
      note: '现场核查完成',
      observation: { count: 420, confidence: 0.9 },
    });

    const deadline = Date.now() + 3000;
    let continued = null as ReturnType<typeof mvp.listAgentRuns>[number] | null;
    while (Date.now() < deadline) {
      continued = mvp.listAgentRuns(100).find(
        item => item.trigger === `continuation:${first.run_id}`,
      ) ?? null;
      if (continued) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(continued, '未观察到续接运行');
    assert.equal(continued?.mode, 'AGENTARTS_CONNECTED');
    assert.ok((continued?.trace.length ?? 0) >= 1);

    // 续接必须复用原会话，并把 previous_run_id / 工单 / 反馈传给平台。
    const continuationCalls = stub.requests.filter(call =>
      typeof call.body?.input?.trigger === 'string'
      && call.body.input.trigger.startsWith('continuation:'));
    assert.ok(continuationCalls.length >= 1, '未捕获到续接请求');
    const call = continuationCalls[0];
    assert.equal(call.headers['x-hw-agentarts-session-id'], first.trace_id);
    assert.equal(call.body.input.context.previous_run_id, first.run_id);
    assert.equal(call.body.input.context.work_order_id, orderId);
    assert.equal(call.body.input.context.feedback?.work_order_id, orderId);
    assert.match(String(call.body.input.context.feedback?.note ?? ''), /现场核查完成/);
  } finally {
    clearAgentArtsEnv();
    await stub.close();
    fixture.cleanup();
  }
});
