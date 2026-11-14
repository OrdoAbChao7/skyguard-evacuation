/**
 * 资源预留、预算结算与过期回收。
 *
 * 函数通过 ReservationContext 读写 OpsService 的内存状态；
 * 不直接持有服务实例，便于独立测试和复用。
 */
import { randomUUID } from 'node:crypto';
import type { AuditLog } from '../../safety/audit';
import type { SafetyScenario, StaffMember } from '../../safety/types';
import {
  BUDGET_EPSILON,
  ResourceUnavailableError,
  WorkOrderCreateSchema,
  type RecommendStaffResult,
  type ReservationPreview,
  type ResourceReservation,
  type WorkOrder,
  type WorkOrderCreateInput,
} from './model';

export interface ReservationContext {
  scenario: SafetyScenario;
  workOrders: Map<string, WorkOrder>;
  staffStatus: Map<string, StaffMember['status']>;
  budgetSettled: { actions: number; cost: number; person_minutes: number };
  audit: AuditLog;
  currentVersion(): { observation: number; constraint: number; scenario: string };
  persist(): void;
  getStaff(staffId: string): (StaffMember & { runtime_status: string }) | undefined;
  recommendStaff(input: {
    region_id: string;
    required_skills?: string[];
    preferred_roles?: string[];
  }): RecommendStaffResult;
}

function activeReservationTotals(
  workOrders: Map<string, WorkOrder>,
): { actions: number; cost: number; person_minutes: number } {
  let actions = 0;
  let cost = 0;
  let personMinutes = 0;
  for (const order of workOrders.values()) {
    const reservation = order.reservation;
    if (!reservation?.budget_tracked) continue;
    if (reservation.state !== 'HELD' && reservation.state !== 'CONFIRMED') continue;
    actions += 1;
    cost += reservation.budget_units;
    personMinutes += reservation.person_minutes;
  }
  return {
    actions,
    cost: Number(cost.toFixed(6)),
    person_minutes: Number(personMinutes.toFixed(6)),
  };
}

export function budgetSnapshot(
  scenario: SafetyScenario,
  workOrders: Map<string, WorkOrder>,
  budgetSettled: { actions: number; cost: number; person_minutes: number },
): ReservationPreview['budget'] {
  const budget = scenario.investigation?.budget ?? null;
  const reserved = activeReservationTotals(workOrders);
  const settled = {
    actions: budgetSettled.actions,
    cost: Number(budgetSettled.cost.toFixed(6)),
    person_minutes: Number(budgetSettled.person_minutes.toFixed(6)),
  };
  return {
    max_actions: budget?.max_actions ?? null,
    max_total_cost: budget?.max_total_cost ?? null,
    max_total_time_minutes: budget?.max_total_time_minutes ?? null,
    settled,
    reserved,
    remaining: {
      actions: budget ? Math.max(0, budget.max_actions - settled.actions - reserved.actions) : null,
      cost: budget ? Number(Math.max(0, budget.max_total_cost - settled.cost - reserved.cost).toFixed(6)) : null,
      person_minutes: budget
        ? Number(Math.max(0, budget.max_total_time_minutes - settled.person_minutes - reserved.person_minutes).toFixed(6))
        : null,
    },
  };
}

/**
 * 选择要软预留的工作人员：显式请求必须可用；推荐人员不可用时重新推荐。
 * 返回 null 表示没有可预留人员，但工单仍可进入待审批（派发时再检查）。
 */
function chooseHoldStaff(
  ctx: ReservationContext,
  input: WorkOrderCreateInput,
  strictExplicit: boolean,
): string | null {
  const explicit = input.resource_request?.staff_id;
  if (explicit) {
    const member = ctx.getStaff(explicit);
    if (!member) throw new ResourceUnavailableError(`unknown staff: ${explicit}`);
    if (member.runtime_status !== 'available') {
      throw new ResourceUnavailableError(`工作人员 ${explicit} 当前为 ${member.runtime_status}，不可预留`);
    }
    return explicit;
  }
  const recommended = input.recommendation?.staff_id;
  if (recommended) {
    const member = ctx.getStaff(recommended);
    if (member?.runtime_status === 'available') return recommended;
  }
  if (input.region_id) {
    const recommendation = ctx.recommendStaff({
      region_id: input.region_id,
      required_skills: input.required_skills,
    });
    return recommendation.recommended?.staff_id ?? null;
  }
  if (strictExplicit) return null;
  return null;
}

