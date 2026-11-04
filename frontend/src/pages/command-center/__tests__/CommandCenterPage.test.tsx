import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommandCenterPage from '../CommandCenterPage';
import type { SafetyScenarioSummary, SafetyStatus } from '../../../services/safetyApi';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  scenario: vi.fn(),
  audit: vi.fn(),
  providers: vi.fn(),
  recompute: vi.fn(),
  simulate: vi.fn(),
  runDemo: vi.fn(),
  createIncident: vi.fn(),
  confirmIncident: vi.fn(),
  resolveIncident: vi.fn(),
  parseIncident: vi.fn(),
}));

vi.mock('../../../services/safetyApi', () => ({ default: mocks }));

const regions = [
  {
    id: 'R_MAIN',
    name: '主展厅',
    area_m2: 600,
    area_provenance: 'estimated',
    geometry: { x: 190, y: 110, width: 220, height: 180 },
    holding_capacity_persons: 700,
    enabled: true,
    camera: { camera_id: 'CAM-MAIN-01', calibration_status: 'uncalibrated', calibration_version: 'v0' },
  },
  {
    id: 'R_EAST',
    name: '东侧展区',
    area_m2: 450,
    area_provenance: 'estimated',
    geometry: { x: 610, y: 110, width: 180, height: 180 },
    holding_capacity_persons: 500,
    enabled: true,
    camera: { camera_id: 'CAM-EAST-01', calibration_status: 'uncalibrated', calibration_version: 'v0' },
  },
];

const corridors = [
  {
    id: 'C02',
    name: '中庭—东侧展区',
    from_region_id: 'R_MAIN',
    to_region_id: 'R_EAST',
    direction: 'both',
    base_status: 'open',
    effective_status: 'open',
    capacity_per_min: 100,
    capacity_provenance: 'estimated',
    traversal_seconds: 45,
    usable: true,
    status_reason: 'synthetic',
  },
];

const exits = [
  {
    id: 'E_A',
    name: '主展厅南出口',
    region_id: 'R_MAIN',
    base_status: 'open',
    effective_status: 'open',
    capacity_per_min: 90,
    capacity_provenance: 'estimated',
    usable: true,
    status_reason: 'synthetic',
  },
  {
    id: 'E_B',
    name: '东侧主出口',
    region_id: 'R_EAST',
    base_status: 'open',
    effective_status: 'closed',
    capacity_per_min: 120,
    capacity_provenance: 'estimated',
    usable: false,
    status_reason: '事件 INC-1 强制关闭',
    blocked_by_incident_id: 'INC-1',
  },
];

const plan = {
  plan_id: 'PLAN-1',
  created_at: '2026-10-29T10:00:00.000Z',
  scenario_version: '1.0.0',
  constraint_version: 0,
  observation_version: 6,
  horizon_minutes: 8,
  status: 'feasible' as const,
  routes: [
    {
      route_id: 'RT-001',
      from_region_id: 'R_MAIN',
      exit_id: 'E_A',
      persons: 380,
      depart_minute: 0,
      arrive_minute: 0,
      steps: [],
    },
  ],
  unresolved: [],
  exit_totals: [{ exit_id: 'E_A', persons: 380 }],
  corridor_totals: [],
  demand_by_region: [{ region_id: 'R_MAIN', persons: 380 }],
  total_persons: 380,
  evacuated_persons: 380,
  unresolved_persons: 0,
  planner: { algorithm: 'time-expanded min-cost max-flow', model: 'test', notes: [] },
};

