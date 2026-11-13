/**
 * V7.4 Phase 2：surge/regime 检测与误报评估。
 *
 *   npm run benchmark:v74 --prefix backend -- --only=surge
 *
 * 对比：
 *  - 现有 OnlineChangePointDetector（CUSUM + spike）
 *  - 朴素 3σ 阈值基线
 * 指标：检测率、检测延迟、稳定段误报/100 步。
 * 合成序列；不代表真实预测精度。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { OnlineChangePointDetector } from '../src/services/mvp/conformal';

const RUN_ID = process.env.V74_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v74', RUN_ID);
const SEEDS = Array.from({ length: 30 }, (_, index) => 20261111 + index);
const MECHANISMS = ['stable', 'surge', 'regime_shift', 'noisy'] as const;
type Mechanism = (typeof MECHANISMS)[number];
const CHANGE_STEP = 30;
const WINDOW = 10;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  const v = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface SeriesResult { values: number[]; changeStep: number | null }
function seriesFor(mechanism: Mechanism, seed: number): SeriesResult {
  const rng = mulberry32(seed * 1009 + MECHANISMS.indexOf(mechanism) * 104_729);
  const values: number[] = [];
  for (let t = 0; t < 60; t += 1) {
    let value = 300 + gaussian(rng) * 5;
    if (mechanism === 'stable') value = 300 + gaussian(rng) * 8;
    if (mechanism === 'surge' && t >= CHANGE_STEP) value += 2 * (t - CHANGE_STEP + 1);
    if (mechanism === 'regime_shift' && t >= CHANGE_STEP) value += 2 * (t - CHANGE_STEP + 1);
    if (mechanism === 'regime_shift' && t >= 45) value -= 4 * (t - 44);
    if (mechanism === 'noisy') value += gaussian(rng) * 25;
    values.push(value);
  }
  return { values, changeStep: mechanism === 'stable' || mechanism === 'noisy' ? null : CHANGE_STEP };
}

class NaiveThresholdDetector {
  private window: number[] = [];
  private mean = 0;
  private variance = 0;
  update(residual: number): boolean {
    this.window.push(residual);
    if (this.window.length > 30) this.window.shift();
    const n = this.window.length;
    this.mean += (residual - this.mean) / n;
    this.variance += (residual - this.mean) * (residual - this.mean);
    const sd = n > 1 ? Math.sqrt(this.variance / (n - 1)) : 0;
    return n >= 10 && sd > 1e-9 && residual > this.mean + 3 * sd;
  }
}

interface Outcome {
  mechanism: Mechanism;
  seed: number;
  detector: 'changepoint' | 'naive3sigma';
  detected: boolean;
  latency: number | null;
  false_alarms: number;
  false_alarms_per_100: number;
  detections_on_stable: number;
}

function runDetector(mechanism: Mechanism, seed: number, kind: 'changepoint' | 'naive3sigma'): Outcome {
  const { values, changeStep } = seriesFor(mechanism, seed);
  const changepoint = new OnlineChangePointDetector();
  const naive = new NaiveThresholdDetector();
  let baseline = 0;
  let baselineCount = 0;
  let detected = false;
  let latency: number | null = null;
  let falseAlarms = 0;
  for (let t = 0; t < values.length; t += 1) {
    const residual = Math.abs(values[t] - 300);
    const beforeChange = changeStep === null || t < changeStep;
    if (beforeChange) {
      baseline += residual;
      baselineCount += 1;
    }
    const alarm = kind === 'changepoint'
      ? changepoint.update(residual).detected
      : naive.update(residual);
    if (beforeChange && alarm) falseAlarms += 1;
    if (!beforeChange && !detected && alarm && t < (changeStep ?? 0) + WINDOW) {
      detected = true;
      latency = t - (changeStep ?? 0);
    }
  }
  return {
    mechanism,
    seed,
    detector: kind,
    detected,
    latency,
    false_alarms: falseAlarms,
    false_alarms_per_100: Number((falseAlarms / Math.max(1, baselineCount) * 100).toFixed(4)),
    detections_on_stable: mechanism === 'stable' ? (detected ? 1 : 0) : 0,
  };
}

const rows: Outcome[] = [];
for (const mechanism of MECHANISMS) {
  for (const seed of SEEDS) {
    rows.push(runDetector(mechanism, seed, 'changepoint'));
    rows.push(runDetector(mechanism, seed, 'naive3sigma'));
  }
}

const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const summary = Object.fromEntries(['changepoint', 'naive3sigma'].map(detector => [detector, Object.fromEntries(MECHANISMS.map(mechanism => {
  const subset = rows.filter(row => row.detector === detector && row.mechanism === mechanism);
  const latencies = subset.map(row => row.latency).filter((value): value is number => value !== null);
  return [mechanism, {
    n: subset.length,
    detection_rate: Number((subset.filter(row => row.detected).length / Math.max(1, subset.length)).toFixed(4)),
    median_latency: median(latencies),
    mean_latency: Number(mean(latencies).toFixed(3)),
    false_alarms_per_100: Number(mean(subset.map(row => row.false_alarms_per_100)).toFixed(4)),
    stable_false_positive_rate: mechanism === 'stable'
      ? Number((subset.filter(row => row.false_alarms > 0).length / Math.max(1, subset.length)).toFixed(4))
      : null,
  }];
}))]));

fs.mkdirSync(OUT, { recursive: true });
const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('surge_rows.json', rows);
write('surge_summary.json', {
  config: { seeds: SEEDS, mechanisms: MECHANISMS, change_step: CHANGE_STEP, detection_window: WINDOW, data_nature: 'synthetic；不代表真实预测精度。' },
  summary,
});

const report = `# V7.4 Surge/Regime 检测实验

> 运行 ID：\`${RUN_ID}\`。30 种子 × 4 机制 × 2 检测器；合成序列，不代表真实预测精度。

## 结果

| 检测器 | 机制 | 检测率 | 中位延迟 | 平均延迟 | 误报/100 步 |
| --- | --- | --- | --- | --- | --- |
${['changepoint', 'naive3sigma'].flatMap(detector => MECHANISMS.map(mechanism => {
  const v = (summary as any)[detector][mechanism];
  return `| ${detector} | ${mechanism} | ${v.detection_rate} | ${v.median_latency} | ${v.mean_latency} | ${v.false_alarms_per_100} |`;
})).join('\n')}

## 解释

- 检测对象是相对基线的残差 \(|value-300|\)，不是疏散预测误差；
- stable 段误报率反映检测器噪声敏感性；
- 结果只用于选择门控策略，不得表述为真实人群突增检测精度。
`;
fs.writeFileSync(path.join(OUT, 'surge_README.md'), report);
fs.writeFileSync(path.join(OUT, 'surge_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(), run_id: RUN_ID,
  node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);
const files = fs.readdirSync(OUT).filter(name => name.startsWith('surge_')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'surge_MANIFEST.json'), `${JSON.stringify({ version: 1, run_id: RUN_ID, note: 'V7.4 surge 检测证据（合成）。', file_count: manifest.length, files: manifest }, null, 2)}\n`);

console.log(`V7.4 surge benchmark complete: evaluation/v74/${RUN_ID}/`);
for (const detector of ['changepoint', 'naive3sigma']) {
  console.log(detector, MECHANISMS.map(m => `${m}=${(summary as any)[detector][m].detection_rate}/${(summary as any)[detector][m].median_latency}`).join(', '));
}
