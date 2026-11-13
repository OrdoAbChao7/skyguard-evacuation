/**
 * SkyGuard 安全 API（独立于灵小禅游客/管理业务路由）。
 *
 * 认证约定：
 *  - 读接口开放（原型阶段，便于大屏轮询；生产需另加鉴权，见 LIMITATIONS.md）；
 *  - 所有写接口统一要求 JWT，且角色必须是 `admin` 或 `safety_operator`；
 *  - 关键状态变更（事件确认/解除、方案发布）都会写审计日志。
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { verifyToken } from './auth';
import { EvacuationPlanSchema } from '../../services/safety/types';
import { listScenarioFiles, getScenarioFileName } from '../../services/safety/scenario';
import { resetMvpServiceForTests } from '../../services/mvp';
import {
  getProviders,
  getSafetyService,
  parseIncidentText,
  resetSafetyServiceForTests,
} from '../../services/safety';
import { ProviderUnavailableError } from '../../services/safety/providers/types';
import { IncidentTransitionError } from '../../services/safety/incidents';
import { buildCongestionPreview, buildMpcPreview } from '../../services/v70/research';
import { shadowConfig, shadowComparisonsOf } from '../../services/safety/planning/v7-adapter';
import { securityConfig } from '../../config/security';

export interface SafetyRouterOptions {
  /** 测试用：跳过 JWT（默认 false）。 */
  bypassAuth?: boolean;
}

const OPERATOR_ROLES = new Set(['admin', 'safety_operator']);

function actorOf(req: Request): { username: string; role: string } {
  const user = (req as Request & { user?: { username?: string; role?: string } }).user;
  return {
    username: user?.username ?? 'anonymous',
    role: user?.role ?? 'viewer',
  };
}

function requireOperator(options: SafetyRouterOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (options.bypassAuth) {
      (req as Request & { user?: unknown }).user = { username: 'test-operator', role: 'safety_operator' };
      next();
      return;
    }
    const actor = actorOf(req);
    if (!OPERATOR_ROLES.has(actor.role)) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: '当前身份无权执行安全关键操作，需要 admin 或 safety_operator 角色',
        },
      });
      return;
    }
    next();
  };
}

function fail(res: Response, status: number, code: string, message: string, detail?: unknown): void {
  res.status(status).json({ error: { code, message, detail } });
}

const ObservationBody = z.object({
  region_id: z.string().min(1),
  count: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  source: z.enum(['simulation', 'recorded_video', 'live_video', 'csv_replay', 'field_report', 'uav_observation']),
  provider: z.string().min(1).default('manual'),
  model_version: z.string().min(1).default('manual'),
  calibration_version: z.string().min(1).optional(),
  observed_at: z.string().datetime({ offset: true }).optional(),
  valid: z.boolean().optional(),
  invalid_reason: z.string().optional(),
  recompute: z.boolean().optional(),
});

const SimulateBody = z.object({
  observations: z.record(
    z.object({ count: z.number().nonnegative(), confidence: z.number().min(0).max(1) }),
  ),
  recompute: z.boolean().optional(),
});

const VideoBody = z.object({
  region_id: z.string().min(1),
  video_path: z.string().min(1),
  max_frames: z.number().int().positive().max(2000).optional(),
  sample_every: z.number().int().positive().max(300).optional(),
  recompute: z.boolean().optional(),
});

const IncidentBody = z.object({
  type: z.enum(['fire', 'corridor_closure', 'crowd_surge', 'sensor_failure', 'other']),
  description: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  affected: z.object({
    region_ids: z.array(z.string()).default([]),
    corridor_ids: z.array(z.string()).default([]),
    exit_ids: z.array(z.string()).default([]),
  }),
  source: z.enum(['operator', 'natural_language', 'sensor', 'simulation']).default('operator'),
  raw_text: z.string().optional(),
  confirm_immediately: z.boolean().optional(),
  recompute: z.boolean().optional(),
});

const ParseBody = z.object({ text: z.string().min(1) });
const ResolveBody = z.object({ note: z.string().optional(), recompute: z.boolean().optional() });
const RecomputeBody = z.object({ trigger: z.string().optional() });

