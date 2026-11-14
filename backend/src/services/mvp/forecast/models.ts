import { forecastWithMethod, type ForecastMethod } from '../prediction';
import type { AdvancedMethod, SeriesPoint } from './types';
import { clamp, linearFit, mean, regularize, residualStdPoints, sorted, std } from './math';

export interface ModelOutput {
  predicted: number;
  variance?: number;
}

const HW_ALPHA = 0.3;

const HW_BETA = 0.1;

const HW_GAMMA = 0.2;

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
