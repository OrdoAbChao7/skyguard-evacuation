/**
 * V7.2 场馆标定流水线（研究/工程模块）。
 *
 * 目标：把「场景配置」与「标定证据」分离，确保：
 *  - 每个参数都带来源、方法、时间、样本量与可信度；
 *  - 合成数据永远不能伪装成实测/标定值；
 *  - 相机到区域的映射、传感器标定版本可追溯；
 *  - 参数估计（步行速度、出口服务率、拥堵系数）在样本不足时降级为 estimated；
 *  - 应用标定必须显式记录变更清单与版本，不静默覆盖安全配置。
 *
 * 本模块不读写安全内核的运行时状态，也不改变四态/发布语义。
 */
import { z } from 'zod';
import { PROVENANCE } from '../types';
import type { DensityObservation, SafetyScenario } from '../types';
import { buildObservation } from '../observations';

const CalibratedValueSchema = z.object({
  value: z.number(),
  unit: z.string().min(1),
  provenance: z.enum(PROVENANCE),
  source: z.string().min(1),
  method: z.string().min(1),
  measured_at: z.string().datetime({ offset: true }).optional(),
  samples: z.number().int().nonnegative().optional(),
  confidence_interval: z.object({ lower: z.number(), upper: z.number() }).optional(),
  notes: z.string().optional(),
});
export type CalibratedValue = z.infer<typeof CalibratedValueSchema>;

export const CALIBRATION_DATA_NATURE = ['synthetic', 'public_dataset', 'authorized_real', 'mixed'] as const;
export type CalibrationDataNature = (typeof CALIBRATION_DATA_NATURE)[number];

export const VenueProfileSchema = z.object({
  profile_id: z.string().min(1),
  venue_id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  data_nature: z.enum(CALIBRATION_DATA_NATURE),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  regions: z.array(z.object({
    region_id: z.string().min(1),
    area_m2: CalibratedValueSchema,
    holding_capacity_persons: CalibratedValueSchema,
    camera_ids: z.array(z.string()).default([]),
  })).min(1),
  corridors: z.array(z.object({
    corridor_id: z.string().min(1),
    from_region_id: z.string().min(1),
    to_region_id: z.string().min(1),
    capacity_per_min: CalibratedValueSchema,
    traversal_seconds: CalibratedValueSchema,
  })).min(1),
  exits: z.array(z.object({
    exit_id: z.string().min(1),
    region_id: z.string().min(1),
    capacity_per_min: CalibratedValueSchema,
  })).min(1),
  cameras: z.array(z.object({
    camera_id: z.string().min(1),
    region_id: z.string().min(1),
    roi: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().positive().max(1), h: z.number().positive().max(1) }),
    calibration_status: z.enum(PROVENANCE),
    calibration_version: z.string().min(1),
    sensor: z.object({
      model_name: z.string().optional(),
      mounting_height_m: z.number().positive().optional(),
      tilt_deg: z.number().min(-90).max(90).optional(),
      resolution: z.string().optional(),
    }).optional(),
  })).default([]),
  flow: z.object({
    walking_speed_mps: CalibratedValueSchema,
    bpr_a: CalibratedValueSchema,
    bpr_b: CalibratedValueSchema,
    exit_service_queue_scale: CalibratedValueSchema,
  }),
  observation_adapters: z.array(z.object({
    adapter_id: z.string().min(1),
    kind: z.enum(['csv', 'http', 'camera_count', 'public_dataset']),
    region_mapping: z.record(z.string()),
    calibration_version: z.string().min(1),
  })).default([]),
  notes: z.array(z.string()).default([]),
});
export type VenueProfile = z.infer<typeof VenueProfileSchema>;

export interface CalibrationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
}

export interface CalibrationValidation {
  valid: boolean;
  errors: CalibrationIssue[];
  warnings: CalibrationIssue[];
  checked_regions: number;
  checked_corridors: number;
  checked_exits: number;
  checked_cameras: number;
  provenance_counts: Record<string, number>;
}

