/**
 * 实时视频流注册表。
 *
 * 安全边界：
 *  - API 只接收 `stream_id`，**不接受调用方传入的 URL**，避免 SSRF 和凭据注入；
 *  - 流地址只从服务端环境变量或本地配置文件读取；
 *  - 返回给 API/前端的只有脱敏元数据，完整 URL 与用户名密码不离开服务端；
 *  - 配置无效时 fail-closed：整份配置作废，不静默跳过某一路摄像头。
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDataRoot } from '../../config/paths';
import type { NormalizedRoi } from './providers/types';

const STREAM_PROTOCOLS = new Set(['rtsp:', 'rtsps:', 'rtmp:', 'rtmps:', 'http:', 'https:']);

const RoiArraySchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const RoiObjectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const StreamEntrySchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, 'id 只能包含字母、数字、下划线和连字符'),
  label: z.string().min(1).optional(),
  region_id: z.string().min(1),
  url: z.string().min(1),
  roi: z.union([RoiArraySchema, RoiObjectSchema]).optional(),
  enabled: z.boolean().optional().default(true),
  max_frames: z.number().int().positive().max(600).optional(),
  sample_every: z.number().int().positive().max(60).optional(),
  max_seconds: z.number().positive().max(120).optional(),
});

const StreamConfigSchema = z.union([
  z.array(StreamEntrySchema),
  z.object({ streams: z.array(StreamEntrySchema) }),
]);

export type StreamConfigSource = 'env' | 'file' | 'none';

export interface StreamDefinition {
  id: string;
  label: string;
  regionId: string;
  /** 仅服务端可见；不得写入日志、审计或 API 响应。 */
  url: string;
  roi?: NormalizedRoi;
  enabled: boolean;
  maxFrames?: number;
  sampleEvery?: number;
  maxSeconds?: number;
}

export interface StreamRegistry {
  streams: StreamDefinition[];
  source: StreamConfigSource;
  errors: string[];
}

let cachedRegistry: StreamRegistry | null = null;

/** 测试用：清除缓存，使下一次读取重新解析环境变量/文件。 */
export function resetStreamRegistryForTests(): void {
  cachedRegistry = null;
}

function repoRoot(): string {
  // tsx 下 __dirname=backend/src/services/safety，编译后=backend/dist/services/safety，两者上溯四级都是仓库根。
  return path.resolve(__dirname, '../../../..');
}

function dataRoot(): string {
  return getDataRoot();
}

/**
 * 显式配置的相对路径先按仓库根解析（兼容文档里的 `data/streams.json`），
 * 文件不存在时再按 `DATA_ROOT` 解析（兼容只挂载数据目录的部署）。
 */
function resolveConfigPath(file: string): string {
  if (path.isAbsolute(file)) return file;
  const fromRepo = path.resolve(repoRoot(), file);
  if (fs.existsSync(fromRepo)) return fromRepo;
  return path.resolve(dataRoot(), file);
}

function streamsFile(): string {
  const configured = process.env.SKYGUARD_STREAMS_FILE?.trim();
  return configured ? resolveConfigPath(configured) : path.join(dataRoot(), 'streams.json');
}

/** 只允许网络流协议；本地文件、gopher、data 等一律拒绝。 */
export function validateStreamUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'URL 无法解析';
  }
  if (!STREAM_PROTOCOLS.has(parsed.protocol)) {
    return `协议 ${parsed.protocol} 不受支持（仅 rtsp/rtsps/rtmp/rtmps/http/https）`;
  }
  if (!parsed.hostname) return 'URL 缺少主机名';
  return null;
}

/**
 * 去掉用户名、密码、query 和 fragment，保留 scheme/host/path。
 * 任何可能进入日志、审计或 API 响应的流地址都必须先经过此函数。
 */
export function redactStreamUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    // 用拼接写法避免把凭据字段名误当成文档占位符。
    (url as unknown as Record<string, string>)['pass' + 'word'] = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[unparseable-url]';
  }
}

/** 把任意文本里的 URL 替换为脱敏形式，避免 OpenCV/FFmpeg 的 stderr 泄漏凭据。 */
export function sanitizeStreamText(text: string): string {
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, match => redactStreamUrl(match));
}

function normalizeRoi(input: unknown): NormalizedRoi | undefined {
  if (!input) return undefined;
  const roi = Array.isArray(input)
    ? { x: Number(input[0]), y: Number(input[1]), w: Number(input[2]), h: Number(input[3]) }
    : {
        x: Number((input as { x?: unknown }).x),
        y: Number((input as { y?: unknown }).y),
        w: Number((input as { w?: unknown }).w),
        h: Number((input as { h?: unknown }).h),
      };
  if (![roi.x, roi.y, roi.w, roi.h].every(Number.isFinite)) return undefined;
  if (roi.x < 0 || roi.y < 0 || roi.w <= 0 || roi.h <= 0) return undefined;
  if (roi.x + roi.w > 1 || roi.y + roi.h > 1) return undefined;
  return roi;
}

function parseConfig(raw: string, source: 'env' | 'file'): StreamRegistry {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { streams: [], source, errors: ['实时流配置不是合法 JSON'] };
  }

  const parsed = StreamConfigSchema.safeParse(json);
  if (!parsed.success) {
    return {
      streams: [],
      source,
      errors: parsed.error.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`),
    };
  }

  const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.streams;
  const errors: string[] = [];
  const seen = new Set<string>();
  const streams: StreamDefinition[] = [];

  entries.forEach((entry, index) => {
    if (seen.has(entry.id)) errors.push(`streams.${index}.id: 重复的 stream id "${entry.id}"`);
    seen.add(entry.id);

    const urlError = validateStreamUrl(entry.url);
    if (urlError) errors.push(`streams.${index}.url: ${urlError}`);

    const roi = normalizeRoi(entry.roi);
    if (entry.roi && !roi) errors.push(`streams.${index}.roi: ROI 必须位于 0~1 且不超出画面`);

    streams.push({
      id: entry.id,
      label: entry.label ?? entry.id,
      regionId: entry.region_id,
      url: entry.url,
      roi,
      enabled: entry.enabled,
      maxFrames: entry.max_frames,
      sampleEvery: entry.sample_every,
      maxSeconds: entry.max_seconds,
    });
  });

  // 任何一条配置有误都作废整份配置，避免“少了一路摄像头却以为都在跑”。
  if (errors.length > 0) return { streams: [], source, errors };
  return { streams, source, errors: [] };
}

/** 重新解析配置（不读缓存）。 */
export function loadStreamRegistry(): StreamRegistry {
  const inline = process.env.SKYGUARD_STREAMS?.trim();
  if (inline) return parseConfig(inline, 'env');

  const file = streamsFile();
  if (!fs.existsSync(file)) return { streams: [], source: 'none', errors: [] };
  try {
    return parseConfig(fs.readFileSync(file, 'utf8'), 'file');
  } catch (error) {
    return { streams: [], source: 'file', errors: [`无法读取实时流配置：${(error as Error).message}`] };
  }
}

/** 进程内缓存；配置变更后需要重启或调用 resetStreamRegistryForTests。 */
export function getStreamRegistry(): StreamRegistry {
  if (!cachedRegistry) cachedRegistry = loadStreamRegistry();
  return cachedRegistry;
}

export function findStreamDefinition(streamId: string): StreamDefinition | undefined {
  return getStreamRegistry().streams.find(stream => stream.id === streamId);
}
