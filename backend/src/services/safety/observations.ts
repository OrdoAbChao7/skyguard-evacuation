/**
 * 人群观测服务：观测构建、时效/置信度判定与版本管理。
 *
 * 安全语义：观测不可信时系统必须显式降级，绝不允许把过期或低置信度数据
 * 继续当作"当前真实状态"使用。
 */
import { randomUUID } from 'node:crypto';
import type {
  DensityObservation,
  ObservationSource,
  Region,
  SafetyConfig,
} from './types';

export interface BuildObservationInput {
  region: Region;
  count: number;
  confidence: number;
  source: ObservationSource;
  provider: string;
  modelVersion: string;
  calibrationVersion?: string;
  observedAt?: Date;
  receivedAt?: Date;
  valid?: boolean;
  invalidReason?: string;
  evidence?: Record<string, unknown>;
}

/**
 * 由「人数 + 区域面积」确定性推导密度。
 * 密度不接受外部传入，避免人数与密度互相矛盾。
 */
export function buildObservation(input: BuildObservationInput): DensityObservation {
  const observedAt = input.observedAt ?? new Date();
  const receivedAt = input.receivedAt ?? new Date();
  const count = Math.max(0, Math.round(input.count));
  const density = count / input.region.area_m2;
  const calibrationVersion = input.calibrationVersion ?? input.region.camera.calibration_version;

  return {
    id: `OBS-${randomUUID()}`,
    region_id: input.region.id,
    observed_at: observedAt.toISOString(),
    received_at: receivedAt.toISOString(),
    estimated_count: count,
    estimated_density: Number(density.toFixed(4)),
    confidence: Number(input.confidence.toFixed(4)),
    source: input.source,
    provider: input.provider,
    model_version: input.modelVersion,
    calibration_version: calibrationVersion,
    valid: input.valid ?? true,
    invalid_reason: input.invalidReason,
    evidence: input.evidence,
  };
}

export interface ObservationAssessment {
  regionId: string;
  observation: DensityObservation;
  ageSeconds: number;
  stale: boolean;
  lowConfidence: boolean;
  invalid: boolean;
  untrustedReasons: string[];
  trusted: boolean;
}

export interface RegionAssessment {
  regionId: string;
  latest?: ObservationAssessment;
  trusted: boolean;
  reasons: string[];
}

export function assessObservation(
  observation: DensityObservation,
  config: SafetyConfig,
  now: Date = new Date(),
): ObservationAssessment {
  const ageSeconds = Math.max(0, (now.getTime() - new Date(observation.observed_at).getTime()) / 1000);
  const stale = ageSeconds > config.max_observation_age_seconds;
  const lowConfidence = observation.confidence < config.min_confidence;
  const invalid = !observation.valid;

  const untrustedReasons: string[] = [];
  if (invalid) untrustedReasons.push(observation.invalid_reason ? `invalid:${observation.invalid_reason}` : 'invalid');
  if (stale) untrustedReasons.push(`stale:${Math.round(ageSeconds)}s>${config.max_observation_age_seconds}s`);
  if (lowConfidence) untrustedReasons.push(`low_confidence:${observation.confidence}<${config.min_confidence}`);

  return {
    regionId: observation.region_id,
    observation,
    ageSeconds,
    stale,
    lowConfidence,
    invalid,
    untrustedReasons,
    trusted: untrustedReasons.length === 0,
  };
}

export class ObservationStore {
  private history = new Map<string, DensityObservation[]>();
  private version = 0;

  ingest(observation: DensityObservation): void {
    const list = this.history.get(observation.region_id) ?? [];
    list.push(observation);
    // 仅保留最近 200 条，避免内存无界增长
    if (list.length > 200) list.splice(0, list.length - 200);
    this.history.set(observation.region_id, list);
    this.version += 1;
  }

  latest(regionId: string): DensityObservation | undefined {
    const list = this.history.get(regionId);
    if (!list || list.length === 0) return undefined;
    return list[list.length - 1];
  }

  /** 最近一条有效观测（有效 = 采集时未被标记无效）。 */
  latestValid(regionId: string): DensityObservation | undefined {
    const list = this.history.get(regionId);
    if (!list) return undefined;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].valid) return list[i];
    }
    return undefined;
  }

  /** 返回时间窗口内的观测（升序）。 */
  window(regionId: string, fromTime: Date, toTime: Date = new Date()): DensityObservation[] {
    const list = this.history.get(regionId) ?? [];
    return list.filter(obs => {
      const t = new Date(obs.observed_at).getTime();
      return t >= fromTime.getTime() && t <= toTime.getTime();
    });
  }

  snapshot(): DensityObservation[] {
    const out: DensityObservation[] = [];
    for (const list of this.history.values()) {
      if (list.length > 0) out.push(list[list.length - 1]);
    }
    return out.sort((a, b) => a.region_id.localeCompare(b.region_id));
  }

  getVersion(): number {
    return this.version;
  }

  reset(): void {
    this.history.clear();
    this.version = 0;
  }
}
