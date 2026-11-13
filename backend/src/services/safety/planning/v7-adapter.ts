/**
 * V7 Planner Adapter — Shadow Mode（V7.1）。
 *
 * 目标：让 V7 规划器与既有安全规划器在同一输入快照上并行计算，
 * 但**只记录比较结果，永不替换默认发布方案**。
 *
 * 安全边界：
 *  - 默认关闭（V7_SHADOW_MODE 未设置或为 0）；
 *  - Shadow 结果不发布、不审批、不改变四态；
 *  - 两套方案都经独立 Validator 复算；
 *  - V7 超时/异常/无解时自动回退，旧链路完全不受影响；
 *  - 只有通过后续独立安全验收，才允许提出启用建议。
 */
import crypto from 'node:crypto';
import type {
  DensityObservation,
  EvacuationPlan,
  SafetyConfig,
  SafetyScenario,
  SafetyValidationResult,
} from '../types';
import type { EffectiveNetwork } from '../network';
import { validateSafetyPlan } from '../validator';
import { simulatePlanExecution } from './congestion';
import { dominantExits, switchingImpact } from './route-stability';
import { solveTimeExpandedPlan, type SolveVersions } from './strategies';
import type { SafetyDecisionService } from '../decision-service';

export interface ShadowConfig {
  enabled: boolean;
  strategy: 'solver';
  maxSolveMs: number;
  maxComparisons: number;
  /** V7.3：快照最大允许年龄（毫秒）；超过即判定 stale。 */
  maxSnapshotAgeMs: number;
  source: string;
}

export function shadowConfig(env: NodeJS.ProcessEnv = process.env): ShadowConfig {
  const enabled = env.V7_SHADOW_MODE === '1' || env.V7_SHADOW_MODE === 'true';
  const raw = Number(env.V7_SHADOW_MAX_SOLVE_MS ?? 500);
  const rawAge = Number(env.V7_SHADOW_MAX_SNAPSHOT_AGE_MS ?? 10_000);
  return {
    enabled,
    strategy: 'solver',
    maxSolveMs: Number.isFinite(raw) ? Math.max(0, Math.min(5000, raw)) : 500,
    maxComparisons: 20,
    maxSnapshotAgeMs: Number.isFinite(rawAge) ? Math.max(0, Math.min(600_000, rawAge)) : 10_000,
    source: 'environment',
  };
}

export interface ShadowSnapshot {
  scenario_version: string;
  constraint_version: number;
  observation_version: number;
  captured_at: string;
  /** V7.3：快照年龄与过期标记。 */
  age_ms: number;
  stale: boolean;
  demand_total: number;
  demand_by_region: Array<{ region_id: string; persons: number }>;
  usable_corridors: number;
  usable_exits: number;
  hash: string;
}

export interface ShadowPlanSide {
  plan_id: string;
  status: string;
  evacuated_persons: number;
  unresolved_persons: number;
  routes: number;
  validation_valid: boolean | null;
  violation_codes: string[];
  solve_ms: number;
  projected_makespan_minute: number | null;
  projected_queue_person_minutes: number | null;
  projected_unserved_persons: number | null;
}

export interface ShadowComparison {
  id: string;
  created_at: string;
  config: ShadowConfig;
  snapshot: ShadowSnapshot;
  legacy: ShadowPlanSide;
  v7: ShadowPlanSide | null;
  /**
   * 输入一致性：计划声明的总人数必须与快照需求一致。
   * 不一致说明 legacy/V7 没有基于同一版本化输入，比较无效。
   */
  integrity: {
    legacy_persons_match_snapshot: boolean;
    v7_persons_match_snapshot: boolean | null;
  };
  comparison: {
    evacuated_delta: number | null;
    unresolved_delta: number | null;
    projected_makespan_delta: number | null;
    projected_queue_delta: number | null;
    v7_valid: boolean | null;
    legacy_valid: boolean | null;
  };
  decision: 'legacy_only' | 'v7_eligible_for_review';
  fallback_reason: string | null;
  /** V7.3：legacy 与 V7 方案之间的出口改派比较。 */
  route_switch_comparison: {
    changed_regions: number;
    affected_persons: number;
    regions: string[];
  } | null;
  notes: string[];
}

export type ShadowSolver = (input: {
  scenario: SafetyScenario;
  network: EffectiveNetwork;
  demandByRegion: Map<string, number>;
  versions: SolveVersions;
  now: Date;
  horizonMinutes: number;
}) => { plan: EvacuationPlan; solveMs?: number };

export interface ShadowInput {
  scenario: SafetyScenario;
  network: EffectiveNetwork;
  demandByRegion: Map<string, number>;
  versions: SolveVersions;
  latestObservations: Map<string, DensityObservation>;
  config: SafetyConfig;
  legacyPlan: EvacuationPlan;
  legacySolveMs: number;
  now?: Date;
  configOverride?: Partial<ShadowConfig>;
  /**
   * 求解器注入（默认 V7 时间扩展求解器）。仅用于故障注入与回放压力测试；
   * 生产调用方不得传入会改变发布语义的实现。
   */
  solverOverride?: ShadowSolver;
  /** V7.3：回放时使用的快照采集时间；缺省为 now。 */
  snapshotCapturedAt?: Date;
}

