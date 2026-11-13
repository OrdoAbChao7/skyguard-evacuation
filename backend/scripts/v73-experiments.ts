/**
 * V7.3 实验编排器：自适应稳定性 + 场馆导入 + Shadow 运营 + Ascend + AgentArts。
 *
 *   npm run benchmark:v73 --prefix backend
 *   npm run benchmark:v73 --prefix backend -- --only=stability
 *   ... calibration / shadow / ascend / agentarts
 *
 * 共享 V73_RUN_ID，输出 evaluation/v73/<run-id>/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const RUN_ID = process.env.V73_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v73', RUN_ID);
fs.mkdirSync(OUT, { recursive: true });

const onlyArg = process.argv.find(argument => argument.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : 'all';
const scripts: Array<{ key: string; file: string }> = [
  { key: 'stability', file: 'v73-stability-benchmark.ts' },
  { key: 'calibration', file: 'v73-venue-import.ts' },
  { key: 'shadow', file: 'v73-shadow-ops.ts' },
  { key: 'ascend', file: 'v73-ascend-pipeline.ts' },
  { key: 'agentarts', file: 'v73-agentarts-status.ts' },
];
const selected = only === 'all' ? scripts : scripts.filter(item => item.key === only);
if (selected.length === 0) {
  console.error(`未知 --only 取值：${only}（可用：${scripts.map(item => item.key).join(' / ')} / all）`);
  process.exit(2);
}

for (const item of selected) {
  const started = Date.now();
  console.log(`[v73] running ${item.key} ...`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve(__dirname, item.file)], {
    env: { ...process.env, V73_RUN_ID: RUN_ID },
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
  if (result.status !== 0) {
    console.error(`[v73] ${item.key} failed with exit code ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }
  console.log(`[v73] ${item.key} done in ${Date.now() - started}ms`);
}

const readJson = (name: string): any => {
  const file = path.join(OUT, name);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const stability = readJson('stability_summary.json');
const calibration = readJson('calibration_import.json');
const shadow = readJson('shadow_ops_summary.json');
const ascend = readJson('ascend/ascend_pipeline.json');
const agentarts = readJson('agentarts_status.json');

const lines: string[] = [
  '# SkyGuard V7.3 实验汇总',
  '',
  `> 运行 ID：\`${RUN_ID}\`。全部为合成数据；不代表真实场馆/平台/硬件效果。`,
  `> 生成时间：${new Date().toISOString()}`,
  '',
];
if (stability) {
  lines.push('## 自适应稳定性 A-F');
  for (const [strategy, value] of Object.entries(stability.overall) as Array<[string, any]>) {
    lines.push(`- ${strategy}：未疏散 ${value.unserved.mean}，完成时间 ${value.makespan.mean}，队列 ${value.queue_person_minutes.mean}，密度 ${value.max_density.mean}，切换 ${value.switch_persons.mean}，振荡 ${value.oscillation_persons.mean}，安全违规 ${value.safety_violations.mean}。`);
  }
  lines.push('');
}
if (calibration) {
  lines.push('## 场馆导入');
  lines.push(`- 场景拓扑错误 ${calibration.scenario_import?.topology_errors?.length ?? 'n/a'}；档案校验 ${calibration.profile_validation?.valid ?? 'n/a'}；CSV replay/live ${calibration.observations_csv?.replay_accepted ?? 'n/a'}/${calibration.observations_csv?.live_accepted ?? 'n/a'}；视频 ${calibration.video_interface?.accepted ?? 'n/a'}；public/authorized ${calibration.public_dataset_adapter?.accepted ?? 'n/a'}/${calibration.authorized_real_adapter?.accepted ?? 'n/a'}。`);
  lines.push('');
}
if (shadow) {
  lines.push('## Shadow 运营验证');
  lines.push(`- 总回放 ${shadow.total_runs}；确定性不一致 ${shadow.deterministic_mismatches}；决策 ${JSON.stringify(shadow.decisions)}。`);
  for (const [caseName, value] of Object.entries(shadow.by_case) as Array<[string, any]>) {
    lines.push(`- ${caseName}：legacy/V7 校验率 ${value.legacy_valid_rate}/${value.v7_valid_rate}；回退 ${JSON.stringify(value.fallbacks)}；stale ${value.stale_snapshots}；冲突 ${value.conflicts_detected}。`);
  }
  lines.push('');
}
if (ascend) {
  lines.push('## Ascend/ONNX');
  lines.push(`- npu-smi=${ascend.tools?.npu_smi?.available}；atc=${ascend.tools?.atc?.available}；ONNX ${ascend.onnx_pipeline?.status}；checker ${JSON.stringify(ascend.onnx_pipeline?.onnx_checker)}；OM ${ascend.om_pipeline?.status}。`);
  lines.push('');
}
if (agentarts) {
  lines.push('## AgentArts');
  lines.push(`- 真实平台 ${agentarts.platform?.status}；stub 会话头 ${agentarts.local_stub?.session_header_present}；重试复用幂等键 ${agentarts.local_stub?.retry_reused_idempotency_key}。`);
  lines.push('');
}
lines.push('## 边界', '', '- 合成场景/观测；无真实场馆、平台或 NPU 证据。', '- 负向/混合结果保留在各自 rows/summary/README。', '');
fs.writeFileSync(path.join(OUT, 'V73_SUMMARY.md'), `${lines.join('\n')}\n`);

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
  note: 'V7.3 实验根清单；覆盖稳定性、场馆导入、Shadow、Ascend、AgentArts。',
  file_count: files.length, files,
}, null, 2)}\n`);
if (only === 'all') {
  fs.writeFileSync(path.resolve(__dirname, '../../evaluation/v73/LATEST.txt'), `${RUN_ID}\n`);
} else {
  console.log('[v73] partial run; LATEST.txt unchanged');
}
fs.writeFileSync(path.join(OUT, 'run_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(), run_id: RUN_ID,
  node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted', selected,
  data_nature: '全部为合成/夹具数据；不含真实人群、视频、授权数据、AgentArts 实机或昇腾 NPU 实测。',
}, null, 2)}\n`);

console.log(`[v73] all selected experiments complete: evaluation/v73/${RUN_ID}/`);
console.log(`[v73] summary: evaluation/v73/${RUN_ID}/V73_SUMMARY.md`);
