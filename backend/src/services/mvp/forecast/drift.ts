import type { AdvancedMethod, DriftDetection, SeriesPoint } from './types';
import { mean, std } from './math';
import { baseModelForecast } from './models';

export function rollingValidationErrors(
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
