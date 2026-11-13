import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PerceptionReplayPanel from '../PerceptionReplayPanel';

const mocks = vi.hoisted(() => ({
  displays: vi.fn(),
  display: vi.fn(),
  frames: vi.fn(),
  frameQuality: vi.fn(),
}));

vi.mock('../../../services/perceptionApi', () => ({ default: mocks }));

const display = {
  package_id: 'citystreet-display',
  display_name: 'CityStreet C3 单机位人流回放（派生显示数据）',
  usage_tier: 'demo_only',
  scene_id: 'citystreet',
  camera_id: 'C3',
  calibration_id: 'citystreet_C3_fixed_head_height_1p65m',
  time_base: 'clip_start_4hz_assumed',
  frame_count: 3,
  zone_count: 2,
  first_timestamp_ms: 5000,
  last_timestamp_ms: 5500,
  basemap: {
    file: 'orthophoto-z20.jpg',
    width_px: 768,
    height_px: 768,
    available: false,
    url: '/api/v1/perception/displays/citystreet-display/basemap',
  },
  license_status: 'UNVERIFIED',
  ground_truth_available: false,
  provenance_complete: true,
  limitations: ['地图配准为近似配准：东侧两处目视检查点偏差约 4.4 m 与 5.3 m。'],
  prohibited_claims: ['不得用本数据包报告感知精度或人数准确率。'],
  map: { map_image: 'orthophoto-z20.jpg', width_px: 768, height_px: 768 },
  zone_areas_m2: { N: 152.52, 'S-A': 50 },
  notice: '感知回放派生数据，无真值标注：仅用于展示，不得用于报告精度。',
  provenance: { source: { dataset: 'CityStreet' } },
  zones: [
    {
      zone_id: 'N',
      ground_polygon_m: [[17.5, 17.7], [36.1, 17.7], [36.1, 25.9]],
      map_polygon_px: [[100, 100], [200, 100], [200, 200], [100, 200]],
    },
    {
      zone_id: 'S-A',
      ground_polygon_m: [[10, 10], [20, 10], [20, 20]],
      map_polygon_px: [[300, 300], [420, 300], [420, 420], [300, 420]],
    },
  ],
};

function frame(frameId: number, timestampMs: number) {
  return {
    frame_id: frameId,
    timestamp_ms: timestampMs,
    frame_status: 'ok',
    people: [
      { track_id: 1, map_xy_px: [150, 150], confidence: 0.8, zone_id: 'N', speed_mps: 1.2 },
      { track_id: 2, map_xy_px: [340, 340], confidence: 0.7, zone_id: 'S-A', speed_mps: 1.963 },
      { track_id: 3, map_xy_px: null, confidence: 0.5, zone_id: null, speed_mps: null },
    ],
    zone_stats: [
      {
        zone_id: 'N',
        estimated_people: 1,
        median_speed_mps: 1.2,
        speed_sample_count: 1,
        direction_counts: { toward_junction: 1, away_from_junction: 0, unknown: 0 },
      },
      {
        zone_id: 'S-A',
        estimated_people: 4,
        median_speed_mps: 1.963,
        speed_sample_count: 3,
        direction_counts: { toward_junction: 1, away_from_junction: 2, unknown: 1 },
      },
    ],
  };
}

const framesPage = {
  package_id: 'citystreet-display',
  frame_count: 3,
  returned: 3,
  truncated: false,
  next_from: null,
  frames: [frame(2300, 5000), frame(2301, 5250), frame(2302, 5500)],
};

beforeEach(() => {
  mocks.displays.mockResolvedValue([display]);
  mocks.display.mockResolvedValue(display);
  mocks.frames.mockResolvedValue(framesPage);
  mocks.frameQuality.mockResolvedValue({
    package_id: 'citystreet-display',
    frame_id: 2300,
    observed_at: new Date().toISOString(),
    notice: '派生显示数据无真值',
    zones: [
      { zone_id: 'N', estimated_count: 1, area_m2: 152.52, density_per_m2: 0.0066, confidence: 0.8, valid_for_safety: false, quality: { status: 'degraded', reasons: ['missing_region_mapping'], calibrated: false, demo_mapping: true, ground_truth_available: false, license_status: 'UNVERIFIED' }, limitations: [] },
      { zone_id: 'S-A', estimated_count: 4, area_m2: 50, density_per_m2: 0.08, confidence: 0.7, valid_for_safety: false, quality: { status: 'degraded', reasons: ['uncalibrated_region_mapping'], calibrated: false, demo_mapping: true, ground_truth_available: false, license_status: 'UNVERIFIED' }, limitations: [] },
    ],
  });
});

