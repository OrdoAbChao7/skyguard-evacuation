/**
 * 智能体工具注册表（MCP 与本地 Agent 共用同一份实现）。
 *
 * 权限：每个工具声明允许的角色；MCP Server 与本地 Agent 都必须经过同一检查。
 * 审计：每次调用都会写入安全域审计日志（工具名、参数、结果、耗时）。
 * 边界：工具不会暴露任意文件读写或命令执行；Agent 只能创建待审批工单。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SafetyScenario, InvestigationOutcome, DensityObservation } from '../safety/types';
import type { SafetyDecisionService } from '../safety/decision-service';
import type { SafetyStatus } from '../safety/decision-service';
import { assessObservation } from '../safety/observations';
import type { PredictionService, PredictionResult } from './prediction';
import type { OpsActor, OpsService, WorkOrder, WorkOrderStatus } from './ops';
import { WorkOrderCreateSchema } from './ops';
import type { CameraHealth, ReplayService } from './ingest';
import { cameraHealthFor } from './ingest';

const ALL_ROLES = ['agent', 'admin', 'safety_operator', 'staff', 'viewer'];
const OPERATOR_ROLES = ['agent', 'admin', 'safety_operator'];

export interface ToolContext {
  scenario: SafetyScenario;
  safety: SafetyDecisionService;
  prediction: PredictionService;
  ops: OpsService;
  replay: ReplayService;
  cameras(regionId?: string): CameraHealth[];
  now(): Date;
  recordAudit(entry: {
    tool: string;
    actor: OpsActor;
    args: unknown;
    result: 'success' | 'failure';
    error?: string;
    duration_ms: number;
    source: string;
  }): void;
}

export interface ToolResult<T = unknown> {
  tool: string;
  ok: boolean;
  data: T;
  source: string;
  confidence: number | null;
  error?: string;
  /** 结构化错误码：UNKNOWN_TOOL / FORBIDDEN / INVALID_ARGUMENT / TIMEOUT / EXECUTION_ERROR。 */
  error_code?: string;
  generated_at: string;
  duration_ms?: number;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  roles: string[];
  source: string;
  timeout_ms: number;
  handler: (args: any, actor: OpsActor) => Promise<Omit<ToolResult, 'tool' | 'generated_at' | 'duration_ms'>>;
}

const EmptyInput = z.object({}).passthrough();

function ok<T>(data: T, source: string, confidence: number | null = null) {
  return { ok: true, data, source, confidence };
}

function fail(error: string, source: string) {
  return { ok: false, data: null, source, confidence: null, error };
}

function regionOf(ctx: ToolContext, regionId: string) {
  const region = ctx.scenario.regions.find(item => item.id === regionId);
  if (!region) throw new Error(`unknown region: ${regionId}`);
  return region;
}

function densityThreshold(ctx: ToolContext, regionId: string): number {
  const region = regionOf(ctx, regionId);
  return region.thresholds?.high_density ?? ctx.scenario.config.default_thresholds.high_density;
}

function latestAssessment(ctx: ToolContext, regionId: string) {
  const observation = ctx.safety.getObservationStore().latest(regionId);
  if (!observation) return null;
  return assessObservation(observation, ctx.scenario.config, ctx.now());
}

function classifyTrustedObservation(ctx: ToolContext, regionId: string): {
  outcome: InvestigationOutcome;
  observation: DensityObservation;
  trusted: boolean;
  reason: string;
} | null {
  const observation = ctx.safety.getObservationStore().latest(regionId);
  if (!observation) return null;
  const assessment = assessObservation(observation, ctx.scenario.config, ctx.now());
  if (!assessment.trusted) {
    return {
      outcome: observation.valid ? 'inconclusive' : 'unavailable',
      observation,
      trusted: false,
      reason: assessment.untrustedReasons.join('; ') || 'observation untrusted',
    };
  }
  const threshold = densityThreshold(ctx, regionId);
  const outcome: InvestigationOutcome = observation.estimated_density >= threshold
    ? 'signal_congested'
    : 'signal_normal';
  return { outcome, observation, trusted: true, reason: `density ${observation.estimated_density} vs high ${threshold}` };
}

