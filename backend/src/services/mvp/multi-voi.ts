/**
 * 多区域联合 VoI：一个调查动作可能同时覆盖目标区域与相邻区域。
 *
 * 与单区域 VoI 的差异：
 *  - 每个区域维护独立信念；
 *  - 动作收益按覆盖范围加权求和，成本只计一次；
 *  - 支持预算约束（动作数/资源/时间）。
 *
 * 仍是研究原型：覆盖权重与图传播是配置化启发式，不是真实人群行为模型。
 */
import type { InvestigationAction, InvestigationPolicy } from '../safety/types';
import type { RegionRisk } from '../safety/risk';
import {
  applyEvidence,
  entropy,
  expectedRisk,
  priorBelief,
  normalizeBelief,
  type AvailabilityMap,
  type BeliefEntry,
} from './voi';
import { neighborsOf, riskValue, type RegionGraph } from './risk-graph';

export interface MultiRegionActionEvaluation {
  action_id: string;
  kind: string;
  label: string;
  available: boolean;
  unavailable_reason: string | null;
  covered_regions: Array<{ region_id: string; weight: number; risk_reduction: number; information_gain_bits: number }>;
  weighted_risk_reduction: number;
  weighted_information_gain_bits: number;
  time_cost_minutes: number;
  resource_cost: number;
  failure_probability: number;
  score: number | null;
}

export interface MultiRegionDecision {
  engine_version: string;
  target_region_id: string;
  covered_region_count: number;
  evaluations: MultiRegionActionEvaluation[];
  ranked_action_ids: string[];
  recommended_action_id: string | null;
  recommended_covered_regions: string[];
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
}

function coverRegions(
  action: InvestigationAction,
  targetRegionId: string,
  graph: RegionGraph,
  weights: { neighbor?: number; global?: number } = {},
): Array<{ regionId: string; weight: number }> {
  const neighborWeight = weights.neighbor ?? 0.5;
  const globalWeight = weights.global ?? 0.3;
  if (action.coverage === 'all') {
    return graph.regionIds.map(regionId => ({ regionId, weight: regionId === targetRegionId ? 1 : globalWeight }));
  }
  if (action.coverage === 'neighbors') {
    const neighbors = neighborsOf(graph, targetRegionId);
    return [
      { regionId: targetRegionId, weight: 1 },
      ...neighbors.filter(id => id !== targetRegionId).map(regionId => ({ regionId, weight: neighborWeight })),
    ];
  }
  return [{ regionId: targetRegionId, weight: 1 }];
}

export function priorBeliefsForRegions(
  policy: InvestigationPolicy,
  riskByRegion: RegionRisk[],
): Map<string, BeliefEntry[]> {
  const beliefs = new Map<string, BeliefEntry[]>();
  for (const risk of riskByRegion) {
    const prior = priorBelief(policy);
    // 可信观测作为一条证据；不可信观测只保留先验。
    if (risk.trusted) {
      const outcome = riskValue(risk.level) >= 0.6 ? 'signal_congested' : 'signal_normal';
      beliefs.set(risk.regionId, applyEvidence(policy, prior, 'staff_check', outcome));
    } else {
      beliefs.set(risk.regionId, normalizeBelief(prior));
    }
  }
  return beliefs;
}

