/**
 * 联合 VoI（joint VoI）：用粒子表示跨区域的联合信念，显式建模区域间风险相关。
 *
 * 与 multi-voi.ts 的独立加权和不同：
 *  - 区域状态由一个共享压力潜变量 + 区域独立扰动共同生成（相关性来自场景 correlation 配置）；
 *  - 信息价值按**联合熵** H(S_1,...,S_n) 计算，观测一个区域会通过相关性影响其他区域；
 *  - 风险项取覆盖区域/全区域的**最坏区域期望风险**；
 *  - 观测结果用嵌套 Monte Carlo 采样（全局 [0,1) 敏感性、认知不确定性、风险敏感性）。
 *
 * 边界：粒子模型仍是研究原型；共享压力权重是未标定配置，不是真实人群迁移规律。
 * 所有随机性由固定 seed 驱动，可复现。
 */
import type { InvestigationAction, InvestigationPolicy, InvestigationOutcome } from '../safety/types';
import { expectedRisk, normalizeBelief, type BeliefEntry } from './voi';
import { neighborsOf, type RegionGraph } from './risk-graph';
import { allCandidatesBlocked, checkCandidateBudget, type BudgetDecision } from './budget';

export const JOINT_VOI_ENGINE_VERSION = 'joint-voi-v1';

export interface JointActionEvaluation {
  action_id: string;
  kind: string;
  label: string;
  available: boolean;
  unavailable_reason: string | null;
  covered_regions: string[];
  joint_information_gain_bits: number;
  risk_reduction: number;
  risk_before_worst: number;
  expected_risk_after_worst: number;
  time_cost_minutes: number;
  resource_cost: number;
  failure_probability: number;
  score: number | null;
  budget: Pick<BudgetDecision, 'eligible' | 'reason_code' | 'reason' | 'remaining'>;
}

