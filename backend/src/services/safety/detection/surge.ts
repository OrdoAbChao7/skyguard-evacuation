/**
 * V7.5 低误报突增检测（研究模块）。
 *
 * 在 V7.4 的 CUSUM+spike 与 3σ 基线上增加：
 *  - 自适应 CUSUM（EWMA 基线/方差、自适应阈值）；
 *  - 双阈值 + 持续性确认；
 *  - 多传感器可靠性加权证据与冲突抑制；
 *  - SPRT（序贯概率比）对照。
 *
 * 边界：
 *  - 所有检测器只处理标量/多传感器读数，不接触真实视频或人群真值；
 *  - 基线来自预热窗口，突增后不吸收到基线；
 *  - 低误报优先：宁可延迟 1–2 步，也不在稳定/冲突段报警。
 */

export interface SensorObservation {
  sensorId: string;
  value: number;
  reliability: number;
  /** 该读数是否来自延迟队列。 */
  delayed?: boolean;
  missing?: boolean;
}

export interface DetectionSample {
  /** 融合值；没有融合值时可用 NaN。 */
  value: number;
  sensors?: SensorObservation[];
}

export interface DetectionDecision {
  alarm: boolean;
  score: number;
  threshold: number;
  reason: string;
  /** 参与确认的传感器数。 */
  support: number;
  /** 当前是否处于警告/持续状态（诊断用）。 */
  warning?: boolean;
}

export interface Detector {
  readonly name: string;
  update(sample: DetectionSample): DetectionDecision;
  reset(): void;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Baseline {
  mean: number;
  sigma: number;
  count: number;
  warmup: number;
}

function updateBaseline(baseline: Baseline, value: number): void {
  if (baseline.count >= baseline.warmup) return;
  baseline.count += 1;
  const delta = value - baseline.mean;
  baseline.mean += delta / baseline.count;
  if (baseline.count > 1) {
    const variance = ((baseline.count - 2) * baseline.sigma ** 2 + delta * (value - baseline.mean)) / (baseline.count - 1);
    baseline.sigma = Math.sqrt(Math.max(0, variance));
  }
}

function zScore(value: number, baseline: Baseline): number {
  return (value - baseline.mean) / Math.max(1e-6, baseline.sigma);
}

export class ThreeSigmaDetector implements Detector {
  readonly name = 'naive3sigma';
  private baseline: Baseline = { mean: 0, sigma: 0, count: 0, warmup: 20 };

  update(sample: DetectionSample): DetectionDecision {
    if (!finite(sample.value) || sample.value < 0) {
      return { alarm: false, score: 0, threshold: 0, reason: 'invalid_value', support: 0 };
    }
    if (this.baseline.count < this.baseline.warmup) {
      updateBaseline(this.baseline, sample.value);
      return { alarm: false, score: 0, threshold: 3, reason: 'warmup', support: 0 };
    }
    const z = zScore(sample.value, this.baseline);
    return {
      alarm: z >= 3,
      score: Number(z.toFixed(4)),
      threshold: 3,
      reason: z >= 3 ? 'z_above_3' : 'normal',
      support: 1,
    };
  }

  reset(): void {
    this.baseline = { mean: 0, sigma: 0, count: 0, warmup: 20 };
  }
}

export class CusumDetector implements Detector {
  readonly name = 'cusum';
  private baseline: Baseline = { mean: 0, sigma: 0, count: 0, warmup: 20 };
  private score = 0;

  constructor(private readonly k = 0.5, private readonly h = 5) {}

