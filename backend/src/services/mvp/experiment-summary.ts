/**
 * 竞赛基准摘要读取。
 *
 * 只读取 evaluation/competition 下已生成的文件；缺失或损坏时返回 available=false，
 * 不在运行时重新跑实验。
 */
import fs from 'node:fs';
import path from 'node:path';

export function readExperimentSummary(): Record<string, unknown> {
  const dir = path.resolve(__dirname, '../../../../evaluation/competition');
  const files: Record<string, string> = {
    voi: 'experiment_a_voi.json',
    prediction: 'experiment_b_prediction.json',
    planning: 'experiment_c_planning_robustness.json',
    safety: 'experiment_d_safety_faults.json',
    business: 'experiment_e_business_loop.json',
    latency: 'experiment_f_latency.json',
  };
  const experiments: Record<string, unknown> = {};
  for (const [key, file] of Object.entries(files)) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      experiments[key] = parsed.summary ?? parsed.results ?? null;
    } catch { /* ignore corrupt file */ }
  }
  return {
    available: Object.keys(experiments).length > 0,
    generated_at: fs.existsSync(path.join(dir, 'run_metadata.json'))
      ? JSON.parse(fs.readFileSync(path.join(dir, 'run_metadata.json'), 'utf8')).generated_at
      : null,
    experiments,
    report_path: 'evaluation/COMPETITION_REPORT.md',
    note: '全部为合成数据基准；不代表真实场地或平台效果。',
  };
}