function makeStatus(overrides: Partial<SafetyStatus> = {}): SafetyStatus {
  return {
    state: {
      state: 'NORMAL',
      headline: '常态运行 · 方案已通过独立校验',
      reasons: [{ code: 'validated_plan', message: '当前方案通过独立安全校验', severity: 'info' }],
      publishable: true,
      validated_route_display_allowed: true,
      candidate_route_display_allowed: false,
      requires_operator_action: false,
      last_valid_observation_at: '2026-10-29T10:00:00.000Z',
      active_incident_ids: [],
      decided_at: '2026-10-29T10:00:00.000Z',
    },
    state_entered_at: '2026-10-29T10:00:00.000Z',
    versions: { scenario: '1.0.0', constraint: 0, observation: 6 },
    plan,
    candidate_plan: null,
    validation: {
      valid: true,
      checked_at: '2026-10-29T10:00:00.000Z',
      plan_id: 'PLAN-1',
      violations: [],
      checks_run: ['version_match', 'corridor_capacity'],
      versions: { scenario_version: '1.0.0', constraint_version: 0, observation_version: 6 },
    },
    last_valid_plan: { plan_id: 'PLAN-1', created_at: '2026-10-29T10:00:00.000Z', state: 'NORMAL' },
    risks: [
      {
        regionId: 'R_MAIN',
        level: 'normal',
        count: 380,
        density: 0.63,
        confidence: 0.9,
        observedAt: '2026-10-29T10:00:00.000Z',
        ageSeconds: 2,
        trusted: true,
        signals: [],
        thresholdsSource: 'provisional',
      },
    ],
    risk_summary: { highest: 'normal', counts: { normal: 1 } },
    incidents: [],
    observations: [
      {
        id: 'OBS-1',
        region_id: 'R_MAIN',
        observed_at: '2026-10-29T10:00:00.000Z',
        estimated_count: 380,
        estimated_density: 0.63,
        confidence: 0.9,
        source: 'simulation',
        provider: 'simulation-v1',
        model_version: 'simulation/1.0.0',
        valid: true,
      },
    ],
    regions,
    corridors,
    exits,
    scenario: {
      id: 'demo',
      name: 'SkyGuard 演示场馆',
      version: '1.0.0',
      notice: '本场景为合成演示数据，不得用于真实疏散指挥。',
      horizon_minutes: 8,
    },
    inference_health: { healthy: true },
    last_valid_observation_at: '2026-10-29T10:00:00.000Z',
    ...overrides,
  };
}

const scenario: SafetyScenarioSummary = {
  scenario_id: 'demo',
  name: 'SkyGuard 演示场馆',
  version: '1.0.0',
  description: 'demo',
  notice: '本场景为合成演示数据，不得用于真实疏散指挥。',
  config: { horizon_minutes: 8, max_observation_age_seconds: 90, min_confidence: 0.6 },
  regions,
  corridors: corridors.map(corridor => ({
    id: corridor.id,
    name: corridor.name,
    from_region_id: corridor.from_region_id,
    to_region_id: corridor.to_region_id,
    direction: corridor.direction,
    capacity_per_min: corridor.capacity_per_min,
    traversal_seconds: corridor.traversal_seconds,
    status: corridor.base_status,
  })),
  exits: exits.map(exit => ({
    id: exit.id,
    name: exit.name,
    region_id: exit.region_id,
    capacity_per_min: exit.capacity_per_min,
    status: exit.base_status,
  })),
  demo_scenarios: [
    { id: 'A_normal', label: '场景 A · 常规风险预警', description: 'a', expected_state: 'NORMAL' },
  ],
};

const providers = [
  {
    id: 'simulation-v1',
    kind: 'simulation' as const,
    source: 'simulation',
    available: true,
    verified_on_this_host: true,
    model_version: 'simulation/1.0.0',
    checks: [],
    notes: [],
  },
  {
    id: 'ascend-npu-v1',
    kind: 'ascend' as const,
    source: 'recorded_video',
    available: false,
    verified_on_this_host: false,
    model_version: 'unverified',
    checks: [{ name: 'cann_toolkit', ok: false, detail: '未检测到 CANN' }],
    notes: [],
  },
];

async function expectHeadline(text: string) {
  const matches = await screen.findAllByText(text);
  expect(matches.length).toBeGreaterThan(0);
}