  update(sample: DetectionSample): DetectionDecision {
    if (!finite(sample.value) || sample.value < 0) {
      return { alarm: false, score: this.score, threshold: this.h, reason: 'invalid_value', support: 0 };
    }
    if (this.baseline.count < this.baseline.warmup) {
      updateBaseline(this.baseline, sample.value);
      return { alarm: false, score: 0, threshold: this.h, reason: 'warmup', support: 0 };
    }
    const sigma = Math.max(1e-6, this.baseline.sigma);
    const z = (sample.value - this.baseline.mean) / sigma;
    this.score = Math.max(0, this.score + z - this.k);
    const alarm = this.score >= this.h;
    return {
      alarm,
      score: Number(this.score.toFixed(4)),
      threshold: this.h,
      reason: alarm ? 'cusum_above_threshold' : 'normal',
      support: 1,
    };
  }

  reset(): void {
    this.baseline = { mean: 0, sigma: 0, count: 0, warmup: 20 };
    this.score = 0;
  }
}

export class AdaptiveCusumDetector implements Detector {
  readonly name = 'adaptive_cusum';
  private baseline: Baseline = { mean: 0, sigma: 0, count: 0, warmup: 20 };
  private score = 0;
  private lastAlarmAt = -Infinity;
  private tick = 0;

  constructor(
    private readonly alpha = 0.02,
    private readonly hBase = 4.5,
    private readonly minDwell = 5,
  ) {}

  update(sample: DetectionSample): DetectionDecision {
    this.tick += 1;
    if (!finite(sample.value) || sample.value < 0) {
      return { alarm: false, score: this.score, threshold: this.hBase, reason: 'invalid_value', support: 0 };
    }
    if (this.baseline.count < this.baseline.warmup) {
      updateBaseline(this.baseline, sample.value);
      return { alarm: false, score: 0, threshold: this.hBase, reason: 'warmup', support: 0 };
    }
    const sigma = Math.max(1e-6, this.baseline.sigma);
    const z = (sample.value - this.baseline.mean) / sigma;
    this.score = Math.max(0, this.score + z - 0.5);
    // 警报越接近，阈值越高（抑制单点尖峰），并设置最短驻留避免连续报警。
    const threshold = this.hBase + Math.min(2, this.score * 0.1);
    const dwellOk = this.tick - this.lastAlarmAt >= this.minDwell;
    const alarm = this.score >= threshold && dwellOk;
    if (alarm) {
      this.lastAlarmAt = this.tick;
      this.score = 0;
    } else if (!alarm) {
      // 仅在非预警状态缓慢更新基线，避免把突增吸收进基线。
      const slow = this.score < 1 ? this.alpha : this.alpha * 0.1;
      this.baseline.mean += slow * (sample.value - this.baseline.mean);
      const variance = (1 - slow) * this.baseline.sigma ** 2 + slow * (sample.value - this.baseline.mean) ** 2;
      this.baseline.sigma = Math.sqrt(Math.max(1e-6, variance));
    }
    return {
      alarm,
      score: Number(this.score.toFixed(4)),
      threshold: Number(threshold.toFixed(4)),
      reason: alarm ? 'adaptive_cusum_above_threshold' : 'normal',
      support: 1,
    };
  }

  reset(): void {
    this.baseline = { mean: 0, sigma: 0, count: 0, warmup: 20 };
    this.score = 0;
    this.lastAlarmAt = -Infinity;
    this.tick = 0;
  }
}

export class SprtDetector implements Detector {
  readonly name = 'sprt';
  private baseline: Baseline = { mean: 0, sigma: 0, count: 0, warmup: 20 };
  private llr = 0;
  private lastAlarmAt = -Infinity;
  private tick = 0;

  constructor(
    private readonly deltaSigma = 1.5,
    private readonly alpha = 0.01,
    private readonly beta = 0.1,
    private readonly minDwell = 5,
  ) {}

