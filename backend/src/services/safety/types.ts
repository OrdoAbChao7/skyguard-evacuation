/**
 * SkyGuard 安全业务域 · 数据契约 (Zod)
 *
 * 该文件定义安全疏散领域独立的类型系统，与灵小禅旅游业务域 (route/scene) 完全隔离。
 * 所有度量都必须携带来源与核验状态，禁止把估算值呈现为实测值。
 */
import { z } from 'zod';

/** 数据来源可信度分级。`estimated` 与 `uncalibrated` 不得被当作实测。 */
export const PROVENANCE = ['measured', 'calibrated', 'estimated', 'uncalibrated', 'unknown'] as const;
export type Provenance = (typeof PROVENANCE)[number];

/** 观测来源：模拟数据 / 离线视频 / 实时视频。三者在前端必须可区分。 */
export const OBSERVATION_SOURCE = ['simulation', 'recorded_video', 'live_video', 'csv_replay', 'field_report', 'uav_observation'] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCE)[number];

export const CORRIDOR_STATUS = ['open', 'closed', 'unknown'] as const;
export type CorridorStatus = (typeof CORRIDOR_STATUS)[number];

export const RISK_LEVEL = ['normal', 'watch', 'high', 'critical', 'unknown'] as const;
export type RiskLevel = (typeof RISK_LEVEL)[number];

export const SAFETY_STATE = ['NORMAL', 'REROUTE', 'DEGRADED', 'REJECT'] as const;
export type SafetyState = (typeof SAFETY_STATE)[number];

export const INCIDENT_TYPE = [
  'fire',
  'corridor_closure',
  'crowd_surge',
  'sensor_failure',
  'other',
] as const;
export type IncidentType = (typeof INCIDENT_TYPE)[number];

export const INCIDENT_STATUS = ['reported', 'confirmed', 'resolved', 'dismissed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUS)[number];

const IsoTimestamp = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// 区域
// ---------------------------------------------------------------------------

export const RiskThresholdSchema = z.object({
  /** 关注阈值，人/m² */
  watch_density: z.number().positive(),
  /** 高风险阈值，人/m² */
  high_density: z.number().positive(),
  /** 极高风险阈值，人/m² */
  critical_density: z.number().positive(),
  /** 密度上升速率阈值，人/m²/min */
  rise_rate_watch: z.number().positive(),
  /** 阈值来源说明。必须写明是否为现场标定值。 */
  source: z.string().min(1),
});
export type RiskThreshold = z.infer<typeof RiskThresholdSchema>;

export const MapGeometrySchema = z.object({
  /** 指挥大屏示意坐标（无量纲），不是真实地理坐标。 */
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const RegionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 真实面积，平方米。 */
  area_m2: z.number().positive(),
  area_provenance: z.enum(PROVENANCE),
  /** 示意几何（仅用于大屏绘制）。 */
  geometry: MapGeometrySchema,
  geometry_provenance: z.enum(PROVENANCE),
  /** 区域在留容量（可容纳的等待人数），用于网络流的缓冲区容量。 */
  holding_capacity_persons: z.number().int().positive(),
  /** 覆盖全局默认阈值的区域级阈值（可选）。 */
  thresholds: RiskThresholdSchema.optional(),
  enabled: z.boolean(),
  /** 摄像机标定信息，记录像素到区域的映射状态。 */
  camera: z.object({
    camera_id: z.string().min(1),
    /** 视频帧内的关注区域（归一化 0~1）。 */
    roi: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
    calibration_status: z.enum(PROVENANCE),
    calibration_version: z.string().min(1),
    /** 摄像头运行状态（可选；缺省时由最近观测推断）。 */
    status: z.enum(['online', 'offline', 'degraded', 'unknown']).optional(),
  }),
  source: z.string().min(1),
  verified: z.boolean(),
});
export type Region = z.infer<typeof RegionSchema>;

// ---------------------------------------------------------------------------
// 疏散通道
// ---------------------------------------------------------------------------

export const CorridorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  from_region_id: z.string().min(1),
  to_region_id: z.string().min(1),
  /** 基础通行状态（事件会覆盖为有效状态）。 */
  status: z.enum(CORRIDOR_STATUS),
  /** forward 表示仅 from→to；reverse 表示仅 to→from；both 表示双向。 */
  direction: z.enum(['forward', 'reverse', 'both']),
  /** 通行能力，人/分钟。null 表示容量未知，未知不得当作无限。 */
  capacity_per_min: z.number().int().nonnegative().nullable(),
  capacity_provenance: z.enum(PROVENANCE),
  /** 通过该通道所需时间（秒）。 */
  traversal_seconds: z.number().int().positive(),
  status_source: z.string().min(1),
  verified: z.boolean(),
  updated_at: IsoTimestamp,
  closure_reason: z.string().optional(),
});
export type Corridor = z.infer<typeof CorridorSchema>;

