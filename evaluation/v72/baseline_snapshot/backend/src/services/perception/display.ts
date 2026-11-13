/**
 * 感知回放展示包（display package）加载与完整性校验。
 *
 * 边界（与 AGENTS.md 一致）：
 *  - 这里的 `display` 数据属于**感知展示层**，schema 与 `data/scenarios/*.json`
 *    完全不同，不得进入规划器或独立校验器；
 *  - 校验失败一律 fail closed：宁可整包不可用，也不把疑似篡改的数据当作可展示；
 *  - 包内必须带 `PROVENANCE.json`，缺失时只能上报 `license_status: UNKNOWN`，
 *    界面必须按"未标明来源"处理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveDataPath } from '../../config/paths';

const Vec2 = z.tuple([z.number(), z.number()]);

export const DisplayZoneSchema = z.object({
  zone_id: z.string().min(1),
  ground_polygon_m: z.array(Vec2).min(3),
  map_polygon_px: z.array(Vec2).min(3),
  toward_junction_xy: Vec2.nullable().optional(),
});

export const DisplayPersonSchema = z.object({
  track_id: z.union([z.number(), z.string()]),
  head_xy_px: Vec2.nullable().optional(),
  head_bbox_xyxy_px: z.array(z.number()).length(4).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  ground_xy_m: Vec2.nullable().optional(),
  speed_mps: z.number().nullable().optional(),
  heading_rad: z.number().nullable().optional(),
  map_xy_px: Vec2.nullable().optional(),
  zone_id: z.string().nullable().optional(),
});

export const DisplayZoneStatsSchema = z.object({
  zone_id: z.string().min(1),
  estimated_people: z.number().int().nonnegative(),
  median_speed_mps: z.number().nullable().optional(),
  speed_sample_count: z.number().int().nonnegative(),
  direction_counts: z.object({
    toward_junction: z.number().int().nonnegative(),
    away_from_junction: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
});

export const DisplayFrameSchema = z.object({
  frame_id: z.number().int(),
  timestamp_ms: z.number().nonnegative(),
  frame_status: z.string().min(1),
  people: z.array(DisplayPersonSchema),
  zone_stats: z.array(DisplayZoneStatsSchema),
});

export const DisplayPackageSchema = z.object({
  scene_id: z.string().min(1),
  camera_id: z.string().min(1),
  time_base: z.string().min(1),
  calibration_id: z.string().min(1),
  map: z.object({
    map_image: z.string().min(1),
    width_px: z.number().positive(),
    height_px: z.number().positive(),
  }),
  zones: z.array(DisplayZoneSchema).min(1),
  frames: z.array(DisplayFrameSchema).min(1),
});

export type DisplayZone = z.infer<typeof DisplayZoneSchema>;
export type DisplayPerson = z.infer<typeof DisplayPersonSchema>;
export type DisplayZoneStats = z.infer<typeof DisplayZoneStatsSchema>;
export type DisplayFrame = z.infer<typeof DisplayFrameSchema>;
export type DisplayPackage = z.infer<typeof DisplayPackageSchema>;

export interface DisplayProvenance {
  package_id?: string;
  display_name?: string;
  usage_tier?: string;
  summary?: string;
  ingested_at?: string;
  source?: Record<string, unknown>;
  time_base_note?: string;
  calibration?: Record<string, unknown>;
  ground_truth?: { available?: boolean; note?: string };
  known_errors?: string[];
  prohibited_claims?: string[];
  license?: { status?: string; note?: string };
  privacy?: Record<string, unknown>;
}

export interface DisplayBasemap {
  file: string;
  width_px: number;
  height_px: number;
  /** 底图文件是否真实存在（许可未确认的底图不随仓库分发）。 */
  available: boolean;
  url: string;
}

export interface DisplaySummary {
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
  basemap: DisplayBasemap;
  license_status: string;
  ground_truth_available: boolean;
  provenance_complete: boolean;
  limitations: string[];
  prohibited_claims: string[];
}

export interface LoadedDisplayPackage {
  summary: DisplaySummary;
  zones: DisplayZone[];
  frames: DisplayFrame[];
  provenance: DisplayProvenance | null;
  map: DisplayPackage['map'];
}

export class DisplayPackageError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message);
    this.name = 'DisplayPackageError';
  }
}