export function decideMultiRegionInvestigation(
  policy: InvestigationPolicy,
  targetRegionId: string,
  beliefs: Map<string, BeliefEntry[]>,
  graph: RegionGraph,
  availability: AvailabilityMap = {},
  options: {
    usedActions?: number;
    usedCost?: number;
    usedTimeMinutes?: number;
    coverageWeights?: { neighbor?: number; global?: number };
  } = {},
): MultiRegionDecision {
  const usedActions = options.usedActions ?? 0;
  const usedCost = options.usedCost ?? 0;
  const usedTime = options.usedTimeMinutes ?? 0;
  const budget = policy.budget;
  const budgetExhausted = Boolean(
    budget
    && (usedActions >= budget.max_actions
      || usedCost >= budget.max_total_cost
      || usedTime >= budget.max_total_time_minutes),
  );

  const evaluations = policy.actions.map(action => {
    const runtime = availability[action.id];
    const available = !budgetExhausted && Boolean(runtime?.available ?? action.base_availability === 'available');
    const unavailableReason = available
      ? null
      : budgetExhausted
        ? '调查预算已耗尽'
        : runtime?.reason ?? (action.base_availability === 'degraded' ? '数据源降级' : '当前不可用');

    const covered = coverRegions(action, targetRegionId, graph, options.coverageWeights);
    const targetBelief = beliefs.get(targetRegionId) ?? priorBelief(policy);
    const riskBefore = expectedRisk(policy, targetBelief);
    let weightedRiskReduction = 0;
    let weightedInformationGain = 0;
    const perRegion = covered.map(item => {
      const belief = beliefs.get(item.regionId) ?? priorBelief(policy);
      const beforeEntropy = entropy(belief);
      const beforeRisk = expectedRisk(policy, belief);
      let expectedEntropyValue = 0;
      let expectedRiskValue = 0;
      let validOutcomes = 0;
      for (const outcome of policy.outcomes) {
        const outcomeProbability = belief.reduce((sum, entry) => {
          const row = policy.likelihoods[action.kind]?.[entry.hypothesis_id] ?? {};
          const total = policy.outcomes.reduce((acc, key) => acc + (row[key] ?? 0), 0);
          return sum + entry.probability * (total > 0 ? (row[outcome] ?? 0) / total : 1 / policy.outcomes.length);
        }, 0);
        if (outcomeProbability <= 1e-12) continue;
        validOutcomes += 1;
        const posterior = applyEvidence(policy, belief, action.kind, outcome);
        expectedEntropyValue += outcomeProbability * entropy(posterior);
        expectedRiskValue += outcomeProbability * expectedRisk(policy, posterior);
      }
      const ig = validOutcomes > 0 ? beforeEntropy - expectedEntropyValue : 0;
      const deltaRisk = validOutcomes > 0 ? beforeRisk - expectedRiskValue : 0;
      weightedRiskReduction += item.weight * deltaRisk;
      weightedInformationGain += item.weight * ig;
      return {
        region_id: item.regionId,
        weight: item.weight,
        risk_reduction: Number(deltaRisk.toFixed(6)),
        information_gain_bits: Number(ig.toFixed(6)),
      };
    });

    const timeCost = action.time_cost_minutes;
    const resourceCost = action.resource_cost;
    const timeNorm = Math.min(1, timeCost / policy.normalization.max_time_minutes);
    const resourceNorm = Math.min(1, resourceCost / policy.normalization.max_resource_cost);
    const score = available
      ? policy.weights.risk_reduction * weightedRiskReduction
        + policy.weights.information_gain * weightedInformationGain
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
      covered_regions: perRegion,
      weighted_risk_reduction: Number(weightedRiskReduction.toFixed(6)),
      weighted_information_gain_bits: Number(weightedInformationGain.toFixed(6)),
      time_cost_minutes: timeCost,
      resource_cost: resourceCost,
      failure_probability: action.failure_probability,
      score: score === null ? null : Number(score.toFixed(6)),
    };
  });

  const ranked = evaluations
    .filter(item => item.available && item.score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = ranked[0];
  let stopReason: MultiRegionDecision['stop_reason'] = null;
  let shouldInvestigate = false;
  if (budgetExhausted) stopReason = 'budget_exhausted';
  else if (!best) stopReason = 'no_available_action';
  else if ((best.score ?? 0) < policy.stop_threshold) stopReason = 'voi_below_threshold';
  else shouldInvestigate = true;

  return {
    engine_version: 'multi-voi-v1',
    target_region_id: targetRegionId,
    covered_region_count: best?.covered_regions.length ?? 0,
    evaluations,
    ranked_action_ids: ranked.map(item => item.action_id),
    recommended_action_id: shouldInvestigate ? best?.action_id ?? null : null,
    recommended_covered_regions: shouldInvestigate ? (best?.covered_regions.map(item => item.region_id) ?? []) : [],
    should_investigate: shouldInvestigate,
    stop_reason: stopReason,
    budget: {
      used_actions: usedActions,
      used_cost: Number(usedCost.toFixed(4)),
      used_time_minutes: Number(usedTime.toFixed(4)),
      max_actions: budget?.max_actions ?? null,
      max_total_cost: budget?.max_total_cost ?? null,
      max_total_time_minutes: budget?.max_total_time_minutes ?? null,
    },
    provenance: policy.provenance,
  };
}