function snapshotOf(input: ShadowInput, now: Date): ShadowSnapshot {
  const demand = [...input.demandByRegion.entries()]
    .filter(([, persons]) => persons > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([region_id, persons]) => ({ region_id, persons: Math.floor(persons) }));
  const payload = JSON.stringify({
    scenario_version: input.versions.scenarioVersion,
    constraint_version: input.versions.constraintVersion,
    observation_version: input.versions.observationVersion,
    demand,
    corridors: [...input.network.corridors.entries()].filter(([, value]) => value.usable).map(([id]) => id).sort(),
    exits: [...input.network.exits.entries()].filter(([, value]) => value.usable).map(([id]) => id).sort(),
  });
  const capturedAt = input.snapshotCapturedAt ?? now;
  const capturedMs = capturedAt.getTime();
  return {
    scenario_version: input.versions.scenarioVersion,
    constraint_version: input.versions.constraintVersion,
    observation_version: input.versions.observationVersion,
    captured_at: capturedAt.toISOString(),
    age_ms: Math.max(0, now.getTime() - capturedMs),
    stale: false,
    demand_total: demand.reduce((sum, item) => sum + item.persons, 0),
    demand_by_region: demand,
    usable_corridors: [...input.network.corridors.values()].filter(value => value.usable).length,
    usable_exits: [...input.network.exits.values()].filter(value => value.usable).length,
    hash: crypto.createHash('sha256').update(payload).digest('hex'),
  };
}

function planSide(
  plan: EvacuationPlan,
  validation: SafetyValidationResult | null,
  solveMs: number,
  projection: ReturnType<typeof simulatePlanExecution> | null,
): ShadowPlanSide {
  return {
    plan_id: plan.plan_id,
    status: plan.status,
    evacuated_persons: plan.evacuated_persons,
    unresolved_persons: plan.unresolved_persons,
    routes: plan.routes.length,
    validation_valid: validation ? validation.valid : null,
    violation_codes: validation ? validation.violations.map(item => item.code) : [],
    solve_ms: solveMs,
    projected_makespan_minute: projection ? projection.makespan_minute : null,
    projected_queue_person_minutes: projection ? projection.total_queue_person_minutes : null,
    projected_unserved_persons: projection ? projection.unserved_persons : null,
  };
}

/**
 * 在同一输入快照上运行 legacy 与 V7 规划，并做独立校验/执行投影。
 * 只返回比较记录；调用方不得把 V7 方案发布为安全方案。
 */
