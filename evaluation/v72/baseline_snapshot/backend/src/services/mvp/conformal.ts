/**
 * V7.1 自适应 conformal 校准与在线变点检测。
 *
 * 目标：解决 V7.0 中 surge/regime_shift 区间覆盖不足的问题。
 *
 * 方法：
 *  - Adaptive Conformal Inference (ACI)：按实际覆盖结果在线更新误覆盖率 α，
 *      α_{t+1} = clip(α_t + γ(α_target − err_t))，err_t = 1{未覆盖}；
 *  - 残差缓冲：只使用已观测到的历史绝对误差，按 conformal 分位构造区间；
 *  - 变点检测：Page-Hinkley/CUSUM 检测残差均值上移或单点异常，
 *    触发时清空旧缓冲并临时收紧 α（加宽区间）；
 *  - 可靠性门控：覆盖估计、区间相对宽度、变点状态共同决定 ok/warning/failed。
 *
 * 全部为因果在线更新：第 t 步的区间只使用 t 之前的残差与覆盖结果。
 * 不是正式统计置信区间；未在真实场馆时序上验证。
 */

export interface AdaptiveConformalConfig {
  /** 目标覆盖率，例如 0.9 / 0.95。 */
  targetCoverage: number;
  /** ACI 学习率 γ。 */
  gamma?: number;
  /** 残差缓冲上限。 */
  bufferSize?: number;
  /** 最少校准残差数；不足时回退外部区间。 */
  minBuffer?: number;
  /** α 下限/上限（越大区间越窄）。 */
  minAlpha?: number;
  maxAlpha?: number;
  /** 覆盖估计 EWMA 系数。 */
  coverageEta?: number;
}

export interface ConformalInterval {
  lower: number;
  upper: number;
  /** 是否使用校准器（false 表示回退外部区间）。 */
  calibrated: boolean;
  alpha: number;
  quantile: number;
  buffer_size: number;
}

export interface ConformalReliability {
  status: 'ok' | 'warning' | 'failed';
  reasons: string[];
  coverage_estimate: number;
  target_coverage: number;
  relative_width: number | null;
  change_detected: boolean;
}

const clamp = (value: number, lower: number, upper: number): number => Math.min(upper, Math.max(lower, value));

export class AdaptiveConformalCalibrator {
  readonly targetCoverage: number;
  private readonly gamma: number;
  private readonly bufferSize: number;
  private readonly minBuffer: number;
  private readonly minAlpha: number;
  private readonly maxAlpha: number;
  private readonly coverageEta: number;
  private alpha: number;
  /** 带符号残差（actual − predicted）；用于非对称 conformal 区间。 */
  private residuals: number[] = [];
  private coverageEstimate: number;
  private inflationFactor = 1;
  private inflationSteps = 0;

  constructor(config: AdaptiveConformalConfig) {
    this.targetCoverage = clamp(config.targetCoverage, 0.5, 0.99);
    this.gamma = clamp(config.gamma ?? 0.05, 0.001, 0.5);
    this.bufferSize = Math.max(5, Math.floor(config.bufferSize ?? 40));
    this.minBuffer = Math.max(3, Math.floor(config.minBuffer ?? 8));
    this.minAlpha = clamp(config.minAlpha ?? 0.005, 0.001, 0.4);
    this.maxAlpha = clamp(config.maxAlpha ?? 0.5, this.minAlpha, 0.8);
    this.coverageEta = clamp(config.coverageEta ?? 0.15, 0.01, 1);
    this.alpha = 1 - this.targetCoverage;
    this.coverageEstimate = this.targetCoverage;
  }

  get miscoverage(): number {
    return this.alpha;
  }

  get coverage(): number {
    return this.coverageEstimate;
  }

  get size(): number {
    return this.residuals.length;
  }

  get residualsSnapshot(): number[] {
    return [...this.residuals];
  }

