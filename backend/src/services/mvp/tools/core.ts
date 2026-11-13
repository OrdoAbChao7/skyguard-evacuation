/**
 * 工具层共享类型与纯辅助函数。
 *
 * 工具定义按领域拆分到 definitions/ 下，本文件只保留与具体工具无关的契约。
 */
import { z } from 'zod';
import type { SafetyScenario, InvestigationOutcome, DensityObservation } from '../../safety/types';
import type { SafetyDecisionService, SafetyStatus } from '../../safety/decision-service';
import { assessObservation } from '../../safety/observations';
import type { PredictionService } from '../prediction';
import type { OpsActor, OpsService } from '../ops';
import type { CameraHealth, ReplayService } from '../ingest';

export const ALL_ROLES = ['agent', 'admin', 'safety_operator', 'staff', 'viewer'];
export const OPERATOR_ROLES = ['agent', 'admin', 'safety_operator'];

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

export const EmptyInput = z.object({}).passthrough();

export function ok<T>(data: T, source: string, confidence: number | null = null) {
  return { ok: true, data, source, confidence };
}

export function fail(error: string, source: string) {
  return { ok: false, data: null, source, confidence: null, error };
}

export function regionOf(ctx: ToolContext, regionId: string) {
  const region = ctx.scenario.regions.find(item => item.id === regionId);
  if (!region) throw new Error(`unknown region: ${regionId}`);
  return region;
}

export function densityThreshold(ctx: ToolContext, regionId: string): number {
  const region = regionOf(ctx, regionId);
  return region.thresholds?.high_density ?? ctx.scenario.config.default_thresholds.high_density;
}

export function latestAssessment(ctx: ToolContext, regionId: string) {
  const observation = ctx.safety.getObservationStore().latest(regionId);
  if (!observation) return null;
  return assessObservation(observation, ctx.scenario.config, ctx.now());
}

export function classifyTrustedObservation(ctx: ToolContext, regionId: string): {
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

export function summarizeStatus(status: SafetyStatus) {
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

export function agentActor(actor: OpsActor): OpsActor {
  return {
    username: actor.username,
    role: actor.role,
    kind: actor.kind ?? (actor.role === 'agent' ? 'agent' : 'human'),
  };
}

/** 由场景动作成本生成工单资源请求；缺配置时不伪造金额/时长。 */
export function investigationResourceRequest(
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
