/**
 * V7.2 路线稳定性策略（研究模块）。
 *
 * 背景：V7.1 实验显示 V7 时间扩展 MPC 的切换人数约为 legacy 的 5.8 倍。
 * 实现要点（与 V7.1 的 explore 结论一致）：
 *  - 求解器的 `allowedExitsByRegion` 是「出口所属区域」语义，无法表达
 *    「某来源区域只能走某个出口」（这是多商品流约束）；因此稳定性不能靠
 *    单次最小费用流的出口限制实现。
 *  - 本模块采用**决策级路线冻结**：新计划对某区域改派出口时，若改派收益
 *    不足以抵消切换代价/迟滞/承诺窗口，则保留上一计划中该区域尚未执行的
 *    路线；随后做覆盖率与容量复核，任一硬条件不满足就回退到新计划。
 *
 * 安全边界：
 *  - 冻结不得增加未疏散人数（硬条件）；
 *  - 冻结计划必须通过走廊/出口逐分钟容量复核（研究侧预检；发布仍须独立校验）；
 *  - 上一出口不可用时立即解除冻结（紧急覆盖）；
 *  - 稳定性只是柔性偏好，不能凌驾于四态、独立校验与未知不可用之上。
 */
import type { EvacuationPlan, EvacuationRoute, SafetyScenario } from '../types';

export type StabilityMode = 'none' | 'hysteresis' | 'switch_penalty' | 'commitment' | 'adaptive';

export interface RouteStabilityConfig {
  mode: StabilityMode;
  /** 每名被改派人员需要的最低目标改善（人·分钟/人），不足则冻结。 */
  switchPenaltyPerPerson: number;
  /** 承诺窗口：计划发布后多少分钟内优先保持上一出口（仅当不增加未疏散）。 */
  commitMinutes: number;
  /** 迟滞容差：新方案相对旧方案的目标改善比例低于该值则冻结。 */
  hysteresisGap: number;
  /** 自适应模式：出口队列总人数超过该阈值时启用承诺窗口。 */
  adaptiveQueueThreshold: number;
  /** 承诺方案允许的目标劣化比例；超过则整体回退（安全/效率护栏）。 */
  maxObjectiveDegradation: number;
  /** 是否允许紧急覆盖（出口不可用时立即解除承诺）。安全语义上永远为 true。 */
  emergencyOverride: boolean;
}

export const DEFAULT_STABILITY: RouteStabilityConfig = {
  mode: 'none',
  switchPenaltyPerPerson: 0,
  commitMinutes: 0,
  hysteresisGap: 0.02,
  adaptiveQueueThreshold: 120,
  maxObjectiveDegradation: 0.3,
  emergencyOverride: true,
};

const MODES: StabilityMode[] = ['none', 'hysteresis', 'switch_penalty', 'commitment', 'adaptive'];

function finiteOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 解析并夹紧稳定性配置；异常输入回退为默认值而不是让规划失败。 */
export function resolveStabilityConfig(input?: Partial<RouteStabilityConfig> | null): RouteStabilityConfig {
  if (!input) return { ...DEFAULT_STABILITY };
  const mode = MODES.includes(input.mode as StabilityMode) ? (input.mode as StabilityMode) : 'none';
  return {
    mode,
    switchPenaltyPerPerson: Math.max(0, Math.min(10_000, finiteOr(input.switchPenaltyPerPerson, 0))),
    commitMinutes: Math.max(0, Math.min(120, Math.floor(finiteOr(input.commitMinutes, 0)))),
    hysteresisGap: Math.max(0, Math.min(0.5, finiteOr(input.hysteresisGap, DEFAULT_STABILITY.hysteresisGap))),
    adaptiveQueueThreshold: Math.max(0, Math.min(100_000, finiteOr(input.adaptiveQueueThreshold, DEFAULT_STABILITY.adaptiveQueueThreshold))),
    maxObjectiveDegradation: Math.max(0, Math.min(2, finiteOr(input.maxObjectiveDegradation, DEFAULT_STABILITY.maxObjectiveDegradation))),
    // 安全语义：紧急覆盖不可关闭。
    emergencyOverride: true,
  };
}

/** 每个区域在本批路线中人数最多的出口（支配出口）。 */
export function dominantExits(routes: EvacuationRoute[]): Map<string, string> {
  const byRegion = new Map<string, Map<string, number>>();
  for (const route of routes) {
    if (route.persons <= 0) continue;
    const exits = byRegion.get(route.from_region_id) ?? new Map<string, number>();
    exits.set(route.exit_id, (exits.get(route.exit_id) ?? 0) + route.persons);
    byRegion.set(route.from_region_id, exits);
  }
  const result = new Map<string, string>();
  for (const [regionId, exits] of byRegion) {
    let bestExit = '';
    let bestPersons = -1;
    for (const [exitId, persons] of exits) {
      if (persons > bestPersons || (persons === bestPersons && exitId < bestExit)) {
        bestPersons = persons;
        bestExit = exitId;
      }
    }
    result.set(regionId, bestExit);
  }
  return result;
}

/** 相对上一出口发生改派的区域与人数（受影响人口）。 */
export function switchingImpact(
  candidateRoutes: EvacuationRoute[],
  previousExits: Map<string, string>,
): { regions: string[]; persons: number } {
  if (previousExits.size === 0) return { regions: [], persons: 0 };
  const current = dominantExits(candidateRoutes);
  const personsByRegion = new Map<string, number>();
  for (const route of candidateRoutes) {
    personsByRegion.set(route.from_region_id, (personsByRegion.get(route.from_region_id) ?? 0) + route.persons);
  }
  let persons = 0;
  const regions: string[] = [];
  for (const [regionId, exitId] of current) {
    const previous = previousExits.get(regionId);
    if (!previous || previous === exitId) continue;
    regions.push(regionId);
    persons += personsByRegion.get(regionId) ?? 0;
  }
  return { regions: regions.sort(), persons };
}