  /** 记录一次带符号误差（actual − predicted）与是否被当前区间覆盖，并更新 α。 */
  update(signedResidual: number, covered: boolean): void {
    const residual = Number.isFinite(signedResidual) ? signedResidual : 0;
    this.residuals.push(residual);
    if (this.residuals.length > this.bufferSize) this.residuals.shift();
    const targetAlpha = 1 - this.targetCoverage;
    const error = covered ? 0 : 1;
    this.alpha = clamp(this.alpha + this.gamma * (targetAlpha - error), this.minAlpha, this.maxAlpha);
    this.coverageEstimate = (1 - this.coverageEta) * this.coverageEstimate + this.coverageEta * (covered ? 1 : 0);
  }

  /**
   * 变点触发：保留最近少量残差，临时收紧 α，并在有限步内对残差分位做保守膨胀。
   * 新 regime 的幅度未知，仅靠历史分位会滞后；膨胀系数是显式保守启发式。
   */
  onChangePoint(keep = 5, options: { factor?: number; steps?: number } = {}): void {
    this.residuals = this.residuals.slice(-Math.max(1, keep));
    this.alpha = clamp(Math.min(this.alpha, 1 - this.targetCoverage) * 0.5, this.minAlpha, this.maxAlpha);
    this.coverageEstimate = Math.min(this.coverageEstimate, this.targetCoverage - 0.05);
    this.inflationFactor = Math.max(1, options.factor ?? 2.5);
    this.inflationSteps = Math.max(0, Math.floor(options.steps ?? 6));
  }

  get inflation(): number {
    return this.inflationSteps > 0 ? this.inflationFactor : 1;
  }

  private quantileAt(level: number): number | null {
    if (this.residuals.length < this.minBuffer) return null;
    const ordered = [...this.residuals].sort((a, b) => a - b);
    const rank = Math.ceil((ordered.length + 1) * clamp(level, 0.001, 0.999));
    return ordered[Math.min(ordered.length - 1, Math.max(0, rank - 1))];
  }

  /** 绝对残差分位（宽度估计）。 */
  private absQuantileAt(level: number): number | null {
    if (this.residuals.length < this.minBuffer) return null;
    const ordered = this.residuals.map(value => Math.abs(value)).sort((a, b) => a - b);
    const rank = Math.ceil((ordered.length + 1) * clamp(level, 0.001, 0.999));
    return ordered[Math.min(ordered.length - 1, Math.max(0, rank - 1))];
  }

  /** 上侧绝对残差分位（兼容旧接口）。 */
  quantile(): number | null {
    return this.absQuantileAt(1 - this.alpha);
  }

  /**
   * 偏差校正 conformal 区间：
   *   中心 = 预测 + 带符号残差中位数（校正系统性低估/高估）；
   *   半宽 = 绝对残差的 (1−α) 分位 × 变点膨胀系数。
   * 相比纯非对称分位，避免“残差全部同号”时区间整体偏移或零宽。
   */
  interval(predicted: number, fallback?: { lower: number; upper: number }): ConformalInterval {
    const median = this.quantileAt(0.5);
    const qAbs = this.absQuantileAt(1 - this.alpha);
    if (median === null || qAbs === null) {
      const lower = fallback?.lower ?? Math.max(0, predicted);
      const upper = fallback?.upper ?? Math.max(0, predicted);
      return { lower, upper, calibrated: false, alpha: this.alpha, quantile: 0, buffer_size: this.residuals.length };
    }
    const factor = this.inflationSteps > 0 ? this.inflationFactor : 1;
    if (this.inflationSteps > 0) this.inflationSteps -= 1;
    const center = predicted + median;
    const halfWidth = Math.max(3, qAbs * factor);
    return {
      lower: Math.max(0, Math.round(center - halfWidth)),
      upper: Math.max(0, Math.round(center + halfWidth)),
      calibrated: true,
      alpha: Number(this.alpha.toFixed(4)),
      quantile: Number(qAbs.toFixed(4)),
      buffer_size: this.residuals.length,
    };
  }
}

