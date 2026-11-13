/**
 * V7.4 实验编排器：稳定性 Pareto + surge + 标定质量 + Ascend + AgentArts（可选生产检查）。
 *
 *   npm run benchmark:v74 --prefix backend
 *   npm run benchmark:v74 --prefix backend -- --only=stability
 *   V74_INCLUDE_PRODUCTION=1 npm run benchmark:v74 --prefix backend
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const RUN_ID = process.env.V74_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v74', RUN_ID);
fs.mkdirSync(OUT, { recursive: true });

const onlyArg = process.argv.find(argument => argument.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : 'all';
const scripts: Array<{ key: string; file: string; optional?: boolean }> = [
  { key: 'stability', file: 'v74-stability-benchmark.ts' },
  { key: 'surge', file: 'v74-surge-detection.ts' },
  { key: 'calibration', file: 'v74-calibration-quality.ts' },
  { key: 'ascend', file: 'v74-ascend-pipeline.ts' },
  { key: 'agentarts', file: 'v74-agentarts-status.ts' },
  { key: 'production', file: 'v74-production-checks.ts', optional: true },
];
const selected = only === 'all'
  ? scripts.filter(item => !item.optional || process.env.V74_INCLUDE_PRODUCTION === '1')
  : scripts.filter(item => item.key === only);
if (selected.length === 0) {
  console.error(`未知 --only 取值：${only}（可用：${scripts.map(item => item.key).join(' / ')} / all）`);
  process.exit(2);
}

for (const item of selected) {
  const started = Date.now();
  console.log(`[v74] running ${item.key} ...`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve(__dirname, item.file)], {
    env: { ...process.env, V74_RUN_ID: RUN_ID },
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
  if (result.status !== 0) {
    console.error(`[v74] ${item.key} failed with exit code ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }
  console.log(`[v74] ${item.key} done in ${Date.now() - started}ms`);
}

if ((only === 'all' || only === 'browser') && process.env.V74_INCLUDE_BROWSER === '1') {
  const started = Date.now();
  console.log('[v74] running browser e2e ...');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../frontend/e2e/smoke.mjs'), '--out', path.join(OUT, 'browser_e2e.json')], {
    env: { ...process.env },
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '../..'),
  });
  if (result.status !== 0) {
    console.error(`[v74] browser e2e failed with exit code ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }
  console.log(`[v74] browser e2e done in ${Date.now() - started}ms`);
}

const readJson = (name: string): any => {
  const file = path.join(OUT, name);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const stability = readJson('stability_summary.json');
const surge = readJson('surge_summary.json');
const calibration = readJson('calibration_quality.json');
const ascend = readJson('ascend/ascend_pipeline.json');
const agentarts = readJson('agentarts_status.json');
const production = readJson('production_checks.json');

const lines: string[] = [
  '# SkyGuard V7.4 实验汇总',
  '',
  `> 运行 ID：\`${RUN_ID}\`。全部为合成/夹具数据；不代表真实场馆/平台/硬件效果。`,
  `> 生成时间：${new Date().toISOString()}`,
  '',
];
if (stability) {
  lines.push('## 稳定性—效率 Pareto A-F');
  for (const [strategy, value] of Object.entries(stability.overall) as Array<[string, any]>) {
    lines.push(`- ${strategy}：未疏散 ${value.unserved.mean}，完成 ${value.makespan.mean}，队列 ${value.queue_person_minutes.mean}，密度 ${value.max_density.mean}，切换 ${value.switch_persons.mean}，振荡 ${value.oscillation_persons.mean}，安全违规 ${value.safety_violations.mean}，门控拒绝 ${value.gate_rejections.mean}，释放 ${value.commitment_releases.mean}。`);
  }
  lines.push('');
}
if (surge) {
  lines.push('## Surge/Regime 检测');
  for (const detector of ['changepoint', 'naive3sigma']) {
    lines.push(`- ${detector}：` + Object.entries(surge.summary[detector]).map(([m, v]: [string, any]) => `${m} 检测率 ${v.detection_rate}/延迟 ${v.median_latency}`).join('；'));
  }
  lines.push('');
}
if (calibration) {
  lines.push('## 标定质量');
  lines.push(`- 时钟同步接受 ${calibration.timestamp_sync.accepted}，拒绝 ${calibration.timestamp_sync.rejected.length}；缺失区间 ${calibration.missing_intervals.length}；可靠性 provider ${calibration.sensor_reliability.length}。`);
  lines.push(`- 观测覆盖 ${calibration.observation_quality.coverage_ratio}；过期 ${calibration.observation_quality.stale}；低置信度 ${calibration.observation_quality.low_confidence}。`);
  lines.push('');
}
if (ascend) {
  lines.push('## Ascend/ONNX');
  lines.push(`- npu-smi=${ascend.tools?.npu_smi?.available}；atc=${ascend.tools?.atc?.available}；ONNX ${ascend.onnx_pipeline?.status}；checker ${JSON.stringify(ascend.onnx_pipeline?.onnx_checker)}；OM ${ascend.om_pipeline?.status}。`);
  lines.push('');
}
if (agentarts) {
  lines.push('## AgentArts');
  lines.push(`- 真实平台 ${agentarts.platform?.status}；stub 会话头 ${agentarts.local_stub?.session_header_present}；幂等键复用 ${agentarts.local_stub?.retry_reused_idempotency_key}。`);
  lines.push('');
}
if (production) {
  lines.push('## 生产检查');
  lines.push(`- Docker ${production.docker?.status}；CI ${production.ci?.yaml_parse}；API ${production.api_contract?.filter((item: any) => item.ok).length}/${production.api_contract?.length}；负载 p95 ${production.load_test?.p95_ms}ms。`);
  lines.push('');
}
lines.push('## 边界', '', '- 合成/夹具数据；无真实场馆、平台或 NPU 证据。', '- 负向/混合结果保留在各自 rows/summary/README。', '');
fs.writeFileSync(path.join(OUT, 'V74_SUMMARY.md'), `${lines.join('\n')}\n`);

const listFiles = (dir: string, prefix = ''): string[] => {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...listFiles(full, relative));
    else out.push(relative);
  }
  return out;
};
const files = listFiles(OUT)
  .filter(name => name !== 'MANIFEST.json' && name !== 'run_metadata.json')
  .sort()
  .map(name => {
    const bytes = fs.readFileSync(path.join(OUT, name));
    return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, generated_at: new Date().toISOString(),
  note: 'V7.4 实验根清单；稳定性 Pareto、surge、标定质量、Ascend、AgentArts、生产检查。',
  file_count: files.length, files,
}, null, 2)}\n`);
fs.writeFileSync(path.resolve(__dirname, '../../evaluation/v74/LATEST.txt'), `${RUN_ID}\n`);
fs.writeFileSync(path.join(OUT, 'run_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(), run_id: RUN_ID,
  node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted', selected,
  data_nature: '合成/夹具数据；不含真实人群、视频、授权数据、AgentArts 实机或昇腾 NPU 实测。',
}, null, 2)}\n`);

console.log(`[v74] all selected experiments complete: evaluation/v74/${RUN_ID}/`);
console.log(`[v74] summary: evaluation/v74/${RUN_ID}/V74_SUMMARY.md`);
