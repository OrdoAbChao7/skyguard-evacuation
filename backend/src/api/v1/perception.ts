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
import {
  DisplayPackageError,
  getDisplayFramePage,
  listDisplayPackages,
  loadDisplayPackage,
  readBasemap,
} from '../../services/perception/display';

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
    provenance: loaded.provenance,
    notice: loaded.summary.ground_truth_available
      ? '感知回放派生数据：仅用于展示，不参与规划与校验。'
      : '感知回放派生数据，无真值标注：仅用于展示，不得用于报告精度。',
  });
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