export interface ChangePointConfig {
  /** CUSUM 参考值（以标准差计）。 */
  reference?: number;
  /** 检测阈值（归一化）。 */
  threshold?: number;
  /** 单点异常阈值（以运行标准差计）。 */
  spikeSigma?: number;
  /** 触发后的冷却步数。 */
  cooldown?: number;
}

export class OnlineChangePointDetector {
  private readonly reference: number;
  private readonly threshold: number;
  private readonly spikeSigma: number;
  private readonly cooldown: number;
  private mean = 0;
  private variance = 0;
  private count = 0;
  private up = 0;
  private down = 0;
  private cooldownLeft = 0;

  constructor(config: ChangePointConfig = {}) {
    this.reference = Math.max(0.01, config.reference ?? 0.5);
    this.threshold = Math.max(0.1, config.threshold ?? 1.2);
    this.spikeSigma = Math.max(1, config.spikeSigma ?? 3);
    this.cooldown = Math.max(0, Math.floor(config.cooldown ?? 3));
  }

  update(residual: number): { detected: boolean; statistic: number; reason: 'cusum_up' | 'cusum_down' | 'spike' | null } {
    const value = Number.isFinite(residual) ? Math.max(0, residual) : 0;
    this.count += 1;
    const delta = value - this.mean;
    this.mean += delta / this.count;
    this.variance += delta * (value - this.mean);
    const sigma = this.count > 1 ? Math.sqrt(this.variance / (this.count - 1)) : 0;
    const normalized = sigma > 1e-9 ? (value - this.mean) / sigma : 0;

    if (this.cooldownLeft > 0) {
      this.cooldownLeft -= 1;
      return { detected: false, statistic: 0, reason: null };
    }

    this.up = Math.max(0, this.up + normalized - this.reference);
    this.down = Math.max(0, this.down - normalized - this.reference);
    const statistic = Math.max(this.up, this.down) / Math.sqrt(this.count);
    const spike = Math.abs(normalized) > this.spikeSigma && this.count > 3;
    const detected = statistic > this.threshold || spike;
    if (detected) {
      this.up = 0;
      this.down = 0;
      this.cooldownLeft = this.cooldown;
      return {
        detected: true,
        statistic: Number(statistic.toFixed(4)),
        reason: spike ? 'spike' : (this.up >= this.down ? 'cusum_up' : 'cusum_down'),
      };
    }
    return { detected: false, statistic: Number(statistic.toFixed(4)), reason: null };
  }
}

export function assessConformalReliability(input: {
  calibrator: AdaptiveConformalCalibrator;
  interval: ConformalInterval;
  predicted: number;
  changeDetected: boolean;
  maxRelativeWidth: number;
  minCoverageMargin?: number;
}): ConformalReliability {
  const width = input.interval.upper - input.interval.lower;
  const relative = width / Math.max(1, input.predicted);
  const reasons: string[] = [];
  const margin = input.minCoverageMargin ?? 0.08;
  const target = input.calibrator.targetCoverage;
  if (!input.interval.calibrated) reasons.push('insufficient_calibration');
  if (input.interval.calibrated && input.calibrator.coverage < target - margin) {
    reasons.push('coverage_below_target');
  }
  if (relative > input.maxRelativeWidth) reasons.push('interval_too_wide');
  if (input.changeDetected) reasons.push('change_point_detected');
  const status = reasons.includes('interval_too_wide')
    || reasons.includes('insufficient_calibration')
    || (input.interval.calibrated && input.calibrator.coverage < target - 2 * margin)
    ? 'failed'
    : reasons.length > 0 ? 'warning' : 'ok';
  return {
    status,
    reasons,
    coverage_estimate: Number(input.calibrator.coverage.toFixed(4)),
    target_coverage: Number(target.toFixed(4)),
    relative_width: Number(relative.toFixed(4)),
    change_detected: input.changeDetected,
  };
}
