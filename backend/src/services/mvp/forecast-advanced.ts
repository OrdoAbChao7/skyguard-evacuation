/**
 * V7.1 短时人流预测引擎（研究级）。
 *
 * 设计目标：
 *  - 在既有可解释基线（persistence / EMA / damped / blend / linear）之上，引入
 *    Kalman（局部线性趋势）、ARIMA(1,1,0)、Holt-Winters（加性趋势 + 可选季节项）、
 *    轻量在线 LSTM，以及「状态感知自适应集成」；
 *  - 所有方法只使用传入的训练样本；禁止读取目标点或未来数据；
 *  - 区间使用历史回测误差的 split-conformal 近似分位，并按近期误差自适应放大；
 *  - 显式输出 regime、漂移检测与可靠性，便于上层决定预测是否可用于 VoI。
 *
 * 边界：全部为统计/机器学习方法，不建模人群动力学；区间不是正式统计置信区间，
 * 未在真实场馆时序上验证。合成数据实验见 evaluation/v70/。
 */
import { forecastWithMethod, selectForecastMethod, type ForecastMethod } from './prediction';

export interface SeriesPoint {
  x: number;
  y: number;
}

export type AdvancedMethod =
  | 'persistence'
  | 'ema'
  | 'linear'
  | 'damped'
  | 'blend'
  | 'kalman'
  | 'arima'
  | 'holt_winters'
  | 'lstm_online'
  | 'ensemble_v70';

export type RegimeLabel = 'stable' | 'surge' | 'decline' | 'periodic' | 'noisy' | 'mixed' | 'insufficient';

export interface RegimeDetection {
  label: RegimeLabel;
  slope_recent_per_minute: number;
  slope_long_per_minute: number;
  volatility_ratio: number;
  level_shift: boolean;
  periodicity: number;
  detected_lag: number | null;
  confidence: number;
  reasons: string[];
}

export interface DriftDetection {
  detected: boolean;
  statistic: number;
  threshold: number;
  recent_error_ratio: number | null;
  recommendation: 'none' | 'reset_weights' | 'widen_interval';
  note: string;
}

export interface AdvancedForecastOptions {
  horizonMinutes?: number;
  /** 用于滚动验证 / conformal 校准的历史起点数量上界。 */
  validationOrigins?: number;
  /** conformal 名义覆盖率。 */
  conformalLevel?: 0.9 | 0.95;
  /** 可靠性阈值：95% 区间相对宽度超过该值 → failed。 */
  maxRelativeIntervalWidth?: number;
  /** LSTM 采样种子；未提供时使用确定性默认。 */
  seed?: number;
  /** 消融：关闭状态感知候选筛选（默认开启）。 */
  useRegime?: boolean;
  /** 消融：关闭漂移自适应放大（默认开启）。 */
  useDrift?: boolean;
  /** 消融：区间模式。conformal = 历史残差分位；normal = 残差标准差正态近似。 */
  intervalMode?: 'conformal' | 'normal';
  /** 消融：权重方式。error = 逆误差指数权重；equal = 等权。 */
  weighting?: 'error' | 'equal';
}

export interface MethodPrediction {
  method: AdvancedMethod;
  predicted: number;
  weight: number;
  validation_mae: number | null;
  calibration_q95: number | null;
  selected: boolean;
}

export interface ConformalSummary {
  level: number;
  quantile: number;
  scale: number;
  calibration_points: number;
  empirical_q90: number;
  empirical_q95: number;
}

export interface AdvancedForecastResult {
  predicted: number;
  method: 'ensemble_v70';
  horizon_minutes: number;
  regime: RegimeDetection;
  drift: DriftDetection;
  models: MethodPrediction[];
  effective_methods: AdvancedMethod[];
  interval90: { lower: number; upper: number };
  interval95: { lower: number; upper: number };
  conformal: ConformalSummary;
  reliability: {
    status: 'ok' | 'warning' | 'failed';
    reasons: string[];
    relative_interval_width: number | null;
    max_relative_interval_width: number;
  };
  notes: string[];
}

const MIN_POINTS = 4;
const DEFAULT_HORIZON = 5;
const DEFAULT_VALIDATION_ORIGINS = 8;
const CONFORMAL_ORIGINS = 16;
const INTERVAL_FLOOR = 5;

const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const ordered = sorted(values);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.floor(ordered.length * q)))];
}

/** split-conformal 分位：rank = ceil((n+1)(1-alpha))，n 为校准残差个数。 */
function conformalQuantile(errors: number[], level: number): number | null {
  if (errors.length === 0) return null;
  const ordered = sorted(errors);
  const rank = Math.ceil((ordered.length + 1) * level);
  const index = Math.min(ordered.length - 1, Math.max(0, rank - 1));
  return ordered[index];
}

function linearFit(points: SeriesPoint[]): { slope: number; intercept: number } {
  if (points.length < 2) {
    const value = points[0]?.y ?? 0;
    return { slope: 0, intercept: value };
  }
  const meanX = mean(points.map(point => point.x));
  const meanY = mean(points.map(point => point.y));
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  return { slope, intercept: meanY - slope * meanX };
}

function residualStdPoints(points: SeriesPoint[]): number {
  if (points.length < 3) return Math.max(1, std(points.map(point => point.y)));
  const { slope, intercept } = linearFit(points);
  const residuals = points.map(point => point.y - (intercept + slope * point.x));
  return Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, points.length - 2));
}

