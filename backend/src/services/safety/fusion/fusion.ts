/**
 * V7.5 多传感器融合（研究模块）。
 *
 * 目标：在时钟偏移、缺失、重复、过期、冲突与低可靠度存在时，
 * 给出可审计的融合值；无法安全融合时必须 fail-closed（value=null）。
 *
 * 边界：
 *  - 可靠性是外部输入或由置信度估计的代理，不是准确率；
 *  - 融合值不自动进入安全决策，调用方仍需经过观测门禁与独立校验；
 *  - 合成/夹具数据不代表真实摄像机或无人机测量。
 */

export type SensorKind = 'camera' | 'drone' | 'other';

export interface SensorReading {
  sensorId: string;
  regionId: string;
  value: number;
  /** epoch ms */
  observedAt: number;
  /** epoch ms */
  receivedAt: number;
  confidence?: number;
  reliability?: number;
  kind?: SensorKind;
}

export interface FusionConfig {
  /** 期望区域；提供时所有读数必须匹配该区域，而不是以第一条读数为准。 */
  regionId?: string;
  /** 同一 tick 内允许的观测时间分散（毫秒）。 */
  maxSkewMs: number;
  /** 超过该时延视为过期（毫秒）。 */
  staleMs: number;
  /** 相对冲突阈值：两读数差异 / 中位数。 */
  conflictRelative: number;
  /** 绝对冲突阈值（以稳健标准差为单位）。 */
  conflictSigma: number;
  /** 至少需要的有效传感器数。 */
  minSensors: number;
  /** 低于该可靠度的读数不参与融合。 */
  reliabilityFloor: number;
  /** 未来时间戳容忍（毫秒）。 */
  futureToleranceMs: number;
}

export const DEFAULT_FUSION_CONFIG: FusionConfig = {
  maxSkewMs: 5_000,
  staleMs: 30_000,
  conflictRelative: 0.25,
  conflictSigma: 3,
  minSensors: 2,
  reliabilityFloor: 0.2,
  futureToleranceMs: 1_000,
};

export interface FusionAudit {
  sensor_id: string;
  accepted: boolean;
  reason: string;
  weight: number;
}