function historyOutcome(ctx: ToolContext, regionId: string): {
  outcome: InvestigationOutcome;
  points: number;
  first_count: number | null;
  last_count: number | null;
} {
  const windowMinutes = Math.max(5, Math.round(ctx.scenario.config.trend_window_seconds / 60));
  const now = ctx.now();
  const points = ctx.safety.getObservationStore().window(
    regionId,
    new Date(now.getTime() - windowMinutes * 60_000),
    now,
  ).filter(item => item.valid);
  if (points.length < 2) {
    return { outcome: 'inconclusive', points: points.length, first_count: null, last_count: null };
  }
  const first = points[0].estimated_count;
  const last = points[points.length - 1].estimated_count;
  const outcome: InvestigationOutcome = last >= first * 1.15
    ? 'signal_congested'
    : last <= first * 0.85
      ? 'signal_normal'
      : 'inconclusive';
  return { outcome, points: points.length, first_count: first, last_count: last };
}

function predictionOutcome(ctx: ToolContext, regionId: string, prediction: PredictionResult): InvestigationOutcome {
  if (!prediction.sufficient || prediction.predicted_count === null) return 'inconclusive';
  const region = regionOf(ctx, regionId);
  const threshold = densityThreshold(ctx, regionId);
  const predictedDensity = prediction.predicted_count / region.area_m2;
  if (predictedDensity >= threshold) return 'signal_congested';
  if (prediction.trend.direction === 'rising') return 'signal_congested';
  if (prediction.trend.direction === 'falling') return 'signal_normal';
  return 'inconclusive';
}

function summarizeStatus(status: SafetyStatus) {
  return {
    state: status.state,
    versions: status.versions,
    risk_summary: status.risk_summary,
    plan: status.plan
      ? {
        plan_id: status.plan.plan_id,
        status: status.plan.status,
        total_persons: status.plan.total_persons,
        evacuated_persons: status.plan.evacuated_persons,
        unresolved_persons: status.plan.unresolved_persons,
        routes: status.plan.routes.length,
      }
      : null,
    candidate_plan: status.candidate_plan
      ? {
        plan_id: status.candidate_plan.plan_id,
        status: status.candidate_plan.status,
        unresolved_persons: status.candidate_plan.unresolved_persons,
      }
      : null,
    validation: status.validation
      ? { valid: status.validation.valid, violations: status.validation.violations.map(item => item.code) }
      : null,
  };
}

function agentActor(actor: OpsActor): OpsActor {
  return {
    username: actor.username,
    role: actor.role,
    kind: actor.kind ?? (actor.role === 'agent' ? 'agent' : 'human'),
  };
}

/** 由场景动作成本生成工单资源请求；缺配置时不伪造金额/时长。 */
function investigationResourceRequest(
  ctx: ToolContext,
  kind: 'staff_check' | 'uav_request',
  staffId: string | null | undefined,
) {
  const action = ctx.scenario.investigation?.actions.find(item => item.kind === kind);
  if (!action) return undefined;
  return {
    person_minutes: action.time_cost_minutes,
    budget_units: action.resource_cost,
    ...(staffId ? { staff_id: staffId } : {}),
  };
}

