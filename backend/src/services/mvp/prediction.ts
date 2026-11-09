/**
 * 短时人流预测服务（可解释基线）。
 *
 * 算法：EMA 平滑 + 最小二乘线性趋势，向前外推 horizon 分钟。
 * 这是刻意选择的轻量、可解释方法：不引入黑箱模型，便于测试与评审复核。
 * 预测区间由窗口内残差标准差给出，不代表真实统计置信区间。
 */
import type { SafetyScenario } from '../safety/types';
import type { ObservationStore } from '../safety/observations';

export const PREDICTION_ALGORITHM = 'adaptive-forecast-v4';
export const PREDICTION_VERSION = '1.0.0';

export type TrendDirection = 'rising' | 'falling' | 'stable' | 'unknown';

export type PredictionReliabilityStatus = 'ok' | 'warning' | 'failed';

export interface PredictionReliability {
  status: PredictionReliabilityStatus;
  reasons: string[];
  relative_interval_width: number | null;
  max_relative_interval_width: number;
}

export function assessPredictionReliability(input: {
  sufficient: boolean;
  predicted_count: number | null;
  interval: { lower: number; upper: number } | null;
  data_quality: { stale: boolean; low_confidence: boolean; missing: boolean };
  max_relative_interval_width: number;
  /** 近期斜率/加速度显著：区间在机制切换下不可靠，直接失败。 */
  regime_unstable?: boolean;
}): PredictionReliability {
  const max = input.max_relative_interval_width;
  if (!input.sufficient || input.predicted_count === null || input.interval === null) {
    return {
      status: 'failed',
      reasons: ['insufficient_data'],
      relative_interval_width: null,
      max_relative_interval_width: max,
    };
  }
  const relative = (input.interval.upper - input.interval.lower) / Math.max(1, input.predicted_count);
  const reasons: string[] = [];
  if (relative > max) reasons.push('interval_too_wide');
  if (input.regime_unstable) reasons.push('regime_unstable');
  if (input.data_quality.stale) reasons.push('stale_observation');
  if (input.data_quality.low_confidence) reasons.push('low_confidence');
  const status: PredictionReliabilityStatus = reasons.includes('interval_too_wide')
    || reasons.includes('insufficient_data')
    || reasons.includes('regime_unstable')
    ? 'failed'
    : reasons.length > 0 ? 'warning' : 'ok';
  return {
    status,
    reasons,
    relative_interval_width: Number(relative.toFixed(4)),
    max_relative_interval_width: max,
  };
}

export interface PredictionResult {
  region_id: string;
  region_name: string;
  generated_at: string;
  algorithm: string;
  algorithm_version: string;
  horizon_minutes: number;
  window_minutes: number;
  input: {
    points: number;
    span_seconds: number;
    first_at: string | null;
    last_at: string | null;
    sources: string[];
    excluded_low_confidence: number;
    excluded_invalid: number;
  };
  sufficient: boolean;
  current_count: number | null;
  predicted_count: number | null;
  interval: { lower: number; upper: number } | null;
  trend: { direction: TrendDirection; rate_per_minute: number | null };
  /** v3：预测方法由滚动验证选择（persistence / ema / damped / blend / linear）。 */
  selection: {
    method: ForecastMethod;
    selected_by: 'rolling_validation' | 'default';
    candidates: Array<{ method: ForecastMethod; validation_mae: number | null; validation_q95: number | null }>;
  };
  /** 区间校准系数：用滚动验证误差放大残差区间，避免过度自信。 */
  interval_calibration: number;
  data_quality: { stale: boolean; low_confidence: boolean; missing: boolean; note: string };
  /** 预测可靠性：区间过宽或数据不足时标记 failed，不用于 VoI 预测动作。 */
  reliability: PredictionReliability;
  uncertainty_note: string;
}

export interface PredictOptions {
  horizonMinutes?: number;
  windowMinutes?: number;
  now?: Date;
}

const EMA_ALPHA = 0.4;
const MIN_POINTS = 3;
const MIN_SPAN_SECONDS = 120;

function clampCount(value: number): number {
  return Math.max(0, Math.round(value));
}

