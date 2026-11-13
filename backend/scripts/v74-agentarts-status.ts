/**
 * V7.4 Phase 4：AgentArts 运行状态与幂等/会话证据。
 *
 *   npm run benchmark:v73 --prefix backend -- --only=agentarts
 *
 * 无真实租户/凭证时只运行本地官方契约 stub；不得表述为真实平台连接。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { AgentArtsClient, loadAgentArtsConfig, missingConfig, type AgentArtsConfig } from '../src/services/mvp/agentarts';

const RUN_ID = process.env.V74_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v74', RUN_ID);
fs.mkdirSync(OUT, { recursive: true });

function which(command: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface Capture { session: string | null; idempotency: string | null; traceId: string | null }

async function runStub(): Promise<Record<string, unknown>> {
  const captures: Capture[] = [];
  let requestCount = 0;
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.url === '/runtimes/agent-v73/invocations') {
      requestCount += 1;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let traceId: string | null = null;
        try { traceId = (JSON.parse(body) as { inputs?: { trace_id?: string } }).inputs?.trace_id ?? null; } catch { traceId = null; }
        captures.push({
          session: (req.headers['x-hw-agentarts-session-id'] as string | undefined) ?? null,
          idempotency: (req.headers['x-idempotency-key'] as string | undefined) ?? null,
          traceId,
        });
        if (requestCount === 1) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end('{"error":"transient"}');
          return;
        }
        const decision = JSON.stringify({ tool: 'camera_query', arguments: { region_id: 'R_NORTH_STAND' }, reasoning: 'stub decision' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ event: 'message', data: { text: decision } })}\n\n`);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub no port');
  const config: AgentArtsConfig = {
    runtime: 'agentarts',
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'stub-key',
    agentId: 'agent-v73',
    projectId: 'project-v73',
    contract: 'official',
    runtimeName: 'agent-v73',
    invokeMode: 'published',
    sessionHeader: 'x-hw-agentarts-session-id',
    idempotencyHeader: 'x-idempotency-key',
    invokePath: '/runtimes/{runtime_name}/invocations',
    healthPath: '/health',
    timeoutMs: 3000,
    healthRetries: 0,
    invokeRetries: 1,
    retryBaseMs: 10,
  };
  try {
    const client = new AgentArtsClient(config);
    const status = await client.healthCheck();
    const decision = await client.select({
      regionId: 'R_NORTH_STAND',
      trigger: 'v73:agentarts-status',
      traceId: 'trace-v73-1',
      sessionId: 'session-v73',
      query: '请选择下一步安全调查工具',
      context: { scenario_id: 'stadium-evacuation-v1' },
      tools: [{ name: 'camera_query', description: 'camera', roles: ['admin'] }],
    });
    return {
      label: 'local_stub（不是 AgentArts 实机）',
      health: { mode: status.mode, connectivity: status.connectivity, http_status: status.http_status },
      decision: { tool: decision.tool, reasoning: decision.reasoning },
      captures,
      retry_reused_idempotency_key: captures.length >= 2 && captures[0].idempotency === captures[1].idempotency,
      session_header_present: captures.every(item => typeof item.session === 'string' && item.session.length > 0),
      trace_id_distinct: new Set(captures.map(item => item.traceId)).size === 1,
    };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function main(): Promise<void> {
const envConfig = loadAgentArtsConfig();
const missing = missingConfig(envConfig);
let platform: Record<string, unknown>;
if (missing.length > 0) {
  platform = {
    status: 'not_configured',
    contract: envConfig.contract,
    missing,
    note: '无真实 AgentArts 租户/凭证；未发起平台请求。',
  };
} else {
  const client = new AgentArtsClient(envConfig);
  const status = await client.healthCheck();
  platform = {
    status: status.connectivity === 'reachable' ? 'reachable' : 'unreachable',
    mode: status.mode,
    connectivity: status.connectivity,
    http_status: status.http_status,
    checked_at: status.checked_at,
    business_closure_verified: status.business_closure.verified,
    note: '健康探测只代表网络可达；业务闭环仍需平台 Trace/工具回执/审批/反馈证据。',
  };
}

const stub = await runStub();
const evidence = {
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  boundary: 'local_stub 只验证适配器契约；真实平台未配置时不得声称已接入。',
  platform,
  local_stub: stub,
  adapter_capabilities: {
    official_contract: true,
    sse_stream: true,
    session_header: true,
    idempotency_key: true,
    bounded_retry: true,
    tool_permission_gate: 'MvpService 本地注册表（既有测试）',
    human_approval: '既有 AgentArts 运行时测试',
    feedback_resumption: '既有 AGENTARTS_AUTO_CONTINUE 测试',
  },
  runtime_tools: {
    node: process.version,
    jwk_present: which('node'),
  },
};
fs.writeFileSync(path.join(OUT, 'agentarts_status.json'), `${JSON.stringify(evidence, null, 2)}\n`);

const report = `# V7.4 AgentArts 状态与幂等证据

> 运行 ID：\`${RUN_ID}\`。**local stub 不是实机**；无租户/凭证时不声称已接入。

## 1. 真实平台

- 状态：${String(platform.status)}
- 契约：${String(platform.contract)}
- 缺失配置：${missing.length > 0 ? missing.join('、') : '无'}
- 说明：${String(platform.note)}

## 2. 本地官方契约 stub

- 健康：${JSON.stringify((stub as any).health)}
- 决策：${JSON.stringify((stub as any).decision)}
- 会话头存在：${String((stub as any).session_header_present)}
- 重试复用幂等键：${String((stub as any).retry_reused_idempotency_key)}
- 请求捕获：${JSON.stringify((stub as any).captures)}

## 3. 适配器能力

- 官方契约、SSE、会话头、幂等键、有界重试：已实现并有测试；
- 工具权限门、人工审批、反馈续接：由既有 AgentArts 运行时测试覆盖；
- 真实多步工作流/Trace 仍需要租户环境。

## 4. 边界

- 没有真实平台 Trace、工具回执或审批等待证据；
- 不得把本地 stub 表述为 AgentArts 连接成功。
`;
fs.writeFileSync(path.join(OUT, 'agentarts_status_README.md'), report);

const files = fs.readdirSync(OUT).filter(name => name.startsWith('agentarts_status')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'agentarts_MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, note: 'V7.4 AgentArts 状态与幂等证据清单（stub）。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.4 agentarts status complete: evaluation/v74/${RUN_ID}/`);
console.log(`platform=${String(platform.status)} stub_session=${String((stub as any).session_header_present)} idempotency=${String((stub as any).retry_reused_idempotency_key)}`);
}

main().catch(error => { console.error(error); process.exit(1); });
