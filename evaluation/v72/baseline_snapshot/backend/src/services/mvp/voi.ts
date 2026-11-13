/**
 * Risk-aware Value of Information（VoI）主动调查引擎。
 *
 * 数学模型（全部参数来自场景文件 `investigation`，禁止由大模型生成）：
 *   先验      P(H_i)
 *   似然      P(o_j | H_i, a)
 *   后验      P(H_i | o_j, a) = P(o_j | H_i, a) P(H_i) / P(o_j | a)
 *   信息增益  IG(a) = H(B) - E_o[H(B' | a)]            （单位：bit）
 *   风险损失  R(B) = min_d Σ_i P(H_i) L(H_i, d)
 *            ΔR(a) = R(B) - E_o[R(B' | a)]
 *   综合评分  VOI(a) = w_r·ΔR + w_i·IG - w_t·C_t - w_c·C_c - w_f·P_f
 *
 * 调查成本按场景配置归一化；所有输出都携带模型版本与参数来源。
 */
import type {
  InvestigationAction,
  InvestigationKind,
  InvestigationOutcome,
  InvestigationPolicy,
} from '../safety/types';

export const VOI_ENGINE_VERSION = '1.0.0';

export interface BeliefEntry {
  hypothesis_id: string;
  label: string;
  probability: number;
}

export interface AvailabilityOverride {
  available: boolean;
  reason?: string;
}

export type AvailabilityMap = Record<string, AvailabilityOverride>;

export interface OutcomeProbability {
  outcome: InvestigationOutcome;
  probability: number;
}

export interface ActionEvaluation {
  action_id: string;
  kind: InvestigationKind;
  label: string;
  available: boolean;
  unavailable_reason: string | null;
  priority: number;
  source: string;
  outcome_probabilities: OutcomeProbability[];
  posterior_by_outcome: Record<string, BeliefEntry[]>;
  entropy_before: number;
  expected_entropy_after: number;
  information_gain_bits: number;
  risk_before: number;
  expected_risk_after: number;
  risk_reduction: number;
  time_cost_normalized: number;
  resource_cost_normalized: number;
  failure_probability: number;
  score: number | null;
  score_breakdown: {
    risk_term: number;
    information_term: number;
    time_penalty: number;
    resource_penalty: number;
    failure_penalty: number;
  } | null;
}

export interface VoIDecision {
  engine_version: string;
  model_version: string;
  provenance: string;
  generated_at: string;
  belief_before: BeliefEntry[];
  entropy_before_bits: number;
  risk_before: number;
  evaluations: ActionEvaluation[];
  ranked_action_ids: string[];
  recommended_action_id: string | null;
  should_investigate: boolean;
  stop_reason: 'voi_below_threshold' | 'no_available_action' | 'max_investigations_reached' | null;
  stop_threshold: number;
  investigations_used: number;
  max_investigations: number;
  weights: InvestigationPolicy['weights'];
}

export function priorBelief(policy: InvestigationPolicy): BeliefEntry[] {
  return normalizeBelief(
    policy.hypotheses.map(hypothesis => ({
      hypothesis_id: hypothesis.id,
      label: hypothesis.label,
      probability: hypothesis.prior,
    })),
  );
}

export function normalizeBelief(belief: BeliefEntry[]): BeliefEntry[] {
  if (belief.length === 0) return [];
  const total = belief.reduce((sum, entry) => sum + entry.probability, 0);
  if (!Number.isFinite(total) || total <= 1e-12) {
    const uniform = 1 / belief.length;
    return belief.map(entry => ({ ...entry, probability: uniform }));
  }
  return belief.map(entry => ({ ...entry, probability: entry.probability / total }));
}

/** Shannon 熵，单位 bit。 */
export function entropy(belief: BeliefEntry[]): number {
  return -belief.reduce((sum, entry) => {
    if (entry.probability <= 0) return sum;
    return sum + entry.probability * Math.log2(entry.probability);
  }, 0);
}

