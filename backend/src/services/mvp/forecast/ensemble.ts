import type {
  AdvancedForecastOptions,
  AdvancedForecastResult,
  AdvancedMethod,
  MethodPrediction,
  SeriesPoint,
} from './types';
import {
  BASE_METHODS,
  CONFORMAL_ORIGINS,
  DEFAULT_HORIZON,
  DEFAULT_VALIDATION_ORIGINS,
  INTERVAL_FLOOR,
  MIN_POINTS,
} from './types';
import { clamp, conformalQuantile, mean, quantile, residualStdPoints } from './math';
import { REGIME_CANDIDATES, detectRegime } from './regime';
import { baseModelForecast } from './models';
import { detectDrift, rollingValidationErrors } from './drift';

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

export function advancedForecast(samples: SeriesPoint[], options: AdvancedForecastOptions = {}): AdvancedForecastResult {
  return ensembleForecast(samples, options);
}
