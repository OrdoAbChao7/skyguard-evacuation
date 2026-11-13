/**
 * V7.4 标定质量：时钟同步、缺失数据、传感器可靠性、动态容量计划。
 *
 * 所有“可靠性”都是可观测代理（可用性/新鲜度/置信度/稳定性），
 * 没有真实 ground truth 时不得表述为准确率或真实标定。
 */
import type { DensityObservation, SafetyScenario } from '../types';

export interface ClockOffset {
  provider: string;
  /** 该 provider 的时钟相对参考时钟的偏移（秒）；正值表示其时间戳偏慢。 */
  offset_seconds: number;
  samples: number;
}

export interface TimestampSyncResult {
  observations: DensityObservation[];
  rejected: Array<{ id: string; provider: string; reason: string; skew_seconds: number }>;
  applied_offsets: ClockOffset[];
}

/**
 * 按 provider 应用时钟偏移；偏移绝对值超过 maxSkewSeconds 的 provider 全部拒绝。
 * 本函数不估计偏移，只应用已核验的偏移；未列出的 provider 视为 0。
 */
export function synchronizeTimestamps(
  observations: DensityObservation[],
  offsets: ClockOffset[],
  maxSkewSeconds = 30,
): TimestampSyncResult {
  const byProvider = new Map(offsets.map(item => [item.provider, item]));
  const applied: ClockOffset[] = [];
  const rejected: TimestampSyncResult['rejected'] = [];
  const synced: DensityObservation[] = [];
  for (const observation of observations) {
    const offset = byProvider.get(observation.provider);
    if (offset && Math.abs(offset.offset_seconds) > maxSkewSeconds) {
      rejected.push({
        id: observation.id,
        provider: observation.provider,
        reason: 'clock_skew_exceeds_limit',
        skew_seconds: offset.offset_seconds,
      });
      continue;
    }
    const seconds = offset?.offset_seconds ?? 0;
    if (offset && !applied.some(item => item.provider === offset.provider)) applied.push(offset);
    if (seconds === 0) {
      synced.push(observation);
      continue;
    }
    const observed = new Date(new Date(observation.observed_at).getTime() - seconds * 1000).toISOString();
    const received = new Date(new Date(observation.received_at).getTime() - seconds * 1000).toISOString();
    synced.push({
      ...observation,
      observed_at: observed,
      received_at: received,
      evidence: { ...(observation.evidence ?? {}), clock_offset_seconds: seconds, clock_synced: true },
    });
  }
  return { observations: synced, rejected, applied_offsets: applied };
}

export interface MissingInterval {
  region_id: string;
  from: string;
  to: string;
  gap_seconds: number;
  expected_samples: number;
}

/** 检测每个区域相对于期望采样间隔的缺口。 */
export function detectMissingIntervals(
  observations: DensityObservation[],
  expectedIntervalSeconds: number,
  toleranceSeconds = expectedIntervalSeconds * 0.5,
): MissingInterval[] {
  const byRegion = new Map<string, DensityObservation[]>();
  for (const observation of observations) {
    if (!observation.valid) continue;
    const list = byRegion.get(observation.region_id) ?? [];
    list.push(observation);
    byRegion.set(observation.region_id, list);
  }
  const gaps: MissingInterval[] = [];
  for (const [regionId, list] of byRegion) {
    list.sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    for (let index = 1; index < list.length; index += 1) {
      const previous = new Date(list[index - 1].observed_at).getTime();
      const current = new Date(list[index].observed_at).getTime();
      const gapSeconds = (current - previous) / 1000;
      if (gapSeconds > expectedIntervalSeconds + toleranceSeconds) {
        gaps.push({
          region_id: regionId,
          from: list[index - 1].observed_at,
          to: list[index].observed_at,
          gap_seconds: Number(gapSeconds.toFixed(2)),
          expected_samples: Math.max(1, Math.floor(gapSeconds / expectedIntervalSeconds) - 1),
        });
      }
    }
  }
  return gaps.sort((a, b) => a.region_id.localeCompare(b.region_id) || a.from.localeCompare(b.from));
}

export interface SensorReliability {
  provider: string;
  observations: number;
  regions: number;
  availability_ratio: number;
  mean_confidence: number;
  confidence_sd: number;
  /** 代理分数：可用性 × 平均置信度 × 稳定性；不是准确率。 */
  reliability_score: number;
  provenance: 'estimated';
  note: string;
}

/**
 * 传感器可靠性代理：无 ground truth，只衡量可用性/置信度/稳定性。
 * 不得把该分数表述为检测准确率。
 */
