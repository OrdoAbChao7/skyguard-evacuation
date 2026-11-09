import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MvpPanels from '../MvpPanels';

const mocks = vi.hoisted(() => ({
  dashboard: vi.fn(),
  runAgent: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  assign: vi.fn(),
  accept: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  staffLogin: vi.fn(),
  experiments: vi.fn(),
  multiRegion: vi.fn(),
  reset: vi.fn(),
  runDemo: vi.fn(),
  v70Forecast: vi.fn(),
  v70Joint: vi.fn(),
  v70Mpc: vi.fn(),
}));

vi.mock('../../../services/mvpApi', () => ({ default: mocks }));
vi.mock('../../../services/safetyApi', () => ({ default: { v70Mpc: mocks.v70Mpc }, safetyApi: { v70Mpc: mocks.v70Mpc } }));

const dashboard = {
  scenario: {
    id: 'stadium-evacuation-v1',
    name: '滨江体育中心 · 活动散场（合成场景）',
    version: '1.0.0',
    notice: '合成演示场景，不得用于真实疏散指挥。',
    venue: { name: '滨江体育中心（合成）', kind: 'stadium' },
    horizon_minutes: 10,
    regions: 1,
    exits: 1,
  },
  safety: {
    state: { state: 'NORMAL', headline: '常态运行' },
    regions: [{ id: 'R_EAST_STAND', name: '东看台' }],
  },
  cameras: [{
    region_id: 'R_EAST_STAND',
    region_name: '东看台',
    camera_id: 'CAM-E-STAND',
    state: 'degraded',
    declared_status: 'degraded',
    calibration_status: 'uncalibrated',
    last_observation_at: null,
    age_seconds: 12,
    confidence: 0.62,
    sources: ['simulation'],
    reason: '设备清单声明摄像头降级',
  }],
  predictions: [{
    region_id: 'R_EAST_STAND',
    region_name: '东看台',
    generated_at: new Date().toISOString(),
    algorithm: 'ema-linear-v1',
    algorithm_version: '1.0.0',
    horizon_minutes: 5,
    window_minutes: 5,
    input: { points: 6, span_seconds: 300, sources: ['simulation'], excluded_low_confidence: 0, excluded_invalid: 0 },
    sufficient: true,
    current_count: 420,
    predicted_count: 529,
    interval: { lower: 516, upper: 542 },
    trend: { direction: 'rising', rate_per_minute: 25 },
    data_quality: { stale: false, low_confidence: false, missing: false, note: '数据质量正常' },
    uncertainty_note: '合成数据',
  }],
  staff: [{
    id: 'STF-02', name: '李巡（演示）', role: 'security', region_id: 'R_EAST_STAND',
    status: 'available', skills: ['crowd_check'], source: 'simulation', verified: false, runtime_status: 'available',
  }],
  work_orders: [{
    id: 'WO-TEST', type: 'scene_verification', title: '东看台现场核查', description: '核查人流',
    priority: 'high', region_id: 'R_EAST_STAND', status: 'PENDING_APPROVAL',
    created_by: { username: 'skyguard-agent', role: 'agent', kind: 'agent' },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    approval: null, assigned_staff_id: null, feedback: null, history: [],
  }],
  agent_runs: [],
  agentarts: { mode: 'LOCAL_DEMO', configured: false, missing_config: [], detail: '本地演示', checked_at: null },
  replay: { loaded: false, dataset_name: null, total_rows: 0, cursor: 0, completed: false },
  audit: [],
  generated_at: new Date().toISOString(),
};