function regularize(points: SeriesPoint[]): SeriesPoint[] {
  if (points.length < 2) return points;
  const byX = new Map<number, number>();
  for (const point of points) {
    byX.set(Math.round(point.x), (byX.get(Math.round(point.x)) ?? 0) + point.y);
  }
  const first = Math.round(points[0].x);
  const last = Math.round(points[points.length - 1].x);
  const grid: SeriesPoint[] = [];
  let cursor = first;
  let lastKnown: number | null = null;
  const nextKnownX = (x: number): number | null => {
    for (let candidate = x + 1; candidate <= last; candidate += 1) {
      if (byX.has(candidate)) return candidate;
    }
    return null;
  };
  while (cursor <= last) {
    if (byX.has(cursor)) {
      lastKnown = byX.get(cursor)!;
      grid.push({ x: cursor - first, y: lastKnown });
    } else if (lastKnown !== null) {
      const nextX = nextKnownX(cursor);
      const nextY = nextX === null ? lastKnown : byX.get(nextX)!;
      const ratio = nextX === null ? 0 : (cursor - (cursor - 1)) / (nextX - (cursor - 1));
      grid.push({ x: cursor - first, y: lastKnown + (nextY - lastKnown) * ratio });
    }
    cursor += 1;
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Regime detection
// ---------------------------------------------------------------------------

export function detectRegime(samples: SeriesPoint[]): RegimeDetection {
  if (samples.length < MIN_POINTS) {
    return {
      label: 'insufficient',
      slope_recent_per_minute: 0,
      slope_long_per_minute: 0,
      volatility_ratio: 0,
      level_shift: false,
      periodicity: 0,
      detected_lag: null,
      confidence: 0,
      reasons: ['有效点不足，无法判定状态'],
    };
  }
  const ordered = [...samples].sort((a, b) => a.x - b.x);
  const values = ordered.map(point => point.y);
  const level = Math.max(1, mean(values));
  const recentCount = Math.min(10, ordered.length);
  const recent = ordered.slice(-recentCount);
  const slopeRecent = linearFit(recent).slope;
  const slopeLong = linearFit(ordered).slope;
  const volRecent = std(recent.map(point => point.y));
  const volLong = std(values);
  const volatilityRatio = volLong === 0 ? 0 : volRecent / volLong;

  // CUSUM 水平漂移检测（标准化后的累计和）。
  const sigma = Math.max(1e-6, volLong);
  const globalMean = mean(values);
  let cusum = 0;
  let maxCusum = 0;
  for (const value of values) {
    cusum += (value - globalMean) / sigma;
    maxCusum = Math.max(maxCusum, Math.abs(cusum));
  }
  const firstHalf = mean(values.slice(0, Math.floor(values.length / 2)));
  const secondHalf = mean(values.slice(Math.floor(values.length / 2)));
  const levelShift = maxCusum / Math.sqrt(values.length) > 1.4
    && Math.abs(secondHalf - firstHalf) > 0.75 * sigma;

  // 周期性：去趋势后的自相关峰值（滞后 4..30）。intercept 已包含均值，这里不再重复减均值。
  const { slope, intercept } = linearFit(ordered);
  const detrended = ordered.map(point => point.y - (intercept + slope * point.x));
  const maxLag = Math.min(30, Math.floor(detrended.length / 2));
  let bestLag: number | null = null;
  let bestCorr = 0;
  for (let lag = 4; lag <= maxLag; lag += 1) {
    let numerator = 0;
    let denomA = 0;
    let denomB = 0;
    for (let index = 0; index + lag < detrended.length; index += 1) {
      numerator += detrended[index] * detrended[index + lag];
      denomA += detrended[index] ** 2;
      denomB += detrended[index + lag] ** 2;
    }
    const corr = denomA > 0 && denomB > 0 ? numerator / Math.sqrt(denomA * denomB) : 0;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  const reasons: string[] = [];
  const relativeSlope5 = (slopeRecent * 5) / level;
  const noiseThreshold = Math.max(0.05, (2.5 * volLong) / level);
  let label: RegimeLabel = 'stable';
  let confidence = 0.4;

  if (relativeSlope5 > 0.12 && slopeRecent > slopeLong * 1.2) {
    label = 'surge';
    confidence = clamp(0.55 + Math.abs(relativeSlope5), 0.55, 0.95);
    reasons.push(`近期斜率 ${(slopeRecent * 5).toFixed(1)} 人/5min，超过长期趋势`);
  } else if (relativeSlope5 < -0.08) {
    label = 'decline';
    confidence = clamp(0.55 + Math.abs(relativeSlope5), 0.55, 0.95);
    reasons.push(`近期斜率 ${(slopeRecent * 5).toFixed(1)} 人/5min，持续下降`);
  } else if (bestCorr >= 0.45 && bestLag !== null) {
    label = 'periodic';
    confidence = clamp(bestCorr, 0.45, 0.95);
    reasons.push(`去趋势自相关 ${bestCorr.toFixed(2)} @ lag ${bestLag}`);
  } else if (volLong / level > Math.max(noiseThreshold, 0.18) && Math.abs(slopeLong * 5) < 0.08 * level) {
    label = 'noisy';
    confidence = clamp(0.5 + volLong / level, 0.5, 0.9);
    reasons.push(`波动 ${(volLong / level).toFixed(2)} × 均值，无明显趋势`);
  } else if (Math.abs(slopeLong * 5) < 0.05 * level && volLong / level < 0.12) {
    label = 'stable';
    confidence = 0.7;
    reasons.push('水平与波动稳定');
  } else {
    label = 'mixed';
    confidence = 0.45;
    reasons.push('趋势、波动与周期性均不显著');
  }
  if (levelShift) {
    reasons.push(levelShift ? `检测到水平漂移（CUSUM 归一化 ${(maxCusum / Math.sqrt(values.length)).toFixed(2)}）` : '');
    if (label === 'stable') label = 'mixed';
  }
  return {
    label,
    slope_recent_per_minute: Number(slopeRecent.toFixed(4)),
    slope_long_per_minute: Number(slopeLong.toFixed(4)),
    volatility_ratio: Number(volatilityRatio.toFixed(4)),
    level_shift: levelShift,
    periodicity: Number(bestCorr.toFixed(4)),
    detected_lag: bestLag,
    confidence: Number(confidence.toFixed(3)),
    reasons: reasons.filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Individual models
// ---------------------------------------------------------------------------

export interface ModelOutput {
  predicted: number;
  variance?: number;
}

/** Kalman：局部线性趋势状态空间模型；在最终状态上外推 horizon 分钟。 */

/** 在 Kalman 当前状态上外推 horizon 分钟（供集成与实验复用）。 */
export function kalmanForecastHorizon(samples: SeriesPoint[], horizonMinutes: number): ModelOutput {
  if (samples.length === 0) return { predicted: 0, variance: 0 };
  const ordered = [...samples].sort((a, b) => a.x - b.x);
  if (ordered.length === 1) return { predicted: Math.max(0, ordered[0].y), variance: 1 };
  const varianceEstimate = Math.max(1, residualStdPoints(ordered) ** 2);
  let level = ordered[0].y;
  let slope = linearFit(ordered).slope;
  let p00 = varianceEstimate;
  let p01 = 0;
  let p11 = Math.max(1e-4, varianceEstimate * 0.01);
  const qLevel = Math.max(0.02, varianceEstimate * 0.02);
  const qSlope = Math.max(1e-4, varianceEstimate * 0.001);
  const measurementNoise = varianceEstimate;
  for (let index = 1; index < ordered.length; index += 1) {
    const dt = Math.max(0.1, ordered[index].x - ordered[index - 1].x);
    const predictedLevel = level + slope * dt;
    const predictedSlope = slope;
    const n00 = p00 + 2 * dt * p01 + dt * dt * p11 + qLevel * dt;
    const n01 = p01 + dt * p11;
    const n11 = p11 + qSlope * dt;
    const innovation = ordered[index].y - predictedLevel;
    const innovationVar = n00 + measurementNoise;
    const k0 = n00 / innovationVar;
    const k1 = n01 / innovationVar;
    level = predictedLevel + k0 * innovation;
    slope = predictedSlope + k1 * innovation;
    p00 = (1 - k0) * n00;
    p01 = (1 - k0) * n01;
    p11 = n11 - k1 * n01;
  }
  const h = Math.max(0, horizonMinutes);
  const forecast = level + slope * h;
  const variance = p00 + 2 * h * p01 + h * h * p11 + measurementNoise;
  return { predicted: Math.max(0, forecast), variance: Math.max(1, variance) };
}

/** ARIMA(1,1,0)：对一阶差分拟合 AR(1)，再累加还原。 */
export function arimaForecast(samples: SeriesPoint[], horizonMinutes: number): ModelOutput {
  if (samples.length < 2) {
    const value = samples[0]?.y ?? 0;
    return { predicted: Math.max(0, value) };
  }
  const ordered = [...samples].sort((a, b) => a.x - b.x);
  const values = ordered.map(point => point.y);
  const diffs: number[] = [];
  for (let index = 1; index < values.length; index += 1) diffs.push(values[index] - values[index - 1]);
  let numerator = 0;
  let denominator = 0;
  for (let index = 1; index < diffs.length; index += 1) {
    numerator += diffs[index] * diffs[index - 1];
    denominator += diffs[index - 1] ** 2;
  }
  const rawPhi = denominator > 0 ? numerator / denominator : 0.3;
  const phi = clamp(rawPhi, -0.95, 0.95);
  const drift = (1 - phi) * mean(diffs);
  let lastDiff = diffs[diffs.length - 1];
  let forecast = values[values.length - 1];
  for (let step = 1; step <= Math.max(0, Math.round(horizonMinutes)); step += 1) {
    lastDiff = phi * lastDiff + drift;
    forecast += lastDiff;
  }
  return { predicted: Math.max(0, forecast) };
}

const HW_ALPHA = 0.3;
const HW_BETA = 0.1;
const HW_GAMMA = 0.2;

/** Holt-Winters：加性趋势；样本足够且存在周期时加入加性季节项。 */
export function holtWintersForecast(samples: SeriesPoint[], horizonMinutes: number, seasonLength?: number): ModelOutput {
  const grid = regularize([...samples].sort((a, b) => a.x - b.x));
  if (grid.length === 0) return { predicted: 0 };
  if (grid.length === 1) return { predicted: Math.max(0, grid[0].y) };
  const values = grid.map(point => point.y);
  let season = seasonLength ?? 0;
  if (!season) {
    const maxLag = Math.min(30, Math.floor(values.length / 2));
    let bestLag = 0;
    let bestCorr = 0;
    const overall = mean(values);
    const centered = values.map(value => value - overall);
    for (let lag = 4; lag <= maxLag; lag += 1) {
      let num = 0;
      let denA = 0;
      let denB = 0;
      for (let index = 0; index + lag < centered.length; index += 1) {
        num += centered[index] * centered[index + lag];
        denA += centered[index] ** 2;
        denB += centered[index + lag] ** 2;
      }
      const corr = denA > 0 && denB > 0 ? num / Math.sqrt(denA * denB) : 0;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }
    season = bestCorr >= 0.4 && bestLag >= 4 ? bestLag : 0;
  }
  let level = values[0];
  let trend = values[1] - values[0];
  const seasonals = new Array<number>(Math.max(0, season)).fill(0);
  if (season > 0 && values.length >= season) {
    const seasonalMeans = new Array<number>(season).fill(0);
    const counts = new Array<number>(season).fill(0);
    for (let index = 0; index < values.length; index += 1) {
      const slot = index % season;
      seasonalMeans[slot] += values[index];
      counts[slot] += 1;
    }
    const overall = mean(values);
    for (let slot = 0; slot < season; slot += 1) {
      seasonals[slot] = counts[slot] > 0 ? seasonalMeans[slot] / counts[slot] - overall : 0;
    }
  }
  for (let index = 1; index < values.length; index += 1) {
    const slot = season > 0 ? (index - 1) % season : -1;
    const seasonalPrev = slot >= 0 ? seasonals[slot] : 0;
    const predictedLevel = level + trend;
    if (slot >= 0) {
      const deseasonalized = values[index] - seasonalPrev;
      const previousLevel = level;
      level = HW_ALPHA * deseasonalized + (1 - HW_ALPHA) * predictedLevel;
      trend = HW_BETA * (level - previousLevel) + (1 - HW_BETA) * trend;
      seasonals[slot] = HW_GAMMA * (values[index] - level) + (1 - HW_GAMMA) * seasonalPrev;
    } else {
      const previousLevel = level;
      level = HW_ALPHA * values[index] + (1 - HW_ALPHA) * predictedLevel;
      trend = HW_BETA * (level - previousLevel) + (1 - HW_BETA) * trend;
    }
  }
  const h = Math.max(0, Math.round(horizonMinutes));
  const seasonalAhead = season > 0 ? seasonals[(values.length + h - 1) % season] : 0;
  return { predicted: Math.max(0, level + trend * h + seasonalAhead) };
}

// ---------------------------------------------------------------------------
// Lightweight online LSTM (deterministic, seeded)
// ---------------------------------------------------------------------------

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

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-clamp(value, -30, 30)));
}

/**
 * 单层 LSTM（隐藏单元 4，截断 BPTT(1)）在线学习。
 * 这是有意为之的轻量神经网络基线：训练数据量很小，性能可能不佳，负结果同样保留。
 */
class OnlineLstm {
  private readonly n: number;
  private readonly w: number[][]; // [gate*n + unit][input + hidden]
  private readonly b: number[];
  private readonly out: number[];
  private readonly rand: () => number;
  private h: number[];
  private c: number[];
  private runningMean = 0;
  private runningM2 = 0;
  private runningCount = 0;

  constructor(seed: number, hidden = 4) {
    this.n = hidden;
    this.rand = mulberry32(seed);
    const gates = 4;
    this.w = Array.from({ length: gates * this.n }, () =>
      Array.from({ length: 1 + this.n }, () => (this.rand() * 2 - 1) * 0.3),
    );
    this.b = Array.from({ length: gates * this.n }, (_, index) => (index % this.n === this.n - 1 ? 0.1 : 0));
    this.out = Array.from({ length: this.n }, () => (this.rand() * 2 - 1) * 0.2);
    this.h = new Array(this.n).fill(0);
    this.c = new Array(this.n).fill(0);
  }

  private normalize(value: number): number {
    const variance = this.runningCount > 1 ? this.runningM2 / (this.runningCount - 1) : 1;
    return (value - this.runningMean) / Math.max(1, Math.sqrt(variance));
  }

  private denormalize(value: number): number {
    const variance = this.runningCount > 1 ? this.runningM2 / (this.runningCount - 1) : 1;
    return value * Math.max(1, Math.sqrt(variance)) + this.runningMean;
  }

  private updateStats(value: number): void {
    this.runningCount += 1;
    const delta = value - this.runningMean;
    this.runningMean += delta / this.runningCount;
    this.runningM2 += delta * (value - this.runningMean);
  }

  private gate(gateIndex: number, unit: number, input: number): number {
    let sum = this.b[gateIndex * this.n + unit];
    const weights = this.w[gateIndex * this.n + unit];
    sum += weights[0] * input;
    for (let index = 0; index < this.n; index += 1) sum += weights[1 + index] * this.h[index];
    return sum;
  }

  /** 前向传播，返回预测的归一化标量；同时保存激活值以便截断反向传播。 */
  private forward(input: number): { prediction: number; activations: { i: number[]; f: number[]; o: number[]; g: number[]; prevH: number[]; prevC: number[] } } {
    const prevH = [...this.h];
    const prevC = [...this.c];
    const i: number[] = [];
    const f: number[] = [];
    const o: number[] = [];
    const g: number[] = [];
    for (let unit = 0; unit < this.n; unit += 1) {
      i.push(sigmoid(this.gate(0, unit, input)));
      f.push(sigmoid(this.gate(1, unit, input)));
      o.push(sigmoid(this.gate(2, unit, input)));
      g.push(Math.tanh(this.gate(3, unit, input)));
      this.c[unit] = f[unit] * prevC[unit] + i[unit] * g[unit];
      this.h[unit] = o[unit] * Math.tanh(this.c[unit]);
    }
    let prediction = 0;
    for (let unit = 0; unit < this.n; unit += 1) prediction += this.out[unit] * this.h[unit];
    return { prediction, activations: { i, f, o, g, prevH, prevC } };
  }

  /** 单步截断 BPTT：以 prevH/prevC 为常量更新权重。 */
  private trainStep(input: number, target: number, lr: number): number {
    const { prediction, activations } = this.forward(input);
    const error = prediction - target;
    const tanhC = this.c.map(value => Math.tanh(value));
    // 输出层
    const dH = this.h.map((_, unit) => 2 * error * this.out[unit]);
    for (let unit = 0; unit < this.n; unit += 1) this.out[unit] -= lr * 2 * error * this.h[unit];
    // 截断到当前步：dC 只来自当前 h
    const dC = this.h.map((_, unit) => dH[unit] * activations.o[unit] * (1 - tanhC[unit] ** 2));
    for (let unit = 0; unit < this.n; unit += 1) {
      const dI = dC[unit] * activations.g[unit] * activations.i[unit] * (1 - activations.i[unit]);
      const dF = dC[unit] * activations.prevC[unit] * activations.f[unit] * (1 - activations.f[unit]);
      const dO = dH[unit] * tanhC[unit] * activations.o[unit] * (1 - activations.o[unit]);
      const dG = dC[unit] * activations.i[unit] * (1 - activations.g[unit] ** 2);
      const gradients: Array<[number, number]> = [[0, dI], [1, dF], [2, dO], [3, dG]];
      for (const [gateIndex, gradient] of gradients) {
        const weights = this.w[gateIndex * this.n + unit];
        weights[0] -= lr * gradient * input;
        for (let index = 0; index < this.n; index += 1) {
          weights[1 + index] -= lr * gradient * activations.prevH[index];
        }
        this.b[gateIndex * this.n + unit] -= lr * gradient;
      }
    }
    return error;
  }

  train(samples: SeriesPoint[], passes = 3, lr = 0.03): void {
    const values = samples.map(point => point.y);
    for (const value of values) this.updateStats(value);
    const normalized = values.map(value => this.normalize(value));
    for (let pass = 0; pass < passes; pass += 1) {
      this.h = new Array(this.n).fill(0);
      this.c = new Array(this.n).fill(0);
      for (let index = 1; index < normalized.length; index += 1) {
        this.trainStep(normalized[index - 1], normalized[index], lr);
      }
    }
    // 重置状态并消费除最后一点外的序列：下一步输入是最后一个观测，避免重复消费。
    this.h = new Array(this.n).fill(0);
    this.c = new Array(this.n).fill(0);
    for (let index = 0; index < normalized.length - 1; index += 1) this.forward(normalized[index]);
    this.lastInput = normalized[normalized.length - 1] ?? 0;
  }

  private lastInput = 0;

  forecast(horizonMinutes: number, fallback: number): number {
    if (this.runningCount === 0) return fallback;
    let input = this.lastInput;
    let predicted = fallback;
    for (let step = 0; step < Math.max(1, Math.round(horizonMinutes)); step += 1) {
      const result = this.forward(input);
      predicted = this.denormalize(result.prediction);
      input = result.prediction;
    }
    return Math.max(0, predicted);
  }
}

/** 在线 LSTM 外推（确定性种子）；负结果同样如实返回。 */
export function lstmForecast(samples: SeriesPoint[], horizonMinutes: number, seed = 20261109): ModelOutput {
  if (samples.length < 3) {
    const value = samples[samples.length - 1]?.y ?? 0;
    return { predicted: Math.max(0, value) };
  }
  const ordered = [...samples].sort((a, b) => a.x - b.x);
  const model = new OnlineLstm(seed);
  model.train(ordered);
  return { predicted: model.forecast(horizonMinutes, ordered[ordered.length - 1].y) };
}

// ---------------------------------------------------------------------------
// Base model dispatch
// ---------------------------------------------------------------------------

function legacyMethod(method: ForecastMethod): ForecastMethod {
  return method;
}

export function baseModelForecast(method: AdvancedMethod, samples: SeriesPoint[], horizonMinutes: number, seed = 20261109): number {
  if (method === 'ensemble_v70') throw new Error('ensemble_v70 不是基础模型');
  if (method === 'kalman') return kalmanForecastHorizon(samples, horizonMinutes).predicted;
  if (method === 'arima') return arimaForecast(samples, horizonMinutes).predicted;
  if (method === 'holt_winters') return holtWintersForecast(samples, horizonMinutes).predicted;
  if (method === 'lstm_online') return lstmForecast(samples, horizonMinutes, seed).predicted;
  return forecastWithMethod(legacyMethod(method as ForecastMethod), samples, horizonMinutes);
}

export const BASE_METHODS: AdvancedMethod[] = [
  'persistence', 'ema', 'damped', 'blend', 'linear', 'kalman', 'arima', 'holt_winters',
];

const REGIME_CANDIDATES: Record<RegimeLabel, AdvancedMethod[]> = {
  stable: ['persistence', 'ema', 'kalman', 'linear', 'blend'],
  surge: ['persistence', 'linear', 'kalman', 'arima'],
  decline: ['linear', 'kalman', 'ema', 'arima'],
  periodic: ['holt_winters', 'linear', 'persistence', 'kalman'],
  noisy: ['persistence', 'ema', 'damped', 'kalman', 'blend'],
  mixed: ['persistence', 'ema', 'linear', 'kalman', 'damped', 'arima'],
  insufficient: ['persistence'],
};

/** 用历史起点评估每个候选方法在目标 horizon 上的误差（绝不使用目标点之后的数据）。 */
function rollingValidationErrors(
  samples: SeriesPoint[],
  method: AdvancedMethod,
  horizonMinutes: number,
  origins: number,
  seed: number,
): Array<{ origin: number; error: number }> {
  const ordered = [...samples].sort((a, b) => a.x - b.x);
  const errors: Array<{ origin: number; error: number }> = [];
  const lastIndex = ordered.length - 1 - Math.ceil(horizonMinutes) - 1;
  const firstIndex = Math.max(2, lastIndex - origins + 1);
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const train = ordered.slice(0, index + 1);
    const targetX = ordered[index].x + horizonMinutes;
    const target = ordered.find((point, pointIndex) => pointIndex > index && point.x >= targetX);
    if (!target) continue;
    const horizon = target.x - ordered[index].x;
    if (horizon <= 0) continue;
    const predicted = baseModelForecast(method, train, horizon, seed);
    errors.push({ origin: index, error: Math.abs(predicted - target.y) });
  }
  return errors;
}

/** 漂移检测：验证误差漂移 + 输入序列的 Page-Hinkley 水平漂移。 */
export function detectDrift(validationErrors: number[], threshold = 0.6, samples?: SeriesPoint[]): DriftDetection {
  const seriesShift = samples ? detectSeriesDrift(samples) : { detected: false, statistic: 0, direction: 'none' as const };
  if (validationErrors.length < 4) {
    return {
      detected: seriesShift.detected,
      statistic: seriesShift.statistic,
      threshold,
      recent_error_ratio: null,
      recommendation: seriesShift.detected ? 'widen_interval' : 'none',
      note: seriesShift.detected
        ? `输入序列检测到${seriesShift.direction === 'up' ? '上升' : '下降'}漂移（Page-Hinkley ${seriesShift.statistic.toFixed(2)}）`
        : '验证误差样本不足，不做误差漂移判定',
    };
  }
  const overall = mean(validationErrors);
  const recentCount = Math.max(2, Math.floor(validationErrors.length / 3));
  const recent = mean(validationErrors.slice(-recentCount));
  const ratio = overall > 0 ? recent / overall : 1;
  let cumulative = 0;
  let maximum = 0;
  for (const error of validationErrors) {
    cumulative += error / Math.max(1e-6, overall) - 1;
    maximum = Math.max(maximum, cumulative);
  }
  const statistic = Number((maximum / Math.sqrt(validationErrors.length)).toFixed(4));
  const detected = seriesShift.detected || statistic > threshold * 2 || ratio > 1.8;
  return {
    detected,
    statistic: Math.max(statistic, seriesShift.statistic),
    threshold,
    recent_error_ratio: Number(ratio.toFixed(3)),
    recommendation: detected ? (ratio > 2.2 ? 'reset_weights' : 'widen_interval') : 'none',
    note: detected
      ? [
        seriesShift.detected ? `输入序列${seriesShift.direction === 'up' ? '上升' : '下降'}漂移（Page-Hinkley ${seriesShift.statistic.toFixed(2)}）` : '',
        ratio > 1.8 ? `近期误差为历史均值的 ${ratio.toFixed(2)} 倍` : '',
      ].filter(Boolean).join('；') + `，建议${ratio > 2.2 ? '重置权重' : '放大区间'}`
      : '未检测到明显误差或输入漂移',
  };
}

/** 输入序列的 Page-Hinkley：检测均值上/下漂移，对噪声与缺失点稳健。 */
function detectSeriesDrift(samples: SeriesPoint[]): { detected: boolean; statistic: number; direction: 'up' | 'down' | 'none' } {
  if (samples.length < 8) return { detected: false, statistic: 0, direction: 'none' };
  const ordered = [...samples].sort((a, b) => a.x - b.x);
  const values = ordered.map(point => point.y);
  const overall = mean(values);
  const sigma = Math.max(1e-6, std(values));
  const delta = 0.5; // 允许的漂移容差（以标准差计）
  let up = 0;
  let down = 0;
  let maxUp = 0;
  let maxDown = 0;
  for (const value of values) {
    const normalized = (value - overall) / sigma;
    up = Math.max(0, up + normalized - delta);
    down = Math.max(0, down - normalized - delta);
    maxUp = Math.max(maxUp, up);
    maxDown = Math.max(maxDown, down);
  }
  const statistic = Math.max(maxUp, maxDown) / Math.sqrt(values.length);
  const direction = maxUp >= maxDown ? 'up' : 'down';
  return { detected: statistic > 1.2, statistic: Number(statistic.toFixed(4)), direction };
}

function normaliseWeights(errors: Array<{ method: AdvancedMethod; error: number | null }>): Map<AdvancedMethod, number> {
  const valid = errors.filter(item => item.error !== null) as Array<{ method: AdvancedMethod; error: number }>;
  const weights = new Map<AdvancedMethod, number>();
  if (valid.length === 0) {
    for (const item of errors) weights.set(item.method, 1 / Math.max(1, errors.length));
    return weights;
  }
  const baseline = mean(valid.map(item => item.error));
  const scores = valid.map(item => ({
    method: item.method,
    score: Math.exp(-item.error / Math.max(1, baseline)),
  }));
  const total = scores.reduce((sum, item) => sum + item.score, 0);
  for (const item of scores) weights.set(item.method, Math.max(0.02, item.score / total));
  // 归一化（min 权重会略微破坏总和，这里二次归一化）。
  const finalTotal = [...weights.values()].reduce((sum, value) => sum + value, 0);
  for (const [method, weight] of weights) weights.set(method, weight / finalTotal);
  return weights;
}

export interface EnsembleResult extends AdvancedForecastResult {
  validationErrors: Array<{ method: AdvancedMethod; mae: number | null; q95: number | null }>;
}

/**
 * 状态感知自适应集成 + conformal 区间 + 漂移检测。
 * 只使用训练样本；区间校准也只用训练窗口内的历史残差。
 */
export function ensembleForecast(samples: SeriesPoint[], options: AdvancedForecastOptions = {}): EnsembleResult {
  const horizonMinutes = options.horizonMinutes ?? DEFAULT_HORIZON;
  const validationOrigins = options.validationOrigins ?? DEFAULT_VALIDATION_ORIGINS;
  const level = options.conformalLevel ?? 0.95;
  const maxRelativeWidth = options.maxRelativeIntervalWidth ?? 0.5;
  const seed = options.seed ?? 20261109;
  const useRegime = options.useRegime ?? true;
  const useDrift = options.useDrift ?? true;
  const intervalMode = options.intervalMode ?? 'conformal';
  const weightingMode = options.weighting ?? 'error';
  const ordered = [...samples].sort((a, b) => a.x - b.x).filter(point => Number.isFinite(point.y));
  const regime = detectRegime(ordered);
  const notes: string[] = [];

  if (ordered.length < MIN_POINTS) {
    const fallback = ordered.length > 0 ? Math.max(0, ordered[ordered.length - 1].y) : 0;
    return {
      predicted: fallback,
      method: 'ensemble_v70',
      horizon_minutes: horizonMinutes,
      regime,
      drift: {
        detected: false, statistic: 0, threshold: 0.6, recent_error_ratio: null,
        recommendation: 'none', note: '数据不足，未做漂移检测',
      },
      models: BASE_METHODS.map(method => ({
        method, predicted: fallback, weight: method === 'persistence' ? 1 : 0,
        validation_mae: null, calibration_q95: null, selected: method === 'persistence',
      })),
      effective_methods: ['persistence'],
      interval90: { lower: fallback, upper: fallback },
      interval95: { lower: fallback, upper: fallback },
      conformal: { level, quantile: 0, scale: 1, calibration_points: 0, empirical_q90: 0, empirical_q95: 0 },
      reliability: {
        status: 'failed', reasons: ['insufficient_data'], relative_interval_width: null,
        max_relative_interval_width: maxRelativeWidth,
      },
      notes: ['有效点不足，回退为最近有效观测；不给出趋势外推。'],
      validationErrors: [],
    };
  }

  const regimeCandidates = useRegime ? (REGIME_CANDIDATES[regime.label] ?? BASE_METHODS) : BASE_METHODS;
  const candidates = regimeCandidates.filter(method => BASE_METHODS.includes(method));
  if (!candidates.includes('persistence')) candidates.push('persistence');

  const validationByMethod = new Map<AdvancedMethod, Array<{ origin: number; error: number }>>();
  for (const method of candidates) {
    validationByMethod.set(method, rollingValidationErrors(ordered, method, horizonMinutes, validationOrigins, seed));
  }
  const weights = weightingMode === 'equal'
    ? new Map(candidates.map(method => [method, 1 / candidates.length] as [AdvancedMethod, number]))
    : normaliseWeights(candidates.map(method => {
      const errors = validationByMethod.get(method) ?? [];
      return { method, error: errors.length > 0 ? mean(errors.map(item => item.error)) : null };
    }));

  const models: MethodPrediction[] = BASE_METHODS.map(method => {
    const inEnsemble = candidates.includes(method);
    const predicted = baseModelForecast(method, ordered, horizonMinutes, seed);
    const errors = validationByMethod.get(method) ?? [];
    const calibration = conformalQuantile(errors.map(item => item.error), 0.95);
    return {
      method,
      predicted: Number(predicted.toFixed(4)),
      weight: inEnsemble ? Number((weights.get(method) ?? 0).toFixed(4)) : 0,
      validation_mae: errors.length > 0 ? Number(mean(errors.map(item => item.error)).toFixed(4)) : null,
      calibration_q95: calibration === null ? null : Number(calibration.toFixed(4)),
      selected: inEnsemble,
    };
  });

  const effective = models.filter(item => item.weight > 0);
  let predicted = effective.reduce((sum, item) => sum + item.weight * item.predicted, 0);
  if (!Number.isFinite(predicted)) predicted = ordered[ordered.length - 1].y;

  // 校准残差：对每个历史起点，先用同一组合权重得到集成预测，再与真实目标比较。
  const calibrationErrors: number[] = [];
  const calibrationOrigins = Math.min(CONFORMAL_ORIGINS, Math.max(0, ordered.length - Math.ceil(horizonMinutes) - 3));
  const lastIndex = ordered.length - 1 - Math.ceil(horizonMinutes) - 1;
  for (let offset = 0; offset < calibrationOrigins; offset += 1) {
    const index = lastIndex - offset;
    if (index < 3) break;
    const train = ordered.slice(0, index + 1);
    const targetX = ordered[index].x + horizonMinutes;
    const target = ordered.find((point, pointIndex) => pointIndex > index && point.x >= targetX);
    if (!target) continue;
    const horizon = target.x - ordered[index].x;
    if (horizon <= 0) continue;
    let ensembleAtOrigin = 0;
    for (const item of effective) ensembleAtOrigin += item.weight * baseModelForecast(item.method, train, horizon, seed);
    calibrationErrors.push(Math.abs(ensembleAtOrigin - target.y));
  }
  const q90 = conformalQuantile(calibrationErrors, 0.90);
  const q95 = conformalQuantile(calibrationErrors, level);
  const allValidation = [...validationByMethod.values()].flat().map(item => item.error);
  const drift = detectDrift(allValidation, 0.6, ordered);
  const recentCalibration = calibrationErrors.slice(0, Math.min(4, calibrationErrors.length));
  const recentRatio = calibrationErrors.length > 0 && mean(calibrationErrors) > 0
    ? mean(recentCalibration) / mean(calibrationErrors)
    : 1;
  const scale = clamp(recentRatio, 0.8, 2.5) * (useDrift && drift.detected ? 1.5 : 1);
  const fallbackQ95 = quantile(allValidation, 0.95);
  const normalMargin = 1.96 * Math.max(1, residualStdPoints(ordered));
  const margin95 = intervalMode === 'normal'
    ? Math.max(INTERVAL_FLOOR, normalMargin * scale)
    : Math.max(INTERVAL_FLOOR, (q95 ?? fallbackQ95 ?? Math.max(5, residualStdPoints(ordered))) * scale);
  const margin90 = intervalMode === 'normal'
    ? Math.max(INTERVAL_FLOOR, 1.645 * Math.max(1, residualStdPoints(ordered)) * scale)
    : Math.max(INTERVAL_FLOOR, (q90 ?? fallbackQ95 ?? Math.max(5, residualStdPoints(ordered))) * scale);

  const roundedPredicted = Math.max(0, Math.round(predicted));
  const interval90 = {
    lower: Math.max(0, Math.round(predicted - margin90)),
    upper: Math.max(0, Math.round(predicted + margin90)),
  };
  const interval95 = {
    lower: Math.max(0, Math.round(predicted - margin95)),
    upper: Math.max(0, Math.round(predicted + margin95)),
  };
  const relativeWidth = (interval95.upper - interval95.lower) / Math.max(1, roundedPredicted);
  const reasons: string[] = [];
  if (relativeWidth > maxRelativeWidth) reasons.push('interval_too_wide');
  if (useDrift && drift.detected) reasons.push('drift_detected');
  if (regime.label === 'insufficient') reasons.push('insufficient_regime');
  const status = reasons.includes('interval_too_wide') || reasons.includes('insufficient_regime')
    ? 'failed'
    : reasons.length > 0 ? 'warning' : 'ok';

  notes.push(`状态判定：${regime.label}（置信度 ${regime.confidence}），候选模型 ${effective.map(item => item.method).join('/')}。`);
  notes.push(`区间由 ${calibrationErrors.length} 个历史起点残差按 split-conformal 近似校准，自适应系数 ${scale.toFixed(2)}。`);
  if (drift.detected) notes.push(drift.note);
  notes.push('预测仅用于辅助 VoI 与计划灵敏度分析，不替代四态安全判定。');

  return {
    predicted: roundedPredicted,
    method: 'ensemble_v70',
    horizon_minutes: horizonMinutes,
    regime,
    drift,
    models,
    effective_methods: effective.map(item => item.method),
    interval90,
    interval95,
    conformal: {
      level,
      quantile: Number((q95 ?? 0).toFixed(4)),
      scale: Number(scale.toFixed(3)),
      calibration_points: calibrationErrors.length,
      empirical_q90: Number((q90 ?? 0).toFixed(4)),
      empirical_q95: Number((q95 ?? 0).toFixed(4)),
    },
    reliability: {
      status,
      reasons,
      relative_interval_width: Number(relativeWidth.toFixed(4)),
      max_relative_interval_width: maxRelativeWidth,
    },
    notes,
    validationErrors: candidates.map(method => {
      const errors = validationByMethod.get(method) ?? [];
      return {
        method,
        mae: errors.length > 0 ? Number(mean(errors.map(item => item.error)).toFixed(4)) : null,
        q95: (() => {
          const q = quantile(errors.map(item => item.error), 0.95);
          return q === null ? null : Number(q.toFixed(4));
        })(),
      };
    }),
  };
}

/** 便捷入口：供业务层选择预测方法。历史预测服务（prediction.ts）保持不变。 */
export function advancedForecast(samples: SeriesPoint[], options: AdvancedForecastOptions = {}): AdvancedForecastResult {
  return ensembleForecast(samples, options);
}

/** 滚动验证选择（复用旧逻辑），供实验比较“旧自适应”和“新集成”。 */
export { selectForecastMethod };
