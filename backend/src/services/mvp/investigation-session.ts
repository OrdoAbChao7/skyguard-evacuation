/**
 * 序贯调查会话：预算、重试、冷却/退避、证据冲突与停止条件。
 *
 * 这是对单次 VoI 决策的工程化补充：
 *  - 同一动作失败后按指数退避冷却；
 *  - 动作尝试次数受 max_retries 限制；
 *  - 会话总动作数/资源/时间受 policy.budget 限制；
 *  - 相反证据在时间窗内出现时标记冲突，并按折扣更新信念。
 */
import type { InvestigationAction, InvestigationKind, InvestigationOutcome, InvestigationPolicy } from '../safety/types';
import { applyEvidence, entropy, type BeliefEntry } from './voi';
import { allCandidatesBlocked, checkCandidateBudget } from './budget';

export interface InvestigationAttempt {
  actionId: string;
  kind: InvestigationKind;
  at: string;
  success: boolean;
  outcome: InvestigationOutcome;
  cost: number;
  timeMinutes: number;
}

export interface EvidenceRecord {
  actionId: string;
  kind: InvestigationKind;
  outcome: InvestigationOutcome;
  at: string;
}

export interface EvidenceConflict {
  detected: boolean;
  previous: InvestigationOutcome | null;
  current: InvestigationOutcome;
  at: string;
  note: string;
}

export interface InvestigationSession {
  regionId: string;
  attempts: InvestigationAttempt[];
  spentCost: number;
  spentTimeMinutes: number;
  evidence: EvidenceRecord[];
  conflicts: EvidenceConflict[];
}

export function createInvestigationSession(regionId: string): InvestigationSession {
  return {
    regionId,
    attempts: [],
    spentCost: 0,
    spentTimeMinutes: 0,
    evidence: [],
    conflicts: [],
  };
}

export interface ActionAvailability {
  available: boolean;
  reason: string | null;
  nextAvailableAt: string | null;
  attempts: number;
  maxAttempts: number;
}

export function actionAvailability(
  policy: InvestigationPolicy,
  action: InvestigationAction,
  session: InvestigationSession,
  now: Date = new Date(),
): ActionAvailability {
  const attempts = session.attempts.filter(item => item.actionId === action.id);
  const maxAttempts = 1 + (action.retry?.max_retries ?? 0);
  if (attempts.length >= maxAttempts) {
    return { available: false, reason: `已达到最大尝试次数 ${maxAttempts}`, nextAvailableAt: null, attempts: attempts.length, maxAttempts };
  }
  const budget = policy.budget;
  if (budget) {
    // G04：候选动作自身成本也必须计入；只检查"已用 >= 上限"会放行越界动作。
    const budgetDecision = checkCandidateBudget(policy, action, {
      used_actions: session.attempts.length,
      used_cost: session.spentCost,
      used_time_minutes: session.spentTimeMinutes,
    });
    if (!budgetDecision.eligible) {
      return {
        available: false,
        reason: budgetDecision.reason ?? '调查预算不足',
        nextAvailableAt: null,
        attempts: attempts.length,
        maxAttempts,
      };
    }
  }
  if (attempts.length > 0 && action.retry && action.retry.cooldown_minutes > 0) {
    const last = attempts[attempts.length - 1];
    const failures = attempts.filter(item => !item.success).length;
    const cooldown = action.retry.cooldown_minutes * Math.pow(action.retry.backoff_factor, Math.max(0, failures - 1));
    const nextAt = new Date(new Date(last.at).getTime() + cooldown * 60_000);
    if (now.getTime() < nextAt.getTime()) {
      return {
        available: false,
        reason: `冷却中（${cooldown.toFixed(1)} 分钟）`,
        nextAvailableAt: nextAt.toISOString(),
        attempts: attempts.length,
        maxAttempts,
      };
    }
  }
  return { available: true, reason: null, nextAvailableAt: null, attempts: attempts.length, maxAttempts };
}

