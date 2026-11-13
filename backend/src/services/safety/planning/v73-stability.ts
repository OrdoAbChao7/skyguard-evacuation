/**
 * V7.3 自适应稳定性（研究模块）。
 *
 * 在 V7.2 的迟滞/切换惩罚/承诺/自适应之上增加：
 *  - 拥堵/风险自适应的切换惩罚；
 *  - 人群 + 区域风险加权的切换成本；
 *  - A→B→A 路线振荡检测与额外惩罚；
 *  - 多目标标量化（到达时间、完成时间、等待代理、路径暴露、切换）；
 *  - 动态容量因子接口（由 MPC 传入求解器）。
 *
 * 安全边界：这些只是目标函数/决策偏好；未疏散不增加、逐分钟容量复核、
 * 目标劣化护栏与出口不可用紧急覆盖仍由 MPC 强制执行。
 */
import type { EvacuationPlan, EvacuationRoute, SafetyScenario } from '../types';
import { dominantExits, regionRiskRatio, switchingImpact } from './route-stability';

export interface AdaptiveStabilityWeights {
  /** Σ persons × arrive_minute / persons 的权重。 */
  arrival: number;
  /** makespan 的权重。 */
  makespan: number;
  /** Σ persons × depart_minute / persons（等待代理）的权重。 */
  queueProxy: number;
  /** Σ persons × steps（路径暴露代理）的权重。 */
  exposure: number;
  /** 切换/振荡人数/总人数 的权重。 */
  switching: number;
}

export interface AdaptiveStabilityConfig {
  enabled: boolean;
  /** 基础切换惩罚（人·分钟/人）。 */
  basePenaltyPerPerson: number;
  /** 队列压力归一化阈值。 */
  queueThreshold: number;
  /** 风险折扣强度 0~1：风险越高，越允许安全驱动的切换。 */
  riskDiscount: number;
  /** A→B→A 振荡的额外惩罚（人·分钟/人）。 */
  oscillationPenaltyPerPerson: number;
  /** 是否按区域风险加权切换人数。 */
  riskWeightedSwitching: boolean;
  /** V7.4：当最大区域风险比达到该值时自动释放承诺；0 = 禁用。 */
  releaseOnRiskThreshold: number;
  /** V7.4：只承诺风险比低于该值的区域；1 = 所有区域。 */
  regionSelectiveRiskThreshold: number;
  /** V7.5：紧急释放后多少分钟内禁止重新承诺；0 = 立即允许。 */
  recommitCooldownMinutes: number;
  weights: AdaptiveStabilityWeights;
}

export const DEFAULT_ADAPTIVE_STABILITY: AdaptiveStabilityConfig = {
  enabled: false,
  basePenaltyPerPerson: 10,
  queueThreshold: 100,
  riskDiscount: 0.5,
  oscillationPenaltyPerPerson: 20,
  riskWeightedSwitching: true,
  releaseOnRiskThreshold: 0,
  regionSelectiveRiskThreshold: 1,
  recommitCooldownMinutes: 0,
  weights: {
    arrival: 1,
    makespan: 0.5,
    queueProxy: 0.25,
    exposure: 0.05,
    switching: 0.02,
  },
};

function finiteOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveAdaptiveStability(input?: Partial<AdaptiveStabilityConfig> | null): AdaptiveStabilityConfig {
  if (!input) return { ...DEFAULT_ADAPTIVE_STABILITY, weights: { ...DEFAULT_ADAPTIVE_STABILITY.weights } };
  const weights: Partial<AdaptiveStabilityWeights> = input.weights ?? {};
  return {
    enabled: input.enabled === true,
    basePenaltyPerPerson: Math.max(0, Math.min(10_000, finiteOr(input.basePenaltyPerPerson, DEFAULT_ADAPTIVE_STABILITY.basePenaltyPerPerson))),
    queueThreshold: Math.max(1, Math.min(100_000, finiteOr(input.queueThreshold, DEFAULT_ADAPTIVE_STABILITY.queueThreshold))),
    riskDiscount: Math.max(0, Math.min(1, finiteOr(input.riskDiscount, DEFAULT_ADAPTIVE_STABILITY.riskDiscount))),
    oscillationPenaltyPerPerson: Math.max(0, Math.min(10_000, finiteOr(input.oscillationPenaltyPerPerson, DEFAULT_ADAPTIVE_STABILITY.oscillationPenaltyPerPerson))),
    riskWeightedSwitching: input.riskWeightedSwitching !== false,
    releaseOnRiskThreshold: Math.max(0, Math.min(10, finiteOr(input.releaseOnRiskThreshold, 0))),
    regionSelectiveRiskThreshold: Math.max(0, Math.min(10, finiteOr(input.regionSelectiveRiskThreshold, 1))),
    recommitCooldownMinutes: Math.max(0, Math.min(60, finiteOr(input.recommitCooldownMinutes, 0))),
    weights: {
      arrival: Math.max(0, Math.min(100, finiteOr(weights.arrival, DEFAULT_ADAPTIVE_STABILITY.weights.arrival))),
      makespan: Math.max(0, Math.min(100, finiteOr(weights.makespan, DEFAULT_ADAPTIVE_STABILITY.weights.makespan))),
      queueProxy: Math.max(0, Math.min(100, finiteOr(weights.queueProxy, DEFAULT_ADAPTIVE_STABILITY.weights.queueProxy))),
      exposure: Math.max(0, Math.min(100, finiteOr(weights.exposure, DEFAULT_ADAPTIVE_STABILITY.weights.exposure))),
      switching: Math.max(0, Math.min(100, finiteOr(weights.switching, DEFAULT_ADAPTIVE_STABILITY.weights.switching))),
    },
  };
}