const run = {
  run_id: 'RUN-TEST',
  mode: 'LOCAL_DEMO',
  runtime_detail: '本地',
  scenario_id: 'stadium-evacuation-v1',
  trigger: 'console_manual',
  region_id: 'R_EAST_STAND',
  status: 'awaiting_evidence',
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  state: { state: 'DEGRADED', headline: '感知降级' },
  belief_before: [{ hypothesis_id: 'H_STABLE', label: '平稳', probability: 0.45 }],
  belief_after: [{ hypothesis_id: 'H_SURGE', label: '快速积聚', probability: 0.6 }],
  entropy_before_bits: 1.5,
  entropy_after_bits: 1.1,
  risk_before: 0.1,
  risk_after: 0.08,
  investigation: {
    required: true,
    reason: '观测不可信',
    rounds: [{
      round: 1,
      selected_action_id: 'A_STAFF',
      selected_kind: 'staff_check',
      outcome: 'inconclusive',
      pending: true,
      note: '等待现场反馈',
      decision: {
        evaluations: [{
          action_id: 'A_STAFF', label: '请求现场工作人员核查', available: true,
          unavailable_reason: null, score: 0.21, information_gain_bits: 0.67,
          risk_reduction: 0.05, time_cost_normalized: 0.3, resource_cost_normalized: 0.35,
        }],
      },
    }],
    pending_work_order_ids: ['WO-TEST'],
    stopped_reason: 'awaiting_human_evidence',
  },
  prediction: null,
  camera: null,
  staff_recommendation: null,
  work_orders: [{ id: 'WO-TEST', type: 'scene_verification', status: 'PENDING_APPROVAL', title: '东看台现场核查' }],
  recommendations: ['创建了现场核查工单，等待审批。'],
  trace: [{ seq: 1, tool: 'get_crowd_status', ok: true, result_summary: 'regions=1', source: 'safety', confidence: null, duration_ms: 2 }],
  summary: '检测到信息缺口，已创建待审批工单。',
  limitations: ['本地演示'],
};

describe('MVP 指挥面板', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => (mock as ReturnType<typeof vi.fn>).mockReset());
    mocks.dashboard.mockResolvedValue(dashboard);
    mocks.runAgent.mockResolvedValue(run);
    mocks.experiments.mockResolvedValue({
      available: false, generated_at: null, experiments: {}, report_path: 'evaluation/COMPETITION_REPORT.md', note: '合成数据',
    });
    mocks.multiRegion.mockResolvedValue({ available: false, reason: '测试未配置' });
    mocks.v70Forecast.mockResolvedValue({
      available: true, region_id: 'R_EAST_STAND', horizon_minutes: 5,
      result: {
        predicted: 530, interval90: { lower: 500, upper: 560 }, interval95: { lower: 480, upper: 580 },
        reliability: { status: 'ok', reasons: [] }, regime: { label: 'surge' }, effective_methods: ['kalman', 'persistence'],
      },
      provenance: { algorithm: 'ensemble_v70', data_source: 'observations', note: '合成' },
    });
    mocks.v70Joint.mockResolvedValue({
      available: true, target_region_id: 'R_EAST_STAND',
      decision: {
        selected: [{ action_id: 'A_CAMERA', kind: 'camera_query', marginal_risk_reduction: 0.02 }],
        total_expected_risk_reduction: 0.02, stop_reason: 'max_investigations_reached',
        config: { correlation: 0.5, redundancy_penalty: 0.6, max_sequence: 3, source: 'scenario' },
      },
      provenance: { engine: 'joint-voi-v1', note: '合成' },
    });
    mocks.v70Mpc.mockResolvedValue({
      available: true,
      steps: [{
        step: 0, start_minute: 0, control_end_minute: 2,
        plan_summary: { routes: 2, executed_routes: 1, evacuated_persons: 100, unresolved_persons: 0 },
        validation: { performed: true, valid: true, violation_codes: [], note: '第一步校验' },
      }],
      projection: {
        total_input_persons: 300, completed_persons: 300, unserved_persons: 0, makespan_minute: 8,
        total_queue_person_minutes: 120, max_queue_persons: 20, p95_wait_minutes: 1, switch_events: 0, switch_persons: 0,
      },
      provenance: { algorithm: 'mpc', safety_boundary: '只读', data_source: '观测' },
    });
    localStorage.clear();
  });

  it('展示后端态势、预测、摄像头与待审批工单，并标记 LOCAL DEMO', async () => {
    render(<MvpPanels selectedRegion="R_EAST_STAND" onSelectRegion={() => {}} />);
    await waitFor(() => expect(screen.getByText('LOCAL DEMO')).toBeInTheDocument());
    expect(screen.getByText('短时人流预测')).toBeInTheDocument();
    expect(screen.getAllByText('东看台').length).toBeGreaterThan(0);
    expect(screen.getByText(/420 → 529/)).toBeInTheDocument();
    expect(screen.getAllByText('待审批').length).toBeGreaterThan(0);
    expect(screen.getByText('东看台现场核查')).toBeInTheDocument();
  });

  it('运行 Agent 后展示调查轮次、VoI 评分与工具 Trace', async () => {
    render(<MvpPanels selectedRegion="R_EAST_STAND" onSelectRegion={() => {}} />);
    await waitFor(() => expect(screen.getByText('LOCAL DEMO')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '运行 Agent' }));
    await waitFor(() => expect(mocks.runAgent).toHaveBeenCalledWith('R_EAST_STAND', 'console_manual'));
    expect(await screen.findByText(/检测到信息缺口/)).toBeInTheDocument();
    expect(screen.getByText('请求现场工作人员核查')).toBeInTheDocument();
    expect(screen.getByText('get_crowd_status')).toBeInTheDocument();
  });

  it('平台可达性与业务闭环分开显示', async () => {
    mocks.dashboard.mockResolvedValue({
      ...dashboard,
      agentarts: {
        mode: 'AGENTARTS_CONNECTED',
        configured: true,
        missing_config: [],
        detail: '健康探测成功：平台网络可达（仅代表连通）',
        checked_at: new Date().toISOString(),
        runtime_requested: 'agentarts',
        connectivity: 'reachable',
        business_closure: {
          verified: false,
          verified_at: null,
          app_version: null,
          note: '业务闭环未验证',
        },
      },
    });
    render(<MvpPanels selectedRegion="R_EAST_STAND" onSelectRegion={() => {}} />);
    await waitFor(() => expect(screen.getByText('AGENTARTS CONNECTED')).toBeInTheDocument());
    expect(screen.getByText('可达性 可达 · 业务闭环 未验证')).toBeInTheDocument();
  });
});