export function recordAttempt(
  session: InvestigationSession,
  action: InvestigationAction,
  result: { success: boolean; outcome: InvestigationOutcome },
  now: Date = new Date(),
): InvestigationAttempt {
  const attempt: InvestigationAttempt = {
    actionId: action.id,
    kind: action.kind,
    at: now.toISOString(),
    success: result.success,
    outcome: result.outcome,
    cost: action.resource_cost,
    timeMinutes: action.time_cost_minutes,
  };
  session.attempts.push(attempt);
  session.spentCost = Number((session.spentCost + action.resource_cost).toFixed(4));
  session.spentTimeMinutes = Number((session.spentTimeMinutes + action.time_cost_minutes).toFixed(4));
  if (result.outcome === 'signal_normal' || result.outcome === 'signal_congested') {
    session.evidence.push({ actionId: action.id, kind: action.kind, outcome: result.outcome, at: attempt.at });
  }
  return attempt;
}

const OPPOSITE: Record<string, string> = {
  signal_normal: 'signal_congested',
  signal_congested: 'signal_normal',
};

/** 冲突判定时间窗：优先取场景配置，缺省沿用历史默认 10 分钟。 */
export function conflictWindowMinutes(policy: InvestigationPolicy): number {
  return policy.conflict?.window_minutes ?? 10;
}

export function detectEvidenceConflict(
  session: InvestigationSession,
  kind: InvestigationKind,
  outcome: InvestigationOutcome,
  now: Date = new Date(),
  windowMinutes = 10,
): EvidenceConflict {
  if (outcome !== 'signal_normal' && outcome !== 'signal_congested') {
    return { detected: false, previous: null, current: outcome, at: now.toISOString(), note: '非信息性结果不参与冲突判定' };
  }
  const from = now.getTime() - windowMinutes * 60_000;
  const previous = session.evidence
    .filter(item => item.kind === kind && new Date(item.at).getTime() >= from && item.outcome === OPPOSITE[outcome])
    .slice(-1)[0] ?? null;
  const conflict: EvidenceConflict = {
    detected: Boolean(previous),
    previous: previous?.outcome ?? null,
    current: outcome,
    at: now.toISOString(),
    note: previous ? `同一类动作在 ${windowMinutes} 分钟内给出相反证据，需要第二来源核实` : '未发现相反证据',
  };
  if (conflict.detected) session.conflicts.push(conflict);
  return conflict;
}

/** 冲突时把后验与先验按场景系数混合，避免单条矛盾证据过度改变信念。 */
export function applyEvidenceWithConflict(
  policy: InvestigationPolicy,
  belief: BeliefEntry[],
  kind: InvestigationKind,
  outcome: InvestigationOutcome,
  conflict: EvidenceConflict,
): { belief: BeliefEntry[]; entropy: number; blend_prior: number; blend_source: 'scenario' | 'legacy_default' } {
  const blendPrior = policy.conflict?.blend_prior ?? 0.5;
  const posterior = applyEvidence(policy, belief, kind, outcome);
  const blended = conflict.detected
    ? posterior.map((entry, index) => ({
      ...entry,
      probability: blendPrior * entry.probability + (1 - blendPrior) * belief[index].probability,
    }))
    : posterior;
  const total = blended.reduce((sum, entry) => sum + entry.probability, 0);
  const normalized = blended.map(entry => ({ ...entry, probability: entry.probability / total }));
  return {
    belief: normalized,
    entropy: Number(entropy(normalized).toFixed(6)),
    blend_prior: blendPrior,
    blend_source: policy.conflict?.blend_prior === undefined ? 'legacy_default' : 'scenario',
  };
}

export function budgetExhausted(policy: InvestigationPolicy, session: InvestigationSession): boolean {
  if (!policy.budget) return false;
  // 只有所有候选动作都无法准入时才算预算耗尽；单个贵动作超限不应阻断便宜动作。
  return allCandidatesBlocked(policy, {
    used_actions: session.attempts.length,
    used_cost: session.spentCost,
    used_time_minutes: session.spentTimeMinutes,
  });
}
