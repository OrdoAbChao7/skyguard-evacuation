/**
 * V7.4 Phase 5：Ascend/ONNX/OM 部署链路证据。
 *
 *   npm run benchmark:v73 --prefix backend -- --only=ascend
 *
 * 只做可独立执行的部分：ONNX 导出、ONNX checker、CPU 推理基准、设备/工具链探测、
 * OM 元数据模板与校验。没有 NPU/CANN/atc 时明确写未实机，不伪造 OM。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildOmTemplate, validateOmMetadata } from '../src/services/safety/deployment/om-metadata';

const RUN_ID = process.env.V74_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v74', RUN_ID, 'ascend');
const ASCEND_DIR = path.resolve(__dirname, '../python/ascend');
fs.mkdirSync(OUT, { recursive: true });

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
function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const tools = {
  atc: which('atc'),
  npu_smi: which('npu-smi'),
  ascend_home: process.env.ASCEND_HOME_PATH ?? process.env.ASCEND_TOOLKIT_HOME ?? null,
  cann_home: process.env.CANN_HOME ?? null,
};
const python = {
  onnx: pythonProbe('onnx'),
  onnxruntime: pythonProbe('onnxruntime'),
  numpy: pythonProbe('numpy'),
};

let exportResult: Record<string, unknown> = { status: 'skipped' };
let benchmark: Record<string, unknown> | null = null;
if (python.onnx.available && python.onnxruntime.available) {
  try {
    const exportLog = execFileSync('python', [
      path.join(ASCEND_DIR, 'export_forecast_onnx.py'), '--out', OUT,
    ], { encoding: 'utf8' });
    const benchmarkLog = execFileSync('python', [
      path.join(ASCEND_DIR, 'benchmark_onnx.py'), '--model-dir', OUT, '--out', OUT,
    ], { encoding: 'utf8' });
    benchmark = JSON.parse(fs.readFileSync(path.join(OUT, 'onnx_cpu_benchmark.json'), 'utf8')) as Record<string, unknown>;
    exportResult = { status: 'executed_cpu_only', export_log: exportLog.trim(), benchmark_log: benchmarkLog.trim() };
  } catch (error) {
    exportResult = { status: 'failed', error: (error as Error).message.slice(0, 1000) };
  }
} else {
  exportResult = {
    status: 'skipped_missing_dependency',
    missing: Object.entries(python).filter(([, value]) => !value.available).map(([key]) => key),
  };
}

const metadataPath = path.join(OUT, 'forecast_linear_metadata.json');
const modelPath = path.join(OUT, 'forecast_linear.onnx');
const modelMetadata = fs.existsSync(metadataPath)
  ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { sha256: string; input: { shape: number[] }; output: { shape: number[] } }
  : null;
const template = modelMetadata
  ? buildOmTemplate({
    modelName: 'forecast_linear',
    socVersion: tools.npu_smi.available ? 'Ascend（待从 npu-smi 读取具体型号）' : 'Ascend910B3（模板占位，未实机）',
    cannVersion: tools.ascend_home ?? 'CANN（未安装/未探测）',
    omSha256: '0'.repeat(64),
    onnxSha256: modelMetadata.sha256,
    inputShape: modelMetadata.input.shape,
    outputShape: modelMetadata.output.shape,
  })
  : null;
const templateValidation = template ? validateOmMetadata(template) : null;
if (template) fs.writeFileSync(path.join(OUT, 'om-metadata.template.json'), `${JSON.stringify(template, null, 2)}\n`);

const evidence = {
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    python: python.numpy.available ? 'available' : 'unavailable',
  },
  tools,
  python,
  onnx_pipeline: {
    ...exportResult,
    onnx_sha256: modelMetadata?.sha256 ?? (fs.existsSync(modelPath) ? sha256(modelPath) : null),
    onnx_checker: (benchmark as any)?.onnx_check ?? null,
    cpu_benchmark: benchmark,
  },
  om_pipeline: {
    status: tools.atc.available && tools.npu_smi.available ? 'tool_available_not_executed' : 'not_executed_missing_atc_or_npu',
    metadata_template: template ? 'om-metadata.template.json' : null,
    template_validation: templateValidation,
    atc_command_template: template?.atc_command ?? null,
    required_evidence: ['设备型号', '驱动版本', 'CANN/atc 版本', 'ATC 日志', '.om SHA-256', 'NPU p50/p95/内存', '数值一致性'],
  },
  boundary: tools.npu_smi.available
    ? '检测到 npu-smi；本轮仍未执行 NPU 推理，不得宣称实机性能。'
    : '未检测到昇腾 NPU/CANN/atc；ONNX 仅 CPUExecutionProvider；OM/NPU 结果未验证。',
};
fs.writeFileSync(path.join(OUT, 'ascend_pipeline.json'), `${JSON.stringify(evidence, null, 2)}\n`);

const report = `# V7.4 Ascend/ONNX/OM 部署链路证据

> 运行 ID：\`${RUN_ID}\`。**没有 NPU 不等于可以推测 NPU；所有 NPU/OM 结论必须来自实机证据。**

## 1. 环境探测

| 项 | 状态 |
| --- | --- |
| npu-smi | ${tools.npu_smi.available ? tools.npu_smi.path : '不可用'} |
| atc | ${tools.atc.available ? tools.atc.path : '不可用'} |
| ASCEND_HOME_PATH/CANN_HOME | ${tools.ascend_home ?? tools.cann_home ?? '未设置'} |
| onnx | ${python.onnx.available ? python.onnx.version : '不可用'} |
| onnxruntime | ${python.onnxruntime.available ? python.onnxruntime.version : '不可用'} |

## 2. ONNX 链路

- 状态：${String((exportResult as any).status)}
- ONNX SHA-256：${String(evidence.onnx_pipeline.onnx_sha256 ?? 'n/a')}
- ONNX checker：${JSON.stringify(evidence.onnx_pipeline.onnx_checker)}
${benchmark ? `- CPU 基准：p50=${(benchmark as any).latency_ms?.p50}ms，p95=${(benchmark as any).latency_ms?.p95}ms，max_abs_diff=${(benchmark as any).numerical_consistency?.max_abs_diff}` : '- CPU 基准：未执行'}

## 3. OM/NPU

- 状态：${evidence.om_pipeline.status}
- 模板：${evidence.om_pipeline.metadata_template ?? '未生成'}
- 模板校验：${templateValidation ? `${templateValidation.status}（errors=${templateValidation.errors.length}）` : 'n/a'}
- ATC 命令模板：\`${evidence.om_pipeline.atc_command_template ?? 'n/a'}\`
- 边界：${evidence.boundary}

## 4. 结论

- ONNX 导出/checker/CPU 基准是可复现的；**不是 NPU 性能**；
- 没有 OM 文件、CANN 版本、ATC 日志或 NPU 延迟/内存数据；
- 要标记 \`npu_verified\`，必须提供 \`device_evidence.npu_smi_available=true\`、设备型号/驱动/CANN 版本、
  \`benchmark.executed_on="npu"\`、p50/p95/内存与数值一致性；
- 本证据不构成昇腾实机验证。
`;
fs.writeFileSync(path.join(OUT, 'ascend_pipeline_README.md'), report);

const files = fs.readdirSync(OUT).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'ascend_MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, note: 'V7.4 ONNX/OM 部署链路证据清单；不代表 NPU 实机。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.4 ascend pipeline complete: evaluation/v74/${RUN_ID}/ascend/`);
console.log(`npu=${tools.npu_smi.available} atc=${tools.atc.available} onnx=${String((exportResult as any).status)}`);
console.log(`onnx_checker=${JSON.stringify(evidence.onnx_pipeline.onnx_checker)}`);
