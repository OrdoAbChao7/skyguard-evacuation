/**
 * V7.1 预测区间突破实验。
 *
 *   npm run benchmark:v71 --prefix backend -- --only=prediction
 *
 * 对照（同一组点预测，只改变区间机制）：
 *  - v70_static：V7.0 集成区间（历史残差 split-conformal + 漂移放大）；
 *  - aci：在线自适应 conformal（ACI），按实际覆盖更新误覆盖率；
 *  - aci_cp：ACI + 在线变点检测（触发时清空旧残差并加宽）。
 *
 * 30 固定种子 × 7 机制；严格按时间顺序在线更新，第 t 步只使用 t 之前的残差/覆盖结果。
 * 重点报告 surge 与 regime_shift 的 95% 覆盖率、区间宽度与可靠性门控失败率。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensembleForecast } from '../src/services/mvp/forecast-advanced';
import {
  AdaptiveConformalCalibrator,
  OnlineChangePointDetector,
  assessConformalReliability,
} from '../src/services/mvp/conformal';

const SEEDS = Array.from({ length: 30 }, (_, index) => 20261109 + index);
const RUN_ID = process.env.V71_RUN_ID ?? process.env.V70_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v71', RUN_ID);
const HORIZON = 5;
const SERIES_LENGTH = 60;
const MIN_TRAIN = 25;
const RELIABILITY_THRESHOLD = 0.5;

type Mechanism = 'stable' | 'surge' | 'decline' | 'periodic' | 'missing' | 'noisy' | 'regime_shift';
type Variant = 'v70_static' | 'aci' | 'aci_cp';
const MECHANISMS: Mechanism[] = ['stable', 'surge', 'decline', 'periodic', 'missing', 'noisy', 'regime_shift'];
const VARIANTS: Variant[] = ['v70_static', 'aci', 'aci_cp'];

const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const std = (values: number[]): number => (values.length < 2 ? 0 : Math.sqrt(values.reduce((s, v) => s + (v - mean(values)) ** 2, 0) / (values.length - 1)));
const ci = (values: number[]) => {
  const m = mean(values);
  const half = values.length > 1 ? 1.96 * std(values) / Math.sqrt(values.length) : 0;
  return { mean: Number(m.toFixed(4)), lower: Number((m - half).toFixed(4)), upper: Number((m + half).toFixed(4)), sd: Number(std(values).toFixed(4)), n: values.length };
};
const dz = (diffs: number[]): number => (std(diffs) === 0 ? 0 : Number((mean(diffs) / std(diffs)).toFixed(4)));

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
function bootstrap(values: number[], iterations = 2000, seed = 43): { lower: number; upper: number } {
  const rng = mulberry32(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(rng() * values.length)];
    stats.push(sum / values.length);
  }
  stats.sort((a, b) => a - b);
  return { lower: Number(stats[Math.floor(iterations * 0.025)].toFixed(4)), upper: Number(stats[Math.floor(iterations * 0.975)].toFixed(4)) };
}
function normalCdf(value: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(value));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * value * value) * poly;
  return value >= 0 ? cdf : 1 - cdf;
}
function pairedPValue(diffs: number[]): number {
  if (diffs.length < 2) return 1;
  const sd = std(diffs);
  if (sd === 0) return mean(diffs) === 0 ? 1 : 0;
  const z = Math.abs(mean(diffs)) / (sd / Math.sqrt(diffs.length));
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(z))));
}
function holm(pValues: Record<string, number>): Record<string, { raw: number; adjusted: number; rejected_0_05: boolean }> {
  const entries = Object.entries(pValues).sort((a, b) => a[1] - b[1]);
  const m = entries.length;
  const result: Record<string, { raw: number; adjusted: number; rejected_0_05: boolean }> = {};
  let previous = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const [key, value] = entries[index];
    const next = Math.min(1, Math.max(previous, (m - index) * value));
    previous = next;
    result[key] = { raw: Number(value.toFixed(6)), adjusted: Number(next.toFixed(6)), rejected_0_05: next < 0.05 };
  }
  return result;
}

function generateSeries(mechanism: Mechanism, seed: number): Array<{ x: number; y: number } | null> {
  const rng = mulberry32(seed * 101 + MECHANISMS.indexOf(mechanism) * 7_919);
  const points: Array<{ x: number; y: number } | null> = [];
  for (let t = 0; t < SERIES_LENGTH; t += 1) {
    let value = 300;
    if (mechanism === 'stable') value = 300 + gaussian(rng) * 12;
    else if (mechanism === 'surge') value = t < 38 ? 220 + gaussian(rng) * 10 : Math.min(1100, 220 + (t - 37) * 28 + gaussian(rng) * 12);
    else if (mechanism === 'decline') value = Math.max(30, 520 - t * 6.5 + gaussian(rng) * 10);
    else if (mechanism === 'periodic') value = 320 + 100 * Math.sin((2 * Math.PI * t) / 20) + gaussian(rng) * 10;
    else if (mechanism === 'noisy') value = 300 + gaussian(rng) * 80;
    else if (mechanism === 'missing') value = 300 + gaussian(rng) * 15;
    else if (mechanism === 'regime_shift') {
      if (t < 20) value = 300 + gaussian(rng) * 10;
      else if (t < 40) value = 300 + (t - 19) * 18 + gaussian(rng) * 10;
      else value = Math.max(40, 300 + 21 * 18 - (t - 39) * 20 + gaussian(rng) * 10);
    }
    const missing = mechanism === 'missing' && rng() < 0.3;
    points.push(missing ? null : { x: t, y: Math.max(0, value) });
  }
  return points;
}

interface Row {
  seed: number;
  mechanism: Mechanism;
  origin: number;
  variant: Variant;
  actual: number;
  predicted: number;
  abs_error: number;
  covered90: boolean;
  covered95: boolean;
  width: number;
  calibrated: boolean;
  alpha: number;
  reliability_status: 'ok' | 'warning' | 'failed' | null;
  change_detected: boolean;
  segment: 'pre_shift' | 'post_shift' | 'none';
}

interface CalibrationOptions {
  gamma?: number;
  bufferSize?: number;
  minBuffer?: number;
  cpThreshold?: number;
}

function runVariant(
  seed: number,
  mechanism: Mechanism,
  points: Array<{ x: number; y: number }>,
  variant: Variant,
  options: CalibrationOptions = {},
): Row[] {
  const rows: Row[] = [];
  const calibrator90 = new AdaptiveConformalCalibrator({
    targetCoverage: 0.9,
    gamma: options.gamma,
    bufferSize: options.bufferSize,
    minBuffer: options.minBuffer,
  });
  const calibrator95 = new AdaptiveConformalCalibrator({
    targetCoverage: 0.95,
    gamma: options.gamma,
    bufferSize: options.bufferSize,
    minBuffer: options.minBuffer,
  });
  const detector = variant === 'aci_cp'
    ? new OnlineChangePointDetector({ threshold: options.cpThreshold ?? 1.2 })
    : null;

  for (let index = 0; index < points.length; index += 1) {
    const train = points.slice(0, index + 1);
    if (train.length < MIN_TRAIN) continue;
    const target = points.find((point, pointIndex) => pointIndex > index && point.x >= points[index].x + HORIZON);
    if (!target) continue;
    const horizon = target.x - train[train.length - 1].x;
    const forecast = ensembleForecast(train, { horizonMinutes: horizon, seed });
    const predicted = forecast.predicted;
    let interval90 = forecast.interval90;
    let interval95 = forecast.interval95;
    let calibrated = false;
    let alpha = 0;
    let reliability: 'ok' | 'warning' | 'failed' | null = null;
    let changeDetected = false;

    if (variant === 'v70_static') {
      reliability = forecast.reliability.status;
    } else {
      interval90 = calibrator90.interval(predicted, forecast.interval90);
      interval95 = calibrator95.interval(predicted, forecast.interval95);
      calibrated = interval95.calibrated;
      alpha = interval95.alpha;
      if (detector) {
        const detection = detector.update(Math.abs(predicted - target.y));
        changeDetected = detection.detected;
        if (detection.detected) {
          calibrator90.onChangePoint(5, { factor: 2.5, steps: 6 });
          calibrator95.onChangePoint(5, { factor: 2.5, steps: 6 });
        }
      }
      const reliabilityResult = assessConformalReliability({
        calibrator: calibrator95,
        interval: interval95,
        predicted,
        changeDetected,
        maxRelativeWidth: RELIABILITY_THRESHOLD,
      });
      reliability = reliabilityResult.status;
    }

    const covered90 = target.y >= interval90.lower && target.y <= interval90.upper;
    const covered95 = target.y >= interval95.lower && target.y <= interval95.upper;
    const segment: Row['segment'] = mechanism === 'regime_shift'
      ? (points[index].x < 20 ? 'pre_shift' : 'post_shift')
      : 'none';
    rows.push({
      seed, mechanism, origin: index, variant,
      actual: Number(target.y.toFixed(4)),
      predicted,
      abs_error: Number(Math.abs(predicted - target.y).toFixed(4)),
      covered90,
      covered95,
      width: interval95.upper - interval95.lower,
      calibrated,
      alpha: Number(alpha.toFixed(4)),
      reliability_status: reliability,
      change_detected: changeDetected,
      segment,
    });

    if (variant !== 'v70_static') {
      calibrator90.update(target.y - predicted, covered90);
      calibrator95.update(target.y - predicted, covered95);
    }
  }
  return rows;
}

function aggregate(rows: Row[]) {
  const n = rows.length;
  return {
    n,
    mae: Number(mean(rows.map(row => row.abs_error)).toFixed(4)),
    coverage90: Number((rows.filter(row => row.covered90).length / Math.max(1, n)).toFixed(4)),
    coverage95: Number((rows.filter(row => row.covered95).length / Math.max(1, n)).toFixed(4)),
    mean_width: Number(mean(rows.map(row => row.width)).toFixed(4)),
    calibrated_rate: Number((rows.filter(row => row.calibrated).length / Math.max(1, n)).toFixed(4)),
    failed_rate: Number((rows.filter(row => row.reliability_status === 'failed').length / Math.max(1, n)).toFixed(4)),
    warning_rate: Number((rows.filter(row => row.reliability_status === 'warning').length / Math.max(1, n)).toFixed(4)),
    change_rate: Number((rows.filter(row => row.change_detected).length / Math.max(1, n)).toFixed(4)),
  };
}

fs.mkdirSync(OUT, { recursive: true });
const rows: Row[] = [];
for (const seed of SEEDS) {
  for (const mechanism of MECHANISMS) {
    const points = generateSeries(mechanism, seed).filter((item): item is { x: number; y: number } => item !== null);
    for (const variant of VARIANTS) rows.push(...runVariant(seed, mechanism, points, variant));
  }
}

const summary = Object.fromEntries(MECHANISMS.map(mechanism => [
  mechanism,
  Object.fromEntries(VARIANTS.map(variant => {
    const subset = rows.filter(row => row.mechanism === mechanism && row.variant === variant);
    return [variant, {
      ...aggregate(subset),
      post_shift_coverage95: mechanism === 'regime_shift'
        ? Number((subset.filter(row => row.segment === 'post_shift' && row.covered95).length
          / Math.max(1, subset.filter(row => row.segment === 'post_shift').length)).toFixed(4))
        : null,
    }];
  })),
]));

// 配对：aci_cp vs v70_static，aci_cp vs aci（coverage95 / width / failed_rate）
const paired: Record<string, unknown> = {};
const holmFamilies: Record<string, Record<string, { raw: number; adjusted: number; rejected_0_05: boolean }>> = {};
for (const reference of ['v70_static', 'aci'] as Variant[]) {
  const pValues: Record<string, number> = {};
  const metrics: Record<string, unknown> = {};
  for (const metric of ['coverage95', 'mean_width', 'failed_rate'] as const) {
    const diffs: number[] = [];
    for (const seed of SEEDS) {
      for (const mechanism of MECHANISMS) {
        const current = rows.filter(row => row.variant === 'aci_cp' && row.seed === seed && row.mechanism === mechanism);
        const baseline = rows.filter(row => row.variant === reference && row.seed === seed && row.mechanism === mechanism);
        if (current.length === 0 || baseline.length === 0) continue;
        diffs.push(aggregate(current)[metric] - aggregate(baseline)[metric]);
      }
    }
    metrics[metric] = { mean_diff: Number(mean(diffs).toFixed(4)), ci: ci(diffs), bootstrap: bootstrap(diffs), cohen_dz: dz(diffs), n: diffs.length };
    pValues[metric] = pairedPValue(diffs);
  }
  paired[reference] = metrics;
  holmFamilies[reference] = holm(pValues);
}

// 敏感性：gamma / buffer / 变点阈值（10 个种子）
const sensitivity: Record<string, unknown> = {};
for (const gamma of [0.02, 0.05, 0.1]) {
  const subset: Row[] = [];
  for (const seed of SEEDS.slice(0, 10)) {
    for (const mechanism of MECHANISMS) {
      const points = generateSeries(mechanism, seed).filter((item): item is { x: number; y: number } => item !== null);
      subset.push(...runVariant(seed, mechanism, points, 'aci_cp', { gamma }));
    }
  }
  sensitivity[`gamma_${gamma}`] = Object.fromEntries(MECHANISMS.map(mechanism => [mechanism, aggregate(subset.filter(row => row.mechanism === mechanism))]));
}
for (const bufferSize of [20, 40, 80]) {
  const subset: Row[] = [];
  for (const seed of SEEDS.slice(0, 10)) {
    for (const mechanism of MECHANISMS) {
      const points = generateSeries(mechanism, seed).filter((item): item is { x: number; y: number } => item !== null);
      subset.push(...runVariant(seed, mechanism, points, 'aci_cp', { bufferSize }));
    }
  }
  sensitivity[`buffer_${bufferSize}`] = Object.fromEntries(MECHANISMS.map(mechanism => [mechanism, aggregate(subset.filter(row => row.mechanism === mechanism))]));
}
for (const cpThreshold of [0.8, 1.2, 2.0]) {
  const subset: Row[] = [];
  for (const seed of SEEDS.slice(0, 10)) {
    for (const mechanism of MECHANISMS) {
      const points = generateSeries(mechanism, seed).filter((item): item is { x: number; y: number } => item !== null);
      subset.push(...runVariant(seed, mechanism, points, 'aci_cp', { cpThreshold }));
    }
  }
  sensitivity[`cp_threshold_${cpThreshold}`] = Object.fromEntries(MECHANISMS.map(mechanism => [mechanism, aggregate(subset.filter(row => row.mechanism === mechanism))]));
}

const worst = [...rows.filter(row => row.variant === 'aci_cp')].sort((a, b) => b.abs_error - a.abs_error).slice(0, 20);

const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('prediction_rows.json', rows);
write('prediction_summary.json', {
  config: {
    seeds: SEEDS,
    mechanisms: MECHANISMS,
    variants: VARIANTS,
    horizon_steps: HORIZON,
    min_train_points: MIN_TRAIN,
    reliability_threshold: RELIABILITY_THRESHOLD,
    data_nature: '全部为合成数据；不代表真实场馆精度。',
    protocol: '在线因果更新：第 t 步区间只用 t 之前的残差与覆盖结果；点预测与 V7.0 相同。',
  },
  summary,
  paired,
  holm_families: holmFamilies,
  sensitivity,
  worst_cases: worst,
});

const report = `# V7.1 预测区间突破实验

> 运行 ID：\`${RUN_ID}\`。**全部为合成数据**；点预测与 V7.0 相同，只改变区间机制。
> 在线因果更新：第 t 步只用 t 之前的残差与覆盖结果。

## 1. 主结果（30 种子，按机制聚合）

| 机制 | 变体 | MAE | 90% 覆盖 | 95% 覆盖 | 平均宽度 | 已校准率 | 门控失败率 | 变点触发率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${MECHANISMS.flatMap(mechanism => VARIANTS.map(variant => {
  const value = (summary as any)[mechanism][variant];
  return `| ${mechanism} | ${variant} | ${value.mae} | ${value.coverage90} | ${value.coverage95} | ${value.mean_width} | ${value.calibrated_rate} | ${value.failed_rate} | ${value.change_rate} |`;
})).join('\n')}

- regime_shift 后段 95% 覆盖：${VARIANTS.map(variant => `${variant} ${(summary as any).regime_shift[variant].post_shift_coverage95}`).join('；')}。
- surge 95% 覆盖：${VARIANTS.map(variant => `${variant} ${(summary as any).surge[variant].coverage95}`).join('；')}。

## 2. 配对比较（aci_cp − 对照）

${['v70_static', 'aci'].map(reference => `### vs ${reference}\n\n| 指标 | 平均差 [95% CI] | Bootstrap | d_z | Holm 校正 p | 显著 |\n| --- | --- | --- | --- | --- | --- |\n${(['coverage95', 'mean_width', 'failed_rate'] as const).map(metric => {
  const value = (paired as any)[reference][metric];
  const holmValue = holmFamilies[reference][metric];
  return `| ${metric} | ${value.mean_diff} [${value.ci.lower}, ${value.ci.upper}] | [${value.bootstrap.lower}, ${value.bootstrap.upper}] | ${value.cohen_dz} | ${holmValue.adjusted} | ${holmValue.rejected_0_05 ? '是' : '否'} |`;
}).join('\n')}`).join('\n\n')}

## 3. 敏感性与失败案例

- γ 敏感性（surge 95% 覆盖）：0.02=${(sensitivity as any)['gamma_0.02']?.surge?.coverage95}，0.05=${(sensitivity as any)['gamma_0.05']?.surge?.coverage95}，0.1=${(sensitivity as any)['gamma_0.1']?.surge?.coverage95}。
- 缓冲大小（surge 95% 覆盖）：20=${(sensitivity as any)['buffer_20']?.surge?.coverage95}，40=${(sensitivity as any)['buffer_40']?.surge?.coverage95}，80=${(sensitivity as any)['buffer_80']?.surge?.coverage95}。
- 变点阈值（surge 95% 覆盖 / 触发率）：0.8=${(sensitivity as any)['cp_threshold_0.8']?.surge?.coverage95}/${(sensitivity as any)['cp_threshold_0.8']?.surge?.change_rate}，1.2=${(sensitivity as any)['cp_threshold_1.2']?.surge?.coverage95}/${(sensitivity as any)['cp_threshold_1.2']?.surge?.change_rate}，2.0=${(sensitivity as any)['cp_threshold_2.0']?.surge?.coverage95}/${(sensitivity as any)['cp_threshold_2.0']?.surge?.change_rate}。
- 失败案例保留在 \`prediction_rows.json\` 与 \`worst_cases\`；未删除任何种子/机制。

## 4. 解释边界

- 合成机制不等同真实人群动力学；点预测仍是 V7.0 集成，未重新训练；
- ACI 的目标是覆盖校准，不是降低 MAE；MAE 不变是预期结果；
- 区间不是正式统计置信区间；即使覆盖改善，也不得直接用于安全告警阈值；
- 可靠性门控失败时，预测不得进入 VoI/规划；安全四态仍由观测可信度决定。
`;
fs.writeFileSync(path.join(OUT, 'prediction_README.md'), report);
fs.writeFileSync(path.join(OUT, 'prediction_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);

const files = fs.readdirSync(OUT).filter(name => name.startsWith('prediction_')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'prediction_MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, note: 'V7.1 预测区间实验独立清单。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.1 prediction benchmark complete: evaluation/v71/${RUN_ID}/`);
console.log(`surge coverage95: ${VARIANTS.map(variant => `${variant}=${(summary as any).surge[variant].coverage95}`).join(', ')}`);
console.log(`regime_shift post coverage95: ${VARIANTS.map(variant => `${variant}=${(summary as any).regime_shift[variant].post_shift_coverage95}`).join(', ')}`);