/** 规划目标：到达时刻加权人数 + 未疏散惩罚（与 V7.1 稳定性比较口径一致）。 */
export function planObjective(plan: EvacuationPlan): number {
  return plan.unresolved_persons * 10_000
    + plan.routes.reduce((sum, route) => sum + route.persons * route.arrive_minute, 0);
}

/** 区域密度（人/m²）；面积无效时返回 0。 */
export function regionDensity(scenario: SafetyScenario, regionId: string, persons: number): number {
  const region = scenario.regions.find(item => item.id === regionId);
  if (!region || region.area_m2 <= 0) return 0;
  return Math.max(0, persons) / region.area_m2;
}

/** 区域风险比：密度 / critical 阈值（无阈值时返回 0）。 */
export function regionRiskRatio(scenario: SafetyScenario, regionId: string, persons: number): number {
  const region = scenario.regions.find(item => item.id === regionId);
  const thresholds = region?.thresholds ?? scenario.config.default_thresholds;
  if (!thresholds || thresholds.critical_density <= 0) return 0;
  return regionDensity(scenario, regionId, persons) / thresholds.critical_density;
}

// ---------------------------------------------------------------------------
// 决策级冻结
// ---------------------------------------------------------------------------

export interface StabilizationDecisionInput {
  mode: StabilityMode;
  config: RouteStabilityConfig;
  withinCommit: boolean;
  congested: boolean;
  baseObjective: number;
  committedObjective: number;
  baseSwitchPersons: number;
  committedSwitchPersons: number;
}

/**
 * 是否采用「承诺式」整体方案（所有有历史出口的区域保持上一出口）。
 * 只固定子集会把容量压力挤到其它区域，V7.2 实验显示反而增加总切换，
 * 因此策略以整体方案为单位决策。
 */
export function shouldUseCommitment(input: StabilizationDecisionInput): { use: boolean; reason: string } {
  const { mode, config } = input;
  if (mode === 'none') return { use: false, reason: 'stability_disabled' };
  if (mode === 'commitment') {
    return input.withinCommit ? { use: true, reason: 'commitment_window' } : { use: false, reason: 'commitment_expired' };
  }
  if (mode === 'adaptive') {
    if (input.withinCommit) return { use: true, reason: 'adaptive_commitment_window' };
    if (input.congested) return { use: true, reason: 'adaptive_congestion' };
    // 非承诺状态：退回切换惩罚准则。
  }
  if (mode === 'hysteresis') {
    const gap = config.hysteresisGap;
    if (input.committedObjective <= input.baseObjective * (1 + gap) + 1) {
      return { use: true, reason: `within_hysteresis_${gap}` };
    }
    return { use: false, reason: 'objective_degraded_beyond_hysteresis' };
  }
  // switch_penalty / adaptive（非承诺状态）：比较惩罚后目标。
  const basePenalized = input.baseObjective + config.switchPenaltyPerPerson * input.baseSwitchPersons;
  const committedPenalized = input.committedObjective + config.switchPenaltyPerPerson * input.committedSwitchPersons;
  if (committedPenalized < basePenalized) {
    return { use: true, reason: `penalized_objective_${committedPenalized.toFixed(0)}_lt_${basePenalized.toFixed(0)}` };
  }
  return { use: false, reason: 'penalized_objective_prefers_new_plan' };
}

export function checkPlanCapacity(
  scenario: SafetyScenario,
  routes: EvacuationRoute[],
  elapsed: number,
): Array<{ kind: 'corridor' | 'exit'; id: string; minute: number; load: number; capacity: number }> {
  const corridorCapacity = new Map(scenario.corridors.map(item => [item.id, item.capacity_per_min ?? 0]));
  const exitCapacity = new Map(scenario.exits.map(item => [item.id, item.capacity_per_min ?? 0]));
  const corridorLoad = new Map<string, number>();
  const exitLoad = new Map<string, number>();
  for (const route of routes) {
    const exitMinute = elapsed + route.arrive_minute;
    const exitKey = `${route.exit_id}|${exitMinute}`;
    exitLoad.set(exitKey, (exitLoad.get(exitKey) ?? 0) + route.persons);
    for (const step of route.steps) {
      const minute = elapsed + step.depart_minute;
      const key = `${step.corridor_id}|${minute}`;
      corridorLoad.set(key, (corridorLoad.get(key) ?? 0) + route.persons);
    }
  }
  const violations: Array<{ kind: 'corridor' | 'exit'; id: string; minute: number; load: number; capacity: number }> = [];
  for (const [key, load] of corridorLoad) {
    const [id, minuteText] = key.split('|');
    const capacity = corridorCapacity.get(id) ?? 0;
    if (load > capacity) violations.push({ kind: 'corridor', id, minute: Number(minuteText), load, capacity });
  }
  for (const [key, load] of exitLoad) {
    const [id, minuteText] = key.split('|');
    const capacity = exitCapacity.get(id) ?? 0;
    if (load > capacity) violations.push({ kind: 'exit', id, minute: Number(minuteText), load, capacity });
  }
  return violations;
}