export function estimateSensorReliability(
  observations: DensityObservation[],
  windowSeconds: number,
  now: Date = new Date(),
): SensorReliability[] {
  const from = now.getTime() - Math.max(1, windowSeconds) * 1000;
  const recent = observations.filter(item => new Date(item.observed_at).getTime() >= from);
  const byProvider = new Map<string, DensityObservation[]>();
  for (const observation of recent) {
    const list = byProvider.get(observation.provider) ?? [];
    list.push(observation);
    byProvider.set(observation.provider, list);
  }
  const seconds = Math.max(1, windowSeconds);
  return [...byProvider.entries()].map(([provider, list]) => {
    const regions = new Set(list.map(item => item.region_id)).size;
    // 可用性：按“至少每 60 秒一条”的粗略覆盖估计，上限 1。
    const expected = Math.max(1, Math.ceil(seconds / 60));
    const availability = Math.min(1, list.length / (expected * Math.max(1, regions)));
    const confidences = list.map(item => item.confidence);
    const meanConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    const variance = confidences.length > 1
      ? confidences.reduce((sum, value) => sum + (value - meanConfidence) ** 2, 0) / (confidences.length - 1)
      : 0;
    const sd = Math.sqrt(variance);
    const stability = 1 / (1 + sd * 4);
    return {
      provider,
      observations: list.length,
      regions,
      availability_ratio: Number(availability.toFixed(4)),
      mean_confidence: Number(meanConfidence.toFixed(4)),
      confidence_sd: Number(sd.toFixed(4)),
      reliability_score: Number((availability * meanConfidence * stability).toFixed(4)),
      provenance: 'estimated' as const,
      note: '代理分数（可用性×置信度×稳定性），不是准确率；无 ground truth。',
    };
  }).sort((a, b) => b.reliability_score - a.reliability_score);
}

// ---------------------------------------------------------------------------
// 动态容量计划
// ---------------------------------------------------------------------------

export interface CapacityScheduleEntry {
  from_minute: number;
  to_minute: number;
  corridor_factor?: number;
  exit_factor?: number;
  reason: string;
}

export interface CapacitySchedule {
  entries: CapacityScheduleEntry[];
}

export function validateCapacitySchedule(schedule: CapacitySchedule): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const entries = [...schedule.entries].sort((a, b) => a.from_minute - b.from_minute);
  for (const entry of entries) {
    if (!Number.isInteger(entry.from_minute) || !Number.isInteger(entry.to_minute) || entry.to_minute <= entry.from_minute) {
      errors.push(`invalid interval ${entry.from_minute}-${entry.to_minute}`);
    }
    for (const [name, value] of [['corridor_factor', entry.corridor_factor], ['exit_factor', entry.exit_factor]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
        errors.push(`${name} must be in [0,1] at ${entry.from_minute}-${entry.to_minute}`);
      }
    }
    if (!entry.reason || entry.reason.trim().length === 0) warnings.push(`missing reason at ${entry.from_minute}-${entry.to_minute}`);
  }
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index].from_minute < entries[index - 1].to_minute) {
      errors.push(`overlapping intervals at ${entries[index].from_minute}`);
    }
  }
  return { errors, warnings };
}

/** 在指定分钟取容量因子；无覆盖时返回 1。 */
export function capacityFactorAt(
  schedule: CapacitySchedule,
  minute: number,
  kind: 'corridor' | 'exit',
): number {
  const entry = schedule.entries.find(item => minute >= item.from_minute && minute < item.to_minute);
  if (!entry) return 1;
  const value = kind === 'corridor' ? entry.corridor_factor : entry.exit_factor;
  return value === undefined ? 1 : Math.max(0, Math.min(1, value));
}

/** 把动态容量计划转换为 MPC/执行模型的因子函数。 */
export function scheduleToFactor(
  schedule: CapacitySchedule,
  kind: 'corridor' | 'exit',
): (id: string, absoluteMinute: number) => number {
  return (_id, minute) => capacityFactorAt(schedule, minute, kind);
}

/**
 * 观测质量总览：缺失、低置信度、时效、冲突标记（冲突由 ObservationStore 负责）。
 */
export function observationQualityReport(
  scenario: SafetyScenario,
  observations: DensityObservation[],
  now: Date = new Date(),
): {
  missing_regions: string[];
  stale: number;
  low_confidence: number;
  invalid: number;
  duplicate_timestamps: number;
  coverage_ratio: number;
} {
  const enabled = scenario.regions.filter(region => region.enabled);
  const seenRegions = new Set<string>();
  let stale = 0;
  let lowConfidence = 0;
  let invalid = 0;
  let duplicateTimestamps = 0;
  const keys = new Set<string>();
  for (const observation of observations) {
    const region = enabled.find(item => item.id === observation.region_id);
    if (!region) continue;
    seenRegions.add(region.id);
    if (!observation.valid) invalid += 1;
    if (observation.confidence < scenario.config.min_confidence) lowConfidence += 1;
    const age = (now.getTime() - new Date(observation.observed_at).getTime()) / 1000;
    if (age > scenario.config.max_observation_age_seconds) stale += 1;
    const key = `${observation.region_id}|${observation.observed_at}|${observation.provider}`;
    if (keys.has(key)) duplicateTimestamps += 1;
    keys.add(key);
  }
  const missing = enabled.filter(region => !seenRegions.has(region.id)).map(region => region.id);
  return {
    missing_regions: missing,
    stale,
    low_confidence: lowConfidence,
    invalid,
    duplicate_timestamps: duplicateTimestamps,
    coverage_ratio: Number(((enabled.length - missing.length) / Math.max(1, enabled.length)).toFixed(4)),
  };
}
