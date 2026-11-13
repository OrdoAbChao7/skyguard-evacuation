/**
 * 统一感知适配器（V6.5）。
 *
 * 链路：图像/视频帧 → 人数估计 → 观测质量 → 区域观测 → 时间序列
 *       → 预测 → VoI 调查排序 → 风险分析。
 *
 * 安全边界：
 *  - 人数不等于单位面积密度。只有 **人数 + 与场景区域一致的面积 + 已标定映射**
 *    才能生成可用于安全域的观测；否则只能生成不可信观测（valid=false），
 *    系统进入 DEGRADED，而不是用估算密度冒充真实密度。
 *  - CityStreet 派生显示数据无真值、许可未核验、配准近似；只能作为演示质量输入，
 *    不得据此报告精度。
 *  - 公开数据集（ShanghaiTech/P2PNet）结果只证明“图像→人数”链路，不代表现场标定。
 */
import type { DisplayFrame, DisplayZone, LoadedDisplayPackage } from './display';
import crypto from 'node:crypto';
import type { SafetyDecisionService } from '../safety/decision-service';
import type { DensityObservation, SafetyScenario } from '../safety/types';
import type { OpsActor } from '../mvp/ops';
import type { PredictionResult, PredictionService } from '../mvp/prediction';
import type { RegionRisk } from '../safety/risk';
import { buildRegionGraph } from '../mvp/risk-graph';
import { decideMultiRegionInvestigation, priorBeliefsForRegions } from '../mvp/multi-voi';
import { buildInvestigationAvailability } from '../mvp/availability';

export type PerceptionSourceKind = 'image_count' | 'display_frame';
export type CalibrationStatus = 'surveyed' | 'assumed_demo' | 'none';

export interface RegionMapping {
  region_id: string;
  zone_id: string;
  /** 与场景区域一致的面积（平方米）。 */
  area_m2: number;
  calibration: CalibrationStatus;
  calibration_id?: string;
  source: string;
}

export interface PerceptionQuality {
  status: 'ok' | 'degraded' | 'unusable';
  reasons: string[];
  calibrated: boolean;
  demo_mapping: boolean;
  ground_truth_available: boolean;
  license_status: string;
}

export interface PerceptionDraft {
  source_kind: PerceptionSourceKind;
  scene_id: string;
  camera_id: string;
  frame_id: number | null;
  observed_at: string;
  estimated_count: number;
  area_m2: number | null;
  density_per_m2: number | null;
  confidence: number | null;
  region_id: string | null;
  quality: PerceptionQuality;
  /** 仅当面积与映射均可信、置信度足够时为 true；否则安全域必须拒绝。 */
  valid_for_safety: boolean;
  provenance: Record<string, unknown>;
  limitations: string[];
  /** 进程内 HMAC 证明：只有本模块生成的草稿才能进入安全域。 */
  attestation: string;
}

const DRAFT_ATTESTATION_KEY = crypto.randomBytes(32);

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function signDraft(draft: Omit<PerceptionDraft, 'attestation'>): string {
  return crypto.createHmac('sha256', DRAFT_ATTESTATION_KEY).update(stableJson(draft)).digest('hex');
}

function finalizeDraft(draft: Omit<PerceptionDraft, 'attestation'>): PerceptionDraft {
  return { ...draft, attestation: signDraft(draft) };
}

export interface ImageCountInput {
  image_id: string;
  predicted_count: number;
  model: string;
  model_version: string;
  confidence?: number | null;
  ground_truth?: number | null;
  latency_ms?: number | null;
  mapping?: RegionMapping;
  observed_at?: string;
}

/** 鞋带公式：显示包中的地面多边形是米制坐标，可据此得到演示面积。 */
export function zoneAreaM2(polygon: Array<[number, number]>): number | null {
  if (!Array.isArray(polygon) || polygon.length < 3) return null;
  let twice = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[(index + 1) % polygon.length];
    twice += x1 * y2 - x2 * y1;
  }
  const area = Math.abs(twice) / 2;
  return Number.isFinite(area) && area > 0 ? Number(area.toFixed(4)) : null;
}