function ema(values: number[], alpha = EMA_ALPHA): number {
  let result = values[0];
  for (let i = 1; i < values.length; i += 1) {
    result = alpha * values[i] + (1 - alpha) * result;
  }
  return result;
}

function linearSlope(points: Array<{ x: number; y: number }>): { slope: number; intercept: number } {
  const n = points.length;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  return { slope, intercept: meanY - slope * meanX };
}

export const TREND_WEIGHT_CANDIDATES = [0.25, 0.5, 0.75, 1] as const;
const DEFAULT_TREND_WEIGHT = 0.75;

/**
 * 用滚动验证选择 EMA 与线性趋势的混合权重。
 * 只使用当前窗口内的历史点做一步预测回测，不接触未来数据。
 */
export function selectTrendWeight(
  samples: Array<{ x: number; y: number }>,
  candidates: readonly number[] = TREND_WEIGHT_CANDIDATES,
  validationPoints = 3,
): { weight: number; selectedBy: 'rolling_validation' | 'default'; scores: Array<{ weight: number; validation_mae: number | null }> } {
  if (samples.length < Math.max(5, validationPoints + 3)) {
    return {
      weight: DEFAULT_TREND_WEIGHT,
      selectedBy: 'default',
      scores: candidates.map(weight => ({ weight, validation_mae: null })),
    };
  }
  const scores = candidates.map(weight => {
    const errors: number[] = [];
    for (let index = samples.length - validationPoints; index < samples.length; index += 1) {
      const train = samples.slice(0, index);
      if (train.length < 3) continue;
      const { slope, intercept } = linearSlope(train);
      const smoothed = ema(train.map(item => item.y));
      const trendAt = intercept + slope * samples[index].x;
      const predicted = (1 - weight) * smoothed + weight * trendAt;
      errors.push(Math.abs(predicted - samples[index].y));
    }
    return {
      weight,
      validation_mae: errors.length > 0 ? Number((errors.reduce((sum, value) => sum + value, 0) / errors.length).toFixed(4)) : null,
    };
  });
  const scored = scores.filter(item => item.validation_mae !== null) as Array<{ weight: number; validation_mae: number }>;
  if (scored.length === 0) {
    return { weight: DEFAULT_TREND_WEIGHT, selectedBy: 'default', scores };
  }
  scored.sort((a, b) => a.validation_mae - b.validation_mae || b.weight - a.weight);
  return { weight: scored[0].weight, selectedBy: 'rolling_validation', scores };
}

export type ForecastMethod = 'persistence' | 'ema' | 'linear' | 'damped' | 'blend';

export const FORECAST_METHODS: ForecastMethod[] = ['persistence', 'ema', 'damped', 'blend', 'linear'];
const DAMPING_PHI = 0.8;
/** 区间保守系数：经验分位在突增场景仍会低估，乘系数以降低过度自信（非正式统计校准）。 */
const INTERVAL_SAFETY_FACTOR = 1.5;

/**
 * Regime-aware 区间放大：近期斜率或加速度显著时使用更大的安全系数。
 * 这是对“突增/机制切换”失败模式的保守补丁，不是正式统计校准；只会加宽区间。
 */
export function regimeIntervalFactor(
  samples: Array<{ x: number; y: number }>,
  base = INTERVAL_SAFETY_FACTOR,
): number {
  if (samples.length < 5) return base;
  const last = samples.slice(-3);
  const previous = samples.slice(-6, -3);
  if (previous.length < 3) return base;
  const recentSlope = linearSlope(last).slope;
  const previousSlope = linearSlope(previous).slope;
  const meanY = samples.reduce((sum, item) => sum + item.y, 0) / samples.length;
  const threshold = Math.max(5, meanY * 0.05);
  const accelerated = Math.abs(recentSlope - previousSlope) > threshold;
  const steep = Math.abs(recentSlope) > threshold;
  const lookback = samples[Math.max(0, samples.length - 11)];
  const growth = Math.abs(samples[samples.length - 1].y - lookback.y) / Math.max(1, meanY);
  if (accelerated || steep || growth > 0.15) return Math.min(8, base * 4);
  return base;
}

