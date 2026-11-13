/**
 * V7.1 实验编排器：预测区间突破 + 滚动重规划机理（A-G）。
 *
 *   npm run benchmark:v71 --prefix backend
 *   npm run benchmark:v71 --prefix backend -- --only=prediction
 *   npm run benchmark:v71 --prefix backend -- --only=replanning
 *
 * 所有子实验共享同一个 V71_RUN_ID，输出到 evaluation/v71/<run-id>/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const RUN_ID = process.env.V71_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v71', RUN_ID);
fs.mkdirSync(OUT, { recursive: true });

const onlyArg = process.argv.find(argument => argument.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : 'all';
const scripts: Array<{ key: string; file: string }> = [
  { key: 'prediction', file: 'v71-prediction-benchmark.ts' },
  { key: 'replanning', file: 'v71-replanning-benchmark.ts' },
];
const selected = only === 'all' ? scripts : scripts.filter(item => item.key === only);
if (selected.length === 0) {
  console.error(`未知 --only 取值：${only}（可用：prediction / replanning / all）`);
  process.exit(2);
}

for (const item of selected) {
  const started = Date.now();
  console.log(`[v71] running ${item.key} ...`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve(__dirname, item.file)], {
    env: { ...process.env, V71_RUN_ID: RUN_ID },
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
  if (result.status !== 0) {
    console.error(`[v71] ${item.key} failed with exit code ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }
  console.log(`[v71] ${item.key} done in ${Date.now() - started}ms`);
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
const prediction = readJson('prediction_summary.json');
const replanning = readJson('replanning_summary.json');

const lines: string[] = [
  '# SkyGuard V7.1 实验汇总',
  '',
  `> 运行 ID：\`${RUN_ID}\`。全部为合成数据；不代表真实场馆效果。`,
  `> 生成时间：${new Date().toISOString()}`,
  '',
];
if (prediction) {
  lines.push('## 预测区间');
  for (const mechanism of ['stable', 'surge', 'decline', 'periodic', 'missing', 'noisy', 'regime_shift']) {
    const values = prediction.summary[mechanism];
    lines.push(`- ${mechanism}：v70_static 95% 覆盖 ${values.v70_static.coverage95}，aci ${values.aci.coverage95}，aci_cp ${values.aci_cp.coverage95}；aci_cp 宽度 ${values.aci_cp.mean_width}，门控失败率 ${values.aci_cp.failed_rate}。`);
  }
  lines.push('');
}
if (replanning) {
  lines.push('## 滚动重规划（A-G + H/I）');
  for (const [strategy, value] of Object.entries(replanning.overall) as Array<[string, any]>) {
    lines.push(`- ${strategy}：未疏散 ${value.unserved.mean}，完成时间 ${value.makespan.mean}，队列人·分钟 ${value.queue_person_minutes.mean}，切换人数 ${value.switch_persons.mean}，重规划 ${value.replans.mean}，求解 ${value.solve_ms.mean}ms。`);
  }
  lines.push('');
  lines.push('## 机理问题');
  for (const [name, value] of Object.entries(replanning.mechanism) as Array<[string, any]>) {
    const parts = Object.entries(value).map(([metric, stat]: [string, any]) => `${metric} ${stat.mean} [${stat.lower}, ${stat.upper}]`);
    lines.push(`- ${name}：${parts.join('；')}。`);
  }
  lines.push('');
}
lines.push('## 解释边界', '', '- 合成机制/场景与未标定参数；不得表述为真实场馆效果。', '- 负向与混合结果保留在各自 README、summary 与 rows 文件中。', '');
fs.writeFileSync(path.join(OUT, 'V71_SUMMARY.md'), `${lines.join('\n')}\n`);

const files = fs.readdirSync(OUT)
  .filter(name => name !== 'MANIFEST.json')
  .sort()
  .map(name => {
    const bytes = fs.readFileSync(path.join(OUT, name));
    return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), `${JSON.stringify({
  version: 1,
  run_id: RUN_ID,
  generated_at: new Date().toISOString(),
  note: 'V7.1 实验根清单；覆盖预测区间与滚动重规划两组证据。',
  file_count: files.length,
  files,
}, null, 2)}\n`);
fs.writeFileSync(path.resolve(__dirname, '../../evaluation/v71/LATEST.txt'), `${RUN_ID}\n`);
fs.writeFileSync(path.join(OUT, 'run_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
  selected,
  data_nature: '全部为合成/模拟数据；不含真实人群、视频、无人机、昇腾或 AgentArts 实测。',
}, null, 2)}\n`);

console.log(`[v71] all selected experiments complete: evaluation/v71/${RUN_ID}/`);
console.log(`[v71] summary: evaluation/v71/${RUN_ID}/V71_SUMMARY.md`);