  update(sample: DetectionSample): DetectionDecision {
    this.tick += 1;
    if (!finite(sample.value) || sample.value < 0) {
      return { alarm: false, score: this.llr, threshold: 0, reason: 'invalid_value', support: 0 };
    }
    if (this.baseline.count < this.baseline.warmup) {
      updateBaseline(this.baseline, sample.value);
      return { alarm: false, score: 0, threshold: 0, reason: 'warmup', support: 0 };
    }
    const sigma = Math.max(1e-6, this.baseline.sigma);
    const delta = this.deltaSigma * sigma;
    const x = sample.value;
    // H0: N(mu, sigma), H1: N(mu + delta, sigma)
    const llrIncrement = (delta * (x - this.baseline.mean) - delta ** 2 / 2) / (sigma ** 2);
    this.llr = Math.max(0, this.llr + llrIncrement);
    const upper = Math.log((1 - this.beta) / this.alpha);
    const dwellOk = this.tick - this.lastAlarmAt >= this.minDwell;
    const alarm = this.llr >= upper && dwellOk;
    if (alarm) {
      this.lastAlarmAt = this.tick;
      this.llr = 0;
    }
    return {
      alarm,
      score: Number(this.llr.toFixed(4)),
      threshold: Number(upper.toFixed(4)),
      reason: alarm ? 'sprt_upper_crossed' : 'normal',
      support: 1,
    };
  }

  reset(): void {
    this.baseline = { mean: 0, sigma: 0, count: 0, warmup: 20 };
    this.llr = 0;
    this.lastAlarmAt = -Infinity;
    this.tick = 0;
  }
}

export interface DualThresholdConfig {
  /** 警告阈值（z）。 */
  warningZ: number;
  /** 报警阈值（z）。 */
  alarmZ: number;
  /** 达到报警阈值需要连续确认的步数。 */
  persist: number;
  /** 单传感器参与报警所需的最低可靠度。 */
  singleSensorReliability: number;
  /** 传感器间 z 差超过该值视为冲突。 */
  conflictZ: number;
  /** 冲突时至少需要的报警传感器数。 */
  conflictSupport: number;
}

export const DEFAULT_DUAL_CONFIG: DualThresholdConfig = {
  warningZ: 2.5,
  alarmZ: 4,
  persist: 2,
  singleSensorReliability: 0.9,
  conflictZ: 4,
  conflictSupport: 2,
};

/**
 * 双阈值 + 持续性 + 多传感器可靠性加权（V7.5 提议检测器）。
 *
 * 设计目标：稳定段不报警；真实突增在 1–3 步内确认；
 * 单传感器偏置/冲突不单独触发报警；缺失时仍可用剩余传感器确认。
 */
export class ReliabilityDualDetector implements Detector {
  readonly name = 'reliability_dual';
  private baseline: Baseline = { mean: 0, sigma: 0, count: 0, warmup: 20 };
  private persistCount = 0;
  private lastAlarmAt = -Infinity;
  private tick = 0;
  private sensors = new Map<string, { mean: number; sigma: number; count: number }>();

  constructor(configInput: Partial<DualThresholdConfig> = {}, private readonly minDwell = 3) {
    this.config = { ...DEFAULT_DUAL_CONFIG, ...configInput };
  }

  private readonly config: DualThresholdConfig;