function meanConfidence(values: Array<number | null | undefined>): number | null {
  const valid = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (valid.length === 0) return null;
  return Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(4));
}

function qualityStatus(reasons: string[]): PerceptionQuality['status'] {
  if (reasons.some(reason => reason === 'missing_region_mapping' || reason === 'no_count' || reason.startsWith('frame_status_'))) {
    return 'unusable';
  }
  return reasons.length > 0 ? 'degraded' : 'ok';
}

export function adaptImageCount(input: ImageCountInput): PerceptionDraft {
  const reasons: string[] = [];
  const mapping = input.mapping;
  const area = mapping?.area_m2 ?? null;
  const density = area !== null && area > 0 ? Number((input.predicted_count / area).toFixed(4)) : null;
  if (!mapping) reasons.push('missing_region_mapping');
  if (!mapping || mapping.calibration !== 'surveyed') reasons.push('uncalibrated_region_mapping');
  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)) reasons.push('no_model_confidence');
  reasons.push('public_dataset_or_external_model');
  const calibrated = mapping?.calibration === 'surveyed';
  const validForSafety = Boolean(
    mapping
    && calibrated
    && area !== null
    && area > 0
    && typeof input.confidence === 'number'
    && input.confidence > 0
    && input.predicted_count >= 0,
  );
  const draft: Omit<PerceptionDraft, 'attestation'> = {
    source_kind: 'image_count',
    scene_id: input.image_id,
    camera_id: 'image',
    frame_id: null,
    observed_at: input.observed_at ?? new Date().toISOString(),
    estimated_count: Math.max(0, Math.round(input.predicted_count)),
    area_m2: area,
    density_per_m2: density,
    confidence: input.confidence ?? null,
    region_id: mapping?.region_id ?? null,
    quality: {
      status: qualityStatus(reasons),
      reasons: Array.from(new Set(reasons)),
      calibrated,
      demo_mapping: mapping?.calibration === 'assumed_demo',
      ground_truth_available: typeof input.ground_truth === 'number',
      license_status: 'UNKNOWN',
    },
    valid_for_safety: validForSafety,
    provenance: {
      model: input.model,
      model_version: input.model_version,
      latency_ms: input.latency_ms ?? null,
      ground_truth_available: typeof input.ground_truth === 'number',
      mapping_source: mapping?.source ?? null,
      calibration_id: mapping?.calibration_id ?? null,
    },
    limitations: [
      '图像人数不是区域密度；缺少已标定区域映射时不得进入安全域。',
      '公开数据集/外部模型结果不代表现场精度。',
    ],
  };
  return finalizeDraft(draft);
}