/** 在给定信念下，选择期望损失最小的决策后的风险。 */
export function expectedRisk(policy: InvestigationPolicy, belief: BeliefEntry[]): number {
  const decisionRisks = policy.decisions.map(decision => {
    return belief.reduce((sum, entry) => {
      const loss = policy.loss_matrix[entry.hypothesis_id]?.[decision];
      return sum + entry.probability * (typeof loss === 'number' ? loss : 1);
    }, 0);
  });
  return decisionRisks.length > 0 ? Math.min(...decisionRisks) : 0;
}

function normalizedLikelihood(
  policy: InvestigationPolicy,
  kind: InvestigationKind,
  hypothesisId: string,
): Record<string, number> {
  const row = policy.likelihoods[kind]?.[hypothesisId] ?? {};
  let total = 0;
  for (const outcome of policy.outcomes) total += row[outcome] ?? 0;
  const normalized: Record<string, number> = {};
  for (const outcome of policy.outcomes) {
    normalized[outcome] = total > 0 ? (row[outcome] ?? 0) / total : 1 / policy.outcomes.length;
  }
  return normalized;
}

export function outcomeProbabilities(
  policy: InvestigationPolicy,
  kind: InvestigationKind,
  belief: BeliefEntry[],
): OutcomeProbability[] {
  return policy.outcomes.map(outcome => ({
    outcome,
    probability: belief.reduce((sum, entry) => {
      return sum + entry.probability * normalizedLikelihood(policy, kind, entry.hypothesis_id)[outcome];
    }, 0),
  }));
}

export function posteriorAfterOutcome(
  policy: InvestigationPolicy,
  kind: InvestigationKind,
  belief: BeliefEntry[],
  outcome: InvestigationOutcome,
): BeliefEntry[] {
  const unnormalized = belief.map(entry => ({
    ...entry,
    probability: entry.probability * normalizedLikelihood(policy, kind, entry.hypothesis_id)[outcome],
  }));
  const evidenceMass = unnormalized.reduce((sum, entry) => sum + entry.probability, 0);
  // 证据在所有假设下的概率都为 0：该结果不可发生，保持原信念，不制造"均匀后验"。
  if (!Number.isFinite(evidenceMass) || evidenceMass <= 1e-12) {
    return belief.map(entry => ({ ...entry }));
  }
  return unnormalized.map(entry => ({ ...entry, probability: entry.probability / evidenceMass }));
}

function clamp01(value: number, max = 1): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(max, value));
}