  update(sample: DetectionSample): DetectionDecision {
    this.tick += 1;
    if (!finite(sample.value) || sample.value < 0) {
      this.persistCount = 0;
      return { alarm: false, score: 0, threshold: this.config.alarmZ, reason: 'invalid_value', support: 0, warning: false };
    }
    if (this.baseline.count < this.baseline.warmup) {
      updateBaseline(this.baseline, sample.value);
      return { alarm: false, score: 0, threshold: this.config.alarmZ, reason: 'warmup', support: 0, warning: false };
    }

    // 每个传感器的相对基线 z（用融合基线近似；传感器长期偏置会降低权重）。
    const observations = (sample.sensors ?? []).filter(item => !item.missing && finite(item.value) && item.value >= 0);
    let sensorZs: Array<{ sensorId: string; z: number; reliability: number }>;
    if (observations.length === 0) {
      sensorZs = [{ sensorId: 'fused', z: zScore(sample.value, this.baseline), reliability: 0.95 }];
    } else {
      sensorZs = observations.map(item => ({ sensorId: item.sensorId, z: zScore(item.value, this.baseline), reliability: clamp01(item.reliability) }));
    }
    const zValues = sensorZs.map(item => item.z);
    const conflict = zValues.length >= 2 && Math.max(...zValues) - Math.min(...zValues) > this.config.conflictZ;
    const warningSensors = sensorZs.filter(item => item.z >= this.config.warningZ);
    const alarmSensors = sensorZs.filter(item => item.z >= this.config.alarmZ);
    const weightedSupport = alarmSensors.reduce((sum, item) => sum + item.reliability, 0);
    const warningWeighted = warningSensors.reduce((sum, item) => sum + item.reliability, 0);

    const strongSingle = alarmSensors.some(item => item.reliability >= this.config.singleSensorReliability);
    const requiredSupport = conflict ? this.config.conflictSupport : 1;
    const confirmed = conflict
      ? alarmSensors.length >= requiredSupport
      : alarmSensors.length >= 2
        || (warningSensors.length >= 2 && warningWeighted >= 0.8)
        || (strongSingle && alarmSensors.length >= 1);

    const warning = warningSensors.length > 0;
    const rawAlarm = warning && confirmed && weightedSupport >= (conflict ? 0.8 : 0.45);
    this.persistCount = rawAlarm ? this.persistCount + 1 : Math.max(0, this.persistCount - 1);
    const dwellOk = this.tick - this.lastAlarmAt >= this.minDwell;
    const alarm = this.persistCount >= this.config.persist && dwellOk;

    if (alarm) {
      this.lastAlarmAt = this.tick;
      this.persistCount = 0;
    } else if (!warning) {
      // 只在警告以下缓慢更新基线。
      const slow = 0.02;
      this.baseline.mean += slow * (sample.value - this.baseline.mean);
      const variance = (1 - slow) * this.baseline.sigma ** 2 + slow * (sample.value - this.baseline.mean) ** 2;
      this.baseline.sigma = Math.sqrt(Math.max(1e-6, variance));
    }

    return {
      alarm,
      score: Number((warningWeighted + weightedSupport).toFixed(4)),
      threshold: this.config.alarmZ,
      reason: alarm
        ? 'dual_threshold_confirmed'
        : conflict
          ? 'sensor_conflict_suppressed'
          : warning
            ? 'warning_persisting'
            : 'normal',
      support: alarmSensors.length,
      warning,
    };
  }

  reset(): void {
    this.baseline = { mean: 0, sigma: 0, count: 0, warmup: 20 };
    this.persistCount = 0;
    this.lastAlarmAt = -Infinity;
    this.tick = 0;
    this.sensors.clear();
  }
}

/** 观测融合（用于检测输入）：可靠性加权，冲突时退化为中位数并降低支持度。 */
export function fuseDetectorSensors(observations: SensorObservation[]): { value: number; conflict: boolean; support: number } {
  const valid = observations.filter(item => !item.missing && finite(item.value) && item.value >= 0);
  if (valid.length === 0) return { value: NaN, conflict: false, support: 0 };
  if (valid.length === 1) return { value: valid[0].value, conflict: false, support: 1 };
  const values = valid.map(item => item.value);
  const center = median(values);
  const sigma = valid.length === 2
    ? 0
    : Math.max(1, 1.4826 * median(values.map(value => Math.abs(value - center))));
  const limit = valid.length === 2 ? Math.max(1, center * 0.2) : 4 * sigma;
  const conflict = values.some(value => Math.abs(value - center) > limit);
  if (conflict) {
    return { value: center, conflict: true, support: valid.length };
  }
  const total = valid.reduce((sum, item) => sum + clamp01(item.reliability), 0);
  const value = valid.reduce((sum, item) => sum + item.value * clamp01(item.reliability), 0) / Math.max(1e-6, total);
  return { value, conflict, support: valid.length };
}