const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MANIFEST_FILES = new Set(['PROVENANCE.json', 'PACKAGE_README.md']);

function perceptionRoot(): string {
  return resolveDataPath('perception');
}

function packageDir(packageId: string): string {
  if (!PACKAGE_ID_PATTERN.test(packageId)) {
    throw new DisplayPackageError(`非法展示包 ID：${packageId}`, ['package_id_must_be_kebab_case']);
  }
  return resolveDataPath('perception', packageId);
}

const cache = new Map<string, LoadedDisplayPackage>();

export function resetDisplayCacheForTests(): void {
  cache.clear();
}

function readProvenance(dir: string): DisplayProvenance | null {
  const file = path.join(dir, 'PROVENANCE.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as DisplayProvenance;
  } catch {
    // 来源文件损坏时不得静默当作"无来源"以外的任何状态：返回 null 并在 summary 里体现。
    return null;
  }
}

/** 独立于 zod 的结构一致性检查：zod 管字段类型，这里管跨字段引用。 */
function crossChecks(payload: DisplayPackage): string[] {
  const issues: string[] = [];
  const zoneIds = new Set<string>();
  for (const zone of payload.zones) {
    if (zoneIds.has(zone.zone_id)) issues.push(`duplicate_zone:${zone.zone_id}`);
    zoneIds.add(zone.zone_id);
  }

  const seenFrames = new Set<number>();
  let previousTimestamp = -1;
  for (const frame of payload.frames) {
    if (seenFrames.has(frame.frame_id)) issues.push(`duplicate_frame:${frame.frame_id}`);
    seenFrames.add(frame.frame_id);
    if (frame.timestamp_ms < previousTimestamp) {
      issues.push(`timestamp_not_monotonic:${frame.frame_id}`);
    }
    previousTimestamp = frame.timestamp_ms;

    for (const stat of frame.zone_stats) {
      if (!zoneIds.has(stat.zone_id)) issues.push(`zone_stat_unknown_zone:${frame.frame_id}:${stat.zone_id}`);
      const directions =
        stat.direction_counts.toward_junction + stat.direction_counts.away_from_junction + stat.direction_counts.unknown;
      if (directions > stat.estimated_people) {
        issues.push(`direction_counts_exceed_people:${frame.frame_id}:${stat.zone_id}`);
      }
      if (stat.speed_sample_count > stat.estimated_people) {
        issues.push(`speed_samples_exceed_people:${frame.frame_id}:${stat.zone_id}`);
      }
      if (stat.speed_sample_count > 0 && (stat.median_speed_mps === null || stat.median_speed_mps === undefined)) {
        issues.push(`missing_median_speed:${frame.frame_id}:${stat.zone_id}`);
      }
    }

    for (const person of frame.people) {
      if (person.zone_id != null && !zoneIds.has(person.zone_id)) {
        issues.push(`person_unknown_zone:${frame.frame_id}:${person.zone_id}`);
      }
      // 点位不得越出底图坐标系，越界即视为数据损坏而不是"可跳过的空点"。
      if (person.map_xy_px) {
        const [x, y] = person.map_xy_px;
        if (x < 0 || y < 0 || x > payload.map.width_px || y > payload.map.height_px) {
          issues.push(`person_out_of_bounds:${frame.frame_id}:${person.track_id}`);
        }
      }
    }
  }

  if (payload.frames.length < 2) issues.push('frames_too_short');
  return issues;
}

function summarize(payload: DisplayPackage, provenance: DisplayProvenance | null, dir: string): DisplaySummary {
  const mapFile = payload.map.map_image;
  const basemapExists = fs.existsSync(path.join(dir, path.basename(mapFile)));
  const firstFrame = payload.frames[0];
  const lastFrame = payload.frames[payload.frames.length - 1];
  return {
    package_id: path.basename(dir),
    display_name: provenance?.display_name ?? `${payload.scene_id} / ${payload.camera_id}`,
    usage_tier: provenance?.usage_tier ?? 'unclassified',
    scene_id: payload.scene_id,
    camera_id: payload.camera_id,
    calibration_id: payload.calibration_id,
    time_base: payload.time_base,
    frame_count: payload.frames.length,
    zone_count: payload.zones.length,
    first_timestamp_ms: firstFrame.timestamp_ms,
    last_timestamp_ms: lastFrame.timestamp_ms,
    basemap: {
      file: mapFile,
      width_px: payload.map.width_px,
      height_px: payload.map.height_px,
      available: basemapExists,
      url: `/api/v1/perception/displays/${path.basename(dir)}/basemap`,
    },
    license_status: provenance?.license?.status ?? 'UNKNOWN',
    ground_truth_available: provenance?.ground_truth?.available === true,
    provenance_complete: provenance !== null,
    limitations: provenance?.known_errors ?? [],
    prohibited_claims: provenance?.prohibited_claims ?? [],
  };
}