export function createToolDefinitions(ctx: ToolContext): ToolDefinition[] {
  const workOrderSchema = WorkOrderCreateSchema.omit({ submit: true }).extend({
    submit: z.literal(true).optional(),
  });

  return [
    {
      name: 'get_crowd_status',
      title: '读取人流态势',
      description: '返回指定区域或全部区域的当前人数、密度、置信度、时效、可信度与安全状态摘要。',
      inputSchema: z.object({ region_id: z.string().min(1).optional() }),
      roles: ALL_ROLES,
      source: 'safety-observation-store',
      timeout_ms: 3000,
      async handler(args, _actor) {
        const status = ctx.safety.getStatus();
        const regions = status.regions
          .filter(region => !args.region_id || region.id === args.region_id)
          .map(region => {
            const observation = ctx.safety.getObservationStore().latest(region.id);
            const assessment = latestAssessment(ctx, region.id);
            const risk = status.risks.find(item => item.regionId === region.id);
            return {
              region_id: region.id,
              region_name: region.name,
              area_m2: region.area_m2,
              observation: observation
                ? {
                  count: observation.estimated_count,
                  density: observation.estimated_density,
                  confidence: observation.confidence,
                  source: observation.source,
                  provider: observation.provider,
                  observed_at: observation.observed_at,
                  valid: observation.valid,
                  age_seconds: assessment ? Math.round(assessment.ageSeconds) : null,
                  trusted: assessment?.trusted ?? false,
                  untrusted_reasons: assessment?.untrustedReasons ?? [],
                }
                : null,
              risk: risk
                ? { level: risk.level, count: risk.count, density: risk.density, trusted: risk.trusted }
                : null,
            };
          });
        if (args.region_id && regions.length === 0) throw new Error(`unknown region: ${args.region_id}`);
        return ok({ state: status.state, regions, summary: summarizeStatus(status) }, 'safety-observation-store');
      },
    },
    {
      name: 'get_region_trend',
      title: '读取区域人流趋势',
      description: '返回区域时间序列、变化速率与预测趋势（预测由 ema-linear-v1 给出）。',
      inputSchema: z.object({
        region_id: z.string().min(1),
        window_minutes: z.number().int().positive().max(60).optional(),
      }),
      roles: ALL_ROLES,
      source: 'safety-observation-store+prediction',
      timeout_ms: 3000,
      async handler(args, _actor) {
        const windowMinutes = args.window_minutes ?? Math.max(5, Math.round(ctx.scenario.config.trend_window_seconds / 60));
        const now = ctx.now();
        const points = ctx.safety.getObservationStore().window(
          args.region_id,
          new Date(now.getTime() - windowMinutes * 60_000),
          now,
        );
        const prediction = ctx.prediction.predict(args.region_id, { windowMinutes, now });
        return ok({
          region_id: args.region_id,
          window_minutes: windowMinutes,
          points: points.map(item => ({
            observed_at: item.observed_at,
            count: item.estimated_count,
            density: item.estimated_density,
            confidence: item.confidence,
            source: item.source,
            valid: item.valid,
          })),
          prediction,
        }, prediction.sufficient ? 'safety-observation-store+prediction' : 'safety-observation-store', prediction.sufficient ? 0.8 : 0.4);
      },
    },
    {
      name: 'get_camera_status',
      title: '读取摄像头状态',
      description: '返回固定摄像头在线/降级/离线状态、最近观测时效与判定原因。',
      inputSchema: z.object({ region_id: z.string().min(1).optional() }),
      roles: ALL_ROLES,
      source: 'camera-health',
      timeout_ms: 3000,
      async handler(args, _actor) {
        return ok({ cameras: ctx.cameras(args.region_id) }, 'camera-health');
      },
    },
    {
      name: 'request_supplemental_observation',
      title: '请求补充观察',
      description: '查询其他摄像头或请求现场工作人员核查。摄像头查询直接返回证据；人员核查会创建待审批工单。',
      inputSchema: z.object({
        region_id: z.string().min(1),
        channel: z.enum(['camera', 'staff']),
        note: z.string().max(500).optional(),
      }),
      roles: OPERATOR_ROLES,
      source: 'camera-health+ops',
      timeout_ms: 5000,
      async handler(args, actor) {
        const region = regionOf(ctx, args.region_id);
        if (args.channel === 'camera') {
          const camera = cameraHealthFor(ctx.scenario, ctx.safety.getObservationStore(), args.region_id, ctx.now());
          const classified = classifyTrustedObservation(ctx, args.region_id);
          const outcome: InvestigationOutcome = camera.state !== 'online'
            ? (camera.state === 'offline' ? 'unavailable' : 'inconclusive')
            : classified?.outcome ?? 'unavailable';
          return ok({
            channel: 'camera',
            region_id: region.id,
            outcome,
            camera,
            evidence: classified && camera.state === 'online'
              ? {
                observation_id: classified.observation.id,
                count: classified.observation.estimated_count,
                density: classified.observation.estimated_density,
                confidence: classified.observation.confidence,
                observed_at: classified.observation.observed_at,
                trusted: classified.trusted,
                reason: classified.reason,
              }
              : null,
          }, 'camera-health', camera.confidence);
        }

        const recommendation = ctx.ops.recommendStaff({
          region_id: args.region_id,
          required_skills: ['crowd_check'],
        });
        const order = ctx.ops.createWorkOrder(agentActor(actor), {
          type: 'scene_verification',
          title: `${region.name}现场核查`,
          description: args.note ?? `请求工作人员核查 ${region.name} 的人流与通道状态，并回报现场情况。`,
          priority: 'high',
          region_id: args.region_id,
          required_skills: ['crowd_check'],
          evidence: [],
          recommendation: recommendation.recommended
            ? {
              staff_id: recommendation.recommended.staff_id,
              reasons: recommendation.recommended.reasons,
              score: recommendation.recommended.score,
            }
            : { staff_id: null, reasons: [recommendation.reason], score: null },
          submit: true,
          resource_request: investigationResourceRequest(
            ctx,
            'staff_check',
            recommendation.recommended?.staff_id,
          ),
        });
        return ok({
          channel: 'staff',
          region_id: region.id,
          outcome: 'inconclusive',
          pending: true,
          work_order: order,
          recommendation: {
            recommended: recommendation.recommended,
            shortage: recommendation.shortage,
            reason: recommendation.reason,
          },
        }, 'ops-work-order', null);
      },
    },
    {
      name: 'request_uav_observation',
      title: '申请无人机补充观察',
      description: '创建无人机观察请求（待审批）。无人机不会自动起飞，必须人工审批与持证操作员执行。',
      inputSchema: z.object({
        region_id: z.string().min(1),
        reason: z.string().min(1).max(500),
      }),
      roles: OPERATOR_ROLES,
      source: 'venue-uav+ops',
      timeout_ms: 5000,
      async handler(args, actor) {
        const region = regionOf(ctx, args.region_id);
        const units = ctx.scenario.venue?.uav_units ?? [];
        const availableUnits = units.filter(unit => unit.status === 'available');
        const recommendation = ctx.ops.recommendStaff({
          region_id: args.region_id,
          required_skills: ['uav_operation'],
          preferred_roles: ['uav_operator'],
        });
        const order = ctx.ops.createWorkOrder(agentActor(actor), {
          type: 'uav_observation',
          title: `${region.name}无人机补充观察`,
          description: `${args.reason}\n注：无人机起飞需现场负责人审批与持证操作员执行，系统不会自动起飞。`,
          priority: 'high',
          region_id: args.region_id,
          required_skills: ['uav_operation'],
          evidence: [],
          recommendation: recommendation.recommended
            ? {
              staff_id: recommendation.recommended.staff_id,
              reasons: recommendation.recommended.reasons,
              score: recommendation.recommended.score,
            }
            : { staff_id: null, reasons: [recommendation.reason], score: null },
          submit: true,
          resource_request: investigationResourceRequest(
            ctx,
            'uav_request',
            recommendation.recommended?.staff_id,
          ),
        });
        return ok({
          outcome: 'inconclusive',
          pending: true,
          requested: true,
          available_units: availableUnits,
          all_units: units,
          work_order: order,
          recommendation: {
            recommended: recommendation.recommended,
            shortage: recommendation.shortage,
          },
        }, 'venue-uav+ops', null);
      },
    },
    {
      name: 'get_venue_information',
      title: '读取场馆信息',
      description: '返回场馆名称、类型、区域、出口与无人机资源概况。',
      inputSchema: EmptyInput,
      roles: ALL_ROLES,
      source: 'scenario',
      timeout_ms: 2000,
      async handler(_args, _actor) {
        return ok({
          scenario_id: ctx.scenario.scenario_id,
          name: ctx.scenario.venue?.name ?? ctx.scenario.name,
          kind: ctx.scenario.venue?.kind ?? 'unknown',
          description: ctx.scenario.venue?.description ?? ctx.scenario.description,
          notice: ctx.scenario.notice,
          regions: ctx.scenario.regions.map(region => ({ id: region.id, name: region.name, area_m2: region.area_m2 })),
          exits: ctx.scenario.exits.map(exit => ({ id: exit.id, name: exit.name, region_id: exit.region_id, capacity_per_min: exit.capacity_per_min })),
          uav_units: ctx.scenario.venue?.uav_units ?? [],
        }, 'scenario', null);
      },
    },
    {
      name: 'get_venue_rules',
      title: '读取场馆管理规则',
      description: '返回与安全、审批、无人机、人员调度相关的场馆规则。',
      inputSchema: z.object({ category: z.string().min(1).optional() }),
      roles: ALL_ROLES,
      source: 'scenario-venue-rules',
      timeout_ms: 2000,
      async handler(args, _actor) {
        const rules = (ctx.scenario.venue?.rules ?? []).filter(rule => !args.category || rule.category === args.category);
        return ok({ rules, mandatory_count: rules.filter(rule => rule.mandatory).length }, 'scenario-venue-rules');
      },
    },
    {
      name: 'predict_crowd_trend',
      title: '预测短时人流',
      description: '调用 ema-linear-v1 预测区域短时人数、趋势方向与误差区间，并说明数据充分性。',
      inputSchema: z.object({
        region_id: z.string().min(1),
        horizon_minutes: z.number().int().positive().max(30).optional(),
      }),
      roles: ALL_ROLES,
      source: 'prediction:ema-linear-v1',
      timeout_ms: 3000,
      async handler(args, _actor) {
        const result = ctx.prediction.predict(args.region_id, { horizonMinutes: args.horizon_minutes, now: ctx.now() });
        return ok(result, 'prediction:ema-linear-v1', result.sufficient ? 0.8 : 0.4);
      },
    },
    {
      name: 'evaluate_region_risk',
      title: '评估区域风险',
      description: '结合安全域风险评估与短时预测，返回区域风险等级、趋势与可信度。',
      inputSchema: z.object({ region_id: z.string().min(1) }),
      roles: ALL_ROLES,
      source: 'safety-risk+prediction',
      timeout_ms: 3000,
      async handler(args, _actor) {
        const status = ctx.safety.getStatus();
        const risk = status.risks.find(item => item.regionId === args.region_id);
        if (!risk) throw new Error(`unknown region: ${args.region_id}`);
        const prediction = ctx.prediction.predict(args.region_id, { now: ctx.now() });
        return ok({
          region_id: args.region_id,
          risk,
          state: status.state.state,
          prediction: {
            predicted_count: prediction.predicted_count,
            trend: prediction.trend,
            sufficient: prediction.sufficient,
            uncertainty_note: prediction.uncertainty_note,
          },
        }, 'safety-risk+prediction', risk.trusted ? 0.8 : 0.4);
      },
    },
    {
      name: 'recommend_staff',
      title: '推荐工作人员',
      description: '按风险区域、技能、岗位与通道距离推荐可用工作人员，并给出分配理由。',
      inputSchema: z.object({
        region_id: z.string().min(1),
        required_skills: z.array(z.string()).optional(),
        preferred_roles: z.array(z.string()).optional(),
      }),
      roles: ALL_ROLES,
      source: 'ops-staff',
      timeout_ms: 3000,
      async handler(args, _actor) {
        const result = ctx.ops.recommendStaff({
          region_id: args.region_id,
          required_skills: args.required_skills,
          preferred_roles: args.preferred_roles,
        });
        return ok(result, 'ops-staff', result.recommended ? 0.7 : 0.4);
      },
    },
    {
      name: 'calculate_candidate_plan',
      title: '计算候选疏散方案',
      description: '调用时间扩展最小费用流规划器与独立校验器，返回状态、方案与校验结果。Agent 不自行计算路线。',
      inputSchema: z.object({ trigger: z.string().max(200).optional() }),
      roles: OPERATOR_ROLES,
      source: 'safety-planner+validator',
      timeout_ms: 10000,
      async handler(args, actor) {
        const result = ctx.safety.recompute(agentActor(actor), args.trigger ?? 'agent_tool_recompute');
        const status = ctx.safety.getStatus();
        return ok({
          snapshot: result.snapshot,
          plan: result.plan
            ? {
              plan_id: result.plan.plan_id,
              status: result.plan.status,
              total_persons: result.plan.total_persons,
              evacuated_persons: result.plan.evacuated_persons,
              unresolved_persons: result.plan.unresolved_persons,
              routes: result.plan.routes.map(route => ({
                route_id: route.route_id,
                from_region_id: route.from_region_id,
                exit_id: route.exit_id,
                persons: route.persons,
                steps: route.steps.length,
              })),
            }
            : null,
          validation: result.validation
            ? { valid: result.validation.valid, violations: result.validation.violations }
            : null,
          exclusions: result.exclusions,
          state: status.state,
          trace_id: result.trace.trace_id,
        }, 'safety-planner+validator', result.validation?.valid ? 0.9 : 0.5);
      },
    },
    {
      name: 'validate_candidate_plan',
      title: '独立校验候选方案',
      description: '对当前候选方案或给定方案执行独立安全校验；规划器不能自我认证。',
      inputSchema: z.object({}),
      roles: ['agent', 'admin', 'safety_operator', 'staff'],
      source: 'safety-validator',
      timeout_ms: 5000,
      async handler(_args, actor) {
        const status = ctx.safety.getStatus();
        const plan = status.candidate_plan ?? status.plan;
        if (!plan) return fail('当前没有可校验的候选方案', 'safety-validator');
        const validation = ctx.safety.validateCandidate(plan, agentActor(actor));
        return ok({ plan_id: plan.plan_id, validation }, 'safety-validator', validation.valid ? 0.9 : 0.3);
      },
    },
    {
      name: 'create_candidate_work_order',
      title: '创建候选工单',
      description: '创建待审批工单。Agent 只能创建 PENDING_APPROVAL，不能审批、不能派发。',
      inputSchema: workOrderSchema,
      roles: OPERATOR_ROLES,
      source: 'ops-work-order',
      timeout_ms: 5000,
      async handler(args, actor) {
        const preview = ctx.ops.previewReservation({ ...args, submit: true });
        if (!preview.eligible) {
          return {
            ok: false,
            data: { preview },
            source: 'ops-work-order',
            confidence: null,
            error: preview.reason ?? '资源或预算不足，无法创建工单',
            error_code: 'RESOURCE_UNAVAILABLE',
          };
        }
        const order = ctx.ops.createWorkOrder(agentActor(actor), { ...args, submit: true });
        return ok({ work_order: order, reservation: order.reservation, preview }, 'ops-work-order', null);
      },
    },
    {
      name: 'get_work_order_status',
      title: '查询工单状态',
      description: '按工单 ID、状态或工作人员查询工单及状态流转历史。',
      inputSchema: z.object({
        work_order_id: z.string().min(1).optional(),
        status: z.string().min(1).optional(),
        staff_id: z.string().min(1).optional(),
      }),
      roles: ALL_ROLES,
      source: 'ops-work-order',
      timeout_ms: 3000,
      async handler(args, _actor) {
        if (args.work_order_id) {
          const order = ctx.ops.getWorkOrder(args.work_order_id);
          if (!order) throw new Error(`work order not found: ${args.work_order_id}`);
          return ok({ work_order: order }, 'ops-work-order');
        }
        return ok({
          work_orders: ctx.ops.listWorkOrders({
            status: args.status as WorkOrderStatus | undefined,
            staff_id: args.staff_id,
          }),
        }, 'ops-work-order');
      },
    },
    {
      name: 'submit_worker_feedback',
      title: '提交现场反馈',
      description: '工作人员完成工单并提交现场反馈；反馈会写回安全域观测并触发重新评估。仅 staff 身份可用。',
      inputSchema: z.object({
        work_order_id: z.string().min(1),
        note: z.string().min(1).max(1000),
        observation: z.object({
          count: z.number().nonnegative(),
          confidence: z.number().min(0).max(1),
          valid: z.boolean().optional(),
          reason: z.string().max(200).optional(),
        }).optional(),
      }),
      roles: ['staff'],
      source: 'ops-work-order+field-report',
      timeout_ms: 5000,
      async handler(args, actor) {
        if (!actor.staff_id) throw new Error('staff 身份缺少 staff_id');
        const order = ctx.ops.getWorkOrder(args.work_order_id);
        if (!order) throw new Error(`work order not found: ${args.work_order_id}`);
        const updated = ctx.ops.complete(args.work_order_id, actor, {
          note: args.note,
          observation: args.observation,
        });
        return ok({ work_order: updated }, 'ops-work-order+field-report', args.observation?.confidence ?? null);
      },
    },
  ];
}

