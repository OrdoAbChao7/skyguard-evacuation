/**
 * V7.5 实验编排器：检测 + 承诺/稳定性 + 多目标 + 融合 + Ascend + AgentArts（可选生产检查）。
 *
 *   npm run benchmark:v75 --prefix backend
 *   npm run benchmark:v75 --prefix backend -- --only=detection
 *   npm run benchmark:v75 --prefix backend -- --only=detection,fusion
 *   V75_INCLUDE_PRODUCTION=1 npm run benchmark:v75 --prefix backend
 *
 * 全部为合成/夹具数据；不代表真实场馆、平台或硬件效果。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const RUN_ID = process.env.V75_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v75', RUN_ID);
fs.mkdirSync(OUT, { recursive: true });

const onlyArg = process.argv.find(argument => argument.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : 'all';
const requested = only.split(',').map(item => item.trim()).filter(Boolean);
const scripts: Array<{ key: string; file: string; optional?: boolean }> = [
  { key: 'detection', file: 'v75-detection-benchmark.ts' },
  { key: 'commitment', file: 'v75-commitment-benchmark.ts' },
  { key: 'multiobjective', file: 'v75-multiobjective-benchmark.ts' },
  { key: 'fusion', file: 'v75-fusion-benchmark.ts' },
  { key: 'ascend', file: 'v75-ascend-pipeline.ts' },
  { key: 'agentarts', file: 'v75-agentarts-status.ts' },
  { key: 'production', file: 'v75-production-checks.ts', optional: true },
];
const wanted = requested.includes('all')
  ? scripts.filter(item => !item.optional || process.env.V75_INCLUDE_PRODUCTION === '1')
  : scripts.filter(item => requested.includes(item.key));
if (wanted.length === 0) {
  console.error(`未知 --only 取值：${only}（可用：${scripts.map(item => item.key).join(' / ')} / all）`);
  process.exit(2);
}

for (const item of wanted) {
  const started = Date.now();
  console.log(`[v75] running ${item.key} ...`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve(__dirname, item.file)], {
    env: { ...process.env, V75_RUN_ID: RUN_ID },
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
  if (result.status !== 0) {
    console.error(`[v75] ${item.key} failed with exit code ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }
  console.log(`[v75] ${item.key} done in ${Date.now() - started}ms`);
}

if ((requested.includes('all') || requested.includes('browser')) && process.env.V75_INCLUDE_BROWSER === '1') {
  const started = Date.now();
  console.log('[v75] running browser e2e ...');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../frontend/e2e/smoke.mjs'), '--out', path.join(OUT, 'browser_e2e.json')], {
    env: { ...process.env },
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '../..'),
  });
  if (result.status !== 0) {
    console.error(`[v75] browser e2e failed with exit code ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }
  console.log(`[v75] browser e2e done in ${Date.now() - started}ms`);
}

const readJson = (name: string): any => {
  const file = path.join(OUT, name);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const detection = readJson('detection_summary.json');
const commitment = readJson('stability_summary.json');
const multiobjective = readJson('multiobjective_summary.json');
const fusion = readJson('fusion_summary.json');
const ascend = readJson('ascend/ascend_pipeline.json');
const agentarts = readJson('agentarts_status.json');
const production = readJson('production_checks.json');

const lines: string[] = [
  '# SkyGuard V7.5 实验汇总',
  '',
  `> 运行 ID：\`${RUN_ID}\`。全部为合成/夹具数据；不代表真实场馆/平台/硬件效果。`,
  `> 生成时间：${new Date().toISOString()}`,
  '',
];
if (detection) {
  lines.push('## Track A 突增检测');
  for (const [kind, value] of Object.entries(detection.summary) as Array<[string, any]>) {
    lines.push(`- ${kind}：召回 ${value.aggregate.recall}，精确率 ${value.aggregate.precision}，F1 ${value.aggregate.f1}，无变化误报率 ${value.aggregate.false_positive_rate}，误报/100 步 ${value.aggregate.mean_false_alarms_per_100}。`);
  }
  lines.push('');
}
if (commitment) {
  lines.push('## Track B 承诺/稳定性');
  for (const [strategy, value] of Object.entries(commitment.overall) as Array<[string, any]>) {
    lines.push(`- ${strategy}：未疏散 ${value.unserved.mean}，完成 ${value.makespan.mean}，队列 ${value.queue_person_minutes.mean}，密度 ${value.max_density?.mean ?? '-'}，切换 ${value.switch_persons?.mean ?? '-'}，振荡 ${value.oscillation_persons?.mean ?? '-'}，安全违规 ${value.safety_violations?.mean ?? '-'}，门控拒绝 ${value.gate_rejections?.mean ?? '-'}，紧急覆盖 ${value.emergency_overrides?.mean ?? '-'}，紧急响应延迟 ${value.emergency_response_delay?.mean ?? '-'}。`);
  }
  lines.push('');
}
if (multiobjective) {
  lines.push('## Track D 多目标');
  for (const [profile, value] of Object.entries(multiobjective.profile_summary) as Array<[string, any]>) {
    lines.push(`- ${profile}：未疏散 ${value.unserved}，完成 ${value.makespan}，队列 ${value.queue_person_minutes}，切换 ${value.switch_persons}，密度 ${value.max_density}，容量冲突 ${value.capacity_violations}，求解 ${value.solve_ms}ms。`);
  }
  lines.push(`- 选择方法：${(Object.entries(multiobjective.selection_summary) as Array<[string, any]>).map(([name, value]) => `${name}(未疏散 ${value.unserved}/切换 ${value.switch_persons})`).join('，')}；constrained(未疏散 ${multiobjective.constrained.unserved}/切换 ${multiobjective.constrained.switch_persons})。`);
  lines.push(`- Pareto：实例 ${multiobjective.pareto.instances}，平均前沿 ${multiobjective.pareto.mean_front_size}，存在权衡 ${multiobjective.pareto.instances_with_tradeoff}。`);
  lines.push('- 膝点选择为离线分析/上界，不是在线部署算法。');
  lines.push('');
}
if (fusion) {
  lines.push('## Track E 多传感器融合');
  for (const [method, value] of Object.entries(fusion.overall) as Array<[string, any]>) {
    lines.push(`- ${method}：可用率 ${value.availability}，MAE ${value.mae ?? '-'}，偏差 ${value.bias ?? '-'}，严格条件 unsafe fuse 率 ${value.unsafe_fuse_rate_on_strict}，良性 false fail-close 率 ${value.false_failclose_rate_on_benign}，决策准确率 ${value.decision_accuracy}。`);
  }
  lines.push(`- 管线诊断：冲突 fail-closed ${fusion.pipeline_diagnostics.conflict_failclosed_rate}，时钟偏移 fail-closed ${fusion.pipeline_diagnostics.clock_skew_failclosed_rate}，过期拒绝 ${fusion.pipeline_diagnostics.stale_rejections_total}，重复拒绝 ${fusion.pipeline_diagnostics.duplicate_rejections_total}。`);
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
fs.writeFileSync(path.join(OUT, 'V75_SUMMARY.md'), `${lines.join('\n')}\n`);

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
  note: 'V7.5 实验根清单；检测、承诺/稳定性、多目标、融合、Ascend、AgentArts、生产检查。',
  file_count: files.length, files,
}, null, 2)}\n`);
fs.writeFileSync(path.resolve(__dirname, '../../evaluation/v75/LATEST.txt'), `${RUN_ID}\n`);
fs.writeFileSync(path.join(OUT, 'run_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(), run_id: RUN_ID,
  node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted', selected: wanted,
  data_nature: '合成/夹具数据；不含真实人群、视频、授权数据、AgentArts 实机或昇腾 NPU 实测。',
}, null, 2)}\n`);

console.log(`[v75] all selected experiments complete: evaluation/v75/${RUN_ID}/`);
console.log(`[v75] summary: evaluation/v75/${RUN_ID}/V75_SUMMARY.md`);