export interface JointVoIDecision {
  engine_version: string;
  target_region_id: string;
  particle_count: number;
  outcome_samples: number;
  correlation: { shared_pressure_weight: number; seed: number };
  covered_region_count: number;
  evaluations: JointActionEvaluation[];
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

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function probabilityOf(belief: BeliefEntry[], hypothesisId: string): number {
  return belief.find(item => item.hypothesis_id === hypothesisId)?.probability ?? 0;
}

function sampleIndex(probabilities: number[], random: number): number {
  let cumulative = 0;
  for (let index = 0; index < probabilities.length; index += 1) {
    cumulative += probabilities[index];
    if (random <= cumulative + 1e-12) return index;
  }
  return probabilities.length - 1;
}

function buildParticles(
  regionIds: string[],
  beliefs: Map<string, BeliefEntry[]>,
  hypotheses: string[],
  sharedWeight: number,
  count: number,
  random: () => number,
): string[][] {
  const marginals = regionIds.map(regionId => {
    const belief = normalizeBelief(beliefs.get(regionId) ?? []);
    const probabilities = hypotheses.map(hypothesisId => probabilityOf(belief, hypothesisId));
    const total = probabilities.reduce((sum, value) => sum + value, 0);
    return total > 0 ? probabilities.map(value => value / total) : hypotheses.map(() => 1 / hypotheses.length);
  });
  const particles: string[][] = [];
  for (let p = 0; p < count; p += 1) {
    const shared = random();
    const state: string[] = [];
    for (let r = 0; r < regionIds.length; r += 1) {
      const u = random() < sharedWeight ? shared : random();
      state.push(hypotheses[sampleIndex(marginals[r], u)]);
    }
    particles.push(state);
  }
  return particles;
}

function weightedParticleEntropy(particles: string[][], weights: number[]): number {
  const totals = new Map<string, number>();
  let total = 0;
  for (let p = 0; p < particles.length; p += 1) {
    const weight = weights[p];
    if (weight <= 0) continue;
    const key = particles[p].join('|');
    totals.set(key, (totals.get(key) ?? 0) + weight);
    total += weight;
  }
  if (total <= 0) return 0;
  let result = 0;
  for (const weight of totals.values()) {
    const probability = weight / total;
    if (probability > 0) result -= probability * Math.log2(probability);
  }
  return result;
}

function posteriorMarginalRisks(
  policy: InvestigationPolicy,
  regionIds: string[],
  particles: string[][],
  weights: number[],
): number[] {
  const total = weights.reduce((sum, value) => sum + value, 0);
  const hypothesisIds = policy.hypotheses.map(item => item.id);
  return regionIds.map((regionId, regionIndex) => {
    if (total <= 0) return 0;
    const counts = new Map<string, number>(hypothesisIds.map(id => [id, 0]));
    for (let p = 0; p < particles.length; p += 1) {
      const weight = weights[p];
      if (weight <= 0) continue;
      const hypothesisId = particles[p][regionIndex];
      counts.set(hypothesisId, (counts.get(hypothesisId) ?? 0) + weight);
    }
    const belief: BeliefEntry[] = policy.hypotheses.map(hypothesis => ({
      hypothesis_id: hypothesis.id,
      label: hypothesis.label,
      probability: (counts.get(hypothesis.id) ?? 0) / total,
    }));
    return expectedRisk(policy, normalizeBelief(belief));
  });
}

function coveredRegions(
  action: InvestigationAction,
  targetRegionId: string,
  graph: RegionGraph,
): string[] {
  if (action.coverage === 'all') return [...graph.regionIds];
  if (action.coverage === 'neighbors') {
    return [targetRegionId, ...neighborsOf(graph, targetRegionId).filter(id => id !== targetRegionId)];
  }
  return [targetRegionId];
}

function likelihood(
  policy: InvestigationPolicy,
  actionKind: string,
  hypothesisId: string,
  outcome: InvestigationOutcome,
): number {
  const row = policy.likelihoods[actionKind]?.[hypothesisId] ?? {};
  const total = policy.outcomes.reduce((sum, key) => sum + (row[key] ?? 0), 0);
  return total > 0 ? (row[outcome] ?? 0) / total : 1 / policy.outcomes.length;
}

function predictiveOutcome(
  policy: InvestigationPolicy,
  actionKind: string,
  belief: BeliefEntry[],
  random: () => number,
): InvestigationOutcome {
  const probabilities = policy.outcomes.map(outcome =>
    belief.reduce((sum, entry) => sum + entry.probability * likelihood(policy, actionKind, entry.hypothesis_id, outcome), 0));
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  const normalized = total > 0 ? probabilities.map(value => value / total) : probabilities.map(() => 1 / probabilities.length);
  return policy.outcomes[sampleIndex(normalized, random())];
}

/**
 * 联合 VoI 决策。beliefs 为各区域的边际信念（可直接复用 priorBeliefsForRegions）。
 * 粒子数/采样数与相关性权重来自 policy.correlation；缺省时使用保守默认值。
 */
export function decideJointInvestigation(
  policy: InvestigationPolicy,
  targetRegionId: string,
  beliefs: Map<string, BeliefEntry[]>,
  graph: RegionGraph,
  availability: Record<string, { available: boolean; reason?: string }> = {},
  options: {
    usedActions?: number;
    usedCost?: number;
    usedTimeMinutes?: number;
    particleCount?: number;
    outcomeSamples?: number;
    seed?: number;
  } = {},
): JointVoIDecision {
  const regionIds = [...graph.regionIds];
  const correlation = policy.correlation ?? { shared_pressure_weight: 0.45, particles: 1200, seed: 20261109 };
  const particleCount = Math.max(200, Math.min(4000, options.particleCount ?? correlation.particles));
  const outcomeSamples = Math.max(40, Math.min(1000, options.outcomeSamples ?? 120));
  const seed = (options.seed ?? correlation.seed) ^ (targetRegionId.length * 2654435761);
  const random = mulberry32(seed);
  const hypotheses = policy.hypotheses.map(item => item.id);
  const particles = buildParticles(regionIds, beliefs, hypotheses, correlation.shared_pressure_weight, particleCount, random);
  const priorWeights = particles.map(() => 1);
  const jointEntropyBefore = weightedParticleEntropy(particles, priorWeights);
  const priorMarginalRisks = posteriorMarginalRisks(policy, regionIds, particles, priorWeights);
  const riskBeforeWorst = Math.max(0, ...priorMarginalRisks);
  const regionIndex = new Map(regionIds.map((id, index) => [id, index]));
  const priorMarginals = regionIds.map((id, index) => {
    const counts = new Map<string, number>();
    for (const particle of particles) counts.set(particle[index], (counts.get(particle[index]) ?? 0) + 1);
    return normalizeBelief(policy.hypotheses.map(hypothesis => ({
      hypothesis_id: hypothesis.id,
      label: hypothesis.label,
      probability: (counts.get(hypothesis.id) ?? 0) / particles.length,
    })));
  });

  const usedActions = options.usedActions ?? 0;
  const usedCost = options.usedCost ?? 0;
  const usedTime = options.usedTimeMinutes ?? 0;
  const usage = { used_actions: usedActions, used_cost: usedCost, used_time_minutes: usedTime };
  const budget = policy.budget;
  const budgetExhausted = Boolean(budget) && allCandidatesBlocked(policy, usage);

  const evaluations = policy.actions.map(action => {
    const runtime = availability[action.id];
    const runtimeAvailable = Boolean(runtime?.available ?? action.base_availability === 'available');
    const budgetDecision = checkCandidateBudget(policy, action, usage);
    const available = runtimeAvailable && budgetDecision.eligible;
    const unavailableReason = available
      ? null
      : !budgetDecision.eligible
        ? budgetDecision.reason
        : runtime?.reason ?? (action.base_availability === 'degraded' ? '数据源降级' : '当前不可用');
    const covered = coveredRegions(action, targetRegionId, graph);
    const coveredIndexes = covered.map(id => regionIndex.get(id)).filter((index): index is number => index !== undefined);

    let expectedEntropy = 0;
    let expectedWorstRisk = 0;
    for (let sample = 0; sample < outcomeSamples; sample += 1) {
      const outcomes = coveredIndexes.map(index =>
        predictiveOutcome(policy, action.kind, priorMarginals[index], random));
      const weights = particles.map(particle => {
        let weight = 1;
        for (let c = 0; c < coveredIndexes.length; c += 1) {
          weight *= likelihood(policy, action.kind, particle[coveredIndexes[c]], outcomes[c]);
          if (weight <= 0) return 0;
        }
        return weight;
      });
      expectedEntropy += weightedParticleEntropy(particles, weights);
      const risks = posteriorMarginalRisks(policy, regionIds, particles, weights);
      expectedWorstRisk += Math.max(0, ...risks);
    }
    expectedEntropy /= outcomeSamples;
    expectedWorstRisk /= outcomeSamples;
    const informationGain = Math.max(0, jointEntropyBefore - expectedEntropy);
    const riskReduction = Math.max(0, riskBeforeWorst - expectedWorstRisk);

    const timeNorm = Math.min(1, action.time_cost_minutes / policy.normalization.max_time_minutes);
    const resourceNorm = Math.min(1, action.resource_cost / policy.normalization.max_resource_cost);
    const score = available
      ? policy.weights.risk_reduction * riskReduction
        + policy.weights.information_gain * informationGain
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
      covered_regions: covered,
      joint_information_gain_bits: Number(informationGain.toFixed(6)),
      risk_reduction: Number(riskReduction.toFixed(6)),
      risk_before_worst: Number(riskBeforeWorst.toFixed(6)),
      expected_risk_after_worst: Number(expectedWorstRisk.toFixed(6)),
      time_cost_minutes: action.time_cost_minutes,
      resource_cost: action.resource_cost,
      failure_probability: action.failure_probability,
      score: score === null ? null : Number(score.toFixed(6)),
      budget: {
        eligible: budgetDecision.eligible,
        reason_code: budgetDecision.reason_code,
        reason: budgetDecision.reason,
        remaining: budgetDecision.remaining,
      },
    };
  });

  const ranked = evaluations
    .filter(item => item.available && item.score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = ranked[0];
  let stopReason: JointVoIDecision['stop_reason'] = null;
  let shouldInvestigate = false;
  if (usedActions >= policy.max_investigations) stopReason = 'max_investigations_reached';
  else if (budgetExhausted) stopReason = 'budget_exhausted';
  else if (!best) stopReason = 'no_available_action';
  else if ((best.score ?? 0) < policy.stop_threshold) stopReason = 'voi_below_threshold';
  else shouldInvestigate = true;

  return {
    engine_version: JOINT_VOI_ENGINE_VERSION,
    target_region_id: targetRegionId,
    particle_count: particleCount,
    outcome_samples: outcomeSamples,
    correlation: {
      shared_pressure_weight: correlation.shared_pressure_weight,
      seed: correlation.seed,
    },
    covered_region_count: best?.covered_regions.length ?? 0,
    evaluations,
    ranked_action_ids: ranked.map(item => item.action_id),
    recommended_action_id: shouldInvestigate ? best?.action_id ?? null : null,
    recommended_covered_regions: shouldInvestigate ? (best?.covered_regions ?? []) : [],
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