describe('SkyGuard 指挥大屏', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => (mock as ReturnType<typeof vi.fn>).mockReset());
    mocks.scenario.mockResolvedValue(scenario);
    mocks.providers.mockResolvedValue(providers);
    mocks.audit.mockResolvedValue([
      {
        id: 'AUD-1',
        ts: '2026-10-29T10:00:00.000Z',
        actor: 'admin',
        role: 'admin',
        action: 'plan.recompute',
        summary: '重新规划：疏散 380/380 人',
        result: 'success',
      },
    ]);
  });

  it('NORMAL 状态下展示已验证路线与出口分配', async () => {
    mocks.status.mockResolvedValue(makeStatus());
    const { container } = render(<CommandCenterPage />);

    await expectHeadline('常态运行 · 方案已通过独立校验');
    expect(screen.getByRole('status')).toHaveTextContent('NORMAL');
    expect(screen.getByText('已验证方案')).toBeInTheDocument();
    expect(screen.getByText('通过独立校验')).toBeInTheDocument();
    expect(container.querySelector('.map-route-validated')).toBeTruthy();
    expect(container.querySelector('.map-route-candidate')).toBeNull();
    expect(screen.getAllByText('380').length).toBeGreaterThan(0);
    expect(screen.getByText(/本场景为合成演示数据/)).toBeInTheDocument();
  });

  it('REJECT 状态下不显示已验证路线，并给出违规原因', async () => {
    mocks.status.mockResolvedValue(
      makeStatus({
        state: {
          state: 'REJECT',
          headline: '安全拒绝 · 不存在满足全部硬约束的方案',
          reasons: [{ code: 'unresolved_demand', message: '仍有 180 人未被分配疏散路线', severity: 'critical' }],
          publishable: false,
          validated_route_display_allowed: false,
          candidate_route_display_allowed: true,
          requires_operator_action: true,
          last_valid_observation_at: '2026-10-29T10:00:00.000Z',
          active_incident_ids: ['INC-1'],
          decided_at: '2026-10-29T10:00:00.000Z',
        },
        plan: null,
        candidate_plan: { ...plan, status: 'partial', evacuated_persons: 200, unresolved_persons: 180 },
        validation: {
          valid: false,
          checked_at: '2026-10-29T10:00:00.000Z',
          plan_id: 'PLAN-1',
          violations: [
            { code: 'unresolved_demand', severity: 'hard', message: '仍有 180 人未被分配疏散路线' },
          ],
          checks_run: ['version_match'],
          versions: { scenario_version: '1.0.0', constraint_version: 0, observation_version: 6 },
        },
      }),
    );
    const { container } = render(<CommandCenterPage />);

    await expectHeadline('安全拒绝 · 不存在满足全部硬约束的方案');
    expect(screen.getByRole('status')).toHaveTextContent('REJECT');
    expect(screen.getByText('候选方案 · 未通过校验')).toBeInTheDocument();
    expect(container.querySelector('.map-route-validated')).toBeNull();
    expect(container.querySelector('.map-route-candidate')).toBeTruthy();
    expect(screen.getAllByText(/unresolved_demand/).length).toBeGreaterThan(0);
    expect(screen.getByText('需人工介入：是')).toBeInTheDocument();
    expect(screen.getByText(/未经安全验证/)).toBeInTheDocument();
  });

  it('DEGRADED 状态不把过期数据当作实时状态', async () => {
    mocks.status.mockResolvedValue(
      makeStatus({
        state: {
          state: 'DEGRADED',
          headline: '感知降级 · 不得基于不可信数据发布新路线',
          reasons: [{ code: 'untrusted_observation', message: '区域 R_MAIN 观测不可信：stale:600s>90s', severity: 'critical' }],
          publishable: false,
          validated_route_display_allowed: false,
          candidate_route_display_allowed: false,
          requires_operator_action: true,
          last_valid_observation_at: '2026-10-29T09:50:00.000Z',
          active_incident_ids: [],
          decided_at: '2026-10-29T10:00:00.000Z',
        },
        plan: null,
        candidate_plan: null,
      }),
    );
    const { container } = render(<CommandCenterPage />);

    await expectHeadline('感知降级 · 不得基于不可信数据发布新路线');
    expect(screen.getByText(/最后一次有效观测/)).toBeInTheDocument();
    expect(screen.getByText(/当前无可展示方案/)).toBeInTheDocument();
    expect(container.querySelector('.map-route-validated')).toBeNull();
    expect(container.querySelector('.map-route-candidate')).toBeNull();
  });

  it('昇腾 provider 不可用时在大屏如实显示为不可用', async () => {
    mocks.status.mockResolvedValue(makeStatus());
    render(<CommandCenterPage />);
    await expectHeadline('常态运行 · 方案已通过独立校验');
    await waitFor(() => expect(mocks.providers).toHaveBeenCalled());
    expect(screen.getByText(/ascend/)).toBeInTheDocument();
    expect(screen.getByText(/cann_toolkit/)).toBeInTheDocument();
  });
});