describe('V7 研究预览', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => (mock as ReturnType<typeof vi.fn>).mockReset());
    mocks.dashboard.mockResolvedValue(dashboard);
    mocks.multiRegion.mockResolvedValue({ available: false, reason: '测试未配置' });
    mocks.experiments.mockResolvedValue({ available: false, generated_at: null, experiments: {}, report_path: 'x', note: '合成' });
    mocks.v70Forecast.mockResolvedValue({
      available: true, region_id: 'R_EAST_STAND', horizon_minutes: 5,
      result: {
        predicted: 530, interval90: { lower: 500, upper: 560 }, interval95: { lower: 480, upper: 580 },
        reliability: { status: 'ok', reasons: [] }, regime: { label: 'surge' }, effective_methods: ['kalman', 'persistence'],
      },
      provenance: { algorithm: 'ensemble_v70', data_source: 'observations', note: '合成' },
    });
    mocks.v70Joint.mockResolvedValue({
      available: true, target_region_id: 'R_EAST_STAND',
      decision: {
        selected: [{ action_id: 'A_CAMERA', kind: 'camera_query', marginal_risk_reduction: 0.02 }],
        total_expected_risk_reduction: 0.02, stop_reason: 'max_investigations_reached',
        config: { correlation: 0.5, redundancy_penalty: 0.6, max_sequence: 3, source: 'scenario' },
      },
      provenance: { engine: 'joint-voi-v1', note: '合成' },
    });
    mocks.v70Mpc.mockResolvedValue({
      available: true,
      steps: [{
        step: 0, start_minute: 0, control_end_minute: 2,
        plan_summary: { routes: 2, executed_routes: 1, evacuated_persons: 100, unresolved_persons: 0 },
        validation: { performed: true, valid: true, violation_codes: [], note: '第一步校验' },
      }],
      projection: {
        total_input_persons: 300, completed_persons: 300, unserved_persons: 0, makespan_minute: 8,
        total_queue_person_minutes: 120, max_queue_persons: 20, p95_wait_minutes: 1, switch_events: 0, switch_persons: 0,
      },
      provenance: { algorithm: 'mpc', safety_boundary: '只读', data_source: '观测' },
    });
    localStorage.clear();
  });

  it('按钮触发后展示预测、联合 VoI 与 MPC 投影，并标注只读边界', async () => {
    render(<MvpPanels selectedRegion="R_EAST_STAND" onSelectRegion={() => {}} />);
    await waitFor(() => expect(mocks.dashboard).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: '运行 V7 预览' }));
    await waitFor(() => expect(screen.getByText('集成预测')).toBeInTheDocument());
    expect(screen.getByText('联合 VoI')).toBeInTheDocument();
    expect(screen.getByText('MPC 投影')).toBeInTheDocument();
    expect(screen.getByText(/surge/)).toBeInTheDocument();
    expect(screen.getByText(/A_CAMERA/)).toBeInTheDocument();
    expect(screen.getByText(/300\/300/)).toBeInTheDocument();
    expect(screen.getByText(/条件投影/)).toBeInTheDocument();
  });
});