/** 对给定训练样本，用指定方法外推 horizon 分钟（不接触未来数据）。 */
export function forecastWithMethod(
  method: ForecastMethod,
  samples: Array<{ x: number; y: number }>,
  horizonMinutes: number,
  options: { alpha?: number; trendWeight?: number } = {},
): number {
  if (samples.length === 0) return 0;
  const last = samples[samples.length - 1];
  if (method === 'persistence') return Math.max(0, last.y);
  const smoothed = ema(samples.map(item => item.y), options.alpha ?? EMA_ALPHA);
  if (method === 'ema') return Math.max(0, smoothed);
  if (samples.length < 2) return Math.max(0, smoothed);
  const { slope, intercept } = linearSlope(samples);
  if (method === 'linear') return Math.max(0, intercept + slope * (last.x + horizonMinutes));
  if (method === 'damped') {
    let cumulative = 0;
    let factor = 1;
    for (let step = 1; step <= Math.max(1, Math.round(horizonMinutes)); step += 1) {
      factor *= DAMPING_PHI;
      cumulative += factor;
    }
    return Math.max(0, smoothed + slope * cumulative);
  }
  const blend = selectTrendWeight(samples);
  const weight = options.trendWeight ?? blend.weight;
  const trendAtNow = intercept + slope * last.x;
  return Math.max(0, (1 - weight) * smoothed + weight * trendAtNow + slope * horizonMinutes);
}

/** 在 samples 中查找相对 originIndex 至少领先 horizonMinutes 的第一个目标点。 */
function targetAfter(
  samples: Array<{ x: number; y: number }>,
  originIndex: number,
  horizonMinutes: number,
): { index: number; point: { x: number; y: number } } | null {
  const base = samples[originIndex].x + horizonMinutes - 1e-9;
  for (let index = originIndex + 1; index < samples.length; index += 1) {
    if (samples[index].x >= base) return { index, point: samples[index] };
  }
  return null;
}

/**
 * 用滚动验证选择预测方法。
 * v4：验证目标步长与最终预测 horizon 一致，且按时间戳（而非固定索引）取目标，
 * 支持 missing/不规则采样；只使用当前窗口内的历史点。
 */
export function selectForecastMethod(
  samples: Array<{ x: number; y: number }>,
  validationPoints = 3,
  candidates: ForecastMethod[] = FORECAST_METHODS,
  horizonMinutes = 1,
): {
  method: ForecastMethod;
  selectedBy: 'rolling_validation' | 'default';
  scores: Array<{ method: ForecastMethod; validation_mae: number | null; validation_q95: number | null }>;
} {
  const minimum = Math.max(5, validationPoints + Math.ceil(horizonMinutes) + 3);
  if (samples.length < minimum) {
    const fallback = candidates.includes('blend') ? 'blend' : candidates[0] ?? 'blend';
    return {
      method: fallback,
      selectedBy: 'default',
      scores: candidates.map(method => ({ method, validation_mae: null, validation_q95: null })),
    };
  }
  const origins: number[] = [];
  for (let index = samples.length - 2; index >= 3 && origins.length < validationPoints; index -= 1) {
    if (targetAfter(samples, index, horizonMinutes)) origins.push(index);
  }
  if (origins.length === 0) {
    const fallback = candidates.includes('blend') ? 'blend' : candidates[0] ?? 'blend';
    return {
      method: fallback,
      selectedBy: 'default',
      scores: candidates.map(method => ({ method, validation_mae: null, validation_q95: null })),
    };
  }
  const scores = candidates.map(method => {
    const errors: number[] = [];
    for (const originIndex of origins) {
      const train = samples.slice(0, originIndex + 1);
      const target = targetAfter(samples, originIndex, horizonMinutes);
      if (!target || train.length < 3) continue;
      const horizon = target.point.x - train[train.length - 1].x;
      if (horizon <= 0) continue;
      errors.push(Math.abs(forecastWithMethod(method, train, horizon) - target.point.y));
    }
    const sortedErrors = [...errors].sort((a, b) => a - b);
    return {
      method,
      validation_mae: errors.length > 0
        ? Number((errors.reduce((sum, value) => sum + value, 0) / errors.length).toFixed(4))
        : null,
      validation_q95: sortedErrors.length > 0
        ? Number(sortedErrors[Math.min(sortedErrors.length - 1, Math.floor(sortedErrors.length * 0.95))].toFixed(4))
        : null,
    };
  });
  const scored = scores.filter(item => item.validation_mae !== null) as Array<{ method: ForecastMethod; validation_mae: number; validation_q95: number | null }>;
  if (scored.length === 0) {
    const fallback = candidates.includes('blend') ? 'blend' : candidates[0] ?? 'blend';
    return { method: fallback, selectedBy: 'default', scores };
  }
  const preference = new Map(candidates.map((method, index) => [method, index]));
  scored.sort((a, b) => a.validation_mae - b.validation_mae || (preference.get(a.method) ?? 0) - (preference.get(b.method) ?? 0));
  return { method: scored[0].method, selectedBy: 'rolling_validation', scores };
}

