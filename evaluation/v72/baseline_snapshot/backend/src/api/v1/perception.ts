/**
 * 感知回放展示 API（只读）。
 *
 * 定位：把"感知层派生数据"单独暴露出来，供大屏做时间轴/热力/区域查询演示。
 * 刻意不提供任何写入、规划或校验入口 —— 这些数据不得影响安全判定。
 *
 * 数据边界见 data/perception/<package>/PROVENANCE.json；缺失来源时
 * 响应里 license_status 为 UNKNOWN，前端必须按"来源未标明"展示。
 */
import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  DisplayPackageError,
  getDisplayFramePage,
  listDisplayPackages,
  loadDisplayPackage,
  readBasemap,
} from '../../services/perception/display';
import { adaptDisplayFrame, zoneAreaM2 } from '../../services/perception/adapter';

function fail(res: Response, status: number, code: string, message: string, detail?: unknown): void {
  res.status(status).json({ error: { code, message, detail } });
}

function paramOf(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : value;
}

function resolvePackage(req: Request, res: Response) {
  try {
    return loadDisplayPackage(paramOf(req, 'id'));
  } catch (error) {
    if (error instanceof DisplayPackageError) {
      const notFound = error.issues.includes('package_not_found');
      fail(
        res,
        notFound ? 404 : 422,
        notFound ? 'DISPLAY_NOT_FOUND' : 'DISPLAY_PACKAGE_INVALID',
        error.message,
        error.issues,
      );
      return null;
    }
    fail(res, 500, 'DISPLAY_PACKAGE_ERROR', (error as Error).message);
    return null;
  }
}

export const perceptionRouter = Router();

/** 列出全部可用的展示包（只返回摘要，不含逐帧点位）。 */
perceptionRouter.get('/displays', (_req, res) => {
  try {
    res.json({ displays: listDisplayPackages() });
  } catch (error) {
    fail(res, 500, 'DISPLAY_LIST_FAILED', (error as Error).message);
  }
});

/** 单个展示包的元信息：底图坐标系、区域边界、来源与已知误差。 */
perceptionRouter.get('/displays/:id', (req, res) => {
  const loaded = resolvePackage(req, res);
  if (!loaded) return;
  res.json({
    ...loaded.summary,
    map: loaded.map,
    zones: loaded.zones,
    zone_areas_m2: Object.fromEntries(loaded.zones.map(zone => [zone.zone_id, zoneAreaM2(zone.ground_polygon_m)])),
    provenance: loaded.provenance,
    notice: loaded.summary.ground_truth_available
      ? '感知回放派生数据：仅用于展示，不参与规划与校验。'
      : '感知回放派生数据，无真值标注：仅用于展示，不得用于报告精度。',
  });
});

/**
 * 单帧感知质量预览（只读）：把派生帧适配为“人数→面积→密度→质量”草稿。
 * 不写入安全域；缺少 surveyed 标定时 valid_for_safety 恒为 false。
 */
perceptionRouter.get('/displays/:id/frames/:frameId/quality', (req, res) => {
  const loaded = resolvePackage(req, res);
  if (!loaded) return;
  const frameId = Number(paramOf(req, 'frameId'));
  if (!Number.isFinite(frameId) || !Number.isInteger(frameId)) {
    fail(res, 400, 'INVALID_FRAME_ID', 'frameId 必须是整数');
    return;
  }
  const frame = loaded.frames.find(item => item.frame_id === frameId);
  if (!frame) {
    fail(res, 404, 'FRAME_NOT_FOUND', `帧 ${frameId} 不存在`);
    return;
  }
  const last = loaded.frames[loaded.frames.length - 1];
  const observedAt = new Date(Date.now() - Math.max(0, last.timestamp_ms - frame.timestamp_ms)).toISOString();
  const drafts = adaptDisplayFrame(loaded, frame, { observed_at: observedAt });
  res.json({
    package_id: loaded.summary.package_id,
    frame_id: frame.frame_id,
    observed_at: observedAt,
    zones: drafts.map(draft => ({
      zone_id: draft.provenance.zone_id,
      estimated_count: draft.estimated_count,
      area_m2: draft.area_m2,
      density_per_m2: draft.density_per_m2,
      confidence: draft.confidence,
      valid_for_safety: draft.valid_for_safety,
      quality: draft.quality,
      limitations: draft.limitations,
    })),
    notice: '派生显示数据无真值、配准近似；未提供 surveyed 区域映射时不得进入安全域。',
  });
});

/** 公开数据集真实推理结果摘要（只读；没有结果文件时明确 404）。 */
perceptionRouter.get('/real-data/summary', (_req, res) => {
  const file = path.resolve(__dirname, '../../../../evaluation/real-data/RESULTS.json');
  if (!fs.existsSync(file)) {
    fail(res, 404, 'REAL_DATA_RESULTS_MISSING', '尚未生成真实数据评测结果');
    return;
  }
  try {
    const result = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    res.json({
      dataset: result.dataset,
      part: result.part,
      split: result.split,
      model: result.model,
      environment: result.environment,
      images: result.images,
      metrics: result.metrics,
      localization: result.localization,
      latency_ms: result.latency_ms,
      generated_at: result.generated_at,
      caveats: [
        '公开数据集 + 官方权重；不是 SkyGuard 自训练模型，也不是真实场馆实测。',
        '许可 UNVERIFIED；不得据此声称现场精度。',
        '人数到区域密度仍需场地面积与摄像机标定。',
      ],
    });
  } catch (error) {
    fail(res, 500, 'REAL_DATA_RESULTS_INVALID', `真实数据结果无法解析：${(error as Error).message}`);
  }
});

/** 逐帧点位分页读取，避免整包 1.6 MB 每帧轮询。 */
perceptionRouter.get('/displays/:id/frames', (req, res) => {
  const loaded = resolvePackage(req, res);
  if (!loaded) return;

  const fromRaw = req.query.from;
  const limitRaw = req.query.limit;
  const from = fromRaw === undefined ? undefined : Number(fromRaw);
  const limit = limitRaw === undefined ? 60 : Number(limitRaw);

  if (from !== undefined && (!Number.isFinite(from) || !Number.isInteger(from))) {
    fail(res, 400, 'INVALID_QUERY', 'from 必须是整数帧号', { from: fromRaw });
    return;
  }
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > 240) {
    fail(res, 400, 'INVALID_QUERY', 'limit 必须是 1–240 之间的整数', { limit: limitRaw });
    return;
  }

  const page = getDisplayFramePage(loaded, { from, limit });
  res.json({
    package_id: loaded.summary.package_id,
    frame_count: loaded.summary.frame_count,
    returned: page.frames.length,
    truncated: page.truncated,
    next_from: page.next_from,
    frames: page.frames,
  });
});

/** 航拍底图。许可未确认的底图不随仓库分发，缺失时返回明确错误码。 */
perceptionRouter.get('/displays/:id/basemap', (req, res) => {
  const loaded = resolvePackage(req, res);
  if (!loaded) return;
  const basemap = readBasemap(loaded.summary.package_id);
  if (!basemap) {
    fail(
      res,
      404,
      'BASEMAP_NOT_BUNDLED',
      '该展示包的底图未随仓库分发（许可未确认），需由部署方提供后启用',
      { expected_file: loaded.map.map_image },
    );
    return;
  }
  res.setHeader('Content-Type', basemap.contentType);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.send(basemap.buffer);
});