function evaluateAction(
  policy: InvestigationPolicy,
  belief: BeliefEntry[],
  action: InvestigationAction,
  runtime: AvailabilityOverride | undefined,
): ActionEvaluation {
  const baseAvailable = action.base_availability === 'available';
  const available = Boolean(runtime?.available ?? baseAvailable);
  const unavailableReason = available
    ? null
    : runtime?.reason ?? (action.base_availability === 'degraded' ? '数据源降级，未启用' : '当前不可用');

  const entropyBefore = entropy(belief);
  const riskBefore = expectedRisk(policy, belief);
  const outcomes = outcomeProbabilities(policy, action.kind, belief);

  let expectedEntropy = 0;
  let expectedRiskAfter = 0;
  const posteriorByOutcome: Record<string, BeliefEntry[]> = {};
  for (const item of outcomes) {
    const posterior = posteriorAfterOutcome(policy, action.kind, belief, item.outcome);
    posteriorByOutcome[item.outcome] = posterior;
    expectedEntropy += item.probability * entropy(posterior);
    expectedRiskAfter += item.probability * expectedRisk(policy, posterior);
  }

  const informationGain = entropyBefore - expectedEntropy;
  const riskReduction = riskBefore - expectedRiskAfter;
  const timeCost = clamp01(action.time_cost_minutes / policy.normalization.max_time_minutes);
  const resourceCost = clamp01(action.resource_cost / policy.normalization.max_resource_cost);
  const failure = clamp01(action.failure_probability);

  const breakdown = {
    risk_term: policy.weights.risk_reduction * riskReduction,
    information_term: policy.weights.information_gain * informationGain,
    time_penalty: policy.weights.time_cost * timeCost,
    resource_penalty: policy.weights.resource_cost * resourceCost,
    failure_penalty: policy.weights.failure * failure,
  };
  const score = available
    ? breakdown.risk_term + breakdown.information_term
      - breakdown.time_penalty - breakdown.resource_penalty - breakdown.failure_penalty
    : null;

  return {
    action_id: action.id,
    kind: action.kind,
    label: action.label,
    available,
    unavailable_reason: unavailableReason,
    priority: action.priority,
    source: action.source,
    outcome_probabilities: outcomes,
    posterior_by_outcome: posteriorByOutcome,
    entropy_before: Number(entropyBefore.toFixed(6)),
    expected_entropy_after: Number(expectedEntropy.toFixed(6)),
    information_gain_bits: Number(informationGain.toFixed(6)),
    risk_before: Number(riskBefore.toFixed(6)),
    expected_risk_after: Number(expectedRiskAfter.toFixed(6)),
    risk_reduction: Number(riskReduction.toFixed(6)),
    time_cost_normalized: Number(timeCost.toFixed(6)),
    resource_cost_normalized: Number(resourceCost.toFixed(6)),
    failure_probability: failure,
    score: score === null ? null : Number(score.toFixed(6)),
    score_breakdown: score === null ? null : {
      risk_term: Number(breakdown.risk_term.toFixed(6)),
      information_term: Number(breakdown.information_term.toFixed(6)),
      time_penalty: Number(breakdown.time_penalty.toFixed(6)),
      resource_penalty: Number(breakdown.resource_penalty.toFixed(6)),
      failure_penalty: Number(breakdown.failure_penalty.toFixed(6)),
    },
  };
}

export interface DecideOptions {
  availability?: AvailabilityMap;
  investigationsUsed?: number;
  now?: Date;
}

export function decideInvestigation(
  policy: InvestigationPolicy,
  beliefInput: BeliefEntry[] | null,
  options: DecideOptions = {},
): VoIDecision {
  const belief = normalizeBelief(beliefInput ?? priorBelief(policy));
  const evaluations = policy.actions.map(action => evaluateAction(
    policy,
    belief,
    action,
    options.availability?.[action.id],
  ));

  const ranked = evaluations
    .filter(item => item.available && item.score !== null)
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  const best = ranked[0];
  const investigationsUsed = options.investigationsUsed ?? 0;

  let shouldInvestigate = false;
  let stopReason: VoIDecision['stop_reason'] = null;
  if (!best) {
    stopReason = 'no_available_action';
  } else if (investigationsUsed >= policy.max_investigations) {
    stopReason = 'max_investigations_reached';
  } else if ((best.score ?? 0) < policy.stop_threshold) {
    stopReason = 'voi_below_threshold';
  } else {
    shouldInvestigate = true;
  }

  return {
    engine_version: VOI_ENGINE_VERSION,
    model_version: policy.model_version,
    provenance: policy.provenance,
    generated_at: (options.now ?? new Date()).toISOString(),
    belief_before: belief,
    entropy_before_bits: Number(entropy(belief).toFixed(6)),
    risk_before: Number(expectedRisk(policy, belief).toFixed(6)),
    evaluations,
    ranked_action_ids: ranked.map(item => item.action_id),
    recommended_action_id: shouldInvestigate ? best?.action_id ?? null : null,
    should_investigate: shouldInvestigate,
    stop_reason: stopReason,
    stop_threshold: policy.stop_threshold,
    investigations_used: investigationsUsed,
    max_investigations: policy.max_investigations,
    weights: policy.weights,
  };
}

/**
 * 固定优先级基线：按配置 priority 从小到大选择第一个可用动作。
 * 用于实验对照，不计算 VoI。
 */