export function runShadowComparison(input: ShadowInput): ShadowComparison {
  const now = input.now ?? new Date();
  const config = { ...shadowConfig(), ...(input.configOverride ?? {}) };
  const snapshot = snapshotOf(input, now);
  snapshot.stale = snapshot.age_ms > config.maxSnapshotAgeMs;
  const legacyValidation = validateSafetyPlan({
    plan: input.legacyPlan,
    scenario: input.scenario,
    network: input.network,
    latestObservations: input.latestObservations,
    config: input.config,
    constraintVersion: input.versions.constraintVersion,
    observationVersion: input.versions.observationVersion,
    now,
  });
  const legacyProjection = simulatePlanExecution(input.scenario, input.legacyPlan);
  const legacy = planSide(input.legacyPlan, legacyValidation, input.legacySolveMs, legacyProjection);
  const legacyMatchesSnapshot = input.legacyPlan.total_persons === snapshot.demand_total;

  const base: Omit<ShadowComparison, 'v7' | 'comparison' | 'decision' | 'fallback_reason' | 'integrity'> = {
    id: `SHADOW-${now.getTime().toString(36).toUpperCase()}-${snapshot.hash.slice(0, 8)}`,
    created_at: now.toISOString(),
    config,
    snapshot,
    legacy,
    route_switch_comparison: null,
    notes: [
      'Shadow 结果不发布、不审批、不改变四态；仅用于比较与审计。',
      '只有通过后续独立安全验收，才允许提出启用建议。',
    ],
  };
  const integrity = { legacy_persons_match_snapshot: legacyMatchesSnapshot, v7_persons_match_snapshot: null };

  if (!config.enabled) {
    return {
      ...base,
      v7: null,
      integrity,
      comparison: {
        evacuated_delta: null, unresolved_delta: null, projected_makespan_delta: null,
        projected_queue_delta: null, v7_valid: null, legacy_valid: legacy.validation_valid,
      },
      decision: 'legacy_only',
      fallback_reason: 'shadow_disabled',
    };
  }

  if (config.maxSolveMs <= 0) {
    return {
      ...base,
      v7: null,
      integrity,
      comparison: {
        evacuated_delta: null, unresolved_delta: null, projected_makespan_delta: null,
        projected_queue_delta: null, v7_valid: null, legacy_valid: legacy.validation_valid,
      },
      decision: 'legacy_only',
      fallback_reason: 'solve_budget_zero',
    };
  }

  if (snapshot.stale) {
    return {
      ...base,
      v7: null,
      integrity,
      comparison: {
        evacuated_delta: null, unresolved_delta: null, projected_makespan_delta: null,
        projected_queue_delta: null, v7_valid: null, legacy_valid: legacy.validation_valid,
      },
      decision: 'legacy_only',
      fallback_reason: 'snapshot_stale',
    };
  }

  const started = Date.now();
  try {
    const solved = input.solverOverride
      ? input.solverOverride({
        scenario: input.scenario,
        network: input.network,
        demandByRegion: input.demandByRegion,
        versions: input.versions,
        now,
        horizonMinutes: input.scenario.config.horizon_minutes,
      })
      : solveTimeExpandedPlan({
        scenario: input.scenario,
        network: input.network,
        demandByRegion: input.demandByRegion,
        horizonMinutes: input.scenario.config.horizon_minutes,
        versions: input.versions,
        now,
        holdCostPerMinute: 0.05,
        algorithm: 'V7 shadow: time-expanded min-cost flow',
        model: 'same snapshot as legacy planner; no forecast injection',
      });
    const solveMs = solved.solveMs ?? Date.now() - started;
    if (solveMs > config.maxSolveMs) {
      return {
        ...base,
        v7: planSide(solved.plan, null, solveMs, null),
        integrity: {
          legacy_persons_match_snapshot: legacyMatchesSnapshot,
          v7_persons_match_snapshot: solved.plan.total_persons === snapshot.demand_total,
        },
        comparison: {
          evacuated_delta: null, unresolved_delta: null, projected_makespan_delta: null,
          projected_queue_delta: null, v7_valid: null, legacy_valid: legacy.validation_valid,
        },
        decision: 'legacy_only',
        fallback_reason: `v7_timeout_${solveMs}ms_gt_${config.maxSolveMs}ms`,
      };
    }
    const validation = validateSafetyPlan({
      plan: solved.plan,
      scenario: input.scenario,
      network: input.network,
      latestObservations: input.latestObservations,
      config: input.config,
      constraintVersion: input.versions.constraintVersion,
      observationVersion: input.versions.observationVersion,
      now,
    });
    const projection = simulatePlanExecution(input.scenario, solved.plan);
    const v7 = planSide(solved.plan, validation, solveMs, projection);
    const v7MatchesSnapshot = solved.plan.total_persons === snapshot.demand_total;
    const switchImpact = switchingImpact(solved.plan.routes, dominantExits(input.legacyPlan.routes));
    const comparison = {
      evacuated_delta: v7.evacuated_persons - legacy.evacuated_persons,
      unresolved_delta: v7.unresolved_persons - legacy.unresolved_persons,
      projected_makespan_delta: (v7.projected_makespan_minute ?? 0) - (legacy.projected_makespan_minute ?? 0),
      projected_queue_delta: (v7.projected_queue_person_minutes ?? 0) - (legacy.projected_queue_person_minutes ?? 0),
      v7_valid: validation.valid,
      legacy_valid: legacy.validation_valid,
    };
    const eligible = validation.valid
      && legacy.validation_valid === true
      && legacyMatchesSnapshot
      && v7MatchesSnapshot
      && comparison.evacuated_delta >= 0
      && comparison.projected_makespan_delta <= 0
      && comparison.projected_queue_delta <= 0;
    const failureReason = !legacyMatchesSnapshot
      ? 'legacy_snapshot_mismatch'
      : !v7MatchesSnapshot
        ? 'v7_snapshot_mismatch'
        : validation.valid ? null : 'v7_validation_failed';
    return {
      ...base,
      v7,
      integrity: {
        legacy_persons_match_snapshot: legacyMatchesSnapshot,
        v7_persons_match_snapshot: v7MatchesSnapshot,
      },
      comparison,
      decision: eligible ? 'v7_eligible_for_review' : 'legacy_only',
      fallback_reason: failureReason,
      route_switch_comparison: {
        changed_regions: switchImpact.regions.length,
        affected_persons: switchImpact.persons,
        regions: switchImpact.regions,
      },
    };
  } catch (error) {
    return {
      ...base,
      v7: null,
      integrity,
      comparison: {
        evacuated_delta: null, unresolved_delta: null, projected_makespan_delta: null,
        projected_queue_delta: null, v7_valid: null, legacy_valid: legacy.validation_valid,
      },
      decision: 'legacy_only',
      fallback_reason: `v7_error:${(error as Error).message}`,
    };
  }
}

/** 从安全服务读取最近 Shadow 比较（只读）。 */
export function shadowComparisonsOf(service: SafetyDecisionService): ShadowComparison[] {
  return service.getShadowComparisons();
}
