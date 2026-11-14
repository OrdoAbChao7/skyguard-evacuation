import { z } from 'zod';
import { WorkOrderCreateSchema, type WorkOrderStatus } from '../../ops';
import {
  ALL_ROLES,
  OPERATOR_ROLES,
  ok,
  agentActor,
  type ToolContext,
  type ToolDefinition,
} from '../core';

export function workOrderTools(ctx: ToolContext): ToolDefinition[] {
  const workOrderSchema = WorkOrderCreateSchema.omit({ submit: true }).extend({
    submit: z.literal(true).optional(),
  });

  return [
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
