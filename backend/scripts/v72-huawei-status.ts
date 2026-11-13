/**
 * V7.2 华为生态集成状态证据（AgentArts + Ascend/ONNX）。
 *
 *   npm run benchmark:v72 --prefix backend -- --only=huawei
 *
 * 严格区分：
 *  - local_stub：本地 HTTP stub 验证官方契约（路径/会话头/SSE/工具决策），不是平台实机；
 *  - platform：只有真实 AGENTARTS_* 配置存在时才做健康探测，结果如实记录；
 *  - Ascend：只做工具链探测与 ONNX CPU 基准；没有 NPU/CANN 就明确写未实机。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  AgentArtsClient,
  loadAgentArtsConfig,
  missingConfig,
  type AgentArtsConfig,
} from '../src/services/mvp/agentarts';

const RUN_ID = process.env.V72_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v72', RUN_ID);
const ASCEND_OUT = path.join(OUT, 'ascend');
const ASCEND_DIR = path.resolve(__dirname, '../python/ascend');

function which(command: string): { available: boolean; path: string | null } {
  try {
    const output = execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8' }).trim();
    return { available: true, path: output.split(/\r?\n/)[0] ?? null };
  } catch {
    return { available: false, path: null };
  }
}

function pythonProbe(moduleName: string): { available: boolean; version: string | null; error: string | null } {
  try {
    const output = execFileSync('python', ['-c', `import ${moduleName}; print(getattr(${moduleName}, '__version__', 'unknown'))`], { encoding: 'utf8' }).trim();
    return { available: true, version: output || 'unknown', error: null };
  } catch (error) {
    return { available: false, version: null, error: (error as Error).message.slice(0, 300) };
  }
}

interface StubCapture {
  sessionHeader: string | null;
  bodyTraceId: string | null;
  path: string;
}

async function runAgentArtsLocalStub(): Promise<Record<string, unknown>> {
  const captures: StubCapture[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.url === '/runtimes/agent-stub/invocations') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let traceId: string | null = null;
        try {
          traceId = (JSON.parse(body) as { inputs?: { trace_id?: string } }).inputs?.trace_id ?? null;
        } catch {
          traceId = null;
        }
        captures.push({
          sessionHeader: (req.headers['x-hw-agentarts-session-id'] as string | undefined) ?? null,
          bodyTraceId: traceId,
          path: req.url ?? '',
        });
        const decision = JSON.stringify({
          tool: 'camera_query',
          arguments: { region_id: 'R_NORTH_STAND' },
          reasoning: 'local stub decision',
        });
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
  if (!address || typeof address === 'string') throw new Error('stub server has no port');
  const config: AgentArtsConfig = {
    runtime: 'agentarts',
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'stub-key',
    agentId: 'agent-stub',
    projectId: 'project-stub',
    contract: 'official',
    runtimeName: 'agent-stub',
    invokeMode: 'published',
    sessionHeader: 'x-hw-agentarts-session-id',
    invokePath: '/runtimes/{runtime_name}/invocations',
    healthPath: '/health',
    timeoutMs: 3000,
    healthRetries: 0,
    invokeRetries: 0,
    retryBaseMs: 50,
  };
  try {
    const client = new AgentArtsClient(config);
    const status = await client.healthCheck();
    const decisions = [];
    for (const traceId of ['trace-stub-1', 'trace-stub-2']) {
      decisions.push(await client.select({
        regionId: 'R_NORTH_STAND',
        trigger: 'v72:huawei-status',
        traceId,
        sessionId: 'session-stub-1',
        query: '请为北看台选择下一步安全调查工具',
        context: { scenario_id: 'stadium-evacuation-v1' },
        tools: [{ name: 'camera_query', description: '查询相机', roles: ['admin'] }],
      }));
    }
    return {
      label: 'local_stub（不是 AgentArts 实机）',
      health: { mode: status.mode, connectivity: status.connectivity, http_status: status.http_status },
      decisions: decisions.map(item => ({ tool: item.tool, reasoning: item.reasoning, arguments: item.arguments })),
      captures,
      session_header_consistent: captures.length === 2 && captures[0].sessionHeader === captures[1].sessionHeader,
      trace_ids_distinct: captures.length === 2 && captures[0].bodyTraceId !== captures[1].bodyTraceId,
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
    runtime_requested: envConfig.runtime,
    contract: envConfig.contract,
    missing,
    note: '没有真实 AgentArts 租户/凭证；未发起任何平台请求，不得声称已接入。',
  };
} else {
  const client = new AgentArtsClient(envConfig);
  const status = await client.healthCheck();
  platform = {
    status: status.connectivity === 'reachable' ? 'reachable' : 'unreachable',
    contract: status.contract,
    mode: status.mode,
    connectivity: status.connectivity,
    http_status: status.http_status,
    checked_at: status.checked_at,
    detail: status.detail,
    business_closure_verified: status.business_closure.verified,
    note: '健康探测只代表网络可达；工作流/工具回执/人工审批/反馈续接仍需单独证据。',
  };
}

const localStub = await runAgentArtsLocalStub();

const tools = {
  atc: which('atc'),
  npu_smi: which('npu-smi'),
};
const python = {
  onnx: pythonProbe('onnx'),
  onnxruntime: pythonProbe('onnxruntime'),
  numpy: pythonProbe('numpy'),
};

fs.mkdirSync(ASCEND_OUT, { recursive: true });
let onnxPipeline: Record<string, unknown>;
if (python.onnx.available && python.onnxruntime.available) {
  try {
    const exportLog = execFileSync('python', [
      path.join(ASCEND_DIR, 'export_forecast_onnx.py'),
      '--out', ASCEND_OUT,
    ], { encoding: 'utf8' });
    const benchLog = execFileSync('python', [
      path.join(ASCEND_DIR, 'benchmark_onnx.py'),
      '--model-dir', ASCEND_OUT,
      '--out', ASCEND_OUT,
    ], { encoding: 'utf8' });
    const benchmark = JSON.parse(fs.readFileSync(path.join(ASCEND_OUT, 'onnx_cpu_benchmark.json'), 'utf8'));
    onnxPipeline = {
      status: 'executed_cpu_only',
      export_log: exportLog.trim(),
      benchmark_log: benchLog.trim(),
      benchmark,
      note: 'ONNX Runtime CPU 基准；不是昇腾 NPU 实机结果。',
    };
  } catch (error) {
    onnxPipeline = {
      status: 'failed',
      error: (error as Error).message.slice(0, 1000),
      note: 'ONNX 链路执行失败；不得引用任何未生成的数值。',
    };
  }
} else {
  onnxPipeline = {
    status: 'skipped_missing_dependency',
    missing: Object.entries(python).filter(([, value]) => !value.available).map(([key]) => key),
    note: '未安装 onnx/onnxruntime；仅保留脚本与转换模板。',
  };
}
const npuAvailable = tools.npu_smi.available;
const ascend = {
  device_evidence: npuAvailable ? 'npu-smi 可见（仍需实际推理证据）' : 'no_npu_smi',
  atc: tools.atc,
  npu_smi: tools.npu_smi,
  python,
  onnx_pipeline: onnxPipeline,
  om_conversion: {
    status: tools.atc.available ? 'tool_available_not_executed' : 'not_executed_missing_atc',
    command_template: 'atc --model=forecast_linear.onnx --framework=5 --output=forecast_linear --soc_version=<SOC> --input_shape="history:1,12" --log=error',
    required_evidence: ['设备型号', 'CANN/atc 版本', 'ATC 日志', '.om SHA-256', 'NPU 延迟/吞吐/内存', '数值一致性'],
  },
  boundary: npuAvailable
    ? '检测到 npu-smi；本轮仍未执行 NPU 推理，不得宣称实机性能。'
    : '未检测到昇腾 NPU/CANN/atc；一切 NPU/OM 结果均为未验证。',
};

fs.mkdirSync(OUT, { recursive: true });
const evidence = {
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  agentarts: {
    platform,
    local_stub: localStub,
    boundary: 'local_stub 只验证适配器契约；platform 未配置时不得声称已接入 AgentArts。',
  },
  ascend,
};
const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('huawei_status.json', evidence);
write('huawei_agentarts.json', evidence.agentarts);
write('huawei_ascend.json', ascend);

const report = `# V7.2 华为生态集成状态

> 运行 ID：\`${RUN_ID}\`。**不伪造平台/硬件结果**；无凭证、无 NPU 时明确标注阻塞。

## 1. AgentArts

### 1.1 真实平台

- 状态：${String(platform.status)}
- 契约：${String(platform.contract)}
- 缺失配置：${missing.length > 0 ? missing.join('、') : '无'}
- 说明：${String(platform.note)}

### 1.2 本地契约 stub（不是实机）

- 健康：${JSON.stringify((localStub as any).health)}
- 决策：${JSON.stringify((localStub as any).decisions)}
- 会话头一致：${String((localStub as any).session_header_consistent)}
- trace_id 不同：${String((localStub as any).trace_ids_distinct)}

## 2. Ascend / CANN / ONNX

- npu-smi：${JSON.stringify(tools.npu_smi)}
- atc：${JSON.stringify(tools.atc)}
- Python：${JSON.stringify(python)}
- ONNX 链路：${String((onnxPipeline as any).status)}
${(onnxPipeline as any).benchmark ? `- CPU 基准文本：p50=${(onnxPipeline as any).benchmark.latency_ms.p50}ms，p95=${(onnxPipeline as any).benchmark.latency_ms.p95}ms，max_abs_diff=${(onnxPipeline as any).benchmark.numerical_consistency.max_abs_diff}` : ''}
- 边界：${ascend.boundary}

## 3. 结论

- AgentArts：${missing.length > 0 ? '未接入真实平台（缺租户/凭证）；仅契约 stub。' : '已配置并完成健康探测；业务闭环仍未验证。'}
- Ascend：${npuAvailable ? '检测到 npu-smi，但未执行 NPU 推理。' : '无 NPU/CANN/atc；ONNX CPU 链路仅用于部署准备。'}
`;
fs.writeFileSync(path.join(OUT, 'huawei_status_README.md'), report);
fs.writeFileSync(path.join(OUT, 'huawei_status_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);

const files = fs.readdirSync(OUT).filter(name => name.startsWith('huawei_'));
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'huawei_MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, note: 'V7.2 华为生态集成状态清单。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.2 huawei status complete: evaluation/v72/${RUN_ID}/`);
console.log(`agentarts platform=${String(platform.status)}, stub_ok=${String((localStub as any).session_header_consistent)}`);
console.log(`ascend npu=${npuAvailable}, onnx=${String((onnxPipeline as any).status)}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
