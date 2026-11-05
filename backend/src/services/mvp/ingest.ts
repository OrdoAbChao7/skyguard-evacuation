/**
 * 人流数据回放与摄像头健康状态。
 *
 * 数据来源分为：
 *  - 本地视频回放（RecordedVideoCrowdProvider，见 safety/providers/video.ts）
 *  - CSV / JSON 人流数据回放（本文件）
 *  - 模拟数据（SimulationCrowdProvider）
 *  - 现场反馈 / 无人机观测（经工单闭环写入 safety 观测）
 * 所有回放数据都标记 `csv_replay`，不得当作实时测量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDataRoot } from '../../config/paths';
import type {
  DensityObservation,
  SafetyScenario,
} from '../safety/types';
import type { ObservationStore } from '../safety/observations';

export const ReplayRowSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  region_id: z.string().min(1),
  count: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  source: z.enum(['simulation', 'recorded_video', 'live_video', 'csv_replay', 'field_report', 'uav_observation']).optional(),
});
export type ReplayRow = z.infer<typeof ReplayRowSchema>;

export interface ReplayDataset {
  name: string;
  description: string;
  provenance: string;
  rows: ReplayRow[];
}

export interface ReplayStatus {
  loaded: boolean;
  dataset_name: string | null;
  provenance: string | null;
  total_rows: number;
  cursor: number;
  regions: string[];
  first_at: string | null;
  last_at: string | null;
  completed: boolean;
}

/** 极简 CSV 解析：支持逗号分隔与双引号包裹字段，不支持换行字段。 */
export function parseReplayCsv(text: string): ReplayRow[] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]).map(item => item.trim().toLowerCase());
  const required = ['timestamp', 'region_id', 'count', 'confidence'];
  for (const column of required) {
    if (!header.includes(column)) throw new Error(`CSV 缺少列：${column}`);
  }
  return lines.slice(1).map((line, index) => {
    const values = splitCsvLine(line);
    const record: Record<string, string> = {};
    header.forEach((column, i) => { record[column] = values[i] ?? ''; });
    const parsed = ReplayRowSchema.safeParse({
      timestamp: record.timestamp,
      region_id: record.region_id,
      count: Number(record.count),
      confidence: Number(record.confidence),
      ...(record.source ? { source: record.source } : {}),
    });
    if (!parsed.success) {
      throw new Error(`CSV 第 ${index + 2} 行格式不正确：${parsed.error.issues.map(issue => issue.message).join('; ')}`);
    }
    return parsed.data;
  });
}

function splitCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

export class ReplayService {
  private rows: ReplayRow[] = [];
  private cursor = 0;
  private datasetName: string | null = null;
  private provenance: string | null = null;

  constructor(private readonly scenario: SafetyScenario) {}

  getDataRoot(): string {
    return getDataRoot();
  }