function valueIssues(value: CalibratedValue, path: string): CalibrationIssue[] {
  const issues: CalibrationIssue[] = [];
  if (!Number.isFinite(value.value)) {
    issues.push({ code: 'value_not_finite', severity: 'error', message: `${path} 不是有限数值`, path });
  }
  if (value.provenance === 'measured' || value.provenance === 'calibrated') {
    if (!value.measured_at) {
      issues.push({ code: 'measured_without_timestamp', severity: 'error', message: `${path} 声称 ${value.provenance} 但缺少 measured_at`, path });
    }
    if (!value.source || !value.method) {
      issues.push({ code: 'measured_without_source', severity: 'error', message: `${path} 缺少来源或方法`, path });
    }
    if (value.provenance === 'calibrated' && ((value.samples ?? 0) < 5 || !value.confidence_interval)) {
      issues.push({
        code: 'calibrated_without_samples',
        severity: 'error',
        message: `${path} 声称 calibrated，但样本量 <5 或缺少置信区间`,
        path,
      });
    }
  }
  if (value.confidence_interval && value.confidence_interval.lower > value.confidence_interval.upper) {
    issues.push({ code: 'interval_inverted', severity: 'error', message: `${path} 置信区间上下界颠倒`, path });
  }
  return issues;
}

/** 校验场馆标定档案：结构、引用完整性、来源可信度与数据性质一致性。 */
export function validateVenueProfile(
  input: unknown,
  scenario?: SafetyScenario,
): CalibrationValidation {
  const parsed = VenueProfileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map(issue => ({
        code: 'schema_error',
        severity: 'error' as const,
        message: `${issue.path.join('.')}: ${issue.message}`,
        path: issue.path.join('.'),
      })),
      warnings: [],
      checked_regions: 0,
      checked_corridors: 0,
      checked_exits: 0,
      checked_cameras: 0,
      provenance_counts: {},
    };
  }
  const profile = parsed.data;
  const errors: CalibrationIssue[] = [];
  const warnings: CalibrationIssue[] = [];
  const provenanceCounts: Record<string, number> = {};
  const bump = (value: CalibratedValue, path: string) => {
    provenanceCounts[value.provenance] = (provenanceCounts[value.provenance] ?? 0) + 1;
    errors.push(...valueIssues(value, path));
  };

  const regionIds = new Set<string>();
  for (const region of profile.regions) {
    if (regionIds.has(region.region_id)) {
      errors.push({ code: 'duplicate_region', severity: 'error', message: `重复区域 ${region.region_id}`, path: region.region_id });
    }
    regionIds.add(region.region_id);
    if (region.area_m2.value <= 0) errors.push({ code: 'invalid_area', severity: 'error', message: `${region.region_id} 面积必须为正`, path: region.region_id });
    if (region.holding_capacity_persons.value <= 0) {
      errors.push({ code: 'invalid_holding_capacity', severity: 'error', message: `${region.region_id} 在留容量必须为正`, path: region.region_id });
    }
    bump(region.area_m2, `${region.region_id}.area_m2`);
    bump(region.holding_capacity_persons, `${region.region_id}.holding_capacity_persons`);
  }

  const corridorIds = new Set<string>();
  for (const corridor of profile.corridors) {
    if (corridorIds.has(corridor.corridor_id)) {
      errors.push({ code: 'duplicate_corridor', severity: 'error', message: `重复通道 ${corridor.corridor_id}`, path: corridor.corridor_id });
    }
    corridorIds.add(corridor.corridor_id);
    if (!regionIds.has(corridor.from_region_id) || !regionIds.has(corridor.to_region_id)) {
      errors.push({ code: 'corridor_endpoint_missing', severity: 'error', message: `通道 ${corridor.corridor_id} 端点区域不存在`, path: corridor.corridor_id });
    }
    if (corridor.capacity_per_min.value < 0) {
      errors.push({ code: 'negative_capacity', severity: 'error', message: `通道 ${corridor.corridor_id} 容量为负`, path: corridor.corridor_id });
    }
    if (corridor.traversal_seconds.value <= 0) {
      errors.push({ code: 'invalid_traversal', severity: 'error', message: `通道 ${corridor.corridor_id} 通行时间必须为正`, path: corridor.corridor_id });
    }
    bump(corridor.capacity_per_min, `${corridor.corridor_id}.capacity_per_min`);
    bump(corridor.traversal_seconds, `${corridor.corridor_id}.traversal_seconds`);
  }

  for (const exit of profile.exits) {
    if (!regionIds.has(exit.region_id)) {
      errors.push({ code: 'exit_region_missing', severity: 'error', message: `出口 ${exit.exit_id} 所属区域不存在`, path: exit.exit_id });
    }
    if (exit.capacity_per_min.value < 0) {
      errors.push({ code: 'negative_exit_capacity', severity: 'error', message: `出口 ${exit.exit_id} 容量为负`, path: exit.exit_id });
    }
    bump(exit.capacity_per_min, `${exit.exit_id}.capacity_per_min`);
  }

  const cameraIds = new Set<string>();
  for (const camera of profile.cameras) {
    if (cameraIds.has(camera.camera_id)) {
      errors.push({ code: 'duplicate_camera', severity: 'error', message: `重复相机 ${camera.camera_id}`, path: camera.camera_id });
    }
    cameraIds.add(camera.camera_id);
    if (!regionIds.has(camera.region_id)) {
      errors.push({ code: 'camera_region_missing', severity: 'error', message: `相机 ${camera.camera_id} 映射到不存在区域`, path: camera.camera_id });
    }
    if (camera.roi.x + camera.roi.w > 1.0001 || camera.roi.y + camera.roi.h > 1.0001) {
      errors.push({ code: 'roi_out_of_bounds', severity: 'error', message: `相机 ${camera.camera_id} ROI 超出 [0,1]`, path: camera.camera_id });
    }
  }
  for (const region of profile.regions) {
    for (const cameraId of region.camera_ids) {
      if (!cameraIds.has(cameraId)) {
        errors.push({ code: 'region_camera_missing', severity: 'error', message: `区域 ${region.region_id} 引用了不存在的相机 ${cameraId}`, path: region.region_id });
      }
    }
  }

  bump(profile.flow.walking_speed_mps, 'flow.walking_speed_mps');
  bump(profile.flow.bpr_a, 'flow.bpr_a');
  bump(profile.flow.bpr_b, 'flow.bpr_b');
  bump(profile.flow.exit_service_queue_scale, 'flow.exit_service_queue_scale');
  if (profile.flow.bpr_b.value < 1) {
    errors.push({ code: 'invalid_bpr_exponent', severity: 'error', message: 'BPR 指数必须 ≥ 1', path: 'flow.bpr_b' });
  }

  // 数据性质与来源一致性：合成档案不得包含 measured/calibrated。
  if (profile.data_nature === 'synthetic') {
    for (const [provenance, count] of Object.entries(provenanceCounts)) {
      if ((provenance === 'measured' || provenance === 'calibrated') && count > 0) {
        errors.push({
          code: 'synthetic_claims_measured',
          severity: 'error',
          message: `合成档案包含 ${count} 个 ${provenance} 参数；合成数据不得冒充实测/标定值`,
          path: 'data_nature',
        });
      }
    }
  }
  if ((provenanceCounts.uncalibrated ?? 0) + (provenanceCounts.estimated ?? 0) > 0 && profile.data_nature === 'authorized_real') {
    warnings.push({
      code: 'authorized_real_with_estimates',
      severity: 'warning',
      message: '授权真实档案仍包含 estimated/uncalibrated 参数，报告必须逐项标注',
      path: 'data_nature',
    });
  }

  if (scenario) {
    const scenarioRegionIds = new Set(scenario.regions.map(region => region.id));
    const scenarioCorridorIds = new Set(scenario.corridors.map(corridor => corridor.id));
    const scenarioExitIds = new Set(scenario.exits.map(exit => exit.id));
    for (const region of profile.regions) {
      if (!scenarioRegionIds.has(region.region_id)) {
        warnings.push({ code: 'profile_region_not_in_scenario', severity: 'warning', message: `档案区域 ${region.region_id} 不在场景中`, path: region.region_id });
      }
    }
    for (const corridor of profile.corridors) {
      if (!scenarioCorridorIds.has(corridor.corridor_id)) {
        warnings.push({ code: 'profile_corridor_not_in_scenario', severity: 'warning', message: `档案通道 ${corridor.corridor_id} 不在场景中`, path: corridor.corridor_id });
      }
    }
    for (const exit of profile.exits) {
      if (!scenarioExitIds.has(exit.exit_id)) {
        warnings.push({ code: 'profile_exit_not_in_scenario', severity: 'warning', message: `档案出口 ${exit.exit_id} 不在场景中`, path: exit.exit_id });
      }
    }
    for (const region of scenario.regions) {
      if (region.enabled && !profile.regions.some(item => item.region_id === region.id)) {
        warnings.push({ code: 'scenario_region_uncovered', severity: 'warning', message: `场景区域 ${region.id} 未被标定档案覆盖`, path: region.id });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checked_regions: profile.regions.length,
    checked_corridors: profile.corridors.length,
    checked_exits: profile.exits.length,
    checked_cameras: profile.cameras.length,
    provenance_counts: provenanceCounts,
  };
}

export interface ProfileChange {
  kind: 'region' | 'corridor' | 'exit';
  id: string;
  field: string;
  before: number;
  after: number;
  provenance: string;
  source: string;
}

export interface ApplyProfileResult {
  scenario: SafetyScenario;
  changes: ProfileChange[];
  blocked: Array<{ id: string; field: string; reason: string }>;
  version: string;
}

/**
 * 将标定档案应用到场景（返回新对象，不修改输入）。
 * 只允许 applied 的参数具备可用来源；unknown 值一律拒绝。
 */
export function applyVenueProfile(scenario: SafetyScenario, input: unknown): ApplyProfileResult {
  const parsed = VenueProfileSchema.parse(input);
  const validation = validateVenueProfile(parsed, scenario);
  if (!validation.valid) {
    throw new Error(`标定档案未通过校验：${validation.errors.map(item => item.code).join(',')}`);
  }
  const next = JSON.parse(JSON.stringify(scenario)) as SafetyScenario;
  const changes: ProfileChange[] = [];
  const blocked: ApplyProfileResult['blocked'] = [];
  const assign = (
    kind: ProfileChange['kind'],
    id: string,
    field: string,
    current: number,
    calibrated: CalibratedValue,
    write: (value: number) => void,
  ) => {
    if (calibrated.provenance === 'unknown') {
      blocked.push({ id, field, reason: 'unknown_provenance' });
      return;
    }
    const value = calibrated.value;
    if (!Number.isFinite(value) || value < 0) {
      blocked.push({ id, field, reason: 'invalid_value' });
      return;
    }
    if (value === current) return;
    write(value);
    changes.push({ kind, id, field, before: current, after: value, provenance: calibrated.provenance, source: calibrated.source });
  };

  for (const regionProfile of parsed.regions) {
    const region = next.regions.find(item => item.id === regionProfile.region_id);
    if (!region) continue;
    assign('region', region.id, 'area_m2', region.area_m2, regionProfile.area_m2, value => { region.area_m2 = value; });
    region.area_provenance = regionProfile.area_m2.provenance;
    assign('region', region.id, 'holding_capacity_persons', region.holding_capacity_persons, regionProfile.holding_capacity_persons, value => {
      region.holding_capacity_persons = Math.floor(value);
    });
    const camera = regionProfile.camera_ids
      .map(cameraId => parsed.cameras.find(item => item.camera_id === cameraId))
      .find(Boolean);
    if (camera) {
      region.camera.camera_id = camera.camera_id;
      region.camera.roi = camera.roi;
      region.camera.calibration_status = camera.calibration_status;
      region.camera.calibration_version = camera.calibration_version;
    }
  }
  for (const corridorProfile of parsed.corridors) {
    const corridor = next.corridors.find(item => item.id === corridorProfile.corridor_id);
    if (!corridor) continue;
    if (corridor.capacity_per_min !== null) {
      assign('corridor', corridor.id, 'capacity_per_min', corridor.capacity_per_min, corridorProfile.capacity_per_min, value => {
        corridor.capacity_per_min = Math.floor(value);
      });
      corridor.capacity_provenance = corridorProfile.capacity_per_min.provenance;
    }
    assign('corridor', corridor.id, 'traversal_seconds', corridor.traversal_seconds, corridorProfile.traversal_seconds, value => {
      corridor.traversal_seconds = Math.max(1, Math.floor(value));
    });
  }
  for (const exitProfile of parsed.exits) {
    const exit = next.exits.find(item => item.id === exitProfile.exit_id);
    if (!exit) continue;
    if (exit.capacity_per_min !== null) {
      assign('exit', exit.id, 'capacity_per_min', exit.capacity_per_min, exitProfile.capacity_per_min, value => {
        exit.capacity_per_min = Math.floor(value);
      });
      exit.capacity_provenance = exitProfile.capacity_per_min.provenance;
    }
  }
  next.version = `${scenario.version}+profile.${parsed.profile_id}.${parsed.version}`;
  return { scenario: next, changes, blocked, version: next.version };
}

// ---------------------------------------------------------------------------
// 参数估计
// ---------------------------------------------------------------------------

export interface ThroughputSample {
  /** 观测窗口内通过出口/通道的人数。 */
  served: number;
  /** 观测窗口时长（分钟）。 */
  minutes: number;
  /** 可选的排队人数（用于诊断，不参与点估计）。 */
  queue?: number;
}

function meanAndInterval(values: number[]): { mean: number; lower: number; upper: number; sd: number } {
  if (values.length === 0) return { mean: 0, lower: 0, upper: 0, sd: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  const sd = Math.sqrt(variance);
  const half = values.length > 1 ? 1.96 * sd / Math.sqrt(values.length) : 0;
  return { mean, lower: Math.max(0, mean - half), upper: mean + half, sd };
}

/**
 * 合成数据不得因「样本稳定」而被升格为 calibrated；该标签只能来自真实观测。
 * public_dataset 允许 measured（标注即测量），但不因统计稳定自动升为 calibrated。
 */
export function capProvenanceByNature(value: CalibratedValue, nature: CalibrationDataNature): CalibratedValue {
  if (nature === 'authorized_real') return value;
  if (value.provenance === 'calibrated') {
    return {
      ...value,
      provenance: nature === 'public_dataset' ? 'estimated' : 'estimated',
      notes: `${value.notes ?? ''} 数据性质为 ${nature}，不得标记 calibrated；仅保留统计估计。`.trim(),
    };
  }
  if (nature === 'synthetic' && value.provenance === 'measured') {
    return { ...value, provenance: 'estimated', notes: '合成数据不得标记 measured。' };
  }
  return value;
}

/**
 * 估计出口/通道服务率（人/分钟）。
 * 只有样本 ≥10 且变异系数 ≤0.3 时才标记为 calibrated；否则为 estimated。
 * 传入 data_nature 时，合成/公开数据会被降级，防止统计稳定被误读为实测。
 */
export function estimateServiceRate(
  samples: ThroughputSample[],
  source: string,
  dataNature?: CalibrationDataNature,
): CalibratedValue {
  const rates = samples
    .filter(sample => sample.minutes > 0 && Number.isFinite(sample.served))
    .map(sample => Math.max(0, sample.served) / sample.minutes);
  const stats = meanAndInterval(rates);
  const cv = stats.mean > 0 ? stats.sd / stats.mean : Number.POSITIVE_INFINITY;
  const calibrated = rates.length >= 10 && cv <= 0.3;
  const value: CalibratedValue = {
    value: Number(stats.mean.toFixed(4)),
    unit: 'persons/min',
    provenance: calibrated ? 'calibrated' : 'estimated',
    source,
    method: '吞吐率样本均值（1.96·SE 区间；n≥10 且 CV≤0.3 才升为 calibrated）',
    measured_at: calibrated ? new Date().toISOString() : undefined,
    samples: rates.length,
    confidence_interval: { lower: Number(stats.lower.toFixed(4)), upper: Number(stats.upper.toFixed(4)) },
    notes: calibrated ? undefined : `样本 n=${rates.length}, CV=${Number.isFinite(cv) ? cv.toFixed(3) : 'inf'}；不足以称为标定值`,
  };
  return dataNature ? capProvenanceByNature(value, dataNature) : value;
}

/** 由距离/时间样本估计步行速度（m/s）。 */
export function estimateWalkingSpeed(
  samples: Array<{ distance_m: number; seconds: number }>,
  source: string,
  dataNature?: CalibrationDataNature,
): CalibratedValue {
  const speeds = samples
    .filter(sample => sample.seconds > 0 && sample.distance_m > 0)
    .map(sample => sample.distance_m / sample.seconds);
  const stats = meanAndInterval(speeds);
  const cv = stats.mean > 0 ? stats.sd / stats.mean : Number.POSITIVE_INFINITY;
  const calibrated = speeds.length >= 10 && cv <= 0.3;
  const value: CalibratedValue = {
    value: Number(stats.mean.toFixed(4)),
    unit: 'm/s',
    provenance: calibrated ? 'calibrated' : 'estimated',
    source,
    method: '距离/时间样本均值（1.96·SE 区间；n≥10 且 CV≤0.3 才升为 calibrated）',
    measured_at: calibrated ? new Date().toISOString() : undefined,
    samples: speeds.length,
    confidence_interval: { lower: Number(stats.lower.toFixed(4)), upper: Number(stats.upper.toFixed(4)) },
    notes: calibrated ? undefined : `样本 n=${speeds.length}；不足以称为标定值`,
  };
  return dataNature ? capProvenanceByNature(value, dataNature) : value;
}

// ---------------------------------------------------------------------------
// 观测适配器
// ---------------------------------------------------------------------------

export interface CameraCountInput {
  adapter_id: string;
  region_id: string;
  count: number;
  confidence: number;
  observed_at: string;
  received_at: string;
  calibration_version: string;
  provider: string;
  model_version: string;
}

export interface AdaptedObservation {
  observation: DensityObservation | null;
  rejected_reason: string | null;
}

/**
 * 把外部相机计数转换为系统观测；区分 simulation / recorded_video / live_video。
 * 过期、低置信度、非法计数一律拒绝，不静默填充。
 */
export function adaptCameraCount(
  input: CameraCountInput,
  scenario: SafetyScenario,
  options: { now?: Date; source: 'simulation' | 'recorded_video' | 'live_video' },
): AdaptedObservation {
  const now = options.now ?? new Date();
  const region = scenario.regions.find(item => item.id === input.region_id);
  if (!region) return { observation: null, rejected_reason: 'unknown_region' };
  if (region.camera.status === 'offline') return { observation: null, rejected_reason: 'camera_offline' };
  if (!Number.isFinite(input.count) || input.count < 0) return { observation: null, rejected_reason: 'invalid_count' };
  if (!Number.isFinite(input.confidence) || input.confidence < scenario.config.min_confidence) {
    return { observation: null, rejected_reason: 'low_confidence' };
  }
  const observedAt = new Date(input.observed_at);
  if (Number.isNaN(observedAt.getTime())) return { observation: null, rejected_reason: 'invalid_timestamp' };
  const receivedAt = new Date(input.received_at);
  if (Number.isNaN(receivedAt.getTime())) return { observation: null, rejected_reason: 'invalid_timestamp' };
  // 未来时间戳（超出 30 秒容差）说明时钟漂移或伪造，必须拒绝。
  if (observedAt.getTime() - now.getTime() > 30_000) {
    return { observation: null, rejected_reason: 'timestamp_in_future' };
  }
  const ageSeconds = (now.getTime() - observedAt.getTime()) / 1000;
  if (ageSeconds > scenario.config.max_observation_age_seconds) {
    return { observation: null, rejected_reason: 'stale_observation' };
  }
  const observation = buildObservation({
    region,
    count: Math.floor(input.count),
    confidence: input.confidence,
    source: options.source,
    provider: input.provider,
    modelVersion: input.model_version,
    observedAt,
    receivedAt,
    calibrationVersion: input.calibration_version,
  });
  return { observation, rejected_reason: null };
}