export interface FusionResult {
  region_id: string;
  status: 'fused' | 'conflict' | 'insufficient' | 'stale';
  value: number | null;
  uncertainty: number | null;
  participants: string[];
  rejected: Array<{ sensor_id: string; reason: string }>;
  conflicts: Array<{ a: string; b: string; delta: number; limit: number }>;
  audit: FusionAudit[];
  /** 是否允许下游用于安全决策（只有 fused 且非冲突）。 */
  usable: boolean;
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

function robustSigma(values: number[], center: number): number {
  if (values.length < 2) return 0;
  const deviations = values.map(value => Math.abs(value - center));
  return 1.4826 * median(deviations);
}

/**
 * 融合一个 tick 的多传感器读数。
 * 时钟偏移、过期、重复、低可靠度与冲突都显式记录；冲突无法消解时返回 value=null。
 */
export function fuseSensorReadings(
  readings: SensorReading[],
  now: number,
  config: Partial<FusionConfig> = {},
): FusionResult {
  const cfg = { ...DEFAULT_FUSION_CONFIG, ...config };
  const regionId = cfg.regionId ?? readings[0]?.regionId ?? 'unknown';
  const rejected: Array<{ sensor_id: string; reason: string }> = [];
  const audit: FusionAudit[] = [];
  const seen = new Set<string>();
  const accepted: Array<{ reading: SensorReading; weight: number }> = [];

  for (const reading of readings) {
    if (reading.regionId !== regionId) {
      rejected.push({ sensor_id: reading.sensorId, reason: 'region_mismatch' });
      audit.push({ sensor_id: reading.sensorId, accepted: false, reason: 'region_mismatch', weight: 0 });
      continue;
    }
    if (!finite(reading.value) || reading.value < 0) {
      rejected.push({ sensor_id: reading.sensorId, reason: 'invalid_value' });
      audit.push({ sensor_id: reading.sensorId, accepted: false, reason: 'invalid_value', weight: 0 });
      continue;
    }
    if (!finite(reading.observedAt) || !finite(reading.receivedAt)) {
      rejected.push({ sensor_id: reading.sensorId, reason: 'invalid_timestamp' });
      audit.push({ sensor_id: reading.sensorId, accepted: false, reason: 'invalid_timestamp', weight: 0 });
      continue;
    }
    if (reading.observedAt > now + cfg.futureToleranceMs) {
      rejected.push({ sensor_id: reading.sensorId, reason: 'future_timestamp' });
      audit.push({ sensor_id: reading.sensorId, accepted: false, reason: 'future_timestamp', weight: 0 });
      continue;
    }
    if (now - reading.observedAt > cfg.staleMs) {
      rejected.push({ sensor_id: reading.sensorId, reason: 'stale' });
      audit.push({ sensor_id: reading.sensorId, accepted: false, reason: 'stale', weight: 0 });
      continue;
    }
    const duplicateKey = `${reading.sensorId}|${reading.observedAt}`;
    if (seen.has(duplicateKey)) {
      rejected.push({ sensor_id: reading.sensorId, reason: 'duplicate' });
      audit.push({ sensor_id: reading.sensorId, accepted: false, reason: 'duplicate', weight: 0 });
      continue;
    }
    seen.add(duplicateKey);
    const reliability = clamp01(finite(reading.reliability) ? reading.reliability : 0.5);
    const confidence = clamp01(finite(reading.confidence) ? reading.confidence : 0.5);
    const weight = clamp01(reliability * confidence);
    if (weight < cfg.reliabilityFloor) {
      rejected.push({ sensor_id: reading.sensorId, reason: 'low_reliability' });
      audit.push({ sensor_id: reading.sensorId, accepted: false, reason: 'low_reliability', weight });
      continue;
    }
    accepted.push({ reading, weight });
    audit.push({ sensor_id: reading.sensorId, accepted: true, reason: 'accepted', weight: Number(weight.toFixed(4)) });
  }

  if (accepted.length === 0) {
    return {
      region_id: regionId,
      status: 'insufficient',
      value: null,
      uncertainty: null,
      participants: [],
      rejected,
      conflicts: [],
      audit,
      usable: false,
    };
  }

  const times = accepted.map(item => item.reading.observedAt);
  const skew = Math.max(...times) - Math.min(...times);
  if (skew > cfg.maxSkewMs) {
    for (const item of accepted) {
      rejected.push({ sensor_id: item.reading.sensorId, reason: 'clock_skew_exceeds_limit' });
      const entry = audit.find(row => row.sensor_id === item.reading.sensorId && row.accepted);
      if (entry) {
        entry.accepted = false;
        entry.reason = 'clock_skew_exceeds_limit';
        entry.weight = 0;
      }
    }
    return {
      region_id: regionId,
      status: 'stale',
      value: null,
      uncertainty: null,
      participants: [],
      rejected,
      conflicts: [],
      audit,
      usable: false,
    };
  }

  const values = accepted.map(item => item.reading.value);
  const center = median(values);
  const sigma = robustSigma(values, center);
  const conflicts: Array<{ a: string; b: string; delta: number; limit: number }> = [];
  for (let i = 0; i < accepted.length; i += 1) {
    for (let j = i + 1; j < accepted.length; j += 1) {
      const delta = Math.abs(accepted[i].reading.value - accepted[j].reading.value);
      // 两个读数时稳健 sigma 会膨胀，改用相对阈值；三个及以上才使用 sigma。
      const limit = accepted.length === 2
        ? Math.max(1, cfg.conflictRelative * Math.max(1, center))
        : Math.max(
          cfg.conflictRelative * Math.max(1, center),
          cfg.conflictSigma * Math.max(1, sigma),
        );
      if (delta > limit) {
        conflicts.push({
          a: accepted[i].reading.sensorId,
          b: accepted[j].reading.sensorId,
          delta: Number(delta.toFixed(3)),
          limit: Number(limit.toFixed(3)),
        });
      }
    }
  }

  if (conflicts.length > 0) {
    // 冲突无法通过可靠性加权安全消解：fail-closed，交由上层调查/人工确认。
    return {
      region_id: regionId,
      status: 'conflict',
      value: null,
      uncertainty: null,
      participants: accepted.map(item => item.reading.sensorId),
      rejected,
      conflicts,
      audit,
      usable: false,
    };
  }

  if (accepted.length < cfg.minSensors) {
    return {
      region_id: regionId,
      status: 'insufficient',
      value: null,
      uncertainty: null,
      participants: accepted.map(item => item.reading.sensorId),
      rejected,
      conflicts,
      audit,
      usable: false,
    };
  }

  const totalWeight = accepted.reduce((sum, item) => sum + item.weight, 0);
  const value = accepted.reduce((sum, item) => sum + item.reading.value * item.weight, 0) / totalWeight;
  const variance = accepted.reduce((sum, item) => sum + item.weight * (item.reading.value - value) ** 2, 0) / totalWeight;

  return {
    region_id: regionId,
    status: 'fused',
    value: Number(value.toFixed(4)),
    uncertainty: Number(Math.sqrt(variance).toFixed(4)),
    participants: accepted.map(item => item.reading.sensorId),
    rejected,
    conflicts,
    audit,
    usable: true,
  };
}

/**
 * 跨 tick 的时间对齐：为每个传感器估计相对参考时钟的偏移（中位数）。
 * 仅用于诊断/预处理；偏移超过上限的传感器应被上层拒绝。
 */
export function estimateClockOffsets(
  batches: Array<Array<{ sensorId: string; observedAt: number }>>,
  referenceSensor: string,
): Record<string, { offsetMs: number; samples: number }> {
  const offsets = new Map<string, number[]>();
  for (const batch of batches) {
    const reference = batch.find(item => item.sensorId === referenceSensor);
    if (!reference) continue;
    for (const item of batch) {
      if (item.sensorId === referenceSensor) continue;
      const list = offsets.get(item.sensorId) ?? [];
      list.push(item.observedAt - reference.observedAt);
      offsets.set(item.sensorId, list);
    }
  }
  const result: Record<string, { offsetMs: number; samples: number }> = {};
  for (const [sensorId, values] of offsets) {
    result[sensorId] = { offsetMs: Number(median(values).toFixed(1)), samples: values.length };
  }
  return result;
}
