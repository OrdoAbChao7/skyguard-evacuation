/**
 * 从江滩场景生成合成标定档案。
 *
 * 用途：避免在仓库中保存数千行可由场景确定性推导的 JSON；
 * 生成结果始终标记 data_nature=synthetic、provenance=estimated，不得冒充实测。
 */
import type { SafetyScenario } from '../types';
import type { VenueProfile } from './venue-calibration';

const NOTE = '合成/未标定值；不得作为真实江滩参数引用。';
const CAMERA_VERSION = 'hk-cam-unc-0';

function value(
  amount: number,
  unit: string,
  source: string,
  method: string,
): {
  value: number;
  unit: string;
  provenance: 'estimated';
  source: string;
  method: string;
  notes: string;
} {
  return { value: amount, unit, provenance: 'estimated', source, method, notes: NOTE };
}

export function buildSyntheticVenueProfile(scenario: SafetyScenario): VenueProfile {
  const source = `${scenario.scenario_id} scenario (geodesic_anchor_mesh_v1, estimated)`;
  const regions = scenario.regions.map(region => ({
    region_id: region.id,
    area_m2: value(region.area_m2, 'm2', source, '由测地锚点网格估算面积；未现场测绘'),
    holding_capacity_persons: value(
      region.holding_capacity_persons,
      'persons',
      source,
      '按面积与默认密度估算承载量；未现场标定',
    ),
    camera_ids: region.camera ? [region.camera.camera_id] : [],
  }));

  const corridors = scenario.corridors
    .filter(corridor => corridor.capacity_per_min !== null)
    .map(corridor => ({
      corridor_id: corridor.id,
      from_region_id: corridor.from_region_id,
      to_region_id: corridor.to_region_id,
      capacity_per_min: value(
        corridor.capacity_per_min!,
        'persons/min',
        source,
        '按标准公式与竖向折减推导；未现场观测',
      ),
      traversal_seconds: value(
        corridor.traversal_seconds,
        's',
        source,
        '按通道长度与默认步速估算；未实测',
      ),
      direction: corridor.direction,
    }));

  const exits = scenario.exits.map(exit => ({
    exit_id: exit.id,
    region_id: exit.region_id,
    capacity_per_min: value(
      exit.capacity_per_min ?? 0,
      'persons/min',
      source,
      '按闸口宽度标准公式推导；未现场观测',
    ),
  }));

  const cameras = scenario.regions
    .filter(region => Boolean(region.camera))
    .map(region => ({
      camera_id: region.camera!.camera_id,
      region_id: region.id,
      roi: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      calibration_status: 'estimated' as const,
      calibration_version: CAMERA_VERSION,
      sensor: {
        model_name: 'synthetic-camera',
        mounting_height_m: 6,
        tilt_deg: -15,
        resolution: '1920x1080',
      },
    }));

  const observationAdapters = cameras.map(camera => ({
    adapter_id: `camera-count-${camera.region_id.toLowerCase().replace(/_/g, '-')}`,
    kind: 'camera_count' as const,
    region_mapping: { [camera.camera_id]: camera.region_id },
    calibration_version: CAMERA_VERSION,
  }));

  return {
    profile_id: 'hankou-marshland-synthetic-calibration',
    venue_id: scenario.scenario_id,
    name: '武汉汉口江滩 · 合成标定档案',
    version: '1.0.0',
    data_nature: 'synthetic',
    created_at: '2026-11-10T00:00:00.000Z',
    updated_at: '2026-11-10T00:00:00.000Z',
    regions,
    corridors,
    exits,
    cameras,
    flow: {
      walking_speed_mps: value(1.25, 'm/s', source, '通用步行速度经验值；未用江滩样本估计'),
      bpr_a: value(0.15, 'dimensionless', source, '通用 BPR 系数；未标定'),
      bpr_b: value(2, 'dimensionless', source, '通用 BPR 指数；未标定'),
      exit_service_queue_scale: value(5, 'dimensionless', source, '出口排队服务衰减经验尺度；未标定'),
    },
    observation_adapters: observationAdapters,
    notes: [
      '全部参数为合成/未标定数据，来源为江滩场景的测地锚点网格与标准公式推导。',
      '不得表述为现场实测或已标定参数；用于研究级仿真与流水线演练。',
      'C_FLOOD_ESCAPE_UNKNOWN 容量为 unknown，按“未知不可用”原则不写入标定档案，保持场景硬排除。',
    ],
  };
}