  loadRows(rows: ReplayRow[], meta: { name: string; provenance: string }): ReplayStatus {
    const validated = rows.map((row, index) => {
      const parsed = ReplayRowSchema.parse(row);
      if (!this.scenario.regions.some(region => region.id === parsed.region_id)) {
        throw new Error(`回放第 ${index + 1} 行引用未知区域：${parsed.region_id}`);
      }
      return parsed;
    }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    this.rows = validated;
    this.cursor = 0;
    this.datasetName = meta.name;
    this.provenance = meta.provenance;
    return this.status();
  }

  loadJsonFile(fileName: string): ReplayStatus {
    const safeName = path.basename(fileName);
    const filePath = path.resolve(getDataRoot(), 'replays', safeName);
    if (!filePath.startsWith(path.resolve(getDataRoot(), 'replays'))) {
      throw new Error('回放文件路径越界');
    }
    if (!fs.existsSync(filePath)) throw new Error(`回放文件不存在：${filePath}`);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ReplayDataset> & { rows?: ReplayRow[] };
    const rows = raw.rows ?? (Array.isArray(raw) ? raw as ReplayRow[] : []);
    return this.loadRows(rows, {
      name: raw.name ?? safeName,
      provenance: raw.provenance ?? '未声明来源的回放数据',
    });
  }

  loadCsvFile(fileName: string): ReplayStatus {
    const safeName = path.basename(fileName);
    const filePath = path.resolve(getDataRoot(), 'replays', safeName);
    if (!filePath.startsWith(path.resolve(getDataRoot(), 'replays'))) {
      throw new Error('回放文件路径越界');
    }
    if (!fs.existsSync(filePath)) throw new Error(`回放文件不存在：${filePath}`);
    return this.loadRows(parseReplayCsv(fs.readFileSync(filePath, 'utf8')), {
      name: safeName,
      provenance: 'CSV 回放数据（来源见文件头说明）',
    });
  }

  /** 返回下一批待写入的观测（不直接写库，由调用方经 safety 服务写入）。 */
  next(count = 1): ReplayRow[] {
    const slice = this.rows.slice(this.cursor, this.cursor + Math.max(1, count));
    this.cursor += slice.length;
    return slice;
  }

  status(): ReplayStatus {
    const regions = Array.from(new Set(this.rows.map(row => row.region_id))).sort();
    return {
      loaded: this.rows.length > 0,
      dataset_name: this.datasetName,
      provenance: this.provenance,
      total_rows: this.rows.length,
      cursor: this.cursor,
      regions,
      first_at: this.rows[0]?.timestamp ?? null,
      last_at: this.rows[this.rows.length - 1]?.timestamp ?? null,
      completed: this.rows.length > 0 && this.cursor >= this.rows.length,
    };
  }

  reset(): void {
    this.cursor = 0;
  }
}

export type CameraState = 'online' | 'degraded' | 'offline' | 'unknown';

export interface CameraHealth {
  region_id: string;
  region_name: string;
  camera_id: string;
  state: CameraState;
  declared_status: string | null;
  calibration_status: string;
  last_observation_at: string | null;
  age_seconds: number | null;
  /** 数据延迟（秒）：以最近观测时间计算。 */
  data_delay_seconds: number | null;
  /** 疑似丢帧/断流：最近观测过旧，或相邻观测间隔超过 2 倍最大时效。 */
  frame_drop_suspected: boolean;
  confidence: number | null;
  sources: string[];
  reason: string;
}

export function cameraHealthFor(
  scenario: SafetyScenario,
  observations: ObservationStore,
  regionId: string,
  now: Date = new Date(),
): CameraHealth {
  const region = scenario.regions.find(item => item.id === regionId);
  if (!region) throw new Error(`unknown region: ${regionId}`);
  const latest = observations.latest(regionId);
  const ageSeconds = latest
    ? Math.max(0, (now.getTime() - new Date(latest.observed_at).getTime()) / 1000)
    : null;
  const declared = region.camera.status ?? null;
  const maxAge = scenario.config.max_observation_age_seconds;
  const recent = observations.window(
    regionId,
    new Date(now.getTime() - maxAge * 3 * 1000),
    now,
  );
  const gaps: number[] = [];
  for (let index = 1; index < recent.length; index += 1) {
    gaps.push((new Date(recent[index].observed_at).getTime() - new Date(recent[index - 1].observed_at).getTime()) / 1000);
  }
  const latestGap = gaps.length > 0 ? Math.max(...gaps) : null;
  const frameDropSuspected = (ageSeconds !== null && ageSeconds > maxAge * 2)
    || (latestGap !== null && latestGap > maxAge * 2);

  let state: CameraState = 'online';
  let reason = '最近观测有效且未过期';
  if (declared === 'offline') {
    state = 'offline';
    reason = '设备清单声明摄像头离线';
  } else if (!latest) {
    state = declared === 'degraded' ? 'degraded' : 'unknown';
    reason = '没有该区域的观测记录';
  } else if (!latest.valid) {
    state = 'degraded';
    reason = `最近观测无效：${latest.invalid_reason ?? '未说明'}`;
  } else if (ageSeconds !== null && ageSeconds > scenario.config.max_observation_age_seconds) {
    state = 'degraded';
    reason = `最近观测已过期 ${Math.round(ageSeconds)} 秒`;
  } else if (latest.confidence < scenario.config.min_confidence) {
    state = 'degraded';
    reason = `最近观测置信度 ${latest.confidence} 低于阈值 ${scenario.config.min_confidence}`;
  } else if (declared === 'degraded') {
    state = 'degraded';
    reason = '设备清单声明摄像头降级';
  }

  return {
    region_id: region.id,
    region_name: region.name,
    camera_id: region.camera.camera_id,
    state,
    declared_status: declared,
    calibration_status: region.camera.calibration_status,
    last_observation_at: latest?.observed_at ?? null,
    age_seconds: ageSeconds === null ? null : Math.round(ageSeconds),
    data_delay_seconds: ageSeconds === null ? null : Math.round(ageSeconds),
    frame_drop_suspected: frameDropSuspected,
    confidence: latest?.confidence ?? null,
    sources: latest ? [latest.source] : [],
    reason,
  };
}

export function allCameraHealth(
  scenario: SafetyScenario,
  observations: ObservationStore,
  now: Date = new Date(),
): CameraHealth[] {
  return scenario.regions.map(region => cameraHealthFor(scenario, observations, region.id, now));
}

export function replayObservationInputs(
  rows: ReplayRow[],
  scenario: SafetyScenario,
): Array<{ regionId: string; count: number; confidence: number; observedAt: Date; source: DensityObservation['source']; provider: string }> {
  return rows.map(row => {
    if (!scenario.regions.some(region => region.id === row.region_id)) {
      throw new Error(`unknown region in replay: ${row.region_id}`);
    }
    return {
      regionId: row.region_id,
      count: row.count,
      confidence: row.confidence,
      observedAt: new Date(row.timestamp),
      source: row.source ?? 'csv_replay',
      provider: 'csv_replay',
    };
  });
}