// ---------------------------------------------------------------------------
// 出口
// ---------------------------------------------------------------------------

export const ExitSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  region_id: z.string().min(1),
  status: z.enum(CORRIDOR_STATUS),
  capacity_per_min: z.number().int().nonnegative().nullable(),
  capacity_provenance: z.enum(PROVENANCE),
  status_source: z.string().min(1),
  verified: z.boolean(),
  updated_at: IsoTimestamp,
  closure_reason: z.string().optional(),
});
export type SafetyExit = z.infer<typeof ExitSchema>;

// ---------------------------------------------------------------------------
// 人群观测
// ---------------------------------------------------------------------------

export const DensityObservationSchema = z.object({
  id: z.string().min(1),
  region_id: z.string().min(1),
  /** 观测时刻（采集时间）。 */
  observed_at: IsoTimestamp,
  /** 接收时刻（到达系统时间）。 */
  received_at: IsoTimestamp,
  estimated_count: z.number().int().nonnegative(),
  estimated_density: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  source: z.enum(OBSERVATION_SOURCE),
  provider: z.string().min(1),
  model_version: z.string().min(1),
  calibration_version: z.string().min(1),
  /** 观测有效性，无效时必须写明原因。 */
  valid: z.boolean(),
  invalid_reason: z.string().optional(),
  evidence: z.record(z.unknown()).optional(),
});
export type DensityObservation = z.infer<typeof DensityObservationSchema>;

// ---------------------------------------------------------------------------
// 突发事件
// ---------------------------------------------------------------------------

export const IncidentEffectsSchema = z.object({
  region_ids: z.array(z.string()).default([]),
  corridor_ids: z.array(z.string()).default([]),
  exit_ids: z.array(z.string()).default([]),
});

export const IncidentSchema = z.object({
  id: z.string().min(1),
  type: z.enum(INCIDENT_TYPE),
  description: z.string().min(1),
  status: z.enum(INCIDENT_STATUS),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  affected: IncidentEffectsSchema,
  source: z.enum(['operator', 'natural_language', 'sensor', 'simulation']),
  /** 自然语言原文（若由自然语言入口创建）。 */
  raw_text: z.string().optional(),
  reported_by: z.string().min(1),
  reported_at: IsoTimestamp,
  confirmed_by: z.string().optional(),
  confirmed_at: IsoTimestamp.optional(),
  resolved_by: z.string().optional(),
  resolved_at: IsoTimestamp.optional(),
  resolution_note: z.string().optional(),
});
export type Incident = z.infer<typeof IncidentSchema>;

// ---------------------------------------------------------------------------
// 疏散方案
// ---------------------------------------------------------------------------

export const EvacuationStepSchema = z.object({
  corridor_id: z.string().min(1),
  from_region_id: z.string().min(1),
  to_region_id: z.string().min(1),
  /** 进入该通道的时刻（相对规划起点的分钟数）。 */
  depart_minute: z.number().int().nonnegative(),
  arrive_minute: z.number().int().nonnegative(),
  persons: z.number().int().nonnegative(),
});
export type EvacuationStep = z.infer<typeof EvacuationStepSchema>;