export function createSafetyRouter(options: SafetyRouterOptions = {}): Router {
  const router = Router();
  const operatorOnly = requireOperator(options);
  /** 写接口统一要求：有效 JWT + 运维角色。 */
  const writeGuard = options.bypassAuth
    ? [requireOperator(options)]
    : [(req: Request, res: Response, next: NextFunction) => verifyToken(req, res, next), requireOperator(options)];

  // ------------------------------------------------------------------ 读取
  router.get('/status', (_req, res) => {
    try {
      res.json(getSafetyService().getStatus());
    } catch (error) {
      fail(res, 500, 'STATUS_UNAVAILABLE', (error as Error).message);
    }
  });

  router.get('/scenario', (_req, res) => {
    const scenario = getSafetyService().getScenario();
    res.json({
      scenario_id: scenario.scenario_id,
      name: scenario.name,
      version: scenario.version,
      description: scenario.description,
      notice: scenario.notice,
      config: scenario.config,
      regions: scenario.regions,
      corridors: scenario.corridors,
      exits: scenario.exits,
      map: scenario.map ?? { landmarks: [] },
      simulation_baseline: scenario.simulation_baseline ?? null,
      demo_scenarios: scenario.demo_scenarios.map(demo => ({
        id: demo.id,
        label: demo.label,
        description: demo.description,
        expected_state: demo.expected_state,
      })),
    });
  });

  /** 列出 data/scenarios 下的候选场景文件（只读）。 */
  router.get('/scenarios', (_req, res) => {
    res.json({ active: getScenarioFileName(), files: listScenarioFiles() });
  });

  router.get('/plan', (_req, res) => {
    const service = getSafetyService();
    res.json({
      plan: service.getPlan() ?? null,
      candidate_plan: service.getCandidatePlan() ?? null,
      validation: service.getValidation() ?? null,
      exclusions: service.getExclusions(),
    });
  });

  router.get('/observations', (_req, res) => {
    res.json({ observations: getSafetyService().getStatus().observations });
  });

  router.get('/incidents', (_req, res) => {
    res.json({ incidents: getSafetyService().getIncidentStore().list() });
  });

  router.get('/audit', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ entries: getSafetyService().getAuditLog().list(limit) });
  });

  router.get('/traces', (_req, res) => {
    res.json({ traces: getSafetyService().getAuditLog().listTraces(20) });
  });

  router.get('/trace/:id', (req, res) => {
    const trace = getSafetyService().getAuditLog().getTrace(String(req.params.id));
    if (!trace) {
      fail(res, 404, 'TRACE_NOT_FOUND', 'Trace 不存在或已被淘汰');
      return;
    }
    res.json(trace);
  });

  router.get('/providers', async (_req, res) => {
    try {
      const { video, ascend } = getProviders();
      const service = getSafetyService();
      const [videoStatus, ascendStatus, simulationStatus] = await Promise.all([
        video.status(),
        ascend.status(),
        service.simulationProvider.status(),
      ]);
      res.json({
        providers: [simulationStatus, videoStatus, ascendStatus],
        inference_health: service.getStatus().inference_health,
      });
    } catch (error) {
      fail(res, 500, 'PROVIDER_STATUS_FAILED', (error as Error).message);
    }
  });

  // ------------------------------------------------------- V7 研究预览（只读）
  router.get('/v70/mpc-preview', (req, res) => {
    try {
      const booleanOf = (value: unknown, fallback: boolean): boolean => {
        if (value === undefined) return fallback;
        return value === '1' || value === 'true' || value === 'yes';
      };
      const numberParam = (value: unknown): number | undefined => {
        if (value === undefined) return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      };
      const preview = buildMpcPreview(getSafetyService(), {
        controlIntervalMinutes: numberParam(req.query.control_interval),
        planningHorizonMinutes: numberParam(req.query.planning_horizon),
        useForecast: booleanOf(req.query.use_forecast, true),
        queueFeedback: booleanOf(req.query.queue_feedback, true),
        maxSteps: numberParam(req.query.max_steps),
      });
      res.json(preview);
    } catch (error) {
      fail(res, 500, 'V70_MPC_PREVIEW_FAILED', securityConfig().errorDetail ? (error as Error).message : '服务器内部错误');
    }
  });

  router.get('/v70/congestion-preview', (_req, res) => {
    try {
      res.json(buildCongestionPreview(getSafetyService()));
    } catch (error) {
      fail(res, 500, 'V70_CONGESTION_PREVIEW_FAILED', securityConfig().errorDetail ? (error as Error).message : '服务器内部错误');
    }
  });

  router.get('/v70/shadow', (_req, res) => {
    try {
      const config = shadowConfig();
      res.json({
        enabled: config.enabled,
        config,
        comparisons: shadowComparisonsOf(getSafetyService()),
        note: 'Shadow Mode 只读比较；V7 方案不会发布、审批或改变安全状态。',
      });
    } catch (error) {
      fail(res, 500, 'V70_SHADOW_READ_FAILED', securityConfig().errorDetail ? (error as Error).message : '服务器内部错误');
    }
  });

  // ------------------------------------------------------------------ 观测
  router.post('/observations', ...writeGuard, (req, res) => {
    const parsed = ObservationBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'INVALID_INPUT', '观测参数不符合契约', parsed.error.issues.map(issue => issue.path.join('.')));
      return;
    }
    const service = getSafetyService();
    try {
      const observation = service.ingestObservation(
        {
          regionId: parsed.data.region_id,
          count: parsed.data.count,
          confidence: parsed.data.confidence,
          source: parsed.data.source,
          provider: parsed.data.provider,
          modelVersion: parsed.data.model_version,
          calibrationVersion: parsed.data.calibration_version,
          observedAt: parsed.data.observed_at ? new Date(parsed.data.observed_at) : undefined,
          valid: parsed.data.valid,
          invalidReason: parsed.data.invalid_reason,
        },
        actorOf(req),
      );
      const result = parsed.data.recompute === false ? undefined : service.recompute(actorOf(req), 'observation.ingest');
      res.status(201).json({
        observation,
        state: (result?.snapshot ?? service.getStatus().state).state,
        plan_id: result?.plan?.plan_id,
        validation_valid: result?.validation?.valid,
      });
    } catch (error) {
      fail(res, 400, 'OBSERVATION_REJECTED', (error as Error).message);
    }
  });

  router.post('/observations/simulate', ...writeGuard, (req, res) => {
    const parsed = SimulateBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'INVALID_INPUT', '模拟观测参数不符合契约', parsed.error.issues.map(issue => issue.path.join('.')));
      return;
    }
    const service = getSafetyService();
    const scenario = service.getScenario();
    for (const regionId of Object.keys(parsed.data.observations)) {
      if (!scenario.regions.some(region => region.id === regionId)) {
        fail(res, 400, 'UNKNOWN_REGION', `区域不存在：${regionId}`);
        return;
      }
    }
    service.simulationProvider.updateSamples(parsed.data.observations);
    const created = Object.entries(parsed.data.observations).map(([regionId, sample]) =>
      service.ingestObservation(
        {
          regionId,
          count: sample.count,
          confidence: sample.confidence,
          source: 'simulation',
          provider: service.simulationProvider.id,
          modelVersion: 'simulation/1.0.0',
          evidence: { simulated: true, note: '演示脚本显式输入，非视频推理结果' },
        },
        actorOf(req),
      ),
    );
    const result =
      parsed.data.recompute === false ? undefined : service.recompute(actorOf(req), 'observation.simulate');
    res.status(201).json({
      observations: created,
      state: (result?.snapshot ?? service.getStatus().state).state,
      plan_id: result?.plan?.plan_id,
      validation_valid: result?.validation?.valid,
    });
  });

  router.post('/observations/video', ...writeGuard, async (req, res) => {
    const parsed = VideoBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'INVALID_INPUT', '视频观测参数不符合契约', parsed.error.issues.map(issue => issue.path.join('.')));
      return;
    }
    const service = getSafetyService();
    const region = service.getScenario().regions.find(item => item.id === parsed.data.region_id);
    if (!region) {
      fail(res, 400, 'UNKNOWN_REGION', `区域不存在：${parsed.data.region_id}`);
      return;
    }
    const { video } = getProviders();
    try {
      const inference = await video.infer({
        region,
        videoPath: parsed.data.video_path,
        maxFrames: parsed.data.max_frames,
        sampleEvery: parsed.data.sample_every,
      });
      service.setInferenceHealth(true);
      const observation = service.ingestObservation(
        {
          regionId: region.id,
          count: inference.count,
          confidence: inference.confidence,
          source: 'recorded_video',
          provider: inference.provider,
          modelVersion: inference.modelVersion,
          calibrationVersion: inference.calibrationVersion,
          evidence: { ...inference.evidence, warnings: inference.warnings },
        },
        actorOf(req),
      );
      const result = parsed.data.recompute === false ? undefined : service.recompute(actorOf(req), 'observation.video');
      res.status(201).json({
        observation,
        inference,
        state: (result?.snapshot ?? service.getStatus().state).state,
        plan_id: result?.plan?.plan_id,
        validation_valid: result?.validation?.valid,
      });
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        service.setInferenceHealth(false, error.message);
        fail(res, 503, 'PROVIDER_UNAVAILABLE', error.message, error.checks);
        return;
      }
      fail(res, 500, 'VIDEO_INFERENCE_FAILED', (error as Error).message);
    }
  });

  // ------------------------------------------------------------------ 事件
  router.post('/incidents/parse', ...writeGuard, (req, res) => {
    const parsed = ParseBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'INVALID_INPUT', '需要 text 字段');
      return;
    }
    res.json({
      draft: parseIncidentText(parsed.data.text, getSafetyService().getScenario()),
      note: '该结果仅为待确认草稿，不会改变任何约束；必须经操作员确认后通过 POST /incidents 正式登记',
    });
  });

  router.post('/incidents', ...writeGuard, (req, res) => {
    const parsed = IncidentBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'INVALID_INPUT', '事件参数不符合契约', parsed.error.issues.map(issue => issue.path.join('.')));
      return;
    }
    const service = getSafetyService();
    const actor = actorOf(req);
    try {
      const incident = service.createIncident({
        type: parsed.data.type,
        description: parsed.data.description,
        severity: parsed.data.severity,
        affected: parsed.data.affected,
        source: parsed.data.source,
        rawText: parsed.data.raw_text,
        actor: actor.username,
      });
      let confirmed;
      if (parsed.data.confirm_immediately) {
        confirmed = service.confirmIncident(incident.id, actor);
      }
      const result =
        parsed.data.recompute === false || (!confirmed && !parsed.data.recompute)
          ? undefined
          : service.recompute(actor, 'incident.create');
      res.status(201).json({
        incident: confirmed ?? incident,
        state: (result?.snapshot ?? service.getStatus().state).state,
        plan_id: result?.plan?.plan_id,
        validation_valid: result?.validation?.valid,
      });
    } catch (error) {
      fail(res, 400, 'INCIDENT_REJECTED', (error as Error).message);
    }
  });

  router.post('/incidents/:id/confirm', ...writeGuard, (req, res) => {
    const service = getSafetyService();
    const actor = actorOf(req);
    try {
      const incident = service.confirmIncident(String(req.params.id), actor);
      const result = service.recompute(actor, 'incident.confirm');
      res.json({
        incident,
        trace_id: result.trace.trace_id,
        state: result.snapshot.state,
        plan_id: result.plan?.plan_id,
        validation: result.validation,
      });
    } catch (error) {
      if (error instanceof IncidentTransitionError) {
        fail(res, 409, 'INVALID_TRANSITION', error.message);
        return;
      }
      fail(res, 400, 'INCIDENT_REJECTED', (error as Error).message);
    }
  });

  router.post('/incidents/:id/resolve', ...writeGuard, (req, res) => {
    const parsed = ResolveBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, 400, 'INVALID_INPUT', '参数不符合契约');
      return;
    }
    const service = getSafetyService();
    const actor = actorOf(req);
    try {
      const incident = service.resolveIncident(String(req.params.id), actor, parsed.data.note);
      const result = parsed.data.recompute === false ? undefined : service.recompute(actor, 'incident.resolve');
      res.json({
        incident,
        state: (result?.snapshot ?? service.getStatus().state).state,
        // 明确：解除事件不会恢复旧方案，必须重新规划
        note: '事件解除后旧方案已失效，系统已重新规划并重新校验',
        plan_id: result?.plan?.plan_id,
        validation: result?.validation ?? null,
      });
    } catch (error) {
      if (error instanceof IncidentTransitionError) {
        fail(res, 409, 'INVALID_TRANSITION', error.message);
        return;
      }
      fail(res, 400, 'INCIDENT_REJECTED', (error as Error).message);
    }
  });

  router.post('/incidents/:id/dismiss', ...writeGuard, (req, res) => {
    const parsed = ResolveBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, 400, 'INVALID_INPUT', '参数不符合契约');
      return;
    }
    try {
      const incident = getSafetyService().dismissIncident(String(req.params.id), actorOf(req), parsed.data.note);
      res.json({ incident, state: getSafetyService().getStatus().state.state });
    } catch (error) {
      if (error instanceof IncidentTransitionError) {
        fail(res, 409, 'INVALID_TRANSITION', error.message);
        return;
      }
      fail(res, 400, 'INCIDENT_REJECTED', (error as Error).message);
    }
  });

  // ------------------------------------------------------------------ 规划
  router.post('/plan/recompute', ...writeGuard, (req, res) => {
    const parsed = RecomputeBody.safeParse(req.body ?? {});
    const trigger = parsed.success && parsed.data.trigger ? parsed.data.trigger : 'manual';
    const result = getSafetyService().recompute(actorOf(req), trigger);
    res.json({
      trace_id: result.trace.trace_id,
      state: result.snapshot.state,
      reasons: result.snapshot.reasons,
      plan: result.plan ?? null,
      validation: result.validation ?? null,
      exclusions: result.exclusions,
    });
  });

  router.post('/plan/validate', ...writeGuard, (req, res) => {
    const parsed = EvacuationPlanSchema.safeParse(req.body?.plan ?? req.body);
    if (!parsed.success) {
      fail(res, 400, 'INVALID_INPUT', '候选方案不符合 EvacuationPlan 契约', parsed.error.issues.map(issue => issue.path.join('.')));
      return;
    }
    const validation = getSafetyService().validateCandidate(parsed.data, actorOf(req));
    res.json({ validation, publishable: validation.valid });
  });

  // ------------------------------------------------------------------ 演示 / 运维
  router.post('/demo/:id/run', ...writeGuard, async (req, res) => {
    try {
      const result = await getSafetyService().runDemo(String(req.params.id), actorOf(req));
      res.json({
        demo_id: result.demo_id,
        expected_state: result.expected_state,
        actual_state: result.status.state.state,
        matched: result.status.state.state === result.expected_state,
        steps: result.steps,
        status: result.status,
      });
    } catch (error) {
      fail(res, 400, 'DEMO_FAILED', (error as Error).message);
    }
  });

  router.post('/reset', ...writeGuard, (req, res) => {
    getSafetyService().reset(actorOf(req));
    res.json({ status: 'ok', state: getSafetyService().getStatus().state.state });
  });

  const ReloadBody = z.object({ file: z.string().min(1).optional() });
  router.post('/admin/reload-scenario', ...writeGuard, (req, res) => {
    const parsed = ReloadBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, 400, 'INVALID_BODY', '场景文件名格式不正确', parsed.error.flatten());
      return;
    }
    if (parsed.data.file) process.env.SAFETY_SCENARIO_FILE = parsed.data.file;
    try {
      resetSafetyServiceForTests();
      // MVP 服务持有自己的场景/人员/预测实例，必须一起重载，避免 /safety 与 /mvp 场景分叉。
      resetMvpServiceForTests();
      const status = getSafetyService().getStatus();
      res.json({
        status: 'reloaded',
        scenario_id: status.scenario.id,
        scenario_version: status.scenario.version,
        active_file: getScenarioFileName(),
        state: status.state.state,
      });
    } catch (error) {
      fail(res, 400, 'SCENARIO_RELOAD_FAILED', '场景重载失败，已保持原场景不变', (error as Error).message);
      // 重新加载原场景，避免服务处于不可用状态
      process.env.SAFETY_SCENARIO_FILE = '';
      resetSafetyServiceForTests();
      resetMvpServiceForTests();
    }
  });

  return router;
}

export const safetyRouter = createSafetyRouter();
