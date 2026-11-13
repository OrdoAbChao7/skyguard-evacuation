/**
 * V7.2 实验编排器：路线稳定性 + 场馆标定 + Shadow 回放 + 华为生态状态。
 *
 *   npm run benchmark:v72 --prefix backend
 *   npm run benchmark:v72 --prefix backend -- --only=stability
 *   npm run benchmark:v72 --prefix backend -- --only=calibration
 *   npm run benchmark:v72 --prefix backend -- --only=shadow
 *   npm run benchmark:v72 --prefix backend -- --only=huawei
 *
 * 所有子实验共享 V72_RUN_ID，输出到 evaluation/v72/<run-id>/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const RUN_ID = process.env.V72_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v72', RUN_ID);
fs.mkdirSync(OUT, { recursive: true });

const onlyArg = process.argv.find(argument => argument.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : 'all';
const scripts: Array<{ key: string; file: string }> = [
  { key: 'stability', file: 'v72-stability-benchmark.ts' },
  { key: 'calibration', file: 'v72-venue-calibration.ts' },
  { key: 'shadow', file: 'v72-shadow-stress.ts' },
  { key: 'huawei', file: 'v72-huawei-status.ts' },
];
const selected = only === 'all' ? scripts : scripts.filter(item => item.key === only);
if (selected.length === 0) {
  console.error(`未知 --only 取值：${only}（可用：stability / calibration / shadow / huawei / all）`);
  process.exit(2);
}

for (const item of selected) {
  const started = Date.now();
  console.log(`[v72] running ${item.key} ...`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve(__dirname, item.file)], {
    env: { ...process.env, V72_RUN_ID: RUN_ID },
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
  if (result.status !== 0) {
    console.error(`[v72] ${item.key} failed with exit code ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }
  console.log(`[v72] ${item.key} done in ${Date.now() - started}ms`);
}

const readJson = (name: string): any => {
  const file = path.join(OUT, name);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const stability = readJson('stability_summary.json');
const calibration = readJson('calibration_evidence.json');
const shadow = readJson('shadow_stress_summary.json');
const huawei = readJson('huawei_status.json');

const lines: string[] = [
  '# SkyGuard V7.2 实验汇总',
  '',
  `> 运行 ID：\`${RUN_ID}\`。全部为合成数据；不代表真实场馆效果。`,
  `> 生成时间：${new Date().toISOString()}`,
  '',
];
if (stability) {
  lines.push('## 路线稳定性 A-F');
  for (const [strategy, value] of Object.entries(stability.overall) as Array<[string, any]>) {
    lines.push(`- ${strategy}：未疏散 ${value.unserved.mean}，完成时间 ${value.makespan.mean}，队列人·分钟 ${value.queue_person_minutes.mean}，最大密度 ${value.max_density.mean}，切换人数 ${value.switch_persons.mean}，求解 ${value.solve_ms.mean}ms。`);
  }
  lines.push('');
  lines.push('## 稳定性机理（相对 mpc_standard）');
  for (const [strategy, value] of Object.entries(stability.mechanism.stability_switch_reduction) as Array<[string, any]>) {
    const cost = stability.mechanism.stability_makespan_cost[strategy];
    lines.push(`- ${strategy}：切换人数差 ${value.mean} [${value.lower}, ${value.upper}]；完成时间差 ${cost.mean} [${cost.lower}, ${cost.upper}]。`);
  }
  lines.push('');
}
if (calibration) {
  lines.push('## 场馆标定');
  lines.push(`- 数据性质：${calibration.data_nature}；档案校验：${calibration.validation.valid}（错误 ${calibration.validation.errors.length}，警告 ${calibration.validation.warnings.length}）。`);
  lines.push(`- 应用变更 ${calibration.application.changes.length} 项，阻止 ${calibration.application.blocked.length} 项；场景未被原地修改：${calibration.application.scenario_unchanged}。`);
  lines.push(`- 步行速度估计：${calibration.walking_speed.estimate.value} ${calibration.walking_speed.estimate.unit}（${calibration.walking_speed.estimate.provenance}）。`);
  lines.push('');
}
if (shadow) {
  lines.push('## Shadow 回放压力');
  lines.push(`- 总回放 ${shadow.total_runs} 次；确定性不一致 ${shadow.determinism_mismatches}；快照完整性不一致 ${shadow.integrity_mismatches}。`);
  lines.push(`- 决策分布：${JSON.stringify(shadow.decisions)}。`);
  for (const [mode, value] of Object.entries(shadow.by_mode) as Array<[string, any]>) {
    lines.push(`- ${mode}：legacy 校验通过率 ${value.legacy_valid_rate}，V7 校验通过率 ${value.v7_valid_rate}，回退 ${JSON.stringify(value.fallback_counts)}。`);
  }
  lines.push('');
}
if (huawei) {
  lines.push('## 华为生态状态');
  lines.push(`- AgentArts：${huawei.agentarts.platform.status}；本地契约 stub 会话头一致 ${huawei.agentarts.local_stub.session_header_consistent}。`);
  lines.push(`- Ascend：npu-smi=${huawei.ascend.npu_smi.available}，atc=${huawei.ascend.atc.available}；ONNX 链路 ${huawei.ascend.onnx_pipeline.status}。`);
  lines.push(`- 边界：${huawei.ascend.boundary}`);
  lines.push('');
}
lines.push('## 解释边界', '', '- 合成场景/观测与未标定参数；不得表述为真实场馆效果。', '- 没有真实 AgentArts 凭证、昇腾 NPU/CANN 或真实场馆数据；相关结果仅限本地契约/CPU 链路。', '- 负向与混合结果保留在各自 README、summary 与 rows 文件中。', '');
fs.writeFileSync(path.join(OUT, 'V72_SUMMARY.md'), `${lines.join('\n')}\n`);

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
  version: 1,
  run_id: RUN_ID,
  generated_at: new Date().toISOString(),
  note: 'V7.2 实验根清单；覆盖路线稳定性、场馆标定、Shadow 回放与华为生态状态。',
  file_count: files.length,
  files,
}, null, 2)}\n`);
fs.writeFileSync(path.resolve(__dirname, '../../evaluation/v72/LATEST.txt'), `${RUN_ID}\n`);
fs.writeFileSync(path.join(OUT, 'run_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
  selected,
  data_nature: '全部为合成/模拟数据；不含真实人群、视频、无人机、昇腾 NPU 或 AgentArts 实测。',
}, null, 2)}\n`);

console.log(`[v72] all selected experiments complete: evaluation/v72/${RUN_ID}/`);
console.log(`[v72] summary: evaluation/v72/${RUN_ID}/V72_SUMMARY.md`);