export const EvacuationRouteSchema = z.object({
  route_id: z.string().min(1),
  from_region_id: z.string().min(1),
  exit_id: z.string().min(1),
  persons: z.number().int().nonnegative(),
  depart_minute: z.number().int().nonnegative(),
  arrive_minute: z.number().int().nonnegative(),
  steps: z.array(EvacuationStepSchema),
});
export type EvacuationRoute = z.infer<typeof EvacuationRouteSchema>;

export const UnresolvedDemandSchema = z.object({
  region_id: z.string().min(1),
  persons: z.number().int().nonnegative(),
  reason: z.string().min(1),
});
export type UnresolvedDemand = z.infer<typeof UnresolvedDemandSchema>;

export const PLAN_STATUS = ['feasible', 'partial', 'infeasible'] as const;
export type PlanStatus = (typeof PLAN_STATUS)[number];

export const EvacuationPlanSchema = z.object({
  plan_id: z.string().min(1),
  created_at: IsoTimestamp,
  /** 参与计算的版本，用于失效判定。 */
  scenario_version: z.string().min(1),
  constraint_version: z.number().int().nonnegative(),
  observation_version: z.number().int().nonnegative(),
  horizon_minutes: z.number().int().positive(),
  status: z.enum(PLAN_STATUS),
  routes: z.array(EvacuationRouteSchema),
  unresolved: z.array(UnresolvedDemandSchema),
  exit_totals: z.array(z.object({ exit_id: z.string(), persons: z.number().int().nonnegative() })),
  corridor_totals: z.array(z.object({ corridor_id: z.string(), persons: z.number().int().nonnegative() })),
  demand_by_region: z.array(z.object({ region_id: z.string(), persons: z.number().int().nonnegative() })),
  total_persons: z.number().int().nonnegative(),
  evacuated_persons: z.number().int().nonnegative(),
  unresolved_persons: z.number().int().nonnegative(),
  planner: z.object({
    algorithm: z.string().min(1),
    model: z.string().min(1),
    notes: z.array(z.string()),
  }),
});
export type EvacuationPlan = z.infer<typeof EvacuationPlanSchema>;

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export const VIOLATION_SEVERITY = ['hard', 'soft'] as const;
export type ViolationSeverity = (typeof VIOLATION_SEVERITY)[number];

export const SafetyViolationSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(VIOLATION_SEVERITY),
  message: z.string().min(1),
  region_id: z.string().optional(),
  corridor_id: z.string().optional(),
  exit_id: z.string().optional(),
  detail: z.record(z.unknown()).optional(),
});
export type SafetyViolation = z.infer<typeof SafetyViolationSchema>;

export const SafetyValidationResultSchema = z.object({
  valid: z.boolean(),
  checked_at: IsoTimestamp,
  plan_id: z.string().min(1),
  violations: z.array(SafetyViolationSchema),
  checks_run: z.array(z.string()),
  versions: z.object({
    scenario_version: z.string(),
    constraint_version: z.number().int(),
    observation_version: z.number().int(),
  }),
});
export type SafetyValidationResult = z.infer<typeof SafetyValidationResultSchema>;

// ---------------------------------------------------------------------------
// 场景文件
// ---------------------------------------------------------------------------

export const SafetyConfigSchema = z.object({
  horizon_minutes: z.number().int().positive(),
  /** 观测最大有效时长（秒）。超过即视为过期。 */
  max_observation_age_seconds: z.number().int().positive(),
  /** 观测最低可信置信度。 */
  min_confidence: z.number().min(0).max(1),
  /** 密度趋势计算窗口（秒）。 */
  trend_window_seconds: z.number().int().positive(),
  /** 人数/密度一致性容忍度（相对误差）。 */
  density_consistency_tolerance: z.number().min(0).max(1),
  /** 工单资源预留有效期（分钟）；过期后自动释放，需重新确认。 */
  work_order_reservation_ttl_minutes: z.number().positive().max(1440).default(15),
  /** 预测区间相对宽度超过该值时标记预测不可用于 VoI。 */
  prediction_max_relative_interval_width: z.number().positive().max(5).default(0.5),
  default_thresholds: RiskThresholdSchema,
});
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;

