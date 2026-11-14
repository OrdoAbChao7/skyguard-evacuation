import { z } from 'zod';
import {
  ALL_ROLES,
  OPERATOR_ROLES,
  ok,
  fail,
  agentActor,
  type ToolContext,
  type ToolDefinition,
} from '../core';

export function planningTools(ctx: ToolContext): ToolDefinition[] {
  return [
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
  ];
}