export function listDisplayPackages(): DisplaySummary[] {
  const root = perceptionRoot();
  if (!fs.existsSync(root)) return [];
  const out: DisplaySummary[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!PACKAGE_ID_PATTERN.test(entry.name)) continue;
    try {
      out.push(loadDisplayPackage(entry.name).summary);
    } catch {
      // 单个包损坏不应让列表整体失败；损坏的包在 getDisplayPackage 里会给出具体原因。
      continue;
    }
  }
  return out.sort((a, b) => a.package_id.localeCompare(b.package_id));
}

export function displayPackageExists(packageId: string): boolean {
  try {
    return fs.existsSync(packageDir(packageId));
  } catch {
    return false;
  }
}

export function loadDisplayPackage(packageId: string): LoadedDisplayPackage {
  const cached = cache.get(packageId);
  if (cached) return cached;

  const dir = packageDir(packageId);
  if (!fs.existsSync(dir)) {
    throw new DisplayPackageError(`展示包不存在：${packageId}`, ['package_not_found']);
  }

  const candidates = fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.json') && !MANIFEST_FILES.has(name) && name !== 'PROVENANCE.json');
  if (candidates.length === 0) {
    throw new DisplayPackageError(`展示包缺少数据文件：${packageId}`, ['display_payload_missing']);
  }

  const payloadFile = path.join(dir, candidates.sort()[0]);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
  } catch (error) {
    throw new DisplayPackageError(`展示包不是合法 JSON：${candidates[0]}`, [(error as Error).message]);
  }

  const parsed = DisplayPackageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DisplayPackageError(
      `展示包结构不符合契约：${candidates[0]}`,
      parsed.error.issues.map(issue => `${issue.path.join('.')}:${issue.message}`),
    );
  }

  const issues = crossChecks(parsed.data);
  if (issues.length > 0) {
    throw new DisplayPackageError(`展示包内部一致性检查失败：${candidates[0]}`, issues.slice(0, 20));
  }

  const provenance = readProvenance(dir);
  const loaded: LoadedDisplayPackage = {
    summary: summarize(parsed.data, provenance, dir),
    zones: parsed.data.zones,
    frames: parsed.data.frames,
    provenance,
    map: parsed.data.map,
  };
  cache.set(packageId, loaded);
  return loaded;
}

export interface DisplayFramePage {
  frames: DisplayFrame[];
  truncated: boolean;
  next_from: number | null;
}

/** 按 frame_id 起点分页切片；`from` 指向不存在的帧号时返回空页而不是回退到首帧。 */
export function getDisplayFramePage(
  loaded: LoadedDisplayPackage,
  options: { from?: number; limit: number },
): DisplayFramePage {
  const { frames } = loaded;
  const startIndex = options.from === undefined ? 0 : frames.findIndex(frame => frame.frame_id >= options.from!);
  if (startIndex === -1) {
    return { frames: [], truncated: false, next_from: null };
  }
  const slice = frames.slice(startIndex, startIndex + options.limit);
  const nextIndex = startIndex + slice.length;
  const truncated = nextIndex < frames.length;
  return {
    frames: slice,
    truncated,
    next_from: truncated ? frames[nextIndex].frame_id : null,
  };
}

/** 读取底图字节；底图未随仓库分发时返回 null，由 API 层给出明确错误码。 */
export function readBasemap(packageId: string): { buffer: Buffer; contentType: string } | null {
  const loaded = loadDisplayPackage(packageId);
  const name = path.basename(loaded.map.map_image);
  const file = resolveDataPath('perception', packageId, name);
  if (!fs.existsSync(file)) return null;
  const extension = path.extname(name).toLowerCase();
  const contentType =
    extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
  return { buffer: fs.readFileSync(file), contentType };
}