export const DemoStepSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('observe'),
    observations: z.record(
      z.object({ count: z.number().int().nonnegative(), confidence: z.number().min(0).max(1) }),
    ),
  }),
  z.object({
    action: z.literal('sensor_fault'),
    region_ids: z.array(z.string()).min(1),
    reason: z.string().default('模拟感知服务异常'),
  }),
  z.object({
    action: z.literal('incident.create'),
    type: z.enum(INCIDENT_TYPE),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    description: z.string(),
    affected: IncidentEffectsSchema,
    ref: z.string().default('last'),
  }),
  z.object({
    action: z.literal('incident.confirm'),
    ref: z.string().default('last'),
  }),
  z.object({
    action: z.literal('incident.resolve'),
    ref: z.string().default('last'),
  }),
  z.object({ action: z.literal('recompute') }),
]);
export type DemoStep = z.infer<typeof DemoStepSchema>;

export const DemoScenarioSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  /** 该演示期望的最终安全状态，用于自动化验收。 */
  expected_state: z.enum(SAFETY_STATE),
  steps: z.array(DemoStepSchema).min(1),
});
export type DemoScenario = z.infer<typeof DemoScenarioSchema>;

// ---------------------------------------------------------------------------
// 场景地图层（只影响大屏绘制，不参与安全判定）
// ---------------------------------------------------------------------------

export const ScenarioLandmarkSchema = z.object({
  name: z.string().min(1),
  /** 归一化坐标 0~1，相对大屏示意画布。 */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type ScenarioLandmark = z.infer<typeof ScenarioLandmarkSchema>;

export const ScenarioMapSchema = z.object({
  /** 大屏底图说明，例如 "概念底图 · 合成场景 · 未空间标定"。 */
  caption: z.string().min(1).optional(),
  /** 底图资源路径（由前端静态目录提供），缺省则不显示底图。 */
  backdrop: z.string().min(1).optional(),
  /** 底图压暗程度 0~1。 */
  backdrop_opacity: z.number().min(0).max(1).optional(),
  landmarks: z.array(ScenarioLandmarkSchema).default([]),
});
export type ScenarioMap = z.infer<typeof ScenarioMapSchema>;

export const SimulationBaselineSchema = z.record(
  z.object({
    count: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1),
  }),
);
export type SimulationBaseline = z.infer<typeof SimulationBaselineSchema>;

// ---------------------------------------------------------------------------
// 场馆、规则、工作人员与调查策略（MVP 场景适配层）
// ---------------------------------------------------------------------------

export const STAFF_STATUS = ['available', 'reserved', 'busy', 'off_duty'] as const;
export type StaffStatus = (typeof STAFF_STATUS)[number];

export const STAFF_ROLE = ['crowd_control', 'security', 'medical', 'uav_operator', 'supervisor'] as const;
export type StaffRole = (typeof STAFF_ROLE)[number];

export const StaffMemberSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(STAFF_ROLE),
  region_id: z.string().min(1),
  status: z.enum(STAFF_STATUS),
  skills: z.array(z.string()).default([]),
  /** 仅用于演示的工作员登录码；真实部署必须换成正式身份系统。 */
  access_code: z.string().min(4).optional(),
  source: z.string().min(1),
  verified: z.boolean().default(false),
});
export type StaffMember = z.infer<typeof StaffMemberSchema>;

export const VenueRuleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  text: z.string().min(1),
  category: z.enum(['safety', 'operations', 'approval', 'uav', 'staffing', 'data']),
  mandatory: z.boolean().default(false),
  source: z.string().min(1),
});
export type VenueRule = z.infer<typeof VenueRuleSchema>;

export const UavUnitSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(['available', 'busy', 'offline', 'unknown']),
  source: z.string().min(1),
  verified: z.boolean().default(false),
});
export type UavUnit = z.infer<typeof UavUnitSchema>;