/**
 * 自适应切换惩罚：
 *   penalty = base × (1 + queuePressure) × (1 − riskDiscount × risk)
 * 队列越长，稳定性越有价值；风险越高，越允许安全驱动的改派。
 */
export function adaptiveSwitchPenalty(
  config: AdaptiveStabilityConfig,
  context: { queueTotal: number; worstRiskRatio: number },
): number {
  const pressure = Math.min(2, Math.max(0, context.queueTotal) / Math.max(1, config.queueThreshold));
  const risk = Math.max(0, Math.min(1, context.worstRiskRatio));
  return Math.max(0, config.basePenaltyPerPerson * (1 + pressure) * (1 - config.riskDiscount * risk));
}

/** 记录每个区域最近若干步的支配出口（用于 A→B→A 检测）。 */
export function appendExitHistory(
  history: Map<string, string[]>,
  routes: EvacuationRoute[],
  limit = 6,
): void {
  for (const [regionId, exitId] of dominantExits(routes)) {
    const list = history.get(regionId) ?? [];
    list.push(exitId);
    while (list.length > limit) list.shift();
    history.set(regionId, list);
  }
}

/** 检测候选方案中会形成 A→B→A 的区域。 */
export function detectOscillatingRegions(
  history: Map<string, string[]>,
  candidateRoutes: EvacuationRoute[],
): { regions: string[]; persons: number } {
  const current = dominantExits(candidateRoutes);
  const personsByRegion = new Map<string, number>();
  for (const route of candidateRoutes) {
    personsByRegion.set(route.from_region_id, (personsByRegion.get(route.from_region_id) ?? 0) + route.persons);
  }
  const regions: string[] = [];
  let persons = 0;
  for (const [regionId, exitId] of current) {
    const list = history.get(regionId) ?? [];
    if (list.length < 2) continue;
    const last = list[list.length - 1];
    const beforeLast = list[list.length - 2];
    if (last !== exitId && beforeLast === exitId) {
      regions.push(regionId);
      persons += personsByRegion.get(regionId) ?? 0;
    }
  }
  return { regions: regions.sort(), persons };
}

/**
 * 人群 + 风险加权切换人数：Σ persons × (1 + riskWeight × riskRatio)。
 * riskWeight=0 时退化为普通切换人数。
 */
export function weightedSwitchPersons(input: {
  candidateRoutes: EvacuationRoute[];
  previousExits: Map<string, string>;
  scenario: SafetyScenario;
  occupancy: Map<string, number>;
  riskWeight: number;
}): number {
  const current = dominantExits(input.candidateRoutes);
  const personsByRegion = new Map<string, number>();
  for (const route of input.candidateRoutes) {
    personsByRegion.set(route.from_region_id, (personsByRegion.get(route.from_region_id) ?? 0) + route.persons);
  }
  let total = 0;
  for (const [regionId, exitId] of current) {
    const previous = input.previousExits.get(regionId);
    if (!previous || previous === exitId) continue;
    const persons = personsByRegion.get(regionId) ?? 0;
    const risk = input.riskWeight > 0
      ? Math.min(1, regionRiskRatio(input.scenario, regionId, input.occupancy.get(regionId) ?? persons))
      : 0;
    total += persons * (1 + input.riskWeight * risk);
  }
  return total;
}

export interface PlanScoreComponents {
  arrivalPerPerson: number;
  makespan: number;
  queueProxyPerPerson: number;
  exposurePerPerson: number;
  switchPersons: number;
  totalPersons: number;
  score: number;
}

/**
 * 多目标标量化。所有指标都是计划层代理，不是实际执行后的队列/风险。
 */
export function scorePlan(
  plan: EvacuationPlan,
  input: {
    previousExits: Map<string, string>;
    config: AdaptiveStabilityConfig;
    switchPersonsOverride?: number;
  },
): PlanScoreComponents {
  const totalPersons = Math.max(1, plan.routes.reduce((sum, route) => sum + route.persons, 0));
  const arrival = plan.routes.reduce((sum, route) => sum + route.persons * route.arrive_minute, 0);
  const makespan = plan.routes.reduce((max, route) => Math.max(max, route.arrive_minute), 0);
  const queueProxy = plan.routes.reduce((sum, route) => sum + route.persons * route.depart_minute, 0);
  const exposure = plan.routes.reduce((sum, route) => sum + route.persons * route.steps.length, 0);
  const switchPersons = input.switchPersonsOverride ?? switchingImpact(plan.routes, input.previousExits).persons;
  const w = input.config.weights;
  const score =
    (w.arrival * arrival) / totalPersons
    + w.makespan * makespan
    + (w.queueProxy * queueProxy) / totalPersons
    + (w.exposure * exposure) / totalPersons
    + (w.switching * switchPersons) / totalPersons
    + plan.unresolved_persons * 10_000;
  return {
    arrivalPerPerson: Number((arrival / totalPersons).toFixed(4)),
    makespan,
    queueProxyPerPerson: Number((queueProxy / totalPersons).toFixed(4)),
    exposurePerPerson: Number((exposure / totalPersons).toFixed(4)),
    switchPersons,
    totalPersons,
    score: Number(score.toFixed(4)),
  };
}
