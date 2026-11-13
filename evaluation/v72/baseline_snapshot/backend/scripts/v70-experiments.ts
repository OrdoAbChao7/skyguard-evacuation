/**
 * V7.0 实验编排器：一次运行生成预测、规划、联合 VoI 三组证据。
 *
 *   npm run benchmark:v70 --prefix backend
 *   npm run benchmark:v70 --prefix backend -- --only=prediction
 *   npm run benchmark:v70 --prefix backend -- --only=planning
 *   npm run benchmark:v70 --prefix backend -- --only=joint-voi
 *
 * 所有子实验共享同一个 V70_RUN_ID，输出到 evaluation/v70/<run-id>/。
 * 本脚本只负责编排与汇总，不修改任何安全状态、不提交 Git。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const RUN_ID = process.env.V70_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v70', RUN_ID);
fs.mkdirSync(OUT, { recursive: true });

const onlyArg = process.argv.find(argument => argument.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : 'all';
const scripts: Array<{ key: string; file: string }> = [
  { key: 'prediction', file: 'v70-prediction-benchmark.ts' },
  { key: 'planning', file: 'v70-planning-benchmark.ts' },
  { key: 'joint-voi', file: 'v70-joint-voi-benchmark.ts' },
];
const selected = only === 'all' ? scripts : scripts.filter(item => item.key === only);
if (selected.length === 0) {
  console.error(`未知 --only 取值：${only}（可用：prediction / planning / joint-voi / all）`);
  process.exit(2);
}

for (const item of selected) {
  const started = Date.now();
  console.log(`[v70] running ${item.key} ...`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve(__dirname, item.file)], {
    env: { ...process.env, V70_RUN_ID: RUN_ID },
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });
  if (result.status !== 0) {
    console.error(`[v70] ${item.key} failed with exit code ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }
  console.log(`[v70] ${item.key} done in ${Date.now() - started}ms`);
}

// 汇总关键数字（只读取已生成文件，不重新计算）。
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
const planning = readJson('planning_summary.json');
const joint = readJson('joint_voi_summary.json');

const summaryLines: string[] = [
  '# SkyGuard V7.0 实验汇总',
  '',
  `> 运行 ID：\`${RUN_ID}\`。全部为合成数据；不代表真实场馆效果。`,
  `> 生成时间：${new Date().toISOString()}`,
  '',
];
if (prediction) {
  const mechanisms = Object.keys(prediction.summary);
  const rows = mechanisms.map(mechanism => {
    const values = prediction.summary[mechanism];
    const methods = Object.keys(values);
    const best = methods.reduce((current, method) => values[method].aggregate.mae < values[current].aggregate.mae ? method : current, methods[0]);
    return `- 预测 ${mechanism}：最佳 ${best}（MAE ${values[best].aggregate.mae}）；ensemble_v70 MAE ${values.ensemble_v70.aggregate.mae}，95% 覆盖 ${values.ensemble_v70.aggregate.coverage95}。`;
  });
  summaryLines.push('## 预测', ...rows, '');
}
if (planning) {
  summaryLines.push('## 规划');
  for (const [strategy, value] of Object.entries(planning.summary) as Array<[string, any]>) {
    summaryLines.push(`- ${strategy}：未疏散 ${value.unserved.mean}，完成时间 ${value.makespan.mean}，队列人·分钟 ${value.queue_person_minutes.mean}，校验通过率 ${value.validator_valid_rate}。`);
  }
  summaryLines.push('');
}
if (joint) {
  summaryLines.push('## 联合 VoI');
  for (const [strategy, value] of Object.entries(joint.summary) as Array<[string, any]>) {
    summaryLines.push(`- ${strategy}：风险降低 ${value.benefit.mean}，最坏区域终风险 ${value.worst_final_risk.mean}，检测准确率 ${value.detection_accuracy.mean}，成本 ${value.cost.mean}。`);
  }
  summaryLines.push('');
}
summaryLines.push('## 解释边界', '', '- 结果只适用于本仓库合成场景、合成入流与未标定参数；不得表述为真实场馆效果。', '- 负向与混合结果保留在各自 README、summary 与 rows 文件中。', '');
fs.writeFileSync(path.join(OUT, 'V70_SUMMARY.md'), `${summaryLines.join('\n')}\n`);

// 汇总清单：覆盖所有实验文件（排除根 MANIFEST 自身）。
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
  note: 'V7.0 实验根清单；覆盖 prediction/planning/joint-voi 三组证据与汇总。',
  file_count: files.length,
  files,
}, null, 2)}\n`);
fs.writeFileSync(path.resolve(__dirname, '../../evaluation/v70/LATEST.txt'), `${RUN_ID}\n`);
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

console.log(`[v70] all selected experiments complete: evaluation/v70/${RUN_ID}/`);
console.log(`[v70] summary: evaluation/v70/${RUN_ID}/V70_SUMMARY.md`);
