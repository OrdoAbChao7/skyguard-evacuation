/**
 * 联合 VoI（V7.2）：在区域相关性与动作覆盖重叠下顺序选择调查动作。
 *
 * 与 `multi-voi.ts` 的区别：
 *  - 多区域 VoI 只对“当前动作”的覆盖区域加权求和，不建模动作之间的信息冗余；
 *  - 联合 VoI 显式建模：
 *      1) 区域相关性：调查一个区域会按 correlation × 图边权部分降低邻居不确定性；
 *      2) 冗余折扣：与已选动作覆盖重叠越大，边际信息价值越低；
 *      3) 预算内的顺序选择：每次选择后重新评估边际收益。
 *
 * 边界：
 *  - 这是**启发式近似**，不是联合 POMDP 精确解；相关性与冗余参数来自场景文件，
 *    仍是未标定的合成先验；
 *  - 所有动作可用性、预算与似然/损失参数与多区域 VoI 使用同一份策略，
 *    便于公平对照实验。
 */
import type { InvestigationAction, InvestigationKind, InvestigationPolicy } from '../safety/types';
import { neighborsOf, type RegionGraph } from './risk-graph';
import {
  applyEvidence,
  entropy,
  expectedRisk,
  priorBelief,
  type AvailabilityMap,
  type BeliefEntry,
} from './voi';
import { allCandidatesBlocked, checkCandidateBudget } from './budget';

export interface JointVoIConfig {
  correlation: number;
  redundancy_penalty: number;
  max_sequence: number;
  source: 'scenario' | 'legacy_default';
}

export interface JointRegionContribution {
  region_id: string;
  direct_weight: number;
  indirect_weight: number;
  effective_weight: number;
  risk_reduction: number;
  information_gain_bits: number;
}

export interface JointCandidateEvaluation {
  action_id: string;
  kind: string;
  label: string;
  available: boolean;
  unavailable_reason: string | null;
  contributions: JointRegionContribution[];
  base_risk_reduction: number;
  base_information_gain_bits: number;
  redundancy: number;
  marginal_risk_reduction: number;
  marginal_information_gain_bits: number;
  score: number | null;
  budget_eligible: boolean;
}

export interface JointSelectedStep {
  action_id: string;
  kind: string;
  round: number;
  score: number;
  marginal_risk_reduction: number;
  marginal_information_gain_bits: number;
  covered_regions: string[];
  cumulative_risk_reduction: number;
  cumulative_information_gain_bits: number;
  time_cost_minutes: number;
  resource_cost: number;
}

export interface JointDecision {
  engine_version: 'joint-voi-v1';
  target_region_id: string;
  config: JointVoIConfig;
  selected: JointSelectedStep[];
  evaluations_by_round: JointCandidateEvaluation[][];
  total_expected_risk_reduction: number;
  total_information_gain_bits: number;
  should_investigate: boolean;
  stop_reason: 'voi_below_threshold' | 'no_available_action' | 'max_investigations_reached' | 'budget_exhausted' | null;
  budget: {
    used_actions: number;
    used_cost: number;
    used_time_minutes: number;
    max_actions: number | null;
    max_total_cost: number | null;
    max_total_time_minutes: number | null;
  };
  provenance: string;
  notes: string[];
}

function resolveConfig(policy: InvestigationPolicy): JointVoIConfig {
  if (policy.joint) {
    return {
      correlation: policy.joint.correlation,
      redundancy_penalty: policy.joint.redundancy_penalty,
      max_sequence: policy.joint.max_sequence ?? Math.min(policy.max_investigations, 3),
      source: 'scenario',
    };
  }
  return {
    correlation: 0.5,
    redundancy_penalty: 0.6,
    max_sequence: Math.min(policy.max_investigations, 3),
    source: 'legacy_default',
  };
}