/** 用所选方法的历史 h 步回测误差 95 分位校准预测区间。 */
export function selectIntervalQuantile(
  samples: Array<{ x: number; y: number }>,
  method: ForecastMethod,
  horizonMinutes: number,
  validationPoints = 3,
  quantile = 0.95,
): number | null {
  if (samples.length < Math.max(5, validationPoints + Math.ceil(horizonMinutes) + 3)) return null;
  const origins: number[] = [];
  for (let index = samples.length - 2; index >= 3 && origins.length < validationPoints; index -= 1) {
    if (targetAfter(samples, index, horizonMinutes)) origins.push(index);
  }
  const errors: number[] = [];
  for (const originIndex of origins) {
    const train = samples.slice(0, originIndex + 1);
    const target = targetAfter(samples, originIndex, horizonMinutes);
    if (!target || train.length < 3) continue;
    const horizon = target.point.x - train[train.length - 1].x;
    if (horizon <= 0) continue;
    errors.push(Math.abs(forecastWithMethod(method, train, horizon) - target.point.y));
  }
  if (errors.length === 0) return null;
  const sorted = errors.sort((a, b) => a - b);
  const boundedQuantile = Math.max(0.5, Math.min(0.99, quantile));
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * boundedQuantile))].toFixed(4));
}

export interface SpatialPredictionResult extends PredictionResult {
  spatial: {
    neighbors: string[];
    neighbor_mean: number | null;
    weight: number;
    neighbor_predictions: Array<{ region_id: string; predicted_count: number | null; sufficient: boolean }>;
    note: string;
  };
}

export class PredictionService {
  constructor(
    private readonly scenario: SafetyScenario,
    private readonly observations: ObservationStore,
  ) {}

  predict(regionId: string, options: PredictOptions = {}): PredictionResult {
    const region = this.scenario.regions.find(item => item.id === regionId);
    if (!region) throw new Error(`unknown region: ${regionId}`);

    const now = options.now ?? new Date();
    const horizonMinutes = options.horizonMinutes ?? 5;
    const windowMinutes = options.windowMinutes
      ?? Math.max(5, Math.round(this.scenario.config.trend_window_seconds / 60));
    const from = new Date(now.getTime() - windowMinutes * 60_000);

    const raw = this.observations.window(regionId, from, now);
    const invalid = raw.filter(item => !item.valid).length;
    const lowConfidence = raw.filter(item => item.valid && item.confidence < this.scenario.config.min_confidence).length;
    const points = raw
      .filter(item => item.valid && item.confidence >= this.scenario.config.min_confidence)
      .sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime());

    const latest = this.observations.latest(regionId);
    const latestTrusted = this.observations.latestValid(regionId);
    const ageSeconds = latest
      ? Math.max(0, (now.getTime() - new Date(latest.observed_at).getTime()) / 1000)
      : Infinity;
    const stale = ageSeconds > this.scenario.config.max_observation_age_seconds;
    const lowConfidenceLatest = latest ? latest.confidence < this.scenario.config.min_confidence : true;
    const spanSeconds = points.length >= 2
      ? (new Date(points[points.length - 1].observed_at).getTime() - new Date(points[0].observed_at).getTime()) / 1000
      : 0;
    const sufficient = points.length >= MIN_POINTS && spanSeconds >= MIN_SPAN_SECONDS;

