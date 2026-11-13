/**
 * MVP 业务 API：态势聚合、预测、Agent 运行、回放、人员、工单与反馈。
 *
 * 读接口开放（原型阶段）；所有写接口要求 JWT。审批/派发要求 admin 或
 * safety_operator；接单/执行/反馈要求 staff，且只能操作指派给本人的工单。
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { SECRET, verifyToken } from './auth';
import { getMvpService } from '../../services/mvp';
import { WorkOrderCreateSchema, type OpsActor } from '../../services/mvp/ops';
import { securityConfig } from '../../config/security';
import { getSafetyService } from '../../services/safety';
import { buildForecastPreview, buildJointVoIPreview } from '../../services/v70/research';

export function createMvpRouter(): Router {
  const router = Router();

  function actorOf(req: Request): OpsActor {
    const user = (req as Request & { user?: { username?: string; role?: string; staff_id?: string } }).user;
    return {
      username: user?.username ?? 'anonymous',
      role: user?.role ?? 'viewer',
      staff_id: user?.staff_id,
    };
  }

  function paramOf(req: Request, name: string): string {
    const value = req.params[name];
    return Array.isArray(value) ? value[0] : value;
  }

  function requireRole(roles: string[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const actor = actorOf(req);
      if (!roles.includes(actor.role)) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: `需要 ${roles.join(' / ')} 角色` } });
        return;
      }
      next();
    };
  }

  function fail(res: Response, status: number, code: string, message: string, detail?: unknown): void {
    res.status(status).json({ error: { code, message, detail } });
  }

  function handle(fn: (req: Request, res: Response) => void | Promise<void>) {
    return (req: Request, res: Response): void => {
      Promise.resolve(fn(req, res)).catch((error: Error & { status?: number; name?: string }) => {
        const status = Number.isInteger(error.status) && error.status! >= 400 && error.status! < 500
          ? error.status!
          : 500;
        const code = status === 409
          ? (error.name === 'IdempotencyConflictError'
            ? 'IDEMPOTENCY_CONFLICT'
            : error.name === 'ResourceUnavailableError' ? 'RESOURCE_UNAVAILABLE' : 'CONFLICT')
          : 'MVP_API_ERROR';
        const exposeDetail = securityConfig().errorDetail;
        fail(res, status, code, status >= 500 && !exposeDetail ? '服务器内部错误' : error.message);
      });
    };
  }

  const operatorOnly = [verifyToken, requireRole(['admin', 'safety_operator'])];
  const staffOnly = [verifyToken, requireRole(['staff'])];
  const authenticated = [verifyToken];

  // ---------------------------------------------------------------- 登录
  const StaffLoginBody = z.object({ staff_id: z.string().min(1), access_code: z.string().min(1) });
  router.post('/auth/staff-login', handle((req, res) => {
    const parsed = StaffLoginBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'INVALID_BODY', '参数格式不正确', parsed.error.flatten());
      return;
    }
    const member = getMvpService().ops.authenticateStaff(parsed.data.staff_id, parsed.data.access_code);
    if (!member) {
      fail(res, 401, 'STAFF_AUTH_FAILED', '工号或演示登录码错误');
      return;
    }
    const token = jwt.sign(
      { username: member.name, role: 'staff', staff_id: member.id },
      SECRET,
      { expiresIn: '12h' },
    );
    res.json({
      access_token: token,
      token_type: 'bearer',
      username: member.name,
      role: 'staff',
      staff_id: member.id,
      source: member.source,
      note: '演示身份：access_code 来自场景合成名册，真实部署必须替换为正式身份系统。',
    });
  }));

  // ---------------------------------------------------------------- 读
  router.get('/dashboard', handle((_req, res) => {
    res.json(getMvpService().dashboard());
  }));

  router.get('/scenario', handle((_req, res) => {
    const service = getMvpService();
    const scenario = service.getScenario();
    res.json({
      scenario_id: scenario.scenario_id,
      name: scenario.name,
      version: scenario.version,
      notice: scenario.notice,
      venue: scenario.venue ?? null,
      map: scenario.map ?? null,
      staff: scenario.staff,
      investigation: scenario.investigation ?? null,
      regions: scenario.regions,
      corridors: scenario.corridors,
      exits: scenario.exits,
    });
  }));

  router.get('/cameras', handle((req, res) => {
    const regionId = typeof req.query.region_id === 'string' ? req.query.region_id : undefined;
    res.json({ cameras: getMvpService().cameraHealth(regionId) });
  }));

  router.get('/predictions/:regionId', handle((req, res) => {
    const horizon = req.query.horizon_minutes ? Number(req.query.horizon_minutes) : undefined;
    res.json(getMvpService().predict(paramOf(req, 'regionId'), Number.isFinite(horizon) ? horizon : undefined));
  }));

  // ------------------------------------------------------- V7 研究预览（只读）
  router.get('/v70/forecast/:regionId', handle((req, res) => {
    const horizon = req.query.horizon_minutes ? Number(req.query.horizon_minutes) : 5;
    res.json(buildForecastPreview(getSafetyService(), paramOf(req, 'regionId'), Number.isFinite(horizon) ? horizon : 5));
  }));

  router.get('/v70/joint-investigation', handle((req, res) => {
    const target = typeof req.query.region_id === 'string' ? req.query.region_id : undefined;
    if (!target) {
      fail(res, 400, 'INVALID_INPUT', '需要 region_id 参数');
      return;
    }
    const correlation = req.query.correlation !== undefined ? Number(req.query.correlation) : undefined;
    const redundancy = req.query.redundancy !== undefined ? Number(req.query.redundancy) : undefined;
    const maxSequence = req.query.max_sequence !== undefined ? Number(req.query.max_sequence) : undefined;
    res.json(buildJointVoIPreview(getSafetyService(), target, {
      correlation: Number.isFinite(correlation) ? correlation : undefined,
      redundancyPenalty: Number.isFinite(redundancy) ? redundancy : undefined,
      maxSequence: Number.isFinite(maxSequence) && (maxSequence as number) > 0 ? maxSequence : undefined,
    }));
  }));

  router.get('/tools', handle((_req, res) => {
    res.json({ tools: getMvpService().registry.list() });
  }));

  router.post('/tools/:name', ...authenticated, handle(async (req, res) => {
    const actor = actorOf(req);
    const result = await getMvpService().registry.invoke(paramOf(req, 'name'), req.body ?? {}, actor);
    res.status(result.ok ? 200 : 400).json(result);
  }));

  // ---------------------------------------------------------------- Agent
  router.get('/agent/runtime', handle(async (req, res) => {
    const force = req.query.probe === '1' || req.query.probe === 'true';
    res.json(await getMvpService().agentRuntimeStatus(force));
  }));

  const RunBody = z.object({
    region_id: z.string().min(1),
    trigger: z.string().min(1).max(200).default('manual'),
    runtime: z.enum(['local', 'agentarts']).optional(),
  });
  router.post('/agent/runs', ...operatorOnly, handle(async (req, res) => {
    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'INVALID_BODY', '参数格式不正确', parsed.error.flatten());
      return;
    }
    const run = await getMvpService().runAgent({
      regionId: parsed.data.region_id,
      trigger: parsed.data.trigger,
      runtime: parsed.data.runtime,
      actor: actorOf(req),
    });
    res.status(run.status === 'failed' ? 502 : 201).json(run);
  }));

  router.get('/agent/runs', handle((req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    res.json({ runs: getMvpService().listAgentRuns(Number.isFinite(limit) ? limit : 20) });
  }));

  router.get('/agent/runs/:id', handle((req, res) => {
    const run = getMvpService().getAgentRun(paramOf(req, 'id'));
    if (!run) {
      fail(res, 404, 'RUN_NOT_FOUND', 'Agent 运行记录不存在');
      return;
    }
    res.json(run);
  }));

  // ---------------------------------------------------------------- 一键推演与实验
  const DemoBody = z.object({ scenario: z.enum(['A_normal', 'B_surge', 'C_untrusted']) });
  router.post('/demo/run', ...operatorOnly, handle(async (req, res) => {
    const parsed = DemoBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'INVALID_BODY', '场景参数不正确', parsed.error.flatten());
      return;
    }
    res.status(201).json(await getMvpService().runDemoScenario(parsed.data.scenario, actorOf(req)));
  }));

  router.get('/multi-region', handle((req, res) => {
    const regionId = typeof req.query.region_id === 'string' ? req.query.region_id : undefined;
    res.json(getMvpService().getMultiRegionAnalysis(regionId));
  }));

  router.get('/experiments', handle((_req, res) => {
    res.json(getMvpService().getExperimentSummary());
  }));

  // ---------------------------------------------------------------- 回放
  const ReplayLoadBody = z.object({
    file: z.string().min(1),
    format: z.enum(['json', 'csv']).optional(),
  });
  router.post('/replay/load', ...operatorOnly, handle((req, res) => {
    const parsed = ReplayLoadBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'INVALID_BODY', '参数格式不正确', parsed.error.flatten());
      return;
    }
    res.json(getMvpService().loadReplay(parsed.data));
  }));

  const ReplayStepBody = z.object({ count: z.number().int().positive().max(200).default(1) });
  router.post('/replay/step', ...operatorOnly, handle((req, res) => {
    const parsed = ReplayStepBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, 400, 'INVALID_BODY', '参数格式不正确', parsed.error.flatten());
      return;
    }
    res.json(getMvpService().stepReplay({ count: parsed.data.count, actor: actorOf(req) }));
  }));

  router.post('/replay/reset', ...operatorOnly, handle((_req, res) => {
    getMvpService().replay.reset();
    res.json(getMvpService().replay.status());
  }));

  // ---------------------------------------------------------------- 人员与工单
  router.get('/staff', handle((_req, res) => {
    res.json({ staff: getMvpService().ops.listStaff() });
  }));

  router.get('/work-orders', handle((req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const staffId = typeof req.query.staff_id === 'string' ? req.query.staff_id : undefined;
    const regionId = typeof req.query.region_id === 'string' ? req.query.region_id : undefined;
    res.json({
      work_orders: getMvpService().ops.listWorkOrders({
        status: status as never,
        staff_id: staffId,
        region_id: regionId,
      }),
    });
  }));

  router.get('/work-orders/budget', handle((_req, res) => {
    res.json({ budget: getMvpService().ops.getBudgetStatus() });
  }));

  router.post('/work-orders', ...operatorOnly, handle((req, res) => {
    const parsed = WorkOrderCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'INVALID_BODY', '工单参数格式不正确', parsed.error.flatten());
      return;
    }
    const order = getMvpService().ops.createWorkOrder(actorOf(req), parsed.data);
    res.status(201).json({ work_order: order, budget: getMvpService().ops.getBudgetStatus() });
  }));

  router.post('/work-orders/:id/approve', ...operatorOnly, handle((req, res) => {
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    res.json({ work_order: getMvpService().ops.approve(paramOf(req, 'id'), actorOf(req), note) });
  }));

  router.post('/work-orders/:id/reject', ...operatorOnly, handle((req, res) => {
    const note = typeof req.body?.note === 'string' ? req.body.note : '';
    res.json({ work_order: getMvpService().ops.reject(paramOf(req, 'id'), actorOf(req), note) });
  }));

  router.post('/work-orders/:id/assign', ...operatorOnly, handle((req, res) => {
    const staffId = typeof req.body?.staff_id === 'string' ? req.body.staff_id : undefined;
    res.json({ work_order: getMvpService().ops.assignStaff(paramOf(req, 'id'), actorOf(req), staffId) });
  }));

  router.post('/work-orders/:id/revalidate', ...operatorOnly, handle((req, res) => {
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    res.json({ work_order: getMvpService().ops.revalidate(paramOf(req, 'id'), actorOf(req), note) });
  }));

  router.post('/work-orders/:id/accept', ...staffOnly, handle((req, res) => {
    res.json({ work_order: getMvpService().ops.accept(paramOf(req, 'id'), actorOf(req)) });
  }));

  router.post('/work-orders/:id/start', ...staffOnly, handle((req, res) => {
    res.json({ work_order: getMvpService().ops.start(paramOf(req, 'id'), actorOf(req)) });
  }));

  const CompleteBody = z.object({
    note: z.string().min(1).max(1000),
    observation: z.object({
      count: z.number().nonnegative(),
      confidence: z.number().min(0).max(1),
      valid: z.boolean().optional(),
      reason: z.string().max(200).optional(),
    }).optional(),
  });
  router.post('/work-orders/:id/complete', ...staffOnly, handle((req, res) => {
    const parsed = CompleteBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'INVALID_BODY', '反馈参数格式不正确', parsed.error.flatten());
      return;
    }
    res.json({
      work_order: getMvpService().ops.complete(paramOf(req, 'id'), actorOf(req), parsed.data),
    });
  }));

  router.post('/work-orders/:id/fail', ...staffOnly, handle((req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    res.json({ work_order: getMvpService().ops.fail(paramOf(req, 'id'), actorOf(req), reason) });
  }));

  router.post('/work-orders/:id/cancel', ...operatorOnly, handle((req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    res.json({ work_order: getMvpService().ops.cancel(paramOf(req, 'id'), actorOf(req), reason) });
  }));

  // ---------------------------------------------------------------- 运维
  router.post('/reset', ...operatorOnly, handle((req, res) => {
    getMvpService().resetAll(actorOf(req));
    res.json({ status: 'reset' });
  }));

  return router;
}

export const mvpRouter = createMvpRouter();