export const VenueSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  description: z.string().optional(),
  rules: z.array(VenueRuleSchema).default([]),
  uav_units: z.array(UavUnitSchema).default([]),
  /** 本场景允许 Agent 调用的工具名；缺省表示全部启用。 */
  enabled_tools: z.array(z.string()).optional(),
});
export type Venue = z.infer<typeof VenueSchema>;

export const INVESTIGATION_KIND = [
  'camera_query',
  'staff_check',
  'uav_request',
  'history_query',
  'prediction',
] as const;
export type InvestigationKind = (typeof INVESTIGATION_KIND)[number];

export const INVESTIGATION_OUTCOME = [
  'signal_normal',
  'signal_congested',
  'inconclusive',
  'unavailable',
] as const;
export type InvestigationOutcome = (typeof INVESTIGATION_OUTCOME)[number];

export const INVESTIGATION_COVERAGE = ['target', 'neighbors', 'all'] as const;
export type InvestigationCoverage = (typeof INVESTIGATION_COVERAGE)[number];

export const InvestigationRetrySchema = z.object({
  max_retries: z.number().int().min(0).max(3),
  cooldown_minutes: z.number().nonnegative(),
  backoff_factor: z.number().min(1).max(5),
});
export type InvestigationRetry = z.infer<typeof InvestigationRetrySchema>;

export const InvestigationActionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(INVESTIGATION_KIND),
  label: z.string().min(1),
  /** 动作覆盖范围：目标区域 / 相邻区域 / 全部区域（多区域联合调查）。 */
  coverage: z.enum(INVESTIGATION_COVERAGE).default('target'),
  /** 失败重试策略（冷却与指数退避）。 */
  retry: InvestigationRetrySchema.optional(),
  /** 固定调查策略使用的优先级，数字越小越先调查。 */
  priority: z.number().int().positive(),
  time_cost_minutes: z.number().nonnegative(),
  /** 归一化资源成本 0~1。 */
  resource_cost: z.number().min(0).max(1),
  failure_probability: z.number().min(0).max(1),
  base_availability: z.enum(['available', 'unavailable', 'degraded']).default('available'),
  detects: z.array(z.string()).default([]),
  source: z.string().min(1),
});
export type InvestigationAction = z.infer<typeof InvestigationActionSchema>;

export const InvestigationHypothesisSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  prior: z.number().min(0).max(1),
});

export const InvestigationPolicySchema = z.object({
  model_version: z.string().min(1),
  provenance: z.string().min(1),
  hypotheses: z.array(InvestigationHypothesisSchema).min(2),
  outcomes: z.array(z.enum(INVESTIGATION_OUTCOME)).min(2),
  /** action.kind -> hypothesis -> outcome -> P(outcome | hypothesis, action) */
  likelihoods: z.record(z.record(z.record(z.number().min(0).max(1)))),
  /** hypothesis -> decision -> loss */
  loss_matrix: z.record(z.record(z.number().min(0))),
  decisions: z.array(z.string().min(1)).min(1),
  weights: z.object({
    risk_reduction: z.number().nonnegative(),
    information_gain: z.number().nonnegative(),
    time_cost: z.number().nonnegative(),
    resource_cost: z.number().nonnegative(),
    failure: z.number().nonnegative(),
  }),
  normalization: z.object({
    max_time_minutes: z.number().positive(),
    max_resource_cost: z.number().positive(),
  }),
  actions: z.array(InvestigationActionSchema).min(1),
  /** 多区域覆盖权重（来自场景；缺省时沿用历史默认值并在输出中标记 legacy_default）。 */
  coverage_weights: z.object({
    neighbor: z.number().min(0).max(1),
    global: z.number().min(0).max(1),
  }).optional(),
  /** 证据冲突处理参数（来自场景；缺省时沿用历史默认值并在输出中标记 legacy_default）。 */
  conflict: z.object({
    window_minutes: z.number().positive().max(120),
    /** 冲突时后验与先验的混合系数：0 = 完全采用后验，1 = 完全保持先验。 */
    blend_prior: z.number().min(0).max(1),
  }).optional(),
  /** 联合 VoI 参数（来自场景；缺省时使用默认值并在输出中标记 legacy_default）。 */
  joint: z.object({
    /** 区域间信息相关程度：0 = 独立，1 = 完全相关。 */
    correlation: z.number().min(0).max(1),
    /** 覆盖重叠造成的冗余折扣强度：0 = 不折扣，1 = 完全折扣。 */
    redundancy_penalty: z.number().min(0).max(1),
    /** 单次决策最多顺序选择的动作数。 */
    max_sequence: z.number().int().positive().max(6).optional(),
  }).optional(),
  /** VoI 低于该值即停止调查、转人工。 */
  stop_threshold: z.number(),
  max_investigations: z.number().int().positive().max(6),
  /** 调查预算：动作数/总资源成本/总时间上限（可选）。 */
  budget: z.object({
    max_actions: z.number().int().positive().max(10),
    max_total_cost: z.number().positive(),
    max_total_time_minutes: z.number().positive(),
  }).optional(),
});
export type InvestigationPolicy = z.infer<typeof InvestigationPolicySchema>;

