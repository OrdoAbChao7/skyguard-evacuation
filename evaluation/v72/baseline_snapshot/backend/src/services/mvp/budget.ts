/**
 * 调查预算准入（单一判定实现，多个调用入口）。
 *
 * 问题（G04）：旧实现只比较"已用成本 >= 上限"，没有把候选动作本身的成本
 * 计入，因此 0.9 + 1.0 在 1.0 上限下会被错误放行。本模块统一为：
 *
 *   used + reserved + candidate <= max
 *
 * 资源成本沿用场景中的归一化单位（0~1），时间单位为分钟。比较使用 1e-9
 * 容差，只用于吸收浮点表示误差；展示层四舍五入不得反过来决定准入。
 *
 * 该模块只判定调查业务预算，不参与疏散规划；独立 Validator 仍自行重建
 * 安全约束，二者不得共用"规划结果"。
 */
import type { InvestigationAction, InvestigationPolicy } from '../safety/types';

export interface BudgetUsage {
  used_actions: number;
  used_cost: number;
  used_time_minutes: number;
  reserved_actions?: number;
  reserved_cost?: number;
  reserved_time_minutes?: number;
}

export type BudgetReasonCode =
  | 'OK'
  | 'NO_BUDGET'
  | 'INVALID_USAGE'
  | 'INVALID_CANDIDATE'
  | 'ACTION_BUDGET_EXCEEDED'
  | 'COST_BUDGET_EXCEEDED'
  | 'TIME_BUDGET_EXCEEDED';

export interface BudgetRemaining {
  actions: number | null;
  cost: number | null;
  time_minutes: number | null;
}

export interface BudgetDecision {
  eligible: boolean;
  reason_code: BudgetReasonCode;
  reason: string | null;
  remaining: BudgetRemaining;
  /** 用于审计/复现的输入快照。 */
  context: {
    used_actions: number;
    used_cost: number;
    used_time_minutes: number;
    reserved_actions: number;
    reserved_cost: number;
    reserved_time_minutes: number;
    candidate_cost: number;
    candidate_time_minutes: number;
  };
}

const EPSILON = 1e-9;

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeUsage(usage: BudgetUsage): Required<BudgetUsage> {
  return {
    used_actions: usage.used_actions,
    used_cost: usage.used_cost,
    used_time_minutes: usage.used_time_minutes,
    reserved_actions: usage.reserved_actions ?? 0,
    reserved_cost: usage.reserved_cost ?? 0,
    reserved_time_minutes: usage.reserved_time_minutes ?? 0,
  };
}

function usageIsValid(usage: Required<BudgetUsage>): boolean {
  return finiteNonNegative(usage.used_actions)
    && finiteNonNegative(usage.used_cost)
    && finiteNonNegative(usage.used_time_minutes)
    && finiteNonNegative(usage.reserved_actions)
    && finiteNonNegative(usage.reserved_cost)
    && finiteNonNegative(usage.reserved_time_minutes);
}

function candidateIsValid(action: InvestigationAction): boolean {
  return finiteNonNegative(action.resource_cost) && finiteNonNegative(action.time_cost_minutes);
}

/**
 * 判定一个候选动作能否在当前预算下执行。
 * 预算缺省时放行（NO_BUDGET），因为是否启用调查由场景策略另行控制。
 */
export function checkCandidateBudget(
  policy: InvestigationPolicy,
  action: InvestigationAction,
  usageInput: BudgetUsage,
): BudgetDecision {
  const usage = normalizeUsage(usageInput);
  const context = {
    ...usage,
    candidate_cost: action.resource_cost,
    candidate_time_minutes: action.time_cost_minutes,
  };
  const emptyRemaining: BudgetRemaining = { actions: null, cost: null, time_minutes: null };

  if (!usageIsValid(usage)) {
    return {
      eligible: false,
      reason_code: 'INVALID_USAGE',
      reason: '预算用量包含非法数值（NaN/无穷/负数），拒绝准入',
      remaining: emptyRemaining,
      context,
    };
  }
  if (!candidateIsValid(action)) {
    return {
      eligible: false,
      reason_code: 'INVALID_CANDIDATE',
      reason: '候选动作成本或时间非法，拒绝准入',
      remaining: emptyRemaining,
      context,
    };
  }

  const budget = policy.budget;
  if (!budget) {
    return { eligible: true, reason_code: 'NO_BUDGET', reason: null, remaining: emptyRemaining, context };
  }

  const actionsUsed = usage.used_actions + usage.reserved_actions;
  const costUsed = usage.used_cost + usage.reserved_cost;
  const timeUsed = usage.used_time_minutes + usage.reserved_time_minutes;
  const remaining: BudgetRemaining = {
    actions: Math.max(0, budget.max_actions - actionsUsed),
    cost: Number(Math.max(0, budget.max_total_cost - costUsed).toFixed(6)),
    time_minutes: Number(Math.max(0, budget.max_total_time_minutes - timeUsed).toFixed(6)),
  };

  if (actionsUsed + 1 > budget.max_actions + EPSILON) {
    return {
      eligible: false,
      reason_code: 'ACTION_BUDGET_EXCEEDED',
      reason: `调查动作预算 ${budget.max_actions} 已用 ${actionsUsed}，候选动作将超限`,
      remaining,
      context,
    };
  }
  if (costUsed + action.resource_cost > budget.max_total_cost + EPSILON) {
    return {
      eligible: false,
      reason_code: 'COST_BUDGET_EXCEEDED',
      reason: `调查资源预算 ${budget.max_total_cost}，已用/预留 ${costUsed.toFixed(4)}，候选 ${action.resource_cost} 将超限`,
      remaining,
      context,
    };
  }
  if (timeUsed + action.time_cost_minutes > budget.max_total_time_minutes + EPSILON) {
    return {
      eligible: false,
      reason_code: 'TIME_BUDGET_EXCEEDED',
      reason: `调查时间预算 ${budget.max_total_time_minutes} 分钟，已用/预留 ${timeUsed.toFixed(4)}，候选 ${action.time_cost_minutes} 将超限`,
      remaining,
      context,
    };
  }

  return { eligible: true, reason_code: 'OK', reason: null, remaining, context };
}

/** 当前状态下是否所有候选动作都无法准入（用于停止原因与"预算耗尽"语义）。 */
export function allCandidatesBlocked(
  policy: InvestigationPolicy,
  usage: BudgetUsage,
): boolean {
  return policy.actions.every(action => !checkCandidateBudget(policy, action, usage).eligible);
}