export function fixedPriorityChoice(
  policy: InvestigationPolicy,
  availability: AvailabilityMap = {},
): { action_id: string | null; reason: string } {
  const ordered = [...policy.actions].sort((a, b) => a.priority - b.priority);
  for (const action of ordered) {
    const runtime = availability[action.id];
    const available = runtime?.available ?? action.base_availability === 'available';
    if (available) {
      return { action_id: action.id, reason: 'fixed_priority_first_available' };
    }
  }
  return { action_id: null, reason: 'no_available_action' };
}

export interface WeightSensitivity {
  parameter: keyof InvestigationPolicy['weights'];
  factor: number;
  recommended_action_id: string | null;
  ranked_action_ids: string[];
  best_score: number | null;
  second_score: number | null;
  score_gap: number | null;
}

/** 单参数权重敏感性：每次只缩放一个权重，观察推荐动作与分差是否稳定。 */
export function sensitivityAnalysis(
  policy: InvestigationPolicy,
  beliefInput: BeliefEntry[] | null = null,
  options: DecideOptions = {},
  factors: number[] = [0.5, 1, 1.5],
): WeightSensitivity[] {
  const belief = normalizeBelief(beliefInput ?? priorBelief(policy));
  const results: WeightSensitivity[] = [];
  for (const parameter of Object.keys(policy.weights) as Array<keyof InvestigationPolicy['weights']>) {
    for (const factor of factors) {
      const variant: InvestigationPolicy = {
        ...policy,
        weights: { ...policy.weights, [parameter]: policy.weights[parameter] * factor },
      };
      const decision = decideInvestigation(variant, belief, options);
      const scores = decision.evaluations
        .filter(item => item.available && item.score !== null)
        .map(item => item.score as number)
        .sort((a, b) => b - a);
      results.push({
        parameter,
        factor,
        recommended_action_id: decision.recommended_action_id,
        ranked_action_ids: decision.ranked_action_ids,
        best_score: scores[0] ?? null,
        second_score: scores[1] ?? null,
        score_gap: scores.length >= 2 ? Number((scores[0] - scores[1]).toFixed(6)) : null,
      });
    }
  }
  return results;
}

/** 随机策略基线：在可用动作中均匀随机选择。 */
export function randomStrategyChoice(
  policy: InvestigationPolicy,
  availability: AvailabilityMap,
  rng: () => number,
): { action_id: string | null; reason: string } {
  const available = policy.actions.filter(action => {
    const runtime = availability[action.id];
    return runtime?.available ?? action.base_availability === 'available';
  });
  if (available.length === 0) return { action_id: null, reason: 'no_available_action' };
  return {
    action_id: available[Math.floor(rng() * available.length)].id,
    reason: 'random_available',
  };
}

/** 启发式基线：最大化"信息增益 / 归一化成本"，不考虑风险损失。 */
export function heuristicStrategyChoice(
  policy: InvestigationPolicy,
  beliefInput: BeliefEntry[] | null,
  availability: AvailabilityMap,
): { action_id: string | null; reason: string } {
  const belief = normalizeBelief(beliefInput ?? priorBelief(policy));
  const decision = decideInvestigation(policy, belief, { availability });
  let best: { id: string; ratio: number } | null = null;
  for (const evaluation of decision.evaluations) {
    if (!evaluation.available) continue;
    const cost = evaluation.time_cost_normalized + evaluation.resource_cost_normalized;
    const ratio = evaluation.information_gain_bits / Math.max(0.01, cost);
    if (!best || ratio > best.ratio) best = { id: evaluation.action_id, ratio };
  }
  return best
    ? { action_id: best.id, reason: 'max_information_gain_per_cost' }
    : { action_id: null, reason: 'no_available_action' };
}

export function applyEvidence(
  policy: InvestigationPolicy,
  belief: BeliefEntry[],
  kind: InvestigationKind,
  outcome: InvestigationOutcome,
): BeliefEntry[] {
  return posteriorAfterOutcome(policy, kind, belief, outcome);
}