describe('PerceptionReplayPanel', () => {
  it('渲染回放时始终带 DEMO / 非实时 / 无真值 / 许可未确认标注', async () => {
    render(<PerceptionReplayPanel />);
    await waitFor(() => expect(mocks.frames).toHaveBeenCalled());

    expect(await screen.findByText(/DEMO 回放 · 非实时/)).toBeInTheDocument();
    expect(screen.getByText('无真值标注')).toBeInTheDocument();
    expect(screen.getByText('许可 UNVERIFIED')).toBeInTheDocument();
    expect(screen.getByText(/不得用于报告精度/)).toBeInTheDocument();
  });

  it('展示后端返回的帧号、点位与区域统计，而不是写死的结果', async () => {
    render(<PerceptionReplayPanel />);
    expect(await screen.findByText('2300')).toBeInTheDocument();
    expect(screen.getByText('5.00s')).toBeInTheDocument();
    // 点位 3 条，但只有 2 条有坐标；合计与 S-A 的中位速度必须来自数据
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(await screen.findByText('1.96')).toBeInTheDocument();
  });

  it('底图未分发时如实说明，不伪造底图', async () => {
    render(<PerceptionReplayPanel />);
    expect(await screen.findByText(/航拍底图未随仓库分发/)).toBeInTheDocument();
  });

  it('底图可用时改用图像标签指向后端路由', async () => {
    mocks.display.mockResolvedValue({
      ...display,
      basemap: { ...display.basemap, available: true },
    });
    const { container } = render(<PerceptionReplayPanel />);
    await waitFor(() => expect(container.querySelector('image')).not.toBeNull());
    expect(container.querySelector('image')?.getAttribute('href')).toBe(display.basemap.url);
    expect(screen.queryByText(/航拍底图未随仓库分发/)).toBeNull();
  });

  it('点击区域列表可切换区域卡片，数值来自当前帧', async () => {
    render(<PerceptionReplayPanel />);
    await screen.findByText('2300');
    await userEvent.click(screen.getByRole('cell', { name: 'S-A' }));
    expect(await screen.findByRole('heading', { name: /区域 S-A/ })).toBeInTheDocument();
    expect(screen.getByText(/1\.963 m\/s/)).toBeInTheDocument();
    expect(screen.getByText(/朝向路口 1/)).toBeInTheDocument();
    expect(screen.getByText(/50\.00 m²/)).toBeInTheDocument();
    expect(screen.getByText(/0\.080 人\/m²/)).toBeInTheDocument();
    expect(screen.getByText(/不得用于安全判定/)).toBeInTheDocument();
    expect(await screen.findByText(/感知质量：degraded/)).toBeInTheDocument();
    expect(screen.getByText(/不进入安全域/)).toBeInTheDocument();
  });

  it('时间轴切换帧后显示对应帧号', async () => {
    render(<PerceptionReplayPanel />);
    await screen.findByText('2300');
    const slider = screen.getByLabelText('回放帧位置');
    // range 输入不支持 clear，用 fireEvent 走 React 的 value tracker
    fireEvent.change(slider, { target: { value: '2' } });
    expect(await screen.findByText('2302')).toBeInTheDocument();
  });

  it('加载失败时显示不可用，不显示任何点位或推断结果', async () => {
    mocks.display.mockRejectedValue({ response: { data: { error: { message: '展示包不存在' } } } });
    render(<PerceptionReplayPanel />);
    expect(await screen.findByText(/不可用：展示包不存在/)).toBeInTheDocument();
    expect(screen.getByText(/也不会回退到合成或推测数据/)).toBeInTheDocument();
    expect(screen.queryByText(/区域 S-A/)).toBeNull();
  });
});
