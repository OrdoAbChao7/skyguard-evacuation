import type { AdvancedMethod, RegimeDetection, RegimeLabel, SeriesPoint } from './types';
import { BASE_METHODS, MIN_POINTS } from './types';
import { clamp, linearFit, mean, regularize, std } from './math';

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

export const REGIME_CANDIDATES: Record<RegimeLabel, AdvancedMethod[]> = {
  stable: ['persistence', 'ema', 'kalman', 'linear', 'blend'],
  surge: ['persistence', 'linear', 'kalman', 'arima'],
  decline: ['linear', 'kalman', 'ema', 'arima'],
  periodic: ['holt_winters', 'linear', 'persistence', 'kalman'],
  noisy: ['persistence', 'ema', 'damped', 'kalman', 'blend'],
  mixed: ['persistence', 'ema', 'linear', 'kalman', 'damped', 'arima'],
  insufficient: ['persistence'],
};
