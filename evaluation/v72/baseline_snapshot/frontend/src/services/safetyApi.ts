/**
 * SkyGuard 指挥大屏 API 客户端。
 *
 * 与游客/管理端共用同一后端，但使用独立 axios 实例：
 * 安全接口路径是 /safety/*，不属于 /admin/*，因此不能依赖 api.ts 里按前缀注入 JWT 的逻辑。
 */
import axios from 'axios';

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

client.interceptors.request.use(config => {
  const token = localStorage.getItem('admin_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export type SafetyStateName = 'NORMAL' | 'REROUTE' | 'DEGRADED' | 'REJECT';
export type RiskLevel = 'normal' | 'watch' | 'high' | 'critical' | 'unknown';

export interface SafetyStateReason {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface SafetyStateSnapshot {
  state: SafetyStateName;
  headline: string;
  reasons: SafetyStateReason[];
  publishable: boolean;
  validated_route_display_allowed: boolean;
  candidate_route_display_allowed: boolean;
  requires_operator_action: boolean;
  last_valid_observation_at: string | null;
  active_incident_ids: string[];
  decided_at: string;
}

export interface EvacuationStep {
  corridor_id: string;
  from_region_id: string;
  to_region_id: string;
  depart_minute: number;
  arrive_minute: number;
  persons: number;
}

export interface EvacuationRoute {
  route_id: string;
  from_region_id: string;
  exit_id: string;
  persons: number;
  depart_minute: number;
  arrive_minute: number;
  steps: EvacuationStep[];
}

export interface EvacuationPlan {
  plan_id: string;
  created_at: string;
  scenario_version: string;
  constraint_version: number;
  observation_version: number;
  horizon_minutes: number;
  status: 'feasible' | 'partial' | 'infeasible';
  routes: EvacuationRoute[];
  unresolved: Array<{ region_id: string; persons: number; reason: string }>;
  exit_totals: Array<{ exit_id: string; persons: number }>;
  corridor_totals: Array<{ corridor_id: string; persons: number }>;
  demand_by_region: Array<{ region_id: string; persons: number }>;
  total_persons: number;
  evacuated_persons: number;
  unresolved_persons: number;
  planner: { algorithm: string; model: string; notes: string[] };
}

export interface SafetyViolation {
  code: string;
  severity: 'hard' | 'soft';
  message: string;
  region_id?: string;
  corridor_id?: string;
  exit_id?: string;
}

export interface SafetyValidationResult {
  valid: boolean;
  checked_at: string;
  plan_id: string;
  violations: SafetyViolation[];
  checks_run: string[];
  versions: { scenario_version: string; constraint_version: number; observation_version: number };
}

export interface RegionRisk {
  regionId: string;
  level: RiskLevel;
  count: number | null;
  density: number | null;
  confidence: number | null;
  observedAt: string | null;
  ageSeconds: number | null;
  trusted: boolean;
  signals: Array<{ code: string; message: string }>;
  thresholdsSource: string;
}

export interface SafetyObservation {
  id: string;
  region_id: string;
  observed_at: string;
  estimated_count: number;
  estimated_density: number;
  confidence: number;
  source: 'simulation' | 'recorded_video' | 'live_video';
  provider: string;
  model_version: string;
  valid: boolean;
  invalid_reason?: string;
}

export interface SafetyCorridor {
  id: string;
  name: string;
  from_region_id: string;
  to_region_id: string;
  direction: string;
  base_status: string;
  effective_status: string;
  capacity_per_min: number | null;
  capacity_provenance: string;
  traversal_seconds: number;
  usable: boolean;
  status_reason: string;
  blocked_by_incident_id?: string;
}

export interface SafetyExit {
  id: string;
  name: string;
  region_id: string;
  base_status: string;
  effective_status: string;
  capacity_per_min: number | null;
  capacity_provenance: string;
  usable: boolean;
  status_reason: string;
  blocked_by_incident_id?: string;
}

export interface SafetyRegion {
  id: string;
  name: string;
  area_m2: number;
  area_provenance: string;
  geometry: { x: number; y: number; width: number; height: number };
  holding_capacity_persons: number;
  enabled: boolean;
  camera: { camera_id: string; calibration_status: string; calibration_version: string };
}

export interface SafetyIncident {
  id: string;
  type: string;
  description: string;
  status: 'reported' | 'confirmed' | 'resolved' | 'dismissed';
  severity: string;
  affected: { region_ids: string[]; corridor_ids: string[]; exit_ids: string[] };
  source: string;
  reported_by: string;
  reported_at: string;
  confirmed_at?: string;
  resolved_at?: string;
}

export interface AuditEntry {
  id: string;
  ts: string;
  actor: string;
  role: string;
  action: string;
  summary: string;
  result: 'success' | 'failure' | 'rejected';
  reason?: string;
}

export interface ProviderStatus {
  id: string;
  kind: 'simulation' | 'recorded_video' | 'ascend';
  source: string;
  available: boolean;
  verified_on_this_host: boolean;
  model_version: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  notes: string[];
}

export interface SafetyDemoSummary {
  id: string;
  label: string;
  description: string;
  expected_state: SafetyStateName;
}

export interface ScenarioLandmark {
  name: string;
  /** 归一化 0~1 坐标。 */
  x: number;
  y: number;
}

export interface ScenarioMap {
  caption?: string;
  backdrop?: string;
  backdrop_opacity?: number;
  landmarks: ScenarioLandmark[];
}

export interface SafetyScenarioSummary {
  scenario_id: string;
  name: string;
  version: string;
  description: string;
  notice: string;
  config: { horizon_minutes: number; max_observation_age_seconds: number; min_confidence: number };
  regions: SafetyRegion[];
  corridors: Array<{
    id: string;
    name: string;
    from_region_id: string;
    to_region_id: string;
    direction: string;
    capacity_per_min: number | null;
    traversal_seconds: number;
    status: string;
  }>;
  exits: Array<{ id: string; name: string; region_id: string; capacity_per_min: number | null; status: string }>;
  map?: ScenarioMap;
  simulation_baseline?: Record<string, { count: number; confidence: number }> | null;
  demo_scenarios: SafetyDemoSummary[];
}

export interface SafetyStatus {
  state: SafetyStateSnapshot;
  state_entered_at: string;
  versions: { scenario: string; constraint: number; observation: number };
  plan: EvacuationPlan | null;
  candidate_plan: EvacuationPlan | null;
  validation: SafetyValidationResult | null;
  last_valid_plan: { plan_id: string; created_at: string; state: SafetyStateName } | null;
  risks: RegionRisk[];
  risk_summary: { highest: RiskLevel; counts: Record<string, number> };
  incidents: SafetyIncident[];
  observations: SafetyObservation[];
  regions: SafetyRegion[];
  corridors: SafetyCorridor[];
  exits: SafetyExit[];
  scenario: { id: string; name: string; version: string; notice: string; horizon_minutes: number };
  inference_health: { healthy: boolean; reason?: string };
  last_valid_observation_at: string | null;
}

export interface DemoRunResult {
  demo_id: string;
  expected_state: SafetyStateName;
  actual_state: SafetyStateName;
  matched: boolean;
  steps: Array<{ index: number; action: string; result: string; detail?: Record<string, unknown> }>;
  status: SafetyStatus;
}

export interface V70MpcPreview {
  available: boolean;
  reason?: string;
  steps?: Array<{
    step: number;
    start_minute: number;
    control_end_minute: number;
    plan_summary: { routes: number; executed_routes: number; evacuated_persons: number; unresolved_persons: number };
    validation: { performed: boolean; valid: boolean | null; violation_codes: string[]; note: string };
  }>;
  projection?: {
    total_input_persons: number;
    completed_persons: number;
    unserved_persons: number;
    makespan_minute: number;
    total_queue_person_minutes: number;
    max_queue_persons: number;
    p95_wait_minutes: number;
    switch_events: number;
    switch_persons: number;
  };
  provenance: { algorithm: string; safety_boundary: string; data_source: string };
}

export const safetyApi = {
  status: () => client.get<SafetyStatus>('/safety/status').then(response => response.data),
  v70Mpc: () => client.get<V70MpcPreview>('/safety/v70/mpc-preview').then(response => response.data),
  scenario: () => client.get<SafetyScenarioSummary>('/safety/scenario').then(response => response.data),
  scenarios: () =>
    client.get<{ active: string; files: Array<Record<string, unknown>> }>('/safety/scenarios').then(response => response.data),
  audit: (limit = 50) =>
    client.get<{ entries: AuditEntry[] }>(`/safety/audit?limit=${limit}`).then(response => response.data.entries),
  providers: () =>
    client.get<{ providers: ProviderStatus[] }>('/safety/providers').then(response => response.data.providers),
  recompute: () => client.post('/safety/plan/recompute', {}).then(response => response.data),
  simulate: (observations: Record<string, { count: number; confidence: number }>) =>
    client.post('/safety/observations/simulate', { observations }).then(response => response.data),
  runDemo: (id: string) => client.post<DemoRunResult>(`/safety/demo/${id}/run`, {}).then(response => response.data),
  createIncident: (body: {
    type: string;
    description: string;
    severity: string;
    affected: { region_ids?: string[]; corridor_ids?: string[]; exit_ids?: string[] };
    confirm_immediately?: boolean;
    source?: string;
  }) => client.post('/safety/incidents', body).then(response => response.data),
  confirmIncident: (id: string) => client.post(`/safety/incidents/${id}/confirm`, {}).then(response => response.data),
  resolveIncident: (id: string) =>
    client.post(`/safety/incidents/${id}/resolve`, { note: '大屏操作解除' }).then(response => response.data),
  parseIncident: (text: string) =>
    client.post('/safety/incidents/parse', { text }).then(response => response.data.draft),
};

export default safetyApi;