export class ToolRegistry {
  private definitions = new Map<string, ToolDefinition>();
  private actor: OpsActor;

  constructor(
    definitions: ToolDefinition[],
    private readonly recordAudit: ToolContext['recordAudit'],
    actor: OpsActor = { username: 'local-agent', role: 'agent', kind: 'agent' },
  ) {
    for (const definition of definitions) this.definitions.set(definition.name, definition);
    this.actor = actor;
  }

  setActor(actor: OpsActor): void {
    this.actor = actor;
  }

  getActor(): OpsActor {
    return this.actor;
  }

  list(): Array<Pick<ToolDefinition, 'name' | 'title' | 'description' | 'roles' | 'source' | 'timeout_ms'>> {
    return Array.from(this.definitions.values()).map(definition => ({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      roles: definition.roles,
      source: definition.source,
      timeout_ms: definition.timeout_ms,
    }));
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  async invoke(name: string, rawArgs: unknown, actor?: OpsActor): Promise<ToolResult> {
    const definition = this.definitions.get(name);
    const startedAt = Date.now();
    const generatedAt = new Date().toISOString();
    const effectiveActor = actor ?? this.actor;

    if (!definition) {
      return { tool: name, ok: false, data: null, source: 'tool-registry', confidence: null, error: `unknown tool: ${name}`, error_code: 'UNKNOWN_TOOL', generated_at: generatedAt };
    }
    if (!definition.roles.includes(effectiveActor.role)) {
      return {
        tool: name,
        ok: false,
        data: null,
        source: definition.source,
        confidence: null,
        error: `角色 ${effectiveActor.role} 无权调用 ${name}（允许：${definition.roles.join('/')}）`,
        error_code: 'FORBIDDEN',
        generated_at: generatedAt,
        duration_ms: Date.now() - startedAt,
      };
    }

    const parsed = definition.inputSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        tool: name,
        ok: false,
        data: null,
        source: definition.source,
        confidence: null,
        error: `参数校验失败：${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`,
        error_code: 'INVALID_ARGUMENT',
        generated_at: generatedAt,
        duration_ms: Date.now() - startedAt,
      };
    }

