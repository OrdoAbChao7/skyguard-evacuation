/**
 * V7.1 预测对照实验。
 *
 *   npm run benchmark:v70 --prefix backend -- --only=prediction
 *
 * 设计：
 *  - 30 个固定种子；7 种合成机制（stable/surge/decline/periodic/missing/noisy/regime_shift）；
 *  - 严格滚动起点：每个起点只用过去数据训练/选择/校准，目标点不参与；
 *  - 方法：persistence/ema/damped/blend/linear/kalman/arima/holt_winters/lstm_online/
 *          adaptive(旧滚动选择)/ensemble_v70(状态感知集成 + conformal)；
 *  - 指标：MAE/RMSE/NAE、90%/95% 覆盖率、平均宽度、可靠性失败率；
 *  - 统计：配对比较、Bootstrap 置信区间、Cohen's d_z、Holm-Bonferroni 多重比较校正；
 *  - 消融：关闭状态感知、关闭漂移放大、正态区间、等权；
 *  - 敏感性：验证起点数、conformal 名义水平、可靠性阈值；
 *  - 失败案例保留在 rows.json 与 worst_cases。
 *
 * 全部为合成数据；不代表真实场馆精度。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  baseModelForecast,
  detectRegime,
  ensembleForecast,
  type AdvancedMethod,
  type RegimeLabel,
} from '../src/services/mvp/forecast-advanced';
import { selectForecastMethod, type ForecastMethod } from '../src/services/mvp/prediction';

export const V70_SEEDS = Array.from({ length: 30 }, (_, index) => 20261109 + index);
export const V70_RUN_ID = process.env.V70_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
export const V70_OUT = path.resolve(__dirname, '../../evaluation/v70', V70_RUN_ID);

type Mechanism = 'stable' | 'surge' | 'decline' | 'periodic' | 'missing' | 'noisy' | 'regime_shift';
type Method = AdvancedMethod | 'adaptive';

const MECHANISMS: Mechanism[] = ['stable', 'surge', 'decline', 'periodic', 'missing', 'noisy', 'regime_shift'];
const METHODS: Method[] = [
  'persistence', 'ema', 'damped', 'blend', 'linear',
  'kalman', 'arima', 'holt_winters', 'lstm_online',
  'adaptive', 'ensemble_v70',
];
const HORIZON = 5;
const SERIES_LENGTH = 60;
const MIN_TRAIN = 25;
const RELIABILITY_THRESHOLD = 0.5;

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

function bootstrap(values: number[], iterations = 2000, seed = 23): { lower: number; upper: number } {
  const rng = mulberry32(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(rng() * values.length)];
    stats.push(sum / values.length);
  }
  stats.sort((a, b) => a - b);
  return {
    lower: Number(stats[Math.floor(iterations * 0.025)].toFixed(4)),
    upper: Number(stats[Math.floor(iterations * 0.975)].toFixed(4)),
  };
}

function clusterBootstrap(groups: number[][], iterations = 2000, seed = 29): { lower: number; upper: number } {
  const rng = mulberry32(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    let count = 0;
    for (let g = 0; g < groups.length; g += 1) {
      const group = groups[Math.floor(rng() * groups.length)];
      for (let j = 0; j < group.length; j += 1) {
        sum += group[Math.floor(rng() * group.length)];
        count += 1;
      }
    }
    stats.push(sum / Math.max(1, count));
  }
  stats.sort((a, b) => a - b);
  return {
    lower: Number(stats[Math.floor(iterations * 0.025)].toFixed(4)),
    upper: Number(stats[Math.floor(iterations * 0.975)].toFixed(4)),
  };
}

function normalCdf(value: number): number {
  // Abramowitz–Stegun 近似
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
  const adjusted: Record<string, { raw: number; adjusted: number; rejected_0_05: boolean }> = {};
  let previous = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const [key, value] = entries[index];
    const next = Math.min(1, Math.max(previous, (m - index) * value));
    previous = next;
    adjusted[key] = { raw: Number(value.toFixed(6)), adjusted: Number(next.toFixed(6)), rejected_0_05: next < 0.05 };
  }
  return adjusted;
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

function residualStdPoints(points: Array<{ x: number; y: number }>): number {
  if (points.length < 3) return Math.max(5, mean(points.map(item => item.y)) * 0.2);
  const meanX = mean(points.map(item => item.x));
  const meanY = mean(points.map(item => item.y));
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;
  const residuals = points.map(item => item.y - (intercept + slope * item.x));
  return Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, points.length - 2));
}

function historicalErrorQuantile(
  train: Array<{ x: number; y: number }>,
  method: AdvancedMethod,
  horizonMinutes: number,
  quantileLevel: number,
  seed: number,
  origins = 12,
): number | null {
  const errors: number[] = [];
  const lastIndex = train.length - 1 - Math.ceil(horizonMinutes) - 1;
  const start = Math.max(2, lastIndex - origins + 1);
  for (let index = start; index <= lastIndex; index += 1) {
    const trainPrefix = train.slice(0, index + 1);
    const targetX = train[index].x + horizonMinutes;
    const target = train.find((point, pointIndex) => pointIndex > index && point.x >= targetX);
    if (!target) continue;
    const horizon = target.x - train[index].x;
    if (horizon <= 0) continue;
    errors.push(Math.abs(baseModelForecast(method, trainPrefix, horizon, seed) - target.y));
  }
  if (errors.length === 0) return null;
  const sorted = [...errors].sort((a, b) => a - b);
  const rank = Math.ceil((sorted.length + 1) * Math.max(0.5, Math.min(0.99, quantileLevel)));
  return Number(sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))].toFixed(4));
}

interface Row {
  seed: number;
  mechanism: Mechanism;
  origin: number;
  method: Method;
  method_used: string;
  actual: number;
  predicted: number;
  abs_error: number;
  squared_error: number;
  covered90: boolean;
  covered95: boolean;
  width: number;
  reliability_failed: boolean;
  regime: RegimeLabel | null;
  drift_detected: boolean;
}

function predictAtOrigin(
  method: Method,
  train: Array<{ x: number; y: number }>,
  target: { x: number; y: number },
  seed: number,
): { predicted: number; methodUsed: string; interval90: { lower: number; upper: number }; interval95: { lower: number; upper: number }; regime: RegimeLabel | null; drift: boolean } {
  const horizon = target.x - train[train.length - 1].x;
  if (method === 'ensemble_v70') {
    const result = ensembleForecast(train, { horizonMinutes: horizon, seed });
    return {
      predicted: result.predicted,
      methodUsed: `ensemble(${result.effective_methods.join('+')})`,
      interval90: result.interval90,
      interval95: result.interval95,
      regime: result.regime.label,
      drift: result.drift.detected,
    };
  }
  if (method === 'adaptive') {
    const selection = selectForecastMethod(train);
    const predicted = baseModelForecast(selection.method as AdvancedMethod, train, horizon, seed);
    const q90 = historicalErrorQuantile(train, selection.method as AdvancedMethod, horizon, 0.9, seed);
    const q95 = historicalErrorQuantile(train, selection.method as AdvancedMethod, horizon, 0.95, seed);
    const fallback = 1.96 * residualStdPoints(train) * Math.sqrt(1 + horizon / Math.max(1, train.length));
    const margin95 = Math.max(5, (q95 ?? fallback) * 1.5);
    const margin90 = Math.max(5, (q90 ?? fallback) * 1.5);
    return {
      predicted,
      methodUsed: `adaptive:${selection.method}`,
      interval90: { lower: Math.max(0, Math.round(predicted - margin90)), upper: Math.round(predicted + margin90) },
      interval95: { lower: Math.max(0, Math.round(predicted - margin95)), upper: Math.round(predicted + margin95) },
      regime: null,
      drift: false,
    };
  }
  const predicted = baseModelForecast(method, train, horizon, seed);
  const q90 = historicalErrorQuantile(train, method, horizon, 0.9, seed);
  const q95 = historicalErrorQuantile(train, method, horizon, 0.95, seed);
  const fallback = 1.96 * residualStdPoints(train) * Math.sqrt(1 + horizon / Math.max(1, train.length));
  const margin95 = Math.max(5, (q95 ?? fallback) * 1.5);
  const margin90 = Math.max(5, (q90 ?? fallback) * 1.5);
  return {
    predicted,
    methodUsed: method,
    interval90: { lower: Math.max(0, Math.round(predicted - margin90)), upper: Math.round(predicted + margin90) },
    interval95: { lower: Math.max(0, Math.round(predicted - margin95)), upper: Math.round(predicted + margin95) },
    regime: null,
    drift: false,
  };
}

function runRow(
  seed: number,
  mechanism: Mechanism,
  origin: number,
  method: Method,
  train: Array<{ x: number; y: number }>,
  target: { x: number; y: number },
): Row {
  const result = predictAtOrigin(method, train, target, seed);
  const error = result.predicted - target.y;
  const relativeWidth = (result.interval95.upper - result.interval95.lower) / Math.max(1, result.predicted);
  return {
    seed,
    mechanism,
    origin,
    method,
    method_used: result.methodUsed,
    actual: Number(target.y.toFixed(4)),
    predicted: Number(result.predicted.toFixed(4)),
    abs_error: Number(Math.abs(error).toFixed(4)),
    squared_error: Number((error ** 2).toFixed(4)),
    covered90: target.y >= result.interval90.lower && target.y <= result.interval90.upper,
    covered95: target.y >= result.interval95.lower && target.y <= result.interval95.upper,
    width: Number((result.interval95.upper - result.interval95.lower).toFixed(4)),
    reliability_failed: relativeWidth > RELIABILITY_THRESHOLD,
    regime: result.regime,
    drift_detected: result.drift,
  };
}

function aggregate(rows: Row[]) {
  const n = rows.length;
  const absErrors = rows.map(row => row.abs_error);
  const sumActual = rows.reduce((sum, row) => sum + row.actual, 0);
  return {
    n,
    mae: Number(mean(absErrors).toFixed(4)),
    rmse: Number(Math.sqrt(mean(rows.map(row => row.squared_error))).toFixed(4)),
    nae: Number((absErrors.reduce((sum, value) => sum + value, 0) / Math.max(1, sumActual)).toFixed(4)),
    coverage90: Number((rows.filter(row => row.covered90).length / Math.max(1, n)).toFixed(4)),
    coverage95: Number((rows.filter(row => row.covered95).length / Math.max(1, n)).toFixed(4)),
    mean_width: Number(mean(rows.map(row => row.width)).toFixed(4)),
    failure_rate: Number((rows.filter(row => row.reliability_failed).length / Math.max(1, n)).toFixed(4)),
  };
}

export interface PredictionBenchmarkResult {
  summary: Record<string, Record<string, unknown>>;
  paired: Record<string, unknown>;
  holm: Record<string, unknown>;
  regime: Record<string, unknown>;
  drift: Record<string, unknown>;
  sensitivity: Record<string, unknown>;
  ablation: Record<string, unknown>;
  worst_cases: Row[];
  rows: Row[];
}

export function runPredictionBenchmark(): PredictionBenchmarkResult {
  fs.mkdirSync(V70_OUT, { recursive: true });
  const rows: Row[] = [];
  const started = Date.now();
  for (const seed of V70_SEEDS) {
    for (const mechanism of MECHANISMS) {
      const points = generateSeries(mechanism, seed)
        .filter((item): item is { x: number; y: number } => item !== null);
      for (let index = 0; index < points.length; index += 1) {
        const train = points.slice(0, index + 1);
        if (train.length < MIN_TRAIN) continue;
        const target = points.find((point, pointIndex) => pointIndex > index && point.x >= points[index].x + HORIZON);
        if (!target) continue;
        for (const method of METHODS) rows.push(runRow(seed, mechanism, index, method, train, target));
      }
    }
  }
  const elapsed = Date.now() - started;

  const bySeedMechanismMethod = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.seed}|${row.mechanism}|${row.method}`;
    const list = bySeedMechanismMethod.get(key) ?? [];
    list.push(row);
    bySeedMechanismMethod.set(key, list);
  }
  const metricNames = ['mae', 'rmse', 'nae', 'coverage90', 'coverage95', 'mean_width', 'failure_rate'] as const;
  const summary: Record<string, Record<string, unknown>> = {};
  for (const mechanism of MECHANISMS) {
    summary[mechanism] = {};
    for (const method of METHODS) {
      const seedValues = Object.fromEntries(metricNames.map(metric => [
        metric,
        ci(V70_SEEDS.map(seed => {
          const subset = bySeedMechanismMethod.get(`${seed}|${mechanism}|${method}`) ?? [];
          return aggregate(subset)[metric];
        })),
      ]));
      summary[mechanism][method] = {
        ...seedValues,
        aggregate: aggregate(rows.filter(row => row.mechanism === mechanism && row.method === method)),
      };
    }
  }

  // 配对比较：ensemble_v70 vs 每个基线（同 seed/mechanism/origin）
  const paired: Record<string, unknown> = {};
  const pValues: Record<string, number> = {};
  const ensembleRows = rows.filter(row => row.method === 'ensemble_v70');
  for (const baseline of METHODS.filter(method => method !== 'ensemble_v70')) {
    const baselineMap = new Map(rows
      .filter(row => row.method === baseline)
      .map(row => [`${row.seed}|${row.mechanism}|${row.origin}`, row]));
    const diffs: number[] = [];
    const coverageDiffs: number[] = [];
    const perSeed: number[][] = V70_SEEDS.map(() => []);
    for (const row of ensembleRows) {
      const other = baselineMap.get(`${row.seed}|${row.mechanism}|${row.origin}`);
      if (!other) continue;
      diffs.push(row.abs_error - other.abs_error);
      coverageDiffs.push((row.covered95 ? 1 : 0) - (other.covered95 ? 1 : 0));
      perSeed[V70_SEEDS.indexOf(row.seed)].push(row.abs_error - other.abs_error);
    }
    paired[baseline] = {
      ensemble_minus_baseline_abs_error: ci(diffs),
      bootstrap: bootstrap(diffs),
      seed_level: ci(perSeed.map(group => mean(group))),
      cluster_bootstrap_by_seed: clusterBootstrap(perSeed),
      cohen_dz: dz(diffs),
      coverage95_diff: ci(coverageDiffs),
      n_pairs: diffs.length,
    };
    pValues[baseline] = pairedPValue(diffs);
  }
  const holmResult = holm(pValues);

  // Regime 混淆矩阵（仅 ensemble 行有 regime）。
  const regimeRows = rows.filter(row => row.method === 'ensemble_v70' && row.regime !== null);
  const labels: RegimeLabel[] = ['stable', 'surge', 'decline', 'periodic', 'noisy', 'mixed', 'insufficient'];
  const confusion: Record<string, Record<string, number>> = {};
  for (const mechanism of MECHANISMS) {
    confusion[mechanism] = Object.fromEntries(labels.map(label => [label, 0]));
    for (const row of regimeRows.filter(item => item.mechanism === mechanism)) {
      const label = row.regime ?? 'insufficient';
      confusion[mechanism][label] = (confusion[mechanism][label] ?? 0) + 1;
    }
  }
  const expectedLabel: Record<Mechanism, RegimeLabel[]> = {
    stable: ['stable', 'mixed'],
    surge: ['surge', 'mixed'],
    decline: ['decline', 'mixed'],
    periodic: ['periodic', 'mixed'],
    missing: ['stable', 'mixed', 'noisy'],
    noisy: ['noisy', 'mixed'],
    regime_shift: ['stable', 'surge', 'decline', 'mixed'],
  };
  const regimeAccuracy = Object.fromEntries(MECHANISMS.map(mechanism => {
    const subset = regimeRows.filter(row => row.mechanism === mechanism);
    const correct = subset.filter(row => expectedLabel[mechanism].includes(row.regime as RegimeLabel)).length;
    return [mechanism, {
      n: subset.length,
      accepted_accuracy: Number((correct / Math.max(1, subset.length)).toFixed(4)),
      accepted_labels: expectedLabel[mechanism],
    }];
  }));

  // 漂移检测：regime_shift 上的延迟与 stable 上的误报率。
  const shiftSeries = V70_SEEDS.map(seed => {
    const points = generateSeries('regime_shift', seed).filter((item): item is { x: number; y: number } => item !== null);
    const detections: number[] = [];
    for (let index = MIN_TRAIN; index < points.length - HORIZON; index += 1) {
      const train = points.slice(0, index + 1);
      const result = ensembleForecast(train, { horizonMinutes: HORIZON, seed });
      if (result.drift.detected) detections.push(index);
    }
    const firstAfterSurge = detections.find(index => index >= 20 && index < 40);
    const firstAfterDecline = detections.find(index => index >= 40);
    return {
      seed,
      detections,
      latency_surge: firstAfterSurge === undefined ? null : firstAfterSurge - 20,
      latency_decline: firstAfterDecline === undefined ? null : firstAfterDecline - 40,
    };
  });
  const stableRows = rows.filter(row => row.method === 'ensemble_v70' && row.mechanism === 'stable');
  const drift = {
    regime_shift_latency_surge: ci(shiftSeries.filter(item => item.latency_surge !== null).map(item => item.latency_surge as number)),
    regime_shift_latency_decline: ci(shiftSeries.filter(item => item.latency_decline !== null).map(item => item.latency_decline as number)),
    surge_detected_rate: Number((shiftSeries.filter(item => item.latency_surge !== null).length / shiftSeries.length).toFixed(4)),
    decline_detected_rate: Number((shiftSeries.filter(item => item.latency_decline !== null).length / shiftSeries.length).toFixed(4)),
    stable_false_positive_rate: Number((stableRows.filter(row => row.drift_detected).length / Math.max(1, stableRows.length)).toFixed(4)),
    note: '漂移检测用于区间放大与提示，不直接改变安全四态；误报会加宽区间但不会降低安全门槛。',
  };

  // 敏感性与消融（10 个种子的子集，控制运行时间）。
  const subsetSeeds = V70_SEEDS.slice(0, 10);
  const runSubset = (options: Parameters<typeof ensembleForecast>[1]): Row[] => {
    const subsetRows: Row[] = [];
    for (const seed of subsetSeeds) {
      for (const mechanism of MECHANISMS) {
        const points = generateSeries(mechanism, seed).filter((item): item is { x: number; y: number } => item !== null);
        for (let index = 0; index < points.length; index += 1) {
          const train = points.slice(0, index + 1);
          if (train.length < MIN_TRAIN) continue;
          const target = points.find((point, pointIndex) => pointIndex > index && point.x >= points[index].x + HORIZON);
          if (!target) continue;
          const result = ensembleForecast(train, { horizonMinutes: target.x - train[train.length - 1].x, seed, ...options });
          const error = result.predicted - target.y;
          subsetRows.push({
            seed,
            mechanism,
            origin: index,
            method: 'ensemble_v70',
            method_used: 'ensemble',
            actual: target.y,
            predicted: result.predicted,
            abs_error: Math.abs(error),
            squared_error: error ** 2,
            covered90: target.y >= result.interval90.lower && target.y <= result.interval90.upper,
            covered95: target.y >= result.interval95.lower && target.y <= result.interval95.upper,
            width: result.interval95.upper - result.interval95.lower,
            reliability_failed: (result.reliability.relative_interval_width ?? 1) > RELIABILITY_THRESHOLD,
            regime: result.regime.label,
            drift_detected: result.drift.detected,
          });
        }
      }
    }
    return subsetRows;
  };
  const fullSubset = runSubset({});
  const ablation = {
    full: Object.fromEntries(MECHANISMS.map(mechanism => [mechanism, aggregate(fullSubset.filter(row => row.mechanism === mechanism))])),
    no_regime: Object.fromEntries(MECHANISMS.map(mechanism => [mechanism, aggregate(runSubset({ useRegime: false }).filter(row => row.mechanism === mechanism))])),
    no_drift: Object.fromEntries(MECHANISMS.map(mechanism => [mechanism, aggregate(runSubset({ useDrift: false }).filter(row => row.mechanism === mechanism))])),
    normal_interval: Object.fromEntries(MECHANISMS.map(mechanism => [mechanism, aggregate(runSubset({ intervalMode: 'normal' }).filter(row => row.mechanism === mechanism))])),
    equal_weights: Object.fromEntries(MECHANISMS.map(mechanism => [mechanism, aggregate(runSubset({ weighting: 'equal' }).filter(row => row.mechanism === mechanism))])),
    note: '消融在 10 个种子上运行；不同消融共享同一批滚动起点，可直接比较。',
  };

  const sensitivity: Record<string, unknown> = {};
  for (const origins of [4, 8, 12]) {
    sensitivity[`validation_origins_${origins}`] = Object.fromEntries(MECHANISMS.map(mechanism => {
      const result = runSubset({ validationOrigins: origins }).filter(row => row.mechanism === mechanism);
      return [mechanism, { mae: aggregate(result).mae, coverage95: aggregate(result).coverage95, failure_rate: aggregate(result).failure_rate }];
    }));
  }
  for (const level of [0.9, 0.95] as const) {
    sensitivity[`conformal_level_${level}`] = Object.fromEntries(MECHANISMS.map(mechanism => {
      const result = runSubset({ conformalLevel: level }).filter(row => row.mechanism === mechanism);
      return [mechanism, { mae: aggregate(result).mae, coverage90: aggregate(result).coverage90, coverage95: aggregate(result).coverage95 }];
    }));
  }
  sensitivity.reliability_thresholds = Object.fromEntries([0.3, 0.5, 1.0].map(threshold => [
    String(threshold),
    {
      blocked_rate: Number((ensembleRows.filter(row => (row.width / Math.max(1, row.predicted)) > threshold).length / Math.max(1, ensembleRows.length)).toFixed(4)),
      note: '区间相对宽度超过阈值时，VoI 预测动作被阻断的比例。',
    },
  ]));

  const worst = [...ensembleRows].sort((a, b) => b.abs_error - a.abs_error).slice(0, 20);

  const write = (name: string, data: unknown) => fs.writeFileSync(path.join(V70_OUT, name), `${JSON.stringify(data, null, 2)}\n`);
  write('prediction_rows.json', rows);
  write('prediction_summary.json', {
    config: {
      seeds: V70_SEEDS,
      mechanisms: MECHANISMS,
      methods: METHODS,
      series_length: SERIES_LENGTH,
      horizon_steps: HORIZON,
      min_train_points: MIN_TRAIN,
      reliability_threshold: RELIABILITY_THRESHOLD,
      data_nature: '全部为合成数据；不代表真实场馆或公开数据集精度。',
      protocol: '每个起点只用过去数据训练/选择方法/校准区间；目标点完全不参与。',
      elapsed_ms: elapsed,
    },
    summary,
    paired,
    holm: holmResult,
    regime: { confusion, accuracy: regimeAccuracy },
    drift,
    sensitivity,
    ablation,
    worst_cases: worst,
  });
  return { summary, paired, holm: holmResult, regime: { confusion, accuracy: regimeAccuracy }, drift, sensitivity, ablation, worst_cases: worst, rows };
}

function formatCi(value: unknown): string {
  const item = value as { mean: number; lower: number; upper: number };
  return `${item.mean} [${item.lower}, ${item.upper}]`;
}

export function writePredictionReport(result: PredictionBenchmarkResult): void {
  const { summary, paired, holm, regime, drift, sensitivity, ablation } = result;
  const bestPerMechanism = MECHANISMS.map(mechanism => {
    const values = Object.fromEntries(METHODS.map(method => [method, (summary[mechanism][method] as { aggregate: { mae: number } }).aggregate.mae]));
    const best = METHODS.reduce((current, method) => values[method] < values[current] ? method : current, METHODS[0]);
    return `${mechanism}=${best} (${values[best]})`;
  });
  const report = `# V7.1 预测对照实验

> 运行 ID：\`${V70_RUN_ID}\`。全部为**合成数据**；滚动起点只用过去数据，目标点不参与训练/选择/校准。
> 生成命令：\`npm run benchmark:v70 --prefix backend -- --only=prediction\`。

## 1. 主结果（30 种子，按种子聚合的 95% CI）

| 机制 | 方法 | MAE [95% CI] | RMSE | NAE | 90% 覆盖 | 95% 覆盖 | 平均宽度 | 失效检测率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${MECHANISMS.flatMap(mechanism => METHODS.map(method => {
  const value = summary[mechanism][method] as {
    mae: { mean: number; lower: number; upper: number }; rmse: { mean: number }; nae: { mean: number };
    coverage90: { mean: number }; coverage95: { mean: number }; mean_width: { mean: number }; failure_rate: { mean: number };
  };
  return `| ${mechanism} | ${method} | ${formatCi(value.mae)} | ${value.rmse.mean} | ${value.nae.mean} | ${value.coverage90.mean} | ${value.coverage95.mean} | ${value.mean_width.mean} | ${value.failure_rate.mean} |`;
})).join('\n')}

## 2. 配对比较（ensemble_v70 − 基线，绝对误差；负数表示集成更好）

| 基线 | 平均差 [95% CI] | 聚类 Bootstrap | d_z | Holm 校正 p | 显著 (α=0.05) | 95% 覆盖差 |
| --- | --- | --- | --- | --- | --- | --- |
${Object.entries(paired).map(([baseline, value]: [string, any]) => {
  const holmValue = (holm as Record<string, { adjusted: number; rejected_0_05: boolean }>)[baseline];
  return `| ${baseline} | ${formatCi(value.ensemble_minus_baseline_abs_error)} | [${value.cluster_bootstrap_by_seed.lower}, ${value.cluster_bootstrap_by_seed.upper}] | ${value.cohen_dz} | ${holmValue.adjusted} | ${holmValue.rejected_0_05 ? '是' : '否'} | ${formatCi(value.coverage95_diff)} |`;
}).join('\n')}

## 3. 关键观察（必须与上表一致）

- 各机制 MAE 最佳方法：${bestPerMechanism.join('；')}。
- ensemble_v70 与各基线的配对差值见第 2 节；**不预先宣称全面最优**。若 Holm 校正后不显著，只能报告“未发现明确优势”。
- 95% 覆盖率：${MECHANISMS.map(mechanism => {
  const value = summary[mechanism].ensemble_v70 as { aggregate: { coverage95: number } };
  return `${mechanism} ${value.aggregate.coverage95}`;
}).join('，')}。覆盖率低于名义值的机制必须显式报告，区间不得用于安全告警阈值。
- 可靠性失败率（区间相对宽度 > ${RELIABILITY_THRESHOLD}）：${MECHANISMS.map(mechanism => {
  const value = summary[mechanism].ensemble_v70 as { aggregate: { failure_rate: number } };
  return `${mechanism} ${value.aggregate.failure_rate}`;
}).join('，')}。

## 4. Regime 检测

- 可接受标签准确率：${Object.entries((regime as any).accuracy).map(([mechanism, value]: [string, any]) => `${mechanism} ${value.accepted_accuracy}（n=${value.n}）`).join('；')}。
- 混淆矩阵与每行判定见 \`prediction_summary.json\` 的 \`regime.confusion\`。
- 接受集包含 \`mixed\`，因为保守的“混合”判定不应被视为错误；这不是人群状态分类精度。

## 5. 漂移检测

- regime_shift 突增段检测率 ${(drift as any).surge_detected_rate}，平均延迟 ${formatCi((drift as any).regime_shift_latency_surge)}。
- regime_shift 下降段检测率 ${(drift as any).decline_detected_rate}，平均延迟 ${formatCi((drift as any).regime_shift_latency_decline)}。
- stable 误报率 ${(drift as any).stable_false_positive_rate}。
- ${(drift as any).note}

## 6. 敏感性与消融（10 种子子集）

- 验证起点数 4/8/12 的 surge MAE：${JSON.stringify((sensitivity as any).validation_origins_4?.surge?.mae)} / ${JSON.stringify((sensitivity as any).validation_origins_8?.surge?.mae)} / ${JSON.stringify((sensitivity as any).validation_origins_12?.surge?.mae)}。
- conformal 0.90/0.95 的 surge 95% 覆盖：${JSON.stringify((sensitivity as any)['conformal_level_0.9']?.surge?.coverage95)} / ${JSON.stringify((sensitivity as any)['conformal_level_0.95']?.surge?.coverage95)}。
- 消融（surge MAE）：完整 ${(ablation as any).full.surge.mae}；无 regime ${(ablation as any).no_regime.surge.mae}；无漂移放大 ${(ablation as any).no_drift.surge.mae}；正态区间 ${(ablation as any).normal_interval.surge.mae}；等权 ${(ablation as any).equal_weights.surge.mae}。
- 消融（stable 95% 覆盖）：完整 ${(ablation as any).full.stable.coverage95}；正态区间 ${(ablation as any).normal_interval.stable.coverage95}。

## 7. 边界

- 合成机制不等同真实人群动力学；没有真实场馆时间序列真值。
- 区间为历史残差的 split-conformal 近似，不是正式统计置信区间。
- LSTM 为轻量在线基线（隐藏单元 4、截断 BPTT），训练数据很少，表现可能不佳；负结果保留。
- 预测可靠性失败时，VoI 预测动作不可用；安全四态仍由观测可信度决定。
`;
  fs.writeFileSync(path.join(V70_OUT, 'prediction_README.md'), report);
}

if (require.main === module) {
  const result = runPredictionBenchmark();
  writePredictionReport(result);
  const metadata = {
    generated_at: new Date().toISOString(),
    run_id: V70_RUN_ID,
    node: process.version,
    platform: process.platform,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    git_head: process.env.GIT_HEAD ?? 'uncommitted',
  };
  fs.writeFileSync(path.join(V70_OUT, 'prediction_metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  const files = fs.readdirSync(V70_OUT).filter(name => name.startsWith('prediction_')).sort();
  const manifest = files.map(name => {
    const bytes = fs.readFileSync(path.join(V70_OUT, name));
    return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  fs.writeFileSync(path.join(V70_OUT, 'prediction_MANIFEST.json'), `${JSON.stringify({
    version: 1, run_id: V70_RUN_ID, note: 'V7.1 预测实验独立清单。', file_count: manifest.length, files: manifest,
  }, null, 2)}\n`);
  console.log(`V7.1 prediction benchmark complete: evaluation/v70/${V70_RUN_ID}/`);
  console.log(`rows=${result.rows.length}`);
  console.log(`surge ensemble MAE=${(result.summary.surge.ensemble_v70 as any).aggregate.mae}, persistence=${(result.summary.surge.persistence as any).aggregate.mae}`);
}
