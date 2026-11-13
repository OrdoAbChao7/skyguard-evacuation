export interface SeriesPoint {
  x: number;
  y: number;
}

/**
 * 预测模块的公共类型与常量。
 */
export type RegimeLabel = 'stable' | 'surge' | 'decline' | 'periodic' | 'noisy' | 'mixed' | 'insufficient';

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

export const MIN_POINTS = 4;
export const DEFAULT_HORIZON = 5;
export const DEFAULT_VALIDATION_ORIGINS = 8;
export const CONFORMAL_ORIGINS = 16;
export const INTERVAL_FLOOR = 5;

export const BASE_METHODS: AdvancedMethod[] = [
  'persistence', 'ema', 'damped', 'blend', 'linear', 'kalman', 'arima', 'holt_winters',
];