    try {
      const result = await Promise.race([
        definition.handler(parsed.data, effectiveActor),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`tool timeout after ${definition.timeout_ms}ms`)), definition.timeout_ms);
        }),
      ]);
      const duration = Date.now() - startedAt;
      this.recordAudit({
        tool: name,
        actor: effectiveActor,
        args: parsed.data,
        result: result.ok ? 'success' : 'failure',
        error: result.error,
        duration_ms: duration,
        source: definition.source,
      });
      return {
        tool: name,
        ...result,
        error_code: result.ok ? undefined : (result.error_code ?? 'EXECUTION_ERROR'),
        generated_at: generatedAt,
        duration_ms: duration,
      };
    } catch (error) {
      const duration = Date.now() - startedAt;
      const message = (error as Error).message;
      this.recordAudit({
        tool: name,
        actor: effectiveActor,
        args: parsed.data,
        result: 'failure',
        error: message,
        duration_ms: duration,
        source: definition.source,
      });
      return {
        tool: name,
        ok: false,
        data: null,
        source: definition.source,
        confidence: null,
        error: message,
        error_code: /timeout/i.test(message) ? 'TIMEOUT' : 'EXECUTION_ERROR',
        generated_at: generatedAt,
        duration_ms: duration,
      };
    }
  }
}

export function evidenceFromTool(result: ToolResult, kind: string, summary: string): {
  evidence_id: string;
  kind: string;
  summary: string;
  source: string;
  confidence: number | null;
  observed_at: string;
} {
  return {
    evidence_id: `EV-${randomUUID().slice(0, 8)}`,
    kind,
    summary,
    source: result.source,
    confidence: result.confidence,
    observed_at: result.generated_at,
  };
}
