/**
 * 证据一致性校验：从原始 JSON 重新计算关键统计量，与汇总报告/JSON 对比。
 *
 *   npm run verify:evidence --prefix backend
 *
 * 退出码 0 = 全部通过；1 = 存在不一致。
 * 不重新运行仿真，只做"原始数据 → 汇总数字"的独立复算，防止手改报告或脚本漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

const ROOT = path.resolve(__dirname, '../..');
const V61 = path.join(ROOT, 'evaluation/v61');
const checks: Array<{ name: string; expected: unknown; actual: unknown; pass: boolean; note?: string }> = [];

function read<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(V61, name), 'utf8')) as T;
}

function close(actual: number, expected: number, tolerance = 1e-3): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function check(name: string, expected: unknown, actual: unknown, pass: boolean, note?: string) {
  checks.push({ name, expected, actual, pass, note });
}

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const std = (values: number[]) => values.length < 2 ? 0 : Math.sqrt(values.reduce((s, v) => s + (v - mean(values)) ** 2, 0) / (values.length - 1));

// ---------------- A. 多区域公平实验 ----------------
const a = read<any>('experiment_a_fair_multi_region.json');
const aRows = a.raw.filter((row: any) => row.quality === 0.6 && row.budget === 2);
const aSummary = a.summary['q0.6_b2'];
for (const strategy of ['single', 'multi', 'fixed', 'random', 'heuristic']) {
  const subset = aRows.filter((row: any) => row.strategy === strategy);
  const benefit = mean(subset.map((row: any) => row.benefit));
  const cost = mean(subset.map((row: any) => row.cost));
  const covered = mean(subset.map((row: any) => row.unique_covered));
  const efficiency = mean(subset.map((row: any) => row.benefit / Math.max(1e-6, row.cost)));
  check(`A/${strategy}/benefit`, aSummary[strategy].benefit.mean, Number(benefit.toFixed(4)), close(benefit, aSummary[strategy].benefit.mean));
  check(`A/${strategy}/cost`, aSummary[strategy].cost.mean, Number(cost.toFixed(4)), close(cost, aSummary[strategy].cost.mean));
  check(`A/${strategy}/covered`, aSummary[strategy].unique_covered.mean, Number(covered.toFixed(4)), close(covered, aSummary[strategy].unique_covered.mean));
  check(`A/${strategy}/efficiency`, aSummary[strategy].benefit_per_cost.mean, Number(efficiency.toFixed(4)), close(efficiency, aSummary[strategy].benefit_per_cost.mean, 2e-3));
}

const multiRows = aRows.filter((row: any) => row.strategy === 'multi');
const singleRows = aRows.filter((row: any) => row.strategy === 'single');
const pairedDiffs: number[] = [];
for (const row of multiRows) {
  const single = singleRows.find((other: any) => other.trial === row.trial && other.seed === row.seed);
  if (single) pairedDiffs.push(row.benefit - single.benefit);
}
const pairedMean = mean(pairedDiffs);
const dz = std(pairedDiffs) === 0 ? 0 : pairedMean / std(pairedDiffs);
check('A/paired_mean', a.paired_multi_minus_single.benefit_diff.mean, Number(pairedMean.toFixed(4)), close(pairedMean, a.paired_multi_minus_single.benefit_diff.mean));
check('A/cohen_dz', a.paired_multi_minus_single.benefit_diff.cohen_dz, Number(dz.toFixed(4)), close(dz, a.paired_multi_minus_single.benefit_diff.cohen_dz, 2e-3));
check('A/paired_n', a.paired_multi_minus_single.n, pairedDiffs.length, a.paired_multi_minus_single.n === pairedDiffs.length);

// ---------------- B. 序贯审计 ----------------
const b = read<any>('experiment_b_sequential_audit.json');
const bKey = b.summary['p0.3_b2'];
for (const useRetry of [false, true]) {
  const key = useRetry ? 'retry' : 'no_retry';
  const subset = b.raw.filter((row: any) => row.failureProbability === 0.3 && row.budget === 2 && row.useRetry === useRetry);
  const rate = (field: string) => Number((subset.filter((row: any) => row[field]).length / subset.length).toFixed(4));
  check(`B/${key}/success`, bKey[key].success_rate, rate('success'), close(rate('success'), bKey[key].success_rate));
  check(`B/${key}/detection`, bKey[key].detection_accuracy, rate('detection_correct'), close(rate('detection_correct'), bKey[key].detection_accuracy));
  check(`B/${key}/decision`, bKey[key].decision_accuracy, rate('decision_correct'), close(rate('decision_correct'), bKey[key].decision_accuracy));
}

// ---------------- C. 严格预测（由 per-series 指标复算） ----------------
const c = read<any>('experiment_c_strict_prediction.json');
for (const [key, summary] of Object.entries<any>(c.summary)) {
  const series = c.series_metrics.filter((item: any) => `${item.name}_h${item.horizon}` === key);
  const adaptive = mean(series.map((item: any) => item.mae.adaptive));
  const coverage90 = mean(series.map((item: any) => item.coverage90));
  const coverage95 = mean(series.map((item: any) => item.coverage95));
  check(`C/${key}/adaptive_mae`, summary.mae.adaptive.mean, Number(adaptive.toFixed(4)), close(adaptive, summary.mae.adaptive.mean));
  check(`C/${key}/coverage90`, summary.coverage90, Number(coverage90.toFixed(4)), close(coverage90, summary.coverage90));
  check(`C/${key}/coverage95`, summary.coverage95, Number(coverage95.toFixed(4)), close(coverage95, summary.coverage95));
}

// ---------------- D. 风险图 ----------------
const d = read<any>('experiment_d_risk_graph_sensitivity.json');
check('D/baseline_tau', 1, d.ranking_stability.baseline.mean_tau, d.ranking_stability.baseline.mean_tau === 1);
check('D/damping0_lower', true, d.ranking_stability.damping_0.mean_tau < 1, d.ranking_stability.damping_0.mean_tau < 1);
check('D/connected', true, d.graph.connected === true, d.graph.connected === true);

// ---------------- E. 感知匹配 ----------------
const e = read<any>('experiment_e_perception_audit.json');
check('E/optimal_tp', 2, e.optimal_matching_example.true_positives, e.optimal_matching_example.true_positives === 2);

// ---------------- 报告文本包含关键数字 ----------------
const reportPath = path.join(ROOT, 'evaluation/V6_1_REPORT.md');
const report = fs.readFileSync(reportPath, 'utf8');
for (const token of ['0.189', '0.92', '0.6164', 'V6.1']) {
  check(`report/contains/${token}`, true, report.includes(token), report.includes(token));
}

// ---------------- V6.2 30 种子证据 ----------------
const V62 = path.join(ROOT, 'evaluation/v62');
function read62<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(V62, name), 'utf8')) as T;
}
const a62 = read62<any>('experiment_a_multi_region_30seeds.json');
const a62Multi = a62.raw.filter((row: any) => row.strategy === 'multi');
const a62Single = a62.raw.filter((row: any) => row.strategy === 'single');
for (const strategy of ['single', 'multi', 'fixed', 'random', 'heuristic']) {
  const subset = a62.raw.filter((row: any) => row.strategy === strategy);
  const benefit = mean(subset.map((row: any) => row.benefit));
  check(`V62/A/${strategy}/benefit`, a62.summary[strategy].benefit.mean, Number(benefit.toFixed(4)), close(benefit, a62.summary[strategy].benefit.mean));
}
const a62Diffs = a62Multi.map((row: any) => {
  const other = a62Single.find((item: any) => item.seed === row.seed && item.trial === row.trial)!;
  return row.benefit - other.benefit;
});
check('V62/A/paired_mean', a62.paired.trial_level.mean, Number(mean(a62Diffs).toFixed(4)), close(mean(a62Diffs), a62.paired.trial_level.mean));
const dz62 = std(a62Diffs) === 0 ? 0 : mean(a62Diffs) / std(a62Diffs);
check('V62/A/paired_dz', a62.paired.trial_level.cohen_dz, Number(dz62.toFixed(4)), close(dz62, a62.paired.trial_level.cohen_dz, 2e-3));
check('V62/A/n', 1200, a62Diffs.length, a62Diffs.length === 1200);

const b62 = read62<any>('experiment_b_sequential_30seeds.json');
const b62Rows = b62.raw;
const rate62 = (field: string) => Number((b62Rows.filter((row: any) => row[field]).length / b62Rows.length).toFixed(4));
check('V62/B/success', b62.summary.success_rate, rate62('success'), close(rate62('success'), b62.summary.success_rate));
check('V62/B/detection', b62.summary.detection_accuracy, rate62('detection_correct'), close(rate62('detection_correct'), b62.summary.detection_accuracy));
check('V62/B/decision', b62.summary.decision_accuracy, rate62('decision_correct'), close(rate62('decision_correct'), b62.summary.decision_accuracy));

const c62 = read62<any>('experiment_c_prediction_30seeds.json');
for (const summary of c62.results) {
  const key = `${summary.scenario}_h${summary.horizon}`;
  const series = c62.series_metrics.filter((item: any) => item.name === summary.scenario && item.horizon === summary.horizon);
  const adaptive = mean(series.map((item: any) => item.mae.adaptive));
  const coverage95 = mean(series.map((item: any) => item.coverage95));
  check(`V62/C/${key}/adaptive_mae`, summary.mae.adaptive.mean, Number(adaptive.toFixed(4)), close(adaptive, summary.mae.adaptive.mean));
  check(`V62/C/${key}/coverage95`, summary.coverage95, Number(coverage95.toFixed(4)), close(coverage95, summary.coverage95));
}

// V6.1 冻结哈希
const freeze = JSON.parse(fs.readFileSync(path.join(V62, 'freeze_v61.json'), 'utf8')) as any;
for (const file of freeze.files) {
  const full = path.join(ROOT, file.path);
  const hash = fs.existsSync(full) ? crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') : null;
  check(`freeze/${file.path}`, file.sha256, hash, hash === file.sha256);
}

// V6.2 报告关键数字
const report62 = fs.readFileSync(path.join(ROOT, 'evaluation/V6_2_REPORT.md'), 'utf8');
for (const token of ['0.2154', '0.0917', '30 个独立种子']) {
  check(`V62/report/${token}`, true, report62.includes(token), report62.includes(token));
}

// 来源 URL 审计
const sourceAudit = read62<any>('source_verification.json');
check('sources/total', 38, sourceAudit.total, sourceAudit.total === 38);
check('sources/reachable', 28, sourceAudit.reachable, sourceAudit.reachable === 28);

const failed = checks.filter(item => !item.pass);
const output = {
  generated_at: new Date().toISOString(),
  git_head: execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(),
  checks: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  failures: failed,
  results: checks,
};
fs.writeFileSync(path.join(V61, 'verification.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`[verify] ${output.passed}/${output.checks} checks passed; git=${output.git_head.slice(0, 8)}`);
if (failed.length > 0) {
  console.error('失败项：');
  for (const item of failed) console.error(` - ${item.name}: expected=${JSON.stringify(item.expected)} actual=${JSON.stringify(item.actual)}`);
  process.exit(1);
}