function coverageOf(action: InvestigationAction, targetRegionId: string, graph: RegionGraph, policy: InvestigationPolicy): Map<string, number> {
  const weights = policy.coverage_weights ?? { neighbor: 0.5, global: 0.3 };
  const map = new Map<string, number>();
  if (action.coverage === 'all') {
    for (const regionId of graph.regionIds) map.set(regionId, regionId === targetRegionId ? 1 : weights.global);
  } else if (action.coverage === 'neighbors') {
    map.set(targetRegionId, 1);
    for (const neighbor of neighborsOf(graph, targetRegionId)) {
      if (neighbor !== targetRegionId) map.set(neighbor, Math.max(map.get(neighbor) ?? 0, weights.neighbor));
    }
  } else {
    map.set(targetRegionId, 1);
  }
  return map;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function regionValue(
  policy: InvestigationPolicy,
  belief: BeliefEntry[],
  actionKind: InvestigationKind,
): { riskReduction: number; informationGain: number } {
  const beforeEntropy = entropy(belief);
  const beforeRisk = expectedRisk(policy, belief);
  let expectedEntropy = 0;
  let expectedRiskValue = 0;
  let validOutcomes = 0;
  for (const outcome of policy.outcomes) {
    const probability = belief.reduce((sum, entry) => {
      const row = policy.likelihoods[actionKind]?.[entry.hypothesis_id] ?? {};
      const total = policy.outcomes.reduce((acc, key) => acc + (row[key] ?? 0), 0);
      return sum + entry.probability * (total > 0 ? (row[outcome] ?? 0) / total : 1 / policy.outcomes.length);
    }, 0);
    if (probability <= 1e-12) continue;
    validOutcomes += 1;
    const posterior = applyEvidence(policy, belief, actionKind, outcome);
    expectedEntropy += probability * entropy(posterior);
    expectedRiskValue += probability * expectedRisk(policy, posterior);
  }
  if (validOutcomes === 0) return { riskReduction: 0, informationGain: 0 };
  return {
    riskReduction: beforeRisk - expectedRiskValue,
    informationGain: beforeEntropy - expectedEntropy,
  };
}

/**
 * 联合 VoI 顺序决策。`beliefs` 与多区域 VoI 使用同一结构；
 * 返回选中动作序列与每轮候选评估，便于审计与实验。
 */
export function decideJointInvestigation(
  policy: InvestigationPolicy,
  targetRegionId: string,
  beliefs: Map<string, BeliefEntry[]>,
  graph: RegionGraph,
  availability: AvailabilityMap = {},
  options: {
    usedActions?: number;
    usedCost?: number;
    usedTimeMinutes?: number;
    correlation?: number;
    redundancyPenalty?: number;
    maxSequence?: number;
    /** 之前轮次已执行的动作（用于跨轮次的冗余折扣与去重）。 */
    previouslySelected?: Array<{ action_id: string; kind: InvestigationKind; covered_regions: string[] }>;
  } = {},
): JointDecision {
  const config = resolveConfig(policy);
  const correlation = options.correlation ?? config.correlation;
  const redundancyPenalty = options.redundancyPenalty ?? config.redundancy_penalty;
  const maxSequence = options.maxSequence ?? config.max_sequence;
  const budget = policy.budget;
  const usedActions = options.usedActions ?? 0;
  const usedCost = options.usedCost ?? 0;
  const usedTime = options.usedTimeMinutes ?? 0;
  const usage = { used_actions: usedActions, used_cost: usedCost, used_time_minutes: usedTime };

  const selected: JointSelectedStep[] = [];
  const evaluationsByRound: JointCandidateEvaluation[][] = [];
  const usedActionIds = new Set<string>((options.previouslySelected ?? []).map(item => item.action_id));
  const selectedCoverages: Array<{ coverage: Set<string>; kind: string }> = (options.previouslySelected ?? [])
    .map(item => ({ coverage: new Set(item.covered_regions), kind: item.kind }));
  let cumulativeRisk = 0;
  let cumulativeInformation = 0;
  let stopReason: JointDecision['stop_reason'] = null;

  for (let round = 0; round < maxSequence; round += 1) {
    if (budget && allCandidatesBlocked(policy, usage)) {
      stopReason = 'budget_exhausted';
      break;
    }
    const evaluations: JointCandidateEvaluation[] = policy.actions.map(action => {
      const runtime = availability[action.id];
      const runtimeAvailable = Boolean(runtime?.available ?? action.base_availability === 'available');
      const budgetDecision = checkCandidateBudget(policy, action, usage);
      const available = runtimeAvailable && budgetDecision.eligible && !usedActionIds.has(action.id);
      const unavailableReason = available
        ? null
        : usedActionIds.has(action.id)
          ? '已选择'
          : !budgetDecision.eligible
            ? budgetDecision.reason
            : runtime?.reason ?? (action.base_availability === 'degraded' ? '数据源降级' : '当前不可用');

      const coverage = coverageOf(action, targetRegionId, graph, policy);
      // 直接 + 相关邻居的间接信息价值（按图边权与 correlation 折算）。
      const contributions: JointRegionContribution[] = [];
      let baseRisk = 0;
      let baseInformation = 0;
      const allRegions = new Set<string>([...coverage.keys(), ...graph.regionIds]);
      for (const regionId of allRegions) {
        const belief = beliefs.get(regionId) ?? priorBelief(policy);
        const value = regionValue(policy, belief, action.kind);
        const direct = coverage.get(regionId) ?? 0;
        let indirect = 0;
        if (direct === 0 && correlation > 0) {
          for (const [coveredRegionId, directWeight] of coverage) {
            const edge = (graph.adjacency.get(coveredRegionId) ?? []).find(item => item.to === regionId);
            if (edge) indirect = Math.max(indirect, correlation * directWeight * edge.weight);
          }
        }
        const effective = Math.min(1, direct + indirect);
        if (effective <= 0) continue;
        baseRisk += effective * value.riskReduction;
        baseInformation += effective * value.informationGain;
        contributions.push({
          region_id: regionId,
          direct_weight: Number(direct.toFixed(4)),
          indirect_weight: Number(indirect.toFixed(4)),
          effective_weight: Number(effective.toFixed(4)),
          risk_reduction: Number(value.riskReduction.toFixed(6)),
          information_gain_bits: Number(value.informationGain.toFixed(6)),
        });
      }
      contributions.sort((a, b) => b.effective_weight - a.effective_weight);

      const coverageSet = new Set(coverage.keys());
      let maxOverlap = 0;
      for (const selectedCoverage of selectedCoverages) {
        if (selectedCoverage.kind === action.kind) maxOverlap = Math.max(maxOverlap, 1);
        maxOverlap = Math.max(maxOverlap, jaccard(coverageSet, selectedCoverage.coverage));
      }
      const redundancy = 1 - redundancyPenalty * maxOverlap;
      const marginalRisk = baseRisk * redundancy;
      const marginalInformation = baseInformation * redundancy;

      const timeNorm = Math.min(1, action.time_cost_minutes / policy.normalization.max_time_minutes);
      const resourceNorm = Math.min(1, action.resource_cost / policy.normalization.max_resource_cost);
      const score = available
        ? policy.weights.risk_reduction * marginalRisk
          + policy.weights.information_gain * marginalInformation
          - policy.weights.time_cost * timeNorm
          - policy.weights.resource_cost * resourceNorm
          - policy.weights.failure * action.failure_probability
        : null;

      return {
        action_id: action.id,
        kind: action.kind,
        label: action.label,
        available,
        unavailable_reason: unavailableReason,
        contributions,
        base_risk_reduction: Number(baseRisk.toFixed(6)),
        base_information_gain_bits: Number(baseInformation.toFixed(6)),
        redundancy: Number(redundancy.toFixed(4)),
        marginal_risk_reduction: Number(marginalRisk.toFixed(6)),
        marginal_information_gain_bits: Number(marginalInformation.toFixed(6)),
        score: score === null ? null : Number(score.toFixed(6)),
        budget_eligible: budgetDecision.eligible,
      };
    });
    evaluationsByRound.push(evaluations);

    const ranked = evaluations
      .filter(item => item.available && item.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const best = ranked[0];
    if (!best) {
      stopReason = budget && allCandidatesBlocked(policy, usage) ? 'budget_exhausted' : 'no_available_action';
      break;
    }
    if ((best.score ?? 0) < policy.stop_threshold) {
      stopReason = 'voi_below_threshold';
      break;
    }
    const action = policy.actions.find(item => item.id === best.action_id)!;
    usedActionIds.add(action.id);
    usage.used_actions += 1;
    usage.used_cost += action.resource_cost;
    usage.used_time_minutes += action.time_cost_minutes;
    cumulativeRisk += best.marginal_risk_reduction;
    cumulativeInformation += best.marginal_information_gain_bits;
    selectedCoverages.push({ coverage: new Set(best.contributions.map(item => item.region_id)), kind: best.kind });
    selected.push({
      action_id: best.action_id,
      kind: best.kind,
      round,
      score: best.score ?? 0,
      marginal_risk_reduction: best.marginal_risk_reduction,
      marginal_information_gain_bits: best.marginal_information_gain_bits,
      covered_regions: best.contributions.map(item => item.region_id),
      cumulative_risk_reduction: Number(cumulativeRisk.toFixed(6)),
      cumulative_information_gain_bits: Number(cumulativeInformation.toFixed(6)),
      time_cost_minutes: action.time_cost_minutes,
      resource_cost: action.resource_cost,
    });
  }
  if (!stopReason && selected.length >= maxSequence) stopReason = 'max_investigations_reached';

  return {
    engine_version: 'joint-voi-v1',
    target_region_id: targetRegionId,
    config: { ...config, correlation, redundancy_penalty: redundancyPenalty, max_sequence: maxSequence },
    selected,
    evaluations_by_round: evaluationsByRound,
    total_expected_risk_reduction: Number(cumulativeRisk.toFixed(6)),
    total_information_gain_bits: Number(cumulativeInformation.toFixed(6)),
    should_investigate: selected.length > 0,
    stop_reason: stopReason,
    budget: {
      used_actions: usage.used_actions,
      used_cost: Number(usage.used_cost.toFixed(4)),
      used_time_minutes: Number(usage.used_time_minutes.toFixed(4)),
      max_actions: budget?.max_actions ?? null,
      max_total_cost: budget?.max_total_cost ?? null,
      max_total_time_minutes: budget?.max_total_time_minutes ?? null,
    },
    provenance: policy.provenance,
    notes: [
      `相关程度 correlation=${correlation}，冗余折扣 redundancy_penalty=${redundancyPenalty}（来源：${config.source}）。`,
      '联合 VoI 是启发式近似，不是联合 POMDP 精确解；参数未在真实数据上标定。',
      '动作可用性、预算与似然/损失参数与多区域 VoI 共用同一策略，便于公平对照。',
    ],
  };
}
