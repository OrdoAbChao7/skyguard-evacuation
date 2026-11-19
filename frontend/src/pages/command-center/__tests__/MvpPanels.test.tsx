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
  droneBridgeStatus: vi.fn(),
  droneDispatch: vi.fn(),
  runCrowdFlowSimulation: vi.fn(),
}));

vi.mock('../../../services/mvpApi', () => ({ default: mocks }));
vi.mock('../../../services/safetyApi', () => ({ default: { v70Mpc: mocks.v70Mpc }, safetyApi: { v70Mpc: mocks.v70Mpc } }));

const dashboard = {
  scenario: {
    id: 'hankou-mvp-v1',
    name: '武汉汉口江滩 · 人群疏散（合成场景）',
    version: '1.0.0',
    notice: '合成演示场景，不得用于真实疏散指挥。',
    venue: { name: '武汉汉口江滩（合成）', kind: 'urban_riverfront_park' },
    horizon_minutes: 10,
    regions: 1,
    exits: 1,
  },
  safety: {
    state: { state: 'NORMAL', headline: '常态运行' },
    regions: [{ id: 'R_S04_L1_CREST', name: '洞庭门滩顶' }],
  },
  cameras: [{
    region_id: 'R_S04_L1_CREST',
    region_name: '洞庭门滩顶',
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
    region_id: 'R_S04_L1_CREST',
    region_name: '洞庭门滩顶',
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
    id: 'STAFF_GATE_02', name: '李巡（演示）', role: 'security', region_id: 'R_S04_L1_CREST',
    status: 'available', skills: ['crowd_check'], source: 'simulation', verified: false, runtime_status: 'available',
  }],
  work_orders: [{
    id: 'WO-TEST', type: 'scene_verification', title: '洞庭门滩顶现场核查', description: '核查人流',
    priority: 'high', region_id: 'R_S04_L1_CREST', status: 'PENDING_APPROVAL',
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

const droneBridgeStatus = {
  mode: 'outbox',
  configured: true,
  transport: 'outbox',
  simulated: true,
  verified_on_this_host: false,
  real_hardware_verified: false,
  transport_verified: false,
  endpoint: null,
  ttl_minutes: 15,
  pending_dispatches: 0,
  active_units: 0,
  uav_units: [{
    id: 'UAV_HANKOU_01',
    name: '江汉关—粤汉码头段空中巡逻无人机',
    status: 'available',
    source: 'synthetic_uav_fleet',
    verified: false,
    active: false,
  }],
  last_dispatch: null,
  errors: [],
  notes: ['默认 outbox 模式只生成派发包'],
};

const crowdFlowResult = {
  run_id: 'SIM-TEST',
  summary: {
    algorithm: 'crowd-flow-v1',
    scenario_id: 'hankou-mvp-v1',
    scenario_version: '7.6.0',
    preset: 'normal' as const,
    seed: 42,
    minutes: 10,
    step_seconds: 60,
    initial_total: 18000,
    arrivals_total: 0,
    evacuated: 14371,
    remaining_inside: 3032,
    in_transit: 597,
    stranded: 0,
    conservation_ok: true,
    peak_density: {
      region_id: 'R_GATE_04_PLAZA',
      region_name: '洞庭门集散门区',
      density: 0.13,
      count: 596,
      at: new Date().toISOString(),
    },
    peak_region_count: {
      region_id: 'R_S01_L1_CREST',
      region_name: '江汉门滩顶主平台',
      count: 1800,
      at: new Date().toISOString(),
    },
    peak_in_transit: 5974,
    congested_samples: 5,
    exit_totals: { GATE_01_G01: 2000 },
    unresolved_regions: [],
    events: [],
    assumptions: ['合成数据'],
  },
  timeline: [{
    minute: 1,
    at: new Date().toISOString(),
    totals: { inside: 12026, in_transit: 5974, evacuated: 0, stranded: 0, arrivals: 0 },
    events: [],
  }],
  latest_regions: [],
  observations_ingested: 440,
  state: 'NORMAL',
  plan_id: 'PLAN-TEST',
  validation_valid: true,
};

const run = {
  run_id: 'RUN-TEST',
  mode: 'LOCAL_DEMO',
  runtime_detail: '本地',
  scenario_id: 'hankou-mvp-v1',
  trigger: 'console_manual',
  region_id: 'R_S04_L1_CREST',
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
  work_orders: [{ id: 'WO-TEST', type: 'scene_verification', status: 'PENDING_APPROVAL', title: '洞庭门滩顶现场核查' }],
  recommendations: ['创建了现场核查工单，等待审批。'],
  trace: [{ seq: 1, tool: 'get_crowd_status', ok: true, result_summary: 'regions=1', source: 'safety', confidence: null, duration_ms: 2 }],
  summary: '检测到信息缺口，已创建待审批工单。',
  limitations: ['本地演示'],
};

describe('MVP 指挥面板', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => (mock as ReturnType<typeof vi.fn>).mockReset());
    mocks.dashboard.mockResolvedValue(dashboard);
    mocks.droneBridgeStatus.mockResolvedValue(droneBridgeStatus);
    mocks.runAgent.mockResolvedValue(run);
    mocks.experiments.mockResolvedValue({
      available: false, generated_at: null, experiments: {}, report_path: 'evaluation/COMPETITION_REPORT.md', note: '合成数据',
    });
    mocks.multiRegion.mockResolvedValue({ available: false, reason: '测试未配置' });
    mocks.v70Forecast.mockResolvedValue({
      available: true, region_id: 'R_S04_L1_CREST', horizon_minutes: 5,
      result: {
        predicted: 530, interval90: { lower: 500, upper: 560 }, interval95: { lower: 480, upper: 580 },
        reliability: { status: 'ok', reasons: [] }, regime: { label: 'surge' }, effective_methods: ['kalman', 'persistence'],
      },
      provenance: { algorithm: 'ensemble_v70', data_source: 'observations', note: '合成' },
    });
    mocks.v70Joint.mockResolvedValue({
      available: true, target_region_id: 'R_S04_L1_CREST',
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
    render(<MvpPanels selectedRegion="R_S04_L1_CREST" onSelectRegion={() => {}} />);
    await waitFor(() => expect(screen.getByText('LOCAL DEMO')).toBeInTheDocument());
    expect(screen.getByText('短时人流预测')).toBeInTheDocument();
    expect(screen.getAllByText('洞庭门滩顶').length).toBeGreaterThan(0);
    expect(screen.getByText(/420 → 529/)).toBeInTheDocument();
    expect(screen.getAllByText('待审批').length).toBeGreaterThan(0);
    expect(screen.getByText('洞庭门滩顶现场核查')).toBeInTheDocument();
  });

  it('展示无人机桥接状态并明确标注模拟与未实机验证', async () => {
    render(<MvpPanels selectedRegion="R_S04_L1_CREST" onSelectRegion={() => {}} />);
    await waitFor(() => expect(screen.getByText(/无人机桥接 · 出站队列/)).toBeInTheDocument());
    expect(screen.getByText(/模拟任务，不控制真机/)).toBeInTheDocument();
    expect(screen.getByText(/未实机验证/)).toBeInTheDocument();
  });

  it('仅对已指派的无人机工单显示派发按钮，并由管理员调用桥接 API', async () => {
    localStorage.setItem('admin_token', 'test-admin-token');
    mocks.dashboard.mockResolvedValue({
      ...dashboard,
      work_orders: [{
        ...dashboard.work_orders[0],
        id: 'WO-UAV-1',
        type: 'uav_observation',
        title: '无人机空中观测',
        status: 'ASSIGNED',
        assigned_staff_id: 'STAFF_GATE_08',
      }],
    });
    mocks.droneDispatch.mockResolvedValue({
      dispatch: {
        dispatch_id: 'DSP-TEST',
        work_order_id: 'WO-UAV-1',
        status: 'QUEUED',
        effective_status: 'QUEUED',
        transport: 'outbox',
        simulated: true,
        delivered: false,
        created_at: new Date().toISOString(),
        expires_at: new Date().toISOString(),
        created_by: { username: 'admin', role: 'admin' },
        uav_unit: { id: 'UAV_HANKOU_01', name: '江汉关—粤汉码头段空中巡逻无人机', verified: false },
        assigned_operator: { staff_id: 'STAFF_GATE_08', name: '演示人员' },
        external_id: null,
        error: null,
      },
      duplicate: false,
      effective_status: 'QUEUED',
    });
    render(<MvpPanels selectedRegion="R_S04_L1_CREST" onSelectRegion={() => {}} />);
    const button = await screen.findByRole('button', { name: '无人机派发' });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(mocks.droneDispatch).toHaveBeenCalledWith('WO-UAV-1');
  });

  it('管理员可运行算法人群仿真并展示守恒与疏散结果', async () => {
    localStorage.setItem('admin_token', 'test-admin-token');
    mocks.runCrowdFlowSimulation.mockResolvedValue(crowdFlowResult);
    render(<MvpPanels selectedRegion="R_S04_L1_CREST" onSelectRegion={() => {}} />);
    const button = await screen.findByRole('button', { name: '运行 10 分钟仿真' });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(mocks.runCrowdFlowSimulation).toHaveBeenCalledWith({ preset: 'normal', minutes: 10, seed: 42 });
    expect(await screen.findByText(/SIM-TEST/)).toBeInTheDocument();
    expect(screen.getByText('人数守恒')).toBeInTheDocument();
    expect(screen.getByText('14371')).toBeInTheDocument();
    expect(screen.getByText(/合成数据，不是实测/)).toBeInTheDocument();
  });

  it('未从地图点选区域时默认使用首个预测区域，运行 Agent 仍可用', async () => {
    render(<MvpPanels selectedRegion={null} onSelectRegion={() => {}} />);
    await waitFor(() => expect(screen.getByText('LOCAL DEMO')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: '运行 Agent' })).toBeEnabled());
  });

  it('运行 Agent 后展示调查轮次、VoI 评分与工具 Trace', async () => {
    render(<MvpPanels selectedRegion="R_S04_L1_CREST" onSelectRegion={() => {}} />);
    await waitFor(() => expect(screen.getByText('LOCAL DEMO')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '运行 Agent' }));
    await waitFor(() => expect(mocks.runAgent).toHaveBeenCalledWith('R_S04_L1_CREST', 'console_manual'));
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
    render(<MvpPanels selectedRegion="R_S04_L1_CREST" onSelectRegion={() => {}} />);
    await waitFor(() => expect(screen.getByText('AGENTARTS CONNECTED')).toBeInTheDocument());
    expect(screen.getByText('可达性 可达 · 业务闭环 未验证')).toBeInTheDocument();
  });
});


describe('V7 研究预览', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => (mock as ReturnType<typeof vi.fn>).mockReset());
    mocks.dashboard.mockResolvedValue(dashboard);
    mocks.droneBridgeStatus.mockResolvedValue(droneBridgeStatus);
    mocks.multiRegion.mockResolvedValue({ available: false, reason: '测试未配置' });
    mocks.experiments.mockResolvedValue({ available: false, generated_at: null, experiments: {}, report_path: 'x', note: '合成' });
    mocks.v70Forecast.mockResolvedValue({
      available: true, region_id: 'R_S04_L1_CREST', horizon_minutes: 5,
      result: {
        predicted: 530, interval90: { lower: 500, upper: 560 }, interval95: { lower: 480, upper: 580 },
        reliability: { status: 'ok', reasons: [] }, regime: { label: 'surge' }, effective_methods: ['kalman', 'persistence'],
      },
      provenance: { algorithm: 'ensemble_v70', data_source: 'observations', note: '合成' },
    });
    mocks.v70Joint.mockResolvedValue({
      available: true, target_region_id: 'R_S04_L1_CREST',
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
    render(<MvpPanels selectedRegion="R_S04_L1_CREST" onSelectRegion={() => {}} />);
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