    const base = {
      region_id: region.id,
      region_name: region.name,
      generated_at: now.toISOString(),
      algorithm: PREDICTION_ALGORITHM,
      algorithm_version: PREDICTION_VERSION,
      horizon_minutes: horizonMinutes,
      window_minutes: windowMinutes,
      input: {
        points: points.length,
        span_seconds: Math.round(spanSeconds),
        first_at: points[0]?.observed_at ?? null,
        last_at: points[points.length - 1]?.observed_at ?? null,
        sources: Array.from(new Set(points.map(item => item.source))).sort(),
        excluded_low_confidence: lowConfidence,
        excluded_invalid: invalid,
      },
      data_quality: {
        stale,
        low_confidence: lowConfidenceLatest,
        missing: points.length === 0,
        note: this.qualityNote(stale, lowConfidenceLatest, points.length),
      },
    };

    if (!sufficient) {
      const fallback = latestTrusted ? latestTrusted.estimated_count : null;
      const fallbackInterval = fallback === null ? null : { lower: fallback, upper: fallback };
      return {
        ...base,
        sufficient: false,
        current_count: fallback,
        predicted_count: fallback,
        interval: fallbackInterval,
        trend: { direction: 'unknown', rate_per_minute: null },
        selection: {
          method: 'persistence',
          selected_by: 'default',
          candidates: FORECAST_METHODS.map(method => ({ method, validation_mae: null, validation_q95: null })),
        },
        interval_calibration: 1,
        reliability: assessPredictionReliability({
          sufficient: false,
          predicted_count: fallback,
          interval: fallbackInterval,
          data_quality: base.data_quality,
          max_relative_interval_width: this.scenario.config.prediction_max_relative_interval_width,
        }),
        uncertainty_note: `数据不足（有效点 ${points.length} 个，跨度 ${Math.round(spanSeconds)} 秒，要求 ≥${MIN_POINTS} 点且 ≥${MIN_SPAN_SECONDS} 秒），仅回退为最近一次有效观测，不给出趋势外推。`,
      };
    }

    const t0 = new Date(points[0].observed_at).getTime();
    const samples = points.map(item => ({
      x: (new Date(item.observed_at).getTime() - t0) / 60_000,
      y: item.estimated_count,
    }));
    const { slope, intercept } = linearSlope(samples);
    const smoothed = ema(samples.map(item => item.y));
    const lastX = samples[samples.length - 1].x;
    const trendAtNow = intercept + slope * lastX;
    const selection = selectForecastMethod(samples, 3, FORECAST_METHODS, horizonMinutes);
    const predicted = clampCount(forecastWithMethod(selection.method, samples, horizonMinutes));