/** 候选工单的资源与预算预检；不产生任何预留。 */
export function previewReservation(
  ctx: ReservationContext,
  input: WorkOrderCreateInput,
): ReservationPreview {
  sweepExpiredReservations(ctx);
  const parsed = WorkOrderCreateSchema.parse(input);
  const budget = budgetSnapshot(ctx.scenario, ctx.workOrders, ctx.budgetSettled);
  let staffId: string | null = null;
  try {
    staffId = chooseHoldStaff(ctx, parsed, true);
  } catch (error) {
    return {
      eligible: false,
      reason_code: error instanceof ResourceUnavailableError && /unknown staff/.test(error.message)
        ? 'UNKNOWN_STAFF'
        : 'STAFF_UNAVAILABLE',
      reason: (error as Error).message,
      staff_id: null,
      budget,
    };
  }

  const request = parsed.resource_request;
  if (!request) {
    return { eligible: true, reason_code: 'NO_BUDGET', reason: null, staff_id: staffId, budget };
  }
  if (budget.max_actions === null) {
    return { eligible: true, reason_code: 'NO_BUDGET', reason: null, staff_id: staffId, budget };
  }

  const actionsUsed = budget.settled.actions + budget.reserved.actions;
  const costUsed = budget.settled.cost + budget.reserved.cost;
  const minutesUsed = budget.settled.person_minutes + budget.reserved.person_minutes;
  if (actionsUsed + 1 > budget.max_actions! + BUDGET_EPSILON) {
    return {
      eligible: false,
      reason_code: 'ACTION_BUDGET_EXCEEDED',
      reason: `调查动作预算 ${budget.max_actions} 已用/预留 ${actionsUsed}，候选工单将超限`,
      staff_id: staffId,
      budget,
    };
  }
  if (costUsed + request.budget_units > budget.max_total_cost! + BUDGET_EPSILON) {
    return {
      eligible: false,
      reason_code: 'COST_BUDGET_EXCEEDED',
      reason: `调查预算 ${budget.max_total_cost}，已用/预留 ${costUsed.toFixed(4)}，候选 ${request.budget_units} 将超限`,
      staff_id: staffId,
      budget,
    };
  }
  if (minutesUsed + request.person_minutes > budget.max_total_time_minutes! + BUDGET_EPSILON) {
    return {
      eligible: false,
      reason_code: 'TIME_BUDGET_EXCEEDED',
      reason: `调查时间预算 ${budget.max_total_time_minutes} 分钟，已用/预留 ${minutesUsed.toFixed(4)}，候选 ${request.person_minutes} 将超限`,
      staff_id: staffId,
      budget,
    };
  }
  return { eligible: true, reason_code: 'OK', reason: null, staff_id: staffId, budget };
}

export function buildReservation(
  ctx: ReservationContext,
  input: WorkOrderCreateInput,
  staffId: string | null,
): ResourceReservation {
  const request = input.resource_request;
  const ttlMinutes = request?.ttl_minutes
    ?? ctx.scenario.config.work_order_reservation_ttl_minutes
    ?? 15;
  const now = new Date();
  return {
    reservation_id: `RES-${randomUUID().slice(0, 8).toUpperCase()}`,
    state: 'HELD',
    staff_id: staffId,
    person_minutes: request?.person_minutes ?? 0,
    budget_units: request?.budget_units ?? 0,
    budget_tracked: Boolean(request),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    confirmed_at: null,
    released_at: null,
    release_reason: null,
    scenario_version: ctx.currentVersion().scenario,
    context_version: ctx.currentVersion(),
  };
}

export function releaseReservation(
  ctx: ReservationContext,
  order: WorkOrder,
  state: 'RELEASED' | 'EXPIRED',
  reason: string,
  settleBudget = false,
): boolean {
  const reservation = order.reservation;
  if (!reservation) return false;
  if (reservation.state === 'RELEASED' || reservation.state === 'EXPIRED') return false;
  if (reservation.staff_id) {
    const current = ctx.staffStatus.get(reservation.staff_id);
    if (current === 'reserved' || current === 'busy') {
      ctx.staffStatus.set(reservation.staff_id, 'available');
    }
  }
  if (settleBudget && reservation.budget_tracked) {
    ctx.budgetSettled.actions += 1;
    ctx.budgetSettled.cost = Number((ctx.budgetSettled.cost + reservation.budget_units).toFixed(6));
    ctx.budgetSettled.person_minutes = Number(
      (ctx.budgetSettled.person_minutes + reservation.person_minutes).toFixed(6),
    );
  }
  reservation.state = state;
  reservation.released_at = new Date().toISOString();
  reservation.release_reason = reason;
  return true;
}

/** 释放所有已过期的 HELD 预留；工单本身保持待审批，但需要重新确认资源。 */
export function sweepExpiredReservations(
  ctx: ReservationContext,
  now: Date = new Date(),
): void {
  let changed = false;
  for (const order of ctx.workOrders.values()) {
    const reservation = order.reservation;
    if (!reservation || reservation.state !== 'HELD') continue;
    if (new Date(reservation.expires_at).getTime() > now.getTime()) continue;
    releaseReservation(ctx, order, 'EXPIRED', '资源预留过期');
    order.updated_at = now.toISOString();
    order.history.push({
      ts: now.toISOString(),
      status: order.status,
      actor: 'system',
      role: 'system',
      note: '资源预留过期，已释放；需管理员重新确认',
    });
    ctx.audit.record({
      actor: 'system',
      role: 'system',
      action: 'work_order.reservation_expired',
      entity_type: 'work_order',
      entity_id: order.id,
      summary: `工单 ${order.id} 的资源预留已过期并释放`,
      result: 'success',
      after: { reservation_id: reservation.reservation_id },
    });
    changed = true;
  }
  if (changed) ctx.persist();
}