export function adaptDisplayFrame(
  loaded: LoadedDisplayPackage,
  frame: DisplayFrame,
  options: { mappings?: RegionMapping[]; observed_at?: string } = {},
): PerceptionDraft[] {
  const mappings = new Map((options.mappings ?? []).map(mapping => [mapping.zone_id, mapping]));
  const zoneById = new Map(loaded.zones.map(zone => [zone.zone_id, zone]));
  return frame.zone_stats.map(stat => {
    const zone = zoneById.get(stat.zone_id);
    const mapping = mappings.get(stat.zone_id);
    const polygonArea = zone ? zoneAreaM2(zone.ground_polygon_m) : null;
    const area = mapping?.area_m2 ?? polygonArea;
    const count = stat.estimated_people;
    const density = area !== null && area > 0 ? Number((count / area).toFixed(4)) : null;
    const people = frame.people.filter(person => person.zone_id === stat.zone_id);
    const confidence = meanConfidence(people.map(person => person.confidence));
    const reasons = [
      'derived_display_data',
      'approximate_registration',
      'no_ground_truth',
      ...(loaded.summary.license_status === 'VERIFIED' ? [] : ['license_unverified']),
      ...(mapping ? [] : ['missing_region_mapping']),
      ...(mapping && mapping.calibration !== 'surveyed' ? ['uncalibrated_region_mapping'] : []),
    ];
    if (frame.frame_status !== 'ok') reasons.push(`frame_status_${frame.frame_status}`);
    if (confidence === null) reasons.push('no_person_confidence');
    const calibrated = mapping?.calibration === 'surveyed';
    const draft: Omit<PerceptionDraft, 'attestation'> = {
      source_kind: 'display_frame' as const,
      scene_id: loaded.summary.scene_id,
      camera_id: loaded.summary.camera_id,
      frame_id: frame.frame_id,
      observed_at: options.observed_at ?? new Date().toISOString(),
      estimated_count: count,
      area_m2: area,
      density_per_m2: density,
      confidence,
      region_id: mapping?.region_id ?? null,
      quality: {
        status: qualityStatus(reasons),
        reasons: Array.from(new Set(reasons)),
        calibrated,
        demo_mapping: mapping?.calibration !== 'surveyed',
        ground_truth_available: loaded.summary.ground_truth_available,
        license_status: loaded.summary.license_status,
      },
      // 派生显示数据即使有 surveyed 映射也不进入可信安全观测；需另立来源策略。
      valid_for_safety: false,
      provenance: {
        package_id: loaded.summary.package_id,
        calibration_id: loaded.summary.calibration_id,
        zone_id: stat.zone_id,
        polygon_area_m2: polygonArea,
        mapping_source: mapping?.source ?? null,
        time_base: loaded.summary.time_base,
        frame_timestamp_ms: frame.timestamp_ms,
      },
      limitations: [
        'CityStreet 派生显示数据无逐帧真值，不得用于报告精度。',
        '区域映射/配准为近似值；缺少 surveyed 标定时不得进入安全域。',
      ],
    };
    return finalizeDraft(draft);
  });
}

export interface PerceptionIngestResult {
  draft: PerceptionDraft;
  observation: DensityObservation | null;
  skipped_reason: string | null;
}

/**
 * 把感知草稿写入安全域。失败/不可信输入必须显式变成 valid=false 观测，
 * 让四态进入 DEGRADED，而不是静默丢弃。
 */
export function ingestPerceptionDraft(
  safety: SafetyDecisionService,
  draft: PerceptionDraft,
  actor: OpsActor,
): PerceptionIngestResult {
  if (!draft.region_id) {
    return { draft, observation: null, skipped_reason: 'missing_region_mapping' };
  }
  const scenario = safety.getScenario();
  const region = scenario.regions.find(item => item.id === draft.region_id);
  if (!region) {
    return { draft, observation: null, skipped_reason: `unknown_region:${draft.region_id}` };
  }
  const reasons = [...draft.quality.reasons];
  const { attestation, ...unsigned } = draft;
  const attested = typeof attestation === 'string'
    && attestation === signDraft(unsigned as Omit<PerceptionDraft, 'attestation'>);
  let valid = attested && draft.valid_for_safety;
  if (!attested) {
    valid = false;
    reasons.push('unattested_or_tampered_draft');
  }
  if (draft.source_kind === 'display_frame') {
    // 派生显示数据即使被 caller 标注 valid，也不得进入可信安全域。
    valid = false;
    reasons.push('derived_display_source_not_allowed');
  }
  if (!draft.quality.calibrated
    || draft.quality.status === 'unusable'
    || draft.quality.reasons.includes('missing_region_mapping')
    || draft.quality.reasons.includes('uncalibrated_region_mapping')) {
    valid = false;
    reasons.push('uncalibrated_or_unusable_source');
  }
  if (draft.area_m2 === null || Math.abs(draft.area_m2 - region.area_m2) / region.area_m2 > 1e-6) {
    valid = false;
    reasons.push('area_mismatch_with_scenario_region');
  }
  if (draft.confidence === null || draft.confidence < scenario.config.min_confidence) {
    valid = false;
    reasons.push('confidence_below_safety_threshold');
  }
  const observation = safety.ingestObservation({
    regionId: region.id,
    count: draft.estimated_count,
    confidence: draft.confidence ?? 0,
    source: 'recorded_video',
    provider: `perception:${draft.scene_id}:${draft.camera_id}`,
    modelVersion: `${draft.source_kind}/v65`,
    calibrationVersion: draft.provenance.calibration_id ? String(draft.provenance.calibration_id) : undefined,
    observedAt: new Date(draft.observed_at),
    valid,
    invalidReason: valid ? undefined : Array.from(new Set(reasons)).join('; '),
    evidence: {
      perception_quality: draft.quality,
      perception_provenance: draft.provenance,
      density_per_m2: draft.density_per_m2,
      area_m2: draft.area_m2,
    },
  }, actor);
  return { draft, observation, skipped_reason: valid ? null : Array.from(new Set(reasons)).join('; ') };
}