    const residuals = samples.map(item => item.y - (intercept + slope * item.x));
    const residualStd = Math.sqrt(
      residuals.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, residuals.length - 2),
    );
    const selectedScore = selection.scores.find(item => item.method === selection.method) ?? null;
    const empiricalQ95 = selectIntervalQuantile(samples, selection.method, horizonMinutes) ?? selectedScore?.validation_q95 ?? null;
    const intervalCalibration = empiricalQ95 === null
      ? 1
      : Number(Math.max(1, empiricalQ95 / Math.max(1, residualStd)).toFixed(4));
    const margin = empiricalQ95 !== null
      ? Math.max(5, empiricalQ95 * regimeIntervalFactor(samples) * Math.sqrt(1 + horizonMinutes / Math.max(1, samples.length)))
      : Math.max(
        5,
        1.96 * residualStd * Math.sqrt(1 + horizonMinutes / Math.max(1, samples.length)) * intervalCalibration,
      );

    const current = clampCount(points[points.length - 1].estimated_count);
    const direction: TrendDirection = slope > 2 ? 'rising' : slope < -2 ? 'falling' : 'stable';
    const interval = { lower: clampCount(predicted - margin), upper: clampCount(predicted + margin) };
    const reliability = assessPredictionReliability({
      sufficient: true,
      predicted_count: predicted,
      interval,
      data_quality: base.data_quality,
      max_relative_interval_width: this.scenario.config.prediction_max_relative_interval_width,
      regime_unstable: regimeIntervalFactor(samples) > INTERVAL_SAFETY_FACTOR,
    });

    return {
      ...base,
      sufficient: true,
      current_count: current,
      predicted_count: predicted,
      interval,
      trend: { direction, rate_per_minute: Number(slope.toFixed(2)) },
      selection: { method: selection.method, selected_by: selection.selectedBy, candidates: selection.scores },
      interval_calibration: intervalCalibration,
      reliability,
      uncertainty_note: `基于窗口内 ${points.length} 个可信观测，由滚动验证选择 ${selection.method} 方法外推；区间使用验证误差 95 分位校准。未建模事件突变与拥堵反馈，预测 ${horizonMinutes} 分钟内的吞吐上界，不是安全保证。`
        + (reliability.status === 'failed' ? ` 预测可靠性失败：${reliability.reasons.join('、')}。` : ''),
    };
  }

  /** 邻居信息融合：自身数据不足时更多依赖相邻区域趋势；仅作辅助，不替代本地观测。 */
  predictSpatial(regionId: string, neighborRegionIds: string[], options: PredictOptions = {}): SpatialPredictionResult {
    const own = this.predict(regionId, options);
    const neighborPredictions = neighborRegionIds.map(id => this.predict(id, options));
    const usable = neighborPredictions.filter(item => item.sufficient && item.predicted_count !== null);
    if (usable.length === 0 || own.predicted_count === null) {
      return {
        ...own,
        spatial: {
          neighbors: neighborRegionIds,
          neighbor_mean: null,
          weight: 0,
          neighbor_predictions: neighborPredictions.map(item => ({ region_id: item.region_id, predicted_count: item.predicted_count, sufficient: item.sufficient })),
          note: '邻居数据不足，未融合',
        },
      };
    }
    const neighborMean = usable.reduce((sum, item) => sum + (item.predicted_count ?? 0), 0) / usable.length;
    const weight = own.sufficient ? 0.25 : 0.6;
    const blended = Math.max(0, Math.round((1 - weight) * own.predicted_count + weight * neighborMean));
    const spread = Math.sqrt(meanSquare(usable.map(item => (item.predicted_count ?? 0) - neighborMean)));
    const interval = own.interval
      ? { lower: Math.max(0, Math.round(own.interval.lower - spread * weight)), upper: Math.round(own.interval.upper + spread * weight) }
      : null;
    return {
      ...own,
      predicted_count: blended,
      interval,
      spatial: {
        neighbors: neighborRegionIds,
        neighbor_mean: Number(neighborMean.toFixed(2)),
        weight,
        neighbor_predictions: neighborPredictions.map(item => ({ region_id: item.region_id, predicted_count: item.predicted_count, sufficient: item.sufficient })),
        note: `融合 ${usable.length} 个邻居预测（权重 ${weight}）；邻居结果只作辅助，不是人群迁移证据。`,
      },
      uncertainty_note: `${own.uncertainty_note} ${own.sufficient ? '' : '自身数据不足，邻居信息权重提高。'}`.trim(),
    };
  }

  private qualityNote(stale: boolean, lowConfidence: boolean, pointCount: number): string {
    const parts: string[] = [];
    if (pointCount === 0) parts.push('窗口内无可信观测');
    if (stale) parts.push('最近观测已过期');
    if (lowConfidence) parts.push('最近观测置信度低于阈值');
    return parts.length > 0 ? parts.join('；') : '数据质量正常';
  }
}

function meanSquare(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value ** 2, 0) / values.length;
}

/** 供离线实验复用：对任意时间序列做同样的 EMA + 线性外推。 */
export function predictSeries(
  values: number[],
  options: { horizonMinutes?: number; alpha?: number; trendWeight?: number; method?: ForecastMethod } = {},
): { predicted: number; slope: number; smoothed: number } {
  if (values.length < 2) {
    const value = values[0] ?? 0;
    return { predicted: value, slope: 0, smoothed: value };
  }
  const points = values.map((y, x) => ({ x, y }));
  const { slope } = linearSlope(points);
  const smoothed = ema(values, options.alpha ?? EMA_ALPHA);
  const method = options.method ?? 'blend';
  const predicted = clampCount(forecastWithMethod(method, points, options.horizonMinutes ?? 5, {
    alpha: options.alpha,
    trendWeight: options.trendWeight,
  }));
  return { predicted, slope, smoothed };
}