/** 控制台一键推演的数据（来自场景文件，禁止在代码里写死区域 ID 与人数序列）。 */
export const UiDemoSeriesSchema = z.object({
  region_id: z.string().min(1),
  confidence: z.number().min(0).max(1),
  /** region_id -> 按时间顺序的人数序列（合成数据）。 */
  series: z.record(z.array(z.number().nonnegative()).min(1)),
});

export const UiDemoSchema = z.object({
  normal: UiDemoSeriesSchema.optional(),
  surge: UiDemoSeriesSchema.extend({
    degraded: z.object({
      region_id: z.string().min(1),
      count: z.number().nonnegative(),
      confidence: z.number().min(0).max(1),
    }).optional(),
  }).optional(),
  reject: z.object({
    region_id: z.string().min(1),
    offline: z.object({
      count: z.number().nonnegative(),
      confidence: z.number().min(0).max(1),
      reason: z.string().min(1),
    }),
    /** region_id -> 合成人数（用于演示容量压力）。 */
    capacity_by_region: z.record(z.number().nonnegative()),
    capacity_confidence: z.number().min(0).max(1).default(0.95),
    incident: z.object({
      type: z.enum(INCIDENT_TYPE),
      description: z.string().min(1),
      severity: z.enum(['low', 'medium', 'high', 'critical']),
      exit_ids: z.array(z.string().min(1)).min(1),
      region_ids: z.array(z.string().min(1)).default([]),
      corridor_ids: z.array(z.string().min(1)).default([]),
    }),
  }).optional(),
});
export type UiDemo = z.infer<typeof UiDemoSchema>;

export const SafetyScenarioSchema = z.object({
  scenario_id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  notice: z.string().min(1),
  config: SafetyConfigSchema,
  regions: z.array(RegionSchema).min(1),
  corridors: z.array(CorridorSchema).min(1),
  exits: z.array(ExitSchema).min(1),
  demo_scenarios: z.array(DemoScenarioSchema).default([]),
  /** 控制台一键推演数据（可选；合成）。 */
  ui_demos: UiDemoSchema.optional(),
  /** 大屏地图层（可选，不参与任何安全判定）。 */
  map: ScenarioMapSchema.optional(),
  /** "写入模拟观测"按钮的基线（可选）。 */
  simulation_baseline: SimulationBaselineSchema.optional(),
  /** 场馆元信息、管理规则与无人机资源（可选）。 */
  venue: VenueSchema.optional(),
  /** 工作人员名册（可选；人员与位置为演示数据时必须标记来源）。 */
  staff: z.array(StaffMemberSchema).default([]),
  /** 主动调查（VoI）策略（可选）。 */
  investigation: InvestigationPolicySchema.optional(),
});
export type SafetyScenario = z.infer<typeof SafetyScenarioSchema>;
