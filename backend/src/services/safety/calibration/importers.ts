/**
 * V7.3 场馆与观测导入流水线。
 *
 * 支持：JSON 场景导入、CSV 观测导入、视频计数接口、公开数据集适配器、授权真实数据适配器。
 * 数据分级严格区分：
 *   SYNTHETIC / PUBLIC_DATASET / CROSS_DATASET / REAL_WORLD_CALIBRATED
 *
 * 安全边界：
 *  - 公开数据集必须有已核验许可；授权真实数据必须有授权依据；
 *  - 从不把合成/公开数据标记为 real-world calibrated；
 *  - 导入只产生观测/校验结果，不自动发布计划；
 *  - 约束比较不得弱化场景的安全配置。
 */
import {
  SafetyScenarioSchema,
  type DensityObservation,
  type SafetyScenario,
} from '../types';
import { buildObservation } from '../observations';
import type { CalibratedValue, CalibrationDataNature, VenueProfile } from './venue-calibration';

export interface ImportIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  line?: number;
  path?: string;
}

export interface CsvTable {
  header: string[];
  rows: Array<{ line: number; values: Record<string, string> }>;
  errors: ImportIssue[];
}

/** RFC4180 风格 CSV 解析：支持引号、逗号、转义引号、CRLF、UTF-8 BOM。 */
export function parseCsv(text: string): CsvTable {
  const cleaned = text.replace(/^﻿/, '');
  const records: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const pushRecord = () => {
    cells.push(field);
    records.push({ line: recordLine, cells });
    cells = [];
    field = '';
    recordLine = line;
  };

  for (let index = 0; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (inQuotes) {
      if (char === '"') {
        if (cleaned[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      cells.push(field);
      field = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      pushRecord();
      line += 1;
      recordLine = line;
      continue;
    }
    field += char;
  }
  if (inQuotes) {
    return { header: [], rows: [], errors: [{ code: 'csv_unterminated_quote', severity: 'error', message: 'CSV 引号未闭合' }] };
  }
  if (field.length > 0 || cells.length > 0) pushRecord();
  if (records.length === 0) {
    return { header: [], rows: [], errors: [{ code: 'csv_empty', severity: 'error', message: 'CSV 为空' }] };
  }
  const header = records[0].cells.map(cell => cell.trim());
  const errors: ImportIssue[] = [];
  if (new Set(header).size !== header.length) {
    errors.push({ code: 'csv_duplicate_header', severity: 'error', message: 'CSV 表头存在重复列' });
  }
  const rows = records.slice(1).filter(record => record.cells.some(cell => cell.trim().length > 0)).map(record => {
    const values: Record<string, string> = {};
    header.forEach((name, column) => { values[name] = (record.cells[column] ?? '').trim(); });
    return { line: record.line, values };
  });
  return { header, rows, errors };
}

export interface ObservationInput {
  region_id: string;
  observed_at: string;
  received_at?: string;
  count: number;
  confidence: number;
  source?: string;
  provider?: string;
  model_version?: string;
  calibration_version?: string;
}

const OBSERVATION_SOURCES = ['simulation', 'recorded_video', 'live_video', 'csv_replay', 'field_report', 'uav_observation'] as const;

export function parseObservationCsv(text: string): { rows: ObservationInput[]; errors: ImportIssue[]; warnings: ImportIssue[] } {
  const table = parseCsv(text);
  const errors = [...table.errors];
  const warnings: ImportIssue[] = [];
  const required = ['region_id', 'observed_at', 'count', 'confidence'];
  for (const column of required) {
    if (!table.header.includes(column)) {
      errors.push({ code: 'csv_missing_column', severity: 'error', message: `缺少必需列 ${column}` });
    }
  }
  const extra = table.header.filter(column => !required.includes(column) && !['received_at', 'source', 'provider', 'model_version', 'calibration_version'].includes(column));
  if (extra.length > 0) warnings.push({ code: 'csv_extra_columns', severity: 'warning', message: `忽略未识别列：${extra.join(',')}` });
  if (errors.length > 0) return { rows: [], errors, warnings };

  const rows: ObservationInput[] = [];
  for (const row of table.rows) {
    const count = Number(row.values.count);
    const confidence = Number(row.values.confidence);
    if (!Number.isFinite(count) || count < 0) {
      errors.push({ code: 'csv_invalid_count', severity: 'error', message: `第 ${row.line} 行 count 非法`, line: row.line });
      continue;
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      errors.push({ code: 'csv_invalid_confidence', severity: 'error', message: `第 ${row.line} 行 confidence 必须在 [0,1]`, line: row.line });
      continue;
    }
    if (Number.isNaN(new Date(row.values.observed_at).getTime())) {
      errors.push({ code: 'csv_invalid_timestamp', severity: 'error', message: `第 ${row.line} 行 observed_at 非法`, line: row.line });
      continue;
    }
    if (row.values.received_at && Number.isNaN(new Date(row.values.received_at).getTime())) {
      errors.push({ code: 'csv_invalid_timestamp', severity: 'error', message: `第 ${row.line} 行 received_at 非法`, line: row.line });
      continue;
    }
    const source = row.values.source || 'csv_replay';
    if (!OBSERVATION_SOURCES.includes(source as typeof OBSERVATION_SOURCES[number])) {
      errors.push({ code: 'csv_invalid_source', severity: 'error', message: `第 ${row.line} 行 source 非法`, line: row.line });
      continue;
    }
    rows.push({
      region_id: row.values.region_id,
      observed_at: new Date(row.values.observed_at).toISOString(),
      received_at: row.values.received_at ? new Date(row.values.received_at).toISOString() : undefined,
      count,
      confidence,
      source,
      provider: row.values.provider || 'csv-import',
      model_version: row.values.model_version || 'csv-import/1.0.0',
      calibration_version: row.values.calibration_version,
    });
  }
  return { rows, errors, warnings };
}

export interface ObservationImportResult {
  observations: DensityObservation[];
  rejected: Array<{ region_id: string; line?: number; reason: string }>;
  errors: ImportIssue[];
}

export function toDensityObservations(
  scenario: SafetyScenario,
  rows: ObservationInput[],
  options: { now?: Date; mode: 'live' | 'replay'; calibrationVersion?: string; evidence?: Record<string, unknown> },
): ObservationImportResult {
  const now = options.now ?? new Date();
  const observations: DensityObservation[] = [];
  const rejected: ObservationImportResult['rejected'] = [];
  for (const row of rows) {
    const region = scenario.regions.find(item => item.id === row.region_id);
    if (!region) {
      rejected.push({ region_id: row.region_id, reason: 'unknown_region' });
      continue;
    }
    if (row.count < 0 || !Number.isFinite(row.count)) {
      rejected.push({ region_id: row.region_id, reason: 'invalid_count' });
      continue;
    }
    if (row.count > 10_000_000) {
      rejected.push({ region_id: row.region_id, reason: 'count_out_of_range' });
      continue;
    }
    if (row.confidence < scenario.config.min_confidence) {
      rejected.push({ region_id: row.region_id, reason: 'low_confidence' });
      continue;
    }
    const observedAt = new Date(row.observed_at);
    if (options.mode === 'live') {
      const ageSeconds = (now.getTime() - observedAt.getTime()) / 1000;
      if (ageSeconds > scenario.config.max_observation_age_seconds) {
        rejected.push({ region_id: row.region_id, reason: 'stale_observation' });
        continue;
      }
      if (observedAt.getTime() - now.getTime() > 30_000) {
        rejected.push({ region_id: row.region_id, reason: 'timestamp_in_future' });
        continue;
      }
    }
    observations.push(buildObservation({
      region,
      count: Math.floor(row.count),
      confidence: row.confidence,
      source: (row.source as DensityObservation['source']) ?? 'csv_replay',
      provider: row.provider ?? 'csv-import',
      modelVersion: row.model_version ?? 'csv-import/1.0.0',
      observedAt,
      receivedAt: row.received_at ? new Date(row.received_at) : now,
      calibrationVersion: row.calibration_version ?? options.calibrationVersion,
      evidence: { import_mode: options.mode, ...(options.evidence ?? {}) },
    }));
  }
  return { observations, rejected, errors: [] };
}

// ---------------------------------------------------------------------------
// 场景导入与拓扑校验
// ---------------------------------------------------------------------------

export function importScenarioFromJson(text: string): {
  scenario: SafetyScenario | null;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  topology: { errors: ImportIssue[]; warnings: ImportIssue[] };
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      scenario: null,
      errors: [{ code: 'scenario_json_invalid', severity: 'error', message: (error as Error).message }],
      warnings: [],
      topology: { errors: [], warnings: [] },
    };
  }
  const result = SafetyScenarioSchema.safeParse(parsed);
  if (!result.success) {
    return {
      scenario: null,
      errors: result.error.issues.map(issue => ({
        code: 'scenario_schema_error',
        severity: 'error' as const,
        message: `${issue.path.join('.')}: ${issue.message}`,
        path: issue.path.join('.'),
      })),
      warnings: [],
      topology: { errors: [], warnings: [] },
    };
  }
  return { scenario: result.data, errors: [], warnings: [], topology: validateScenarioTopology(result.data) };
}

export function validateScenarioTopology(scenario: SafetyScenario): { errors: ImportIssue[]; warnings: ImportIssue[] } {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const regionIds = new Set<string>();
  for (const region of scenario.regions) {
    if (regionIds.has(region.id)) errors.push({ code: 'duplicate_region', severity: 'error', message: `重复区域 ${region.id}`, path: region.id });
    regionIds.add(region.id);
    if (region.area_m2 <= 0) errors.push({ code: 'invalid_region_area', severity: 'error', message: `区域 ${region.id} 面积必须为正`, path: region.id });
  }
  const corridorIds = new Set<string>();
  for (const corridor of scenario.corridors) {
    if (corridorIds.has(corridor.id)) errors.push({ code: 'duplicate_corridor', severity: 'error', message: `重复通道 ${corridor.id}`, path: corridor.id });
    corridorIds.add(corridor.id);
    if (!regionIds.has(corridor.from_region_id) || !regionIds.has(corridor.to_region_id)) {
      errors.push({ code: 'corridor_endpoint_missing', severity: 'error', message: `通道 ${corridor.id} 端点不存在`, path: corridor.id });
    }
    if (corridor.capacity_per_min !== null && corridor.capacity_per_min < 0) {
      errors.push({ code: 'negative_corridor_capacity', severity: 'error', message: `通道 ${corridor.id} 容量为负`, path: corridor.id });
    }
    if (corridor.traversal_seconds <= 0) errors.push({ code: 'invalid_traversal', severity: 'error', message: `通道 ${corridor.id} 通行时间必须为正`, path: corridor.id });
    if (corridor.direction !== 'both' && corridor.capacity_per_min !== null && corridor.capacity_per_min === 0) {
      warnings.push({ code: 'zero_capacity_direction', severity: 'warning', message: `通道 ${corridor.id} 单向容量为 0`, path: corridor.id });
    }
  }
  const exitIds = new Set<string>();
  for (const exit of scenario.exits) {
    if (exitIds.has(exit.id)) errors.push({ code: 'duplicate_exit', severity: 'error', message: `重复出口 ${exit.id}`, path: exit.id });
    exitIds.add(exit.id);
    if (!regionIds.has(exit.region_id)) errors.push({ code: 'exit_region_missing', severity: 'error', message: `出口 ${exit.id} 所属区域不存在`, path: exit.id });
    if (exit.capacity_per_min !== null && exit.capacity_per_min < 0) {
      errors.push({ code: 'negative_exit_capacity', severity: 'error', message: `出口 ${exit.id} 容量为负`, path: exit.id });
    }
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// 方向性容量与场馆约束
// ---------------------------------------------------------------------------

export function directionalCapacityFactor(
  profile: VenueProfile,
  corridorId: string,
  direction: 'forward' | 'reverse',
): number {
  const corridor = profile.corridors.find(item => item.corridor_id === corridorId);
  if (!corridor) return 1;
  const directional = corridor.directional_capacity?.[direction];
  const physical = corridor.capacity_per_min.value;
  if (!directional || physical <= 0) return 1;
  return Math.max(0, Math.min(1, directional.value / physical));
}

export function compareVenueConstraints(
  scenario: SafetyScenario,
  profile: VenueProfile,
): { errors: ImportIssue[]; warnings: ImportIssue[] } {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const constraints = profile.constraints;
  if (!constraints) return { errors, warnings };
  if (constraints.min_confidence !== undefined && constraints.min_confidence < scenario.config.min_confidence) {
    errors.push({
      code: 'constraint_weakens_min_confidence',
      severity: 'error',
      message: `场馆 min_confidence=${constraints.min_confidence} 低于场景安全配置 ${scenario.config.min_confidence}`,
      path: 'constraints.min_confidence',
    });
  }
  if (constraints.max_observation_age_seconds !== undefined
    && constraints.max_observation_age_seconds > scenario.config.max_observation_age_seconds) {
    errors.push({
      code: 'constraint_weakens_observation_age',
      severity: 'error',
      message: `场馆观测有效期 ${constraints.max_observation_age_seconds}s 长于场景安全配置 ${scenario.config.max_observation_age_seconds}s`,
      path: 'constraints.max_observation_age_seconds',
    });
  }
  const critical = scenario.config.default_thresholds.critical_density;
  if (constraints.max_density_persons_per_m2 !== undefined && constraints.max_density_persons_per_m2 > critical) {
    errors.push({
      code: 'constraint_weakens_density',
      severity: 'error',
      message: `场馆最大密度 ${constraints.max_density_persons_per_m2} 高于场景 critical 阈值 ${critical}`,
      path: 'constraints.max_density_persons_per_m2',
    });
  }
  for (const corridorId of constraints.forbidden_corridor_ids) {
    if (!scenario.corridors.some(corridor => corridor.id === corridorId)) {
      errors.push({ code: 'forbidden_corridor_missing', severity: 'error', message: `禁止通道 ${corridorId} 不存在`, path: corridorId });
    }
  }
  if (constraints.require_human_approval === false) {
    warnings.push({
      code: 'human_approval_not_required',
      severity: 'warning',
      message: '场馆配置未要求人工审批；安全内核仍要求审批，不能据此绕过',
      path: 'constraints.require_human_approval',
    });
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// 视频计数接口
// ---------------------------------------------------------------------------

export interface VideoFrameCount {
  camera_id: string;
  timestamp: string;
  count: number;
  confidence: number;
}

export interface VideoObservationSource {
  kind: 'video';
  adapter_id: string;
  cameraToRegion: Record<string, string>;
  frames: VideoFrameCount[];
}

/**
 * 视频计数接口：输入是已经由视觉模型产生的计数，不是原始视频。
 * 本函数不做 CV，也不把计数精度表述为疏散预测精度。
 */
export function adaptVideoFrames(
  source: VideoObservationSource,
  scenario: SafetyScenario,
  profile: VenueProfile,
  options: { now?: Date; mode: 'live' | 'replay' },
): ObservationImportResult {
  const now = options.now ?? new Date();
  const observations: DensityObservation[] = [];
  const rejected: ObservationImportResult['rejected'] = [];
  for (const frame of source.frames) {
    const regionId = source.cameraToRegion[frame.camera_id]
      ?? profile.cameras.find(camera => camera.camera_id === frame.camera_id)?.region_id;
    if (!regionId) {
      rejected.push({ region_id: frame.camera_id, reason: 'unmapped_camera' });
      continue;
    }
    const region = scenario.regions.find(item => item.id === regionId);
    if (!region) {
      rejected.push({ region_id: regionId, reason: 'unknown_region' });
      continue;
    }
    if (!Number.isFinite(frame.count) || frame.count < 0) {
      rejected.push({ region_id: regionId, reason: 'invalid_count' });
      continue;
    }
    if (frame.count > 10_000_000) {
      rejected.push({ region_id: regionId, reason: 'count_out_of_range' });
      continue;
    }
    if (!Number.isFinite(frame.confidence) || frame.confidence < scenario.config.min_confidence) {
      rejected.push({ region_id: regionId, reason: 'low_confidence' });
      continue;
    }
    const observedAt = new Date(frame.timestamp);
    if (Number.isNaN(observedAt.getTime())) {
      rejected.push({ region_id: regionId, reason: 'invalid_timestamp' });
      continue;
    }
    const ageSeconds = (now.getTime() - observedAt.getTime()) / 1000;
    if (options.mode === 'live' && ageSeconds > scenario.config.max_observation_age_seconds) {
      rejected.push({ region_id: regionId, reason: 'stale_observation' });
      continue;
    }
    if (observedAt.getTime() - now.getTime() > 30_000) {
      rejected.push({ region_id: regionId, reason: 'timestamp_in_future' });
      continue;
    }
    const camera = profile.cameras.find(item => item.camera_id === frame.camera_id);
    observations.push(buildObservation({
      region,
      count: Math.floor(frame.count),
      confidence: frame.confidence,
      source: options.mode === 'live' ? 'live_video' : 'recorded_video',
      provider: source.adapter_id,
      modelVersion: 'video-count-interface/1.0.0',
      observedAt,
      receivedAt: now,
      calibrationVersion: camera?.calibration_version,
      evidence: { camera_id: frame.camera_id, adapter_id: source.adapter_id, mode: options.mode },
    }));
  }
  return { observations, rejected, errors: [] };
}

// ---------------------------------------------------------------------------
// 公开数据集 / 授权真实数据适配器
// ---------------------------------------------------------------------------

export interface DatasetDescriptor {
  name: string;
  url?: string;
  license: string;
  license_verified: boolean;
  citation: string;
  data_nature: Extract<CalibrationDataNature, 'public_dataset' | 'cross_dataset'>;
}

export interface DatasetMapping {
  regionColumn: string;
  countColumn: string;
  timestampColumn: string;
  confidenceColumn?: string;
}

export function adaptPublicDatasetRows(
  rows: Record<string, string>[],
  descriptor: DatasetDescriptor,
  mapping: DatasetMapping,
  scenario: SafetyScenario,
  options: { now?: Date; mode: 'live' | 'replay'; calibrationVersion?: string },
): { observations: DensityObservation[]; rejected: Array<{ region_id: string; reason: string }>; errors: ImportIssue[] } {
  const errors: ImportIssue[] = [];
  if (!descriptor.license_verified) {
    errors.push({ code: 'public_dataset_license_unverified', severity: 'error', message: '公开数据集许可未核验，拒绝导入' });
    return { observations: [], rejected: [], errors };
  }
  if (descriptor.data_nature !== 'public_dataset' && descriptor.data_nature !== 'cross_dataset') {
    errors.push({ code: 'public_dataset_nature_invalid', severity: 'error', message: '公开适配器只接受 public_dataset/cross_dataset' });
    return { observations: [], rejected: [], errors };
  }
  const inputs: ObservationInput[] = [];
  for (const [index, row] of rows.entries()) {
    const regionId = row[mapping.regionColumn];
    const count = Number(row[mapping.countColumn]);
    const timestamp = row[mapping.timestampColumn];
    const confidence = mapping.confidenceColumn ? Number(row[mapping.confidenceColumn]) : 0.8;
    if (!regionId || !Number.isFinite(count) || !timestamp || Number.isNaN(new Date(timestamp).getTime())) {
      errors.push({ code: 'public_row_invalid', severity: 'error', message: `第 ${index + 1} 行缺少区域/计数/合法时间`, line: index + 1 });
      continue;
    }
    inputs.push({
      region_id: regionId,
      observed_at: new Date(timestamp).toISOString(),
      count,
      confidence,
      source: 'csv_replay',
      provider: `public:${descriptor.name}`,
      model_version: `${descriptor.name}/public-adapter`,
      calibration_version: options.calibrationVersion,
    });
  }
  const converted = toDensityObservations(scenario, inputs, {
    now: options.now,
    mode: options.mode,
    calibrationVersion: options.calibrationVersion,
    evidence: {
      dataset: descriptor.name,
      license: descriptor.license,
      citation: descriptor.citation,
      url: descriptor.url,
      data_nature: descriptor.data_nature,
    },
  });
  return { observations: converted.observations, rejected: converted.rejected, errors };
}

export interface AuthorizationDescriptor {
  reference: string;
  legal_basis: string;
  operator: string;
  verified_at: string;
}

/**
 * 授权真实数据适配器。没有授权依据时直接拒绝，不得输出 REAL_WORLD 观测。
 */
export function adaptAuthorizedRealRows(
  rows: Record<string, string>[],
  authorization: AuthorizationDescriptor | undefined,
  mapping: DatasetMapping,
  scenario: SafetyScenario,
  options: { now?: Date; calibrationVersion?: string },
): { observations: DensityObservation[]; rejected: Array<{ region_id: string; reason: string }>; errors: ImportIssue[] } {
  const errors: ImportIssue[] = [];
  if (!authorization || !authorization.reference || !authorization.legal_basis || !authorization.operator || !authorization.verified_at) {
    errors.push({ code: 'real_world_authorization_missing', severity: 'error', message: '缺少授权依据，拒绝导入真实数据' });
    return { observations: [], rejected: [], errors };
  }
  const inputs: ObservationInput[] = [];
  for (const [index, row] of rows.entries()) {
    const regionId = row[mapping.regionColumn];
    const count = Number(row[mapping.countColumn]);
    const timestamp = row[mapping.timestampColumn];
    if (!regionId || !Number.isFinite(count) || count < 0 || count > 10_000_000
      || !timestamp || Number.isNaN(new Date(timestamp).getTime())) {
      errors.push({ code: 'authorized_row_invalid', severity: 'error', message: `第 ${index + 1} 行缺少区域/计数/合法时间`, line: index + 1 });
      continue;
    }
    inputs.push({
      region_id: regionId,
      observed_at: new Date(timestamp).toISOString(),
      count,
      confidence: mapping.confidenceColumn ? Number(row[mapping.confidenceColumn]) : 0.9,
      source: 'field_report',
      provider: `authorized:${authorization.operator}`,
      model_version: 'authorized-real-adapter/1.0.0',
      calibration_version: options.calibrationVersion,
    });
  }
  const converted = toDensityObservations(scenario, inputs, {
    now: options.now,
    mode: 'live',
    calibrationVersion: options.calibrationVersion,
    evidence: {
      authorization_reference: authorization.reference,
      legal_basis: authorization.legal_basis,
      operator: authorization.operator,
      verified_at: authorization.verified_at,
      data_nature: 'REAL_WORLD_CALIBRATED',
    },
  });
  return { observations: converted.observations, rejected: converted.rejected, errors };
}
