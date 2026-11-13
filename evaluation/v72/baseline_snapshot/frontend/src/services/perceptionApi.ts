/**
 * 感知回放展示 API 客户端（只读）。
 *
 * 独立于 safetyApi / mvpApi：这里的类型（`Perception*`）只描述"感知层派生回放数据"，
 * 与 `data/scenarios/*.json` 的场景契约（zones/corridors/exits/容量）没有任何映射关系，
 * 不得把本文件的类型传给规划或校验相关代码。
 */
import axios from 'axios';

const client = axios.create({
  baseURL: '/api/v1/perception',
  timeout: 20000,
});

export type PerceptionVec2 = [number, number];

export interface PerceptionBasemap {
  file: string;
  width_px: number;
  height_px: number;
  /** 底图是否真实随部署分发；false 时前端必须退回无底图坐标系。 */
  available: boolean;
  url: string;
}

export interface PerceptionZone {
  zone_id: string;
  ground_polygon_m: PerceptionVec2[];
  map_polygon_px: PerceptionVec2[];
  toward_junction_xy?: PerceptionVec2 | null;
}

export interface PerceptionPerson {
  track_id: number | string;
  head_xy_px?: PerceptionVec2 | null;
  head_bbox_xyxy_px?: number[] | null;
  confidence?: number | null;
  ground_xy_m?: PerceptionVec2 | null;
  speed_mps?: number | null;
  heading_rad?: number | null;
  map_xy_px?: PerceptionVec2 | null;
  zone_id?: string | null;
}

export interface PerceptionZoneStats {
  zone_id: string;
  estimated_people: number;
  median_speed_mps?: number | null;
  speed_sample_count: number;
  direction_counts: {
    toward_junction: number;
    away_from_junction: number;
    unknown: number;
  };
}

export interface PerceptionFrame {
  frame_id: number;
  timestamp_ms: number;
  frame_status: string;
  people: PerceptionPerson[];
  zone_stats: PerceptionZoneStats[];
}

export interface PerceptionDisplaySummary {
  package_id: string;
  display_name: string;
  usage_tier: string;
  scene_id: string;
  camera_id: string;
  calibration_id: string;
  time_base: string;
  frame_count: number;
  zone_count: number;
  first_timestamp_ms: number;
  last_timestamp_ms: number;
  basemap: PerceptionBasemap;
  license_status: string;
  ground_truth_available: boolean;
  provenance_complete: boolean;
  limitations: string[];
  prohibited_claims: string[];
}

export interface PerceptionDisplayDetail extends PerceptionDisplaySummary {
  map: { map_image: string; width_px: number; height_px: number };
  zones: PerceptionZone[];
  /** 米制多边形鞋带面积（演示；不等于场景区域标定面积）。 */
  zone_areas_m2?: Record<string, number | null>;
  notice: string;
  provenance: Record<string, unknown> | null;
}

export interface PerceptionFrameQuality {
  package_id: string;
  frame_id: number;
  observed_at: string;
  zones: Array<{
    zone_id: string;
    estimated_count: number;
    area_m2: number | null;
    density_per_m2: number | null;
    confidence: number | null;
    valid_for_safety: boolean;
    quality: {
      status: 'ok' | 'degraded' | 'unusable';
      reasons: string[];
      calibrated: boolean;
      demo_mapping: boolean;
      ground_truth_available: boolean;
      license_status: string;
    };
    limitations: string[];
  }>;
  notice: string;
}

export interface PerceptionFramePage {
  package_id: string;
  frame_count: number;
  returned: number;
  truncated: boolean;
  next_from: number | null;
  frames: PerceptionFrame[];
}

const api = {
  async displays(): Promise<PerceptionDisplaySummary[]> {
    const response = await client.get<{ displays: PerceptionDisplaySummary[] }>('/displays');
    return response.data.displays;
  },

  async display(packageId: string): Promise<PerceptionDisplayDetail> {
    const response = await client.get<PerceptionDisplayDetail>(`/displays/${encodeURIComponent(packageId)}`);
    return response.data;
  },

  async frames(packageId: string, options: { from?: number; limit?: number } = {}): Promise<PerceptionFramePage> {
    const response = await client.get<PerceptionFramePage>(`/displays/${encodeURIComponent(packageId)}/frames`, {
      params: { from: options.from, limit: options.limit },
    });
    return response.data;
  },

  async frameQuality(packageId: string, frameId: number): Promise<PerceptionFrameQuality> {
    const response = await client.get<PerceptionFrameQuality>(
      `/displays/${encodeURIComponent(packageId)}/frames/${frameId}/quality`,
    );
    return response.data;
  },
};

export default api;
