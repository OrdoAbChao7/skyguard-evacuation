/**
 * MVP 前端 API 客户端。
 *
 * 读接口免登录；审批/派发使用管理员 JWT（admin_token）；
 * 接单/执行/反馈使用工作人员 JWT（staff_token）。
 */
import axios from 'axios';
import type { SafetyStatus } from './safetyApi';

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

function adminHeaders(): Record<string, string> {
  const token = localStorage.getItem('admin_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function staffHeaders(): Record<string, string> {
  const token = localStorage.getItem('staff_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface CameraHealth {
  region_id: string;
  region_name: string;
  camera_id: string;
  state: 'online' | 'degraded' | 'offline' | 'unknown';
  declared_status: string | null;
  calibration_status: string;
  last_observation_at: string | null;
  age_seconds: number | null;
  data_delay_seconds: number | null;
  frame_drop_suspected: boolean;
  confidence: number | null;
  sources: string[];
  reason: string;
}

export interface PredictionResult {
  region_id: string;
  region_name: string;
  generated_at: string;
  algorithm: string;
  algorithm_version: string;
  horizon_minutes: number;
  window_minutes: number;
  input: {
    points: number;
    span_seconds: number;
    sources: string[];
    excluded_low_confidence: number;
    excluded_invalid: number;
  };
  sufficient: boolean;
  current_count: number | null;
  predicted_count: number | null;
  interval: { lower: number; upper: number } | null;
  trend: { direction: 'rising' | 'falling' | 'stable' | 'unknown'; rate_per_minute: number | null };
  data_quality: { stale: boolean; low_confidence: boolean; missing: boolean; note: string };
  reliability?: {
    status: 'ok' | 'warning' | 'failed';
    reasons: string[];
    relative_interval_width: number | null;
    max_relative_interval_width: number;
  };
  uncertainty_note: string;
}

export interface StaffMember {
  id: string;
  name: string;
  role: string;
  region_id: string;
  status: string;
  skills: string[];
  source: string;
  verified: boolean;
  runtime_status: string;
}

export type WorkOrderStatus =
  | 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'ASSIGNED'
  | 'ACCEPTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface WorkOrder {
  id: string;
  type: string;
  title: string;
  description: string;
  priority: string;
  region_id?: string;
  status: WorkOrderStatus;
  created_by: { username: string; role: string; kind: string };
  created_at: string;
  updated_at: string;
  approval: { decision: string; by: string; at: string; note?: string } | null;
  assigned_staff_id: string | null;
  feedback: { staff_id: string; note: string; at: string; observation?: { count: number; confidence: number } } | null;
  context_version: { observation: number; constraint: number; scenario: string };
  stale: boolean;
  stale_reason: string | null;
  history: Array<{ ts: string; status: WorkOrderStatus; actor: string; role: string; note?: string }>;
}

export interface AgentRun {
  run_id: string;
  mode: 'LOCAL_DEMO' | 'AGENTARTS_CONNECTED' | 'AGENTARTS_UNAVAILABLE';
  runtime_detail: string;
  scenario_id: string;
  trigger: string;
  region_id: string;
  status: string;
  started_at: string;
  completed_at: string;
  state: { state: string; headline: string };
  belief_before: Array<{ hypothesis_id: string; label: string; probability: number }>;
  belief_after: Array<{ hypothesis_id: string; label: string; probability: number }>;
  entropy_before_bits: number | null;
  entropy_after_bits: number | null;
  risk_before: number | null;
  risk_after: number | null;
  investigation: {
    required: boolean;
    reason: string;
    rounds: Array<{
      round: number;
      selected_action_id: string | null;
      selected_kind: string | null;
      outcome: string | null;
      pending: boolean;
      note: string;
      decision: {
        evaluations: Array<{
          action_id: string;
          label: string;
          available: boolean;
          unavailable_reason: string | null;
          score: number | null;
          information_gain_bits: number;
          risk_reduction: number;
          time_cost_normalized: number;
          resource_cost_normalized: number;
        }>;
      };
    }>;
    pending_work_order_ids: string[];
    stopped_reason: string | null;
  };
  prediction: PredictionResult | null;
  camera: CameraHealth | null;
  staff_recommendation: unknown;
  work_orders: Array<{ id: string; type: string; status: string; title: string }>;
  recommendations: string[];
  trace: Array<{
    seq: number;
    tool: string;
    ok: boolean;
    result_summary: string;
    source: string;
    confidence: number | null;
    duration_ms: number;
  }>;
  summary: string;
  limitations: string[];
}

export interface AgentArtsStatus {
  mode: 'LOCAL_DEMO' | 'AGENTARTS_CONNECTED' | 'AGENTARTS_UNAVAILABLE';
  configured: boolean;
  missing_config: string[];
  detail: string;
  checked_at: string | null;
  /** 以下字段用于区分"平台可达"与"业务闭环已验证"。旧后端可能不返回。 */
  runtime_requested?: 'local' | 'agentarts';
  connectivity?: 'not_requested' | 'misconfigured' | 'unreachable' | 'reachable';
  business_closure?: {
    verified: boolean;
    verified_at: string | null;
    app_version: string | null;
    note: string;
  };
  last_successful_call_at?: string | null;
  last_tool_call_at?: string | null;
}

export interface MvpDashboard {
  scenario: {
    id: string;
    name: string;
    version: string;
    notice: string;
    venue: { name: string; kind: string; rules?: Array<{ id: string; title: string; text: string }> } | null;
    horizon_minutes: number;
    regions: number;
    exits: number;
  };
  safety: SafetyStatus;
  cameras: CameraHealth[];
  predictions: PredictionResult[];
  staff: StaffMember[];
  work_orders: WorkOrder[];
  agent_runs: AgentRun[];
  agentarts: AgentArtsStatus;
  state_store?: { enabled: boolean; writable: boolean; revision: number; path: string | null };
  replay: { loaded: boolean; dataset_name: string | null; total_rows: number; cursor: number; completed: boolean };
  audit: Array<{
    id: string;
    ts: string;
    actor: string;
    role: string;
    action: string;
    summary: string;
    result: string;
  }>;
  generated_at: string;
}

export interface MultiRegionAnalysis {
  available: boolean;
  reason?: string;
  target_region_id?: string;
  propagated_risks?: Array<{ regionId: string; localRisk: number; inboundInfluence: number; propagatedRisk: number }>;
  priorities?: Array<{ regionId: string; propagatedRisk: number; uncertainty: number; centrality: number; priority: number; reason: string }>;
  decision?: {
    recommended_action_id: string | null;
    recommended_covered_regions: string[];
    covered_region_count: number;
    ranked_action_ids: string[];
    stop_reason: string | null;
    evaluations: Array<{
      action_id: string;
      label: string;
      available: boolean;
      unavailable_reason: string | null;
      covered_regions: Array<{ region_id: string; weight: number; risk_reduction: number; information_gain_bits: number }>;
      weighted_risk_reduction: number;
      weighted_information_gain_bits: number;
      score: number | null;
    }>;
  };
  note?: string;
}

export const mvpApi = {
  dashboard: () => client.get<MvpDashboard>('/mvp/dashboard').then(response => response.data),
  scenario: () => client.get('/mvp/scenario').then(response => response.data),
  cameras: (regionId?: string) =>
    client.get<{ cameras: CameraHealth[] }>('/mvp/cameras', { params: regionId ? { region_id: regionId } : {} })
      .then(response => response.data.cameras),
  prediction: (regionId: string, horizonMinutes = 5) =>
    client.get<PredictionResult>(`/mvp/predictions/${regionId}`, { params: { horizon_minutes: horizonMinutes } })
      .then(response => response.data),
  agentRuntime: (probe = false) =>
    client.get<AgentArtsStatus>('/mvp/agent/runtime', { params: probe ? { probe: 1 } : {} }).then(response => response.data),
  runAgent: (regionId: string, trigger = 'manual') =>
    client.post<AgentRun>('/mvp/agent/runs', { region_id: regionId, trigger }, { headers: adminHeaders() })
      .then(response => response.data),
  runs: (limit = 10) =>
    client.get<{ runs: AgentRun[] }>('/mvp/agent/runs', { params: { limit } }).then(response => response.data.runs),
  workOrders: (status?: string) =>
    client.get<{ work_orders: WorkOrder[] }>('/mvp/work-orders', { params: status ? { status } : {} })
      .then(response => response.data.work_orders),
  staff: () => client.get<{ staff: StaffMember[] }>('/mvp/staff').then(response => response.data.staff),
  approve: (id: string, note: string) =>
    client.post(`/mvp/work-orders/${id}/approve`, { note }, { headers: adminHeaders() }).then(response => response.data.work_order as WorkOrder),
  reject: (id: string, note: string) =>
    client.post(`/mvp/work-orders/${id}/reject`, { note }, { headers: adminHeaders() }).then(response => response.data.work_order as WorkOrder),
  revalidate: (id: string, note?: string) =>
    client.post(`/mvp/work-orders/${id}/revalidate`, note ? { note } : {}, { headers: adminHeaders() })
      .then(response => response.data.work_order as WorkOrder),
  assign: (id: string, staffId?: string) =>
    client.post(`/mvp/work-orders/${id}/assign`, staffId ? { staff_id: staffId } : {}, { headers: adminHeaders() })
      .then(response => response.data.work_order as WorkOrder),
  accept: (id: string) =>
    client.post(`/mvp/work-orders/${id}/accept`, {}, { headers: staffHeaders() }).then(response => response.data.work_order as WorkOrder),
  start: (id: string) =>
    client.post(`/mvp/work-orders/${id}/start`, {}, { headers: staffHeaders() }).then(response => response.data.work_order as WorkOrder),
  complete: (id: string, body: { note: string; observation?: { count: number; confidence: number; valid?: boolean } }) =>
    client.post(`/mvp/work-orders/${id}/complete`, body, { headers: staffHeaders() })
      .then(response => response.data.work_order as WorkOrder),
  fail: (id: string, reason: string) =>
    client.post(`/mvp/work-orders/${id}/fail`, { reason }, { headers: staffHeaders() })
      .then(response => response.data.work_order as WorkOrder),
  staffLogin: (staffId: string, accessCode: string) =>
    client.post<{ access_token: string; staff_id: string; username: string }>('/mvp/auth/staff-login', {
      staff_id: staffId,
      access_code: accessCode,
    }).then(response => response.data),
  reset: () => client.post('/mvp/reset', {}, { headers: adminHeaders() }).then(response => response.data),
  runDemo: (scenario: 'A_normal' | 'B_surge' | 'C_untrusted') =>
    client.post('/mvp/demo/run', { scenario }, { headers: adminHeaders() })
      .then(response => response.data as { scenario: string; state: { state: string }; run: AgentRun; dashboard: MvpDashboard }),
  multiRegion: (regionId?: string) =>
    client.get<MultiRegionAnalysis>('/mvp/multi-region', { params: regionId ? { region_id: regionId } : {} })
      .then(response => response.data),
  experiments: () =>
    client.get('/mvp/experiments').then(response => response.data as {
      available: boolean;
      generated_at: string | null;
      experiments: Record<string, unknown>;
      report_path: string;
      note: string;
    }),
  replayStep: (count: number) =>
    client.post('/mvp/replay/step', { count }, { headers: adminHeaders() }).then(response => response.data),
  toolCatalog: () => client.get<{ tools: Array<{ name: string; title: string; description: string }> }>('/mvp/tools')
    .then(response => response.data.tools),
};

export default mvpApi;