export interface PerceptionDecisionLoopResult {
  drafts: PerceptionDraft[];
  ingest: PerceptionIngestResult[];
  safety_state: string;
  versions: { observation: number; constraint: number; scenario: string };
  prediction: PredictionResult | null;
  risk: RegionRisk | null;
  voi: Record<string, unknown> | null;
  limitations: string[];
}

/**
 * 本地端到端链路：草稿 → 安全观测 → 重规划 → 预测 → VoI → 风险。
 * 只对目标区域给出分析；不发布任何路线，也不把不可信观测包装成可信。
 */
export function runPerceptionDecisionLoop(input: {
  scenario: SafetyScenario;
  safety: SafetyDecisionService;
  prediction: PredictionService;
  drafts: PerceptionDraft[];
  target_region_id: string;
  actor: OpsActor;
}): PerceptionDecisionLoopResult {
  const ingest = input.drafts.map(draft => ingestPerceptionDraft(input.safety, draft, input.actor));
  input.safety.recompute(input.actor, 'perception_chain');
  const status = input.safety.getStatus();
  const prediction = input.prediction.predict(input.target_region_id);
  const risk = status.risks.find(item => item.regionId === input.target_region_id) ?? null;
  let voi: Record<string, unknown> | null = null;
  const policy = input.scenario.investigation;
  if (policy) {
    const graph = buildRegionGraph(input.scenario);
    const beliefs = priorBeliefsForRegions(policy, status.risks);
    const historyPoints = input.safety.getObservationStore().window(
      input.target_region_id,
      new Date(Date.now() - input.scenario.config.trend_window_seconds * 1000),
      new Date(),
    ).filter(item => item.valid).length;
    const availability = buildInvestigationAvailability(policy, {
      cameraOnline: true,
      staffAvailable: true,
      uavAvailable: false,
      historyPoints,
      predictionReliable: prediction.reliability?.status !== 'failed',
      predictionReason: `预测可靠性 ${prediction.reliability?.status ?? 'unknown'}`,
    });
    const decision = decideMultiRegionInvestigation(policy, input.target_region_id, beliefs, graph, availability);
    voi = {
      recommended_action_id: decision.recommended_action_id,
      should_investigate: decision.should_investigate,
      stop_reason: decision.stop_reason,
      coverage_weight_source: decision.coverage_weight_source,
      evaluations: decision.evaluations.map(item => ({
        action_id: item.action_id,
        kind: item.kind,
        available: item.available,
        unavailable_reason: item.unavailable_reason,
        score: item.score,
      })),
    };
  }
  return {
    drafts: input.drafts,
    ingest,
    safety_state: status.state.state,
    versions: status.versions,
    prediction,
    risk,
    voi,
    limitations: [
      '感知草稿只有同时满足 surveyed 标定、与场景区域一致的面积和足够置信度时才进入安全域。',
      'CityStreet 派生显示数据无真值、许可未核验；本链路不产生精度指标。',
      '预测与 VoI 仅用于调查排序，不替代四态安全判定。',
    ],
  };
}
