/**
 * V7.5 多目标选择（研究模块）。
 *
 * 支持：
 *  - Pareto 非支配前沿；
 *  - 归一化膝点选择（按优先级权重）；
 *  - 硬约束筛选（未疏散、容量、完成时间上限）。
 *
 * 边界：本模块只做候选排序，不生成候选，也不替代安全校验；
 * 权重/约束必须与结果一起报告，不能只展示有利前沿点。
 */

export interface ObjectiveVector {
  /** 未疏散人数（越小越好）。 */
  unresolved: number;
  /** 完成时间（分钟，越小越好）。 */
  makespan: number;
  /** 队列人·分钟（越小越好）。 */
  queuePersonMinutes: number;
  /** 切换人数（越小越好）。 */
  switchPersons: number;
  /** 紧急响应延迟（分钟，越小越好）。 */
  emergencyDelay: number;
}

export type Priority = 'efficiency' | 'stability' | 'safety' | 'balanced';

export const PRIORITY_WEIGHTS: Record<Priority, ObjectiveVector> = {
  efficiency: { unresolved: 100, makespan: 1, queuePersonMinutes: 0.05, switchPersons: 0.005, emergencyDelay: 0.2 },
  stability: { unresolved: 100, makespan: 0.2, queuePersonMinutes: 0.01, switchPersons: 2, emergencyDelay: 0.02 },
  safety: { unresolved: 1000, makespan: 0.2, queuePersonMinutes: 0.01, switchPersons: 0.005, emergencyDelay: 1 },
  balanced: { unresolved: 200, makespan: 0.6, queuePersonMinutes: 0.03, switchPersons: 0.01, emergencyDelay: 0.5 },
};

export const OBJECTIVE_KEYS: Array<keyof ObjectiveVector> = [
  'unresolved', 'makespan', 'queuePersonMinutes', 'switchPersons', 'emergencyDelay',
];

export function dominates(a: ObjectiveVector, b: ObjectiveVector): boolean {
  let strictlyBetter = false;
  for (const key of OBJECTIVE_KEYS) {
    if (a[key] > b[key] + 1e-9) return false;
    if (a[key] < b[key] - 1e-9) strictlyBetter = true;
  }
  return strictlyBetter;
}

export interface ParetoCandidate<T> {
  id: string;
  vector: ObjectiveVector;
  payload: T;
}

export function paretoFront<T>(candidates: ParetoCandidate<T>[]): ParetoCandidate<T>[] {
  return candidates.filter((candidate, index) => {
    return !candidates.some((other, otherIndex) => {
      if (index === otherIndex) return false;
      return dominates(other.vector, candidate.vector);
    });
  });
}

export function normalizeVectors<T>(candidates: ParetoCandidate<T>[]): Map<string, ObjectiveVector> {
  const result = new Map<string, ObjectiveVector>();
  const ranges = new Map<keyof ObjectiveVector, { min: number; max: number }>();
  for (const key of OBJECTIVE_KEYS) {
    const values = candidates.map(candidate => candidate.vector[key]);
    ranges.set(key, { min: Math.min(...values), max: Math.max(...values) });
  }
  for (const candidate of candidates) {
    const normalized = {} as ObjectiveVector;
    for (const key of OBJECTIVE_KEYS) {
      const range = ranges.get(key)!;
      normalized[key] = range.max - range.min < 1e-9
        ? 0
        : (candidate.vector[key] - range.min) / (range.max - range.min);
    }
    result.set(candidate.id, normalized);
  }
  return result;
}

export function weightedScore(vector: ObjectiveVector, weights: ObjectiveVector): number {
  return OBJECTIVE_KEYS.reduce((sum, key) => sum + vector[key] * weights[key], 0);
}

/** 膝点：归一化后加权距离最小者。权重决定优先方向。 */
export function selectKnee<T>(
  front: ParetoCandidate<T>[],
  priority: Priority,
  weightOverrides: Partial<ObjectiveVector> = {},
): ParetoCandidate<T> | null {
  if (front.length === 0) return null;
  const weights = { ...PRIORITY_WEIGHTS[priority], ...weightOverrides };
  const normalized = normalizeVectors(front);
  let best: ParetoCandidate<T> | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of front) {
    const score = weightedScore(normalized.get(candidate.id)!, weights);
    if (score < bestScore - 1e-9) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export interface ObjectiveConstraints {
  maxUnresolved?: number;
  maxMakespan?: number;
  maxQueuePersonMinutes?: number;
  maxSwitchPersons?: number;
  maxEmergencyDelay?: number;
}

export function satisfiesConstraints(vector: ObjectiveVector, constraints: ObjectiveConstraints): boolean {
  return (constraints.maxUnresolved === undefined || vector.unresolved <= constraints.maxUnresolved + 1e-9)
    && (constraints.maxMakespan === undefined || vector.makespan <= constraints.maxMakespan + 1e-9)
    && (constraints.maxQueuePersonMinutes === undefined || vector.queuePersonMinutes <= constraints.maxQueuePersonMinutes + 1e-9)
    && (constraints.maxSwitchPersons === undefined || vector.switchPersons <= constraints.maxSwitchPersons + 1e-9)
    && (constraints.maxEmergencyDelay === undefined || vector.emergencyDelay <= constraints.maxEmergencyDelay + 1e-9);
}

/**
 * 约束优先选择：先满足硬约束，再在可行集合内按优先级选膝点；
 * 无可行解时返回 null（调用方必须回退安全方案，不能静默放宽约束）。
 */
export function selectConstrained<T>(
  candidates: ParetoCandidate<T>[],
  constraints: ObjectiveConstraints,
  priority: Priority = 'balanced',
): ParetoCandidate<T> | null {
  const feasible = candidates.filter(candidate => satisfiesConstraints(candidate.vector, constraints));
  if (feasible.length === 0) return null;
  return selectKnee(paretoFront(feasible), priority);
}
