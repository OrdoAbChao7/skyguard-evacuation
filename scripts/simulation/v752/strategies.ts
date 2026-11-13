/**
 * Real strategy implementations for the V7.5.2 dynamic simulation.
 *
 * There are four independent strategies, not five labels over one planner:
 *  1. STATIC_SHORTEST_PATH: route table frozen at the first control tick.
 *  2. GREEDY_DYNAMIC: least-cost route recomputed every control tick.
 *  3. V73_STABILITY: greedy candidate + switch penalty / hysteresis.
 *  4. V74_COMMITMENT: V7.3 + commitment window + risk-triggered release.
 *
 * V7.3/V7.4 use the project's existing `route-stability.ts` decision functions
 * (`resolveStabilityConfig`, `shouldUseCommitment`, `adaptiveSwitchPenalty`)
 * rather than re-implementing them here.
 */
import {
  resolveStabilityConfig,
  shouldUseCommitment,
} from '../../../backend/src/services/safety/planning/route-stability';
import { adaptiveSwitchPenalty } from '../../../backend/src/services/safety/planning/v73-stability';
import {
  computeAllRoutes,
  evaluateRoute,
  regionDensity,
} from './network';
import type {
  ObservedSnapshot,
  RouteChoice,
  RouteComputation,
  SimScenario,
  StrategyId,
} from './types';

export interface StrategyMemory {
  staticRoutes: Map<string, RouteChoice | null> | null;
  committedRoutes: Map<string, RouteChoice>;
  lastSwitchMinute: Map<string, number>;
  lastReason: Map<string, string>;
}

export function createStrategyMemory(): StrategyMemory {
  return {
    staticRoutes: null,
    committedRoutes: new Map(),
    lastSwitchMinute: new Map(),
    lastReason: new Map(),
  };
}

export interface StrategyResult {
  computation: RouteComputation;
  reasons: Map<string, string>;
}

export interface StrategyConfig {
  v73SwitchPenaltyPerPerson: number;
  v73HysteresisGap: number;
  v74SwitchPenaltyPerPerson: number;
  v74CommitMinutes: number;
  v74HysteresisGap: number;
  v74AdaptiveQueueThreshold: number;
  v74MaxObjectiveDegradation: number;
  v74RiskReleaseThreshold: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  v73SwitchPenaltyPerPerson: 2.0,
  v73HysteresisGap: 0.1,
  v74SwitchPenaltyPerPerson: 3.5,
  v74CommitMinutes: 6,
  v74HysteresisGap: 0.12,
  v74AdaptiveQueueThreshold: 500,
  v74MaxObjectiveDegradation: 0.3,
  v74RiskReleaseThreshold: 2.5,
};

function observedCount(snapshot: ObservedSnapshot, regionId: string): number {
  const observation = snapshot.regions.get(regionId);
  if (!observation || observation.count === null) return 0;
  return Math.max(0, observation.count);
}

function worstDensity(scenario: SimScenario, snapshot: ObservedSnapshot): number {
  let worst = 0;
  for (const region of scenario.regions) {
    worst = Math.max(worst, regionDensity(scenario, snapshot, region.id));
  }
  return worst;
}

function totalObserved(snapshot: ObservedSnapshot): number {
  let total = 0;
  for (const observation of snapshot.regions.values()) total += Math.max(0, observation.count ?? 0);
  return total;
}

function candidateObjective(
  scenario: SimScenario,
  snapshot: ObservedSnapshot,
  route: RouteChoice,
  persons: number,
): number {
  const cost = evaluateRoute(scenario, snapshot, route);
  if (!Number.isFinite(cost)) return Number.POSITIVE_INFINITY;
  return cost * Math.max(1, persons);
}

function committedObjective(
  scenario: SimScenario,
  snapshot: ObservedSnapshot,
  route: RouteChoice,
  persons: number,
): number {
  return candidateObjective(scenario, snapshot, route, persons);
}

export function computeStrategyRoutes(
  strategy: StrategyId,
  scenario: SimScenario,
  snapshot: ObservedSnapshot,
  memory: StrategyMemory,
  minute: number,
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): StrategyResult {
  const reasons = new Map<string, string>();

  if (strategy === 'STATIC_SHORTEST_PATH') {
    if (memory.staticRoutes === null) {
      // A static plan is frozen once, but only from a snapshot in which every
      // region is trusted.  Freezing on a missing/degraded first observation
      // would silently give the static baseline an invalid information
      // advantage (or disadvantage) unrelated to the algorithm.
      const fullyTrusted = scenario.regions.every(region => {
        const observation = snapshot.regions.get(region.id);
        return Boolean(
          observation
          && observation.count !== null
          && observation.valid
          && !observation.conflict
          && observation.confidence >= 0.6
          && observation.age_seconds <= 90,
        );
      });
      if (!fullyTrusted) {
        return {
          computation: {
            routes: new Map(scenario.regions.map(region => [region.id, null])),
            solve_ms: 0,
            graph_nodes: scenario.regions.length,
            graph_edges: 0,
          },
          reasons: new Map(scenario.regions.map(region => [region.id, 'static_waiting_for_fully_trusted_observation'])),
        };
      }
      const frozen = computeAllRoutes(scenario, snapshot);
      memory.staticRoutes = frozen.routes;
      for (const region of scenario.regions) {
        reasons.set(region.id, 'static_frozen_at_first_fully_trusted_control_tick');
      }
      return { computation: frozen, reasons };
    }
    // A static plan never recomputes, even when its route becomes closed.
    return {
      computation: {
        routes: memory.staticRoutes,
        solve_ms: 0,
        graph_nodes: scenario.regions.length,
        graph_edges: 0,
      },
      reasons: new Map(scenario.regions.map(region => [region.id, 'static_frozen_no_recompute'])),
    };
  }

  const fresh = computeAllRoutes(scenario, snapshot);
  if (strategy === 'GREEDY_DYNAMIC') {
    for (const region of scenario.regions) reasons.set(region.id, 'greedy_recomputed_each_control_tick');
    return { computation: fresh, reasons };
  }

  const isV74 = strategy === 'V74_COMMITMENT';
  const stabilityConfig = resolveStabilityConfig(isV74
    ? {
        mode: 'adaptive',
        switchPenaltyPerPerson: config.v74SwitchPenaltyPerPerson,
        commitMinutes: config.v74CommitMinutes,
        hysteresisGap: config.v74HysteresisGap,
        adaptiveQueueThreshold: config.v74AdaptiveQueueThreshold,
        maxObjectiveDegradation: config.v74MaxObjectiveDegradation,
        emergencyOverride: true,
      }
    : {
        mode: 'switch_penalty',
        switchPenaltyPerPerson: config.v73SwitchPenaltyPerPerson,
        commitMinutes: 0,
        hysteresisGap: config.v73HysteresisGap,
        adaptiveQueueThreshold: config.v74AdaptiveQueueThreshold,
        maxObjectiveDegradation: config.v74MaxObjectiveDegradation,
        emergencyOverride: true,
      });
  const maxDensity = worstDensity(scenario, snapshot);
  const queueTotal = totalObserved(snapshot);
  const riskPenalty = adaptiveSwitchPenalty(stabilityConfig, {
    queueTotal,
    worstRiskRatio: Math.min(1, maxDensity / Math.max(0.01, scenario.rhoCrit)),
  });

  const selected = new Map<string, RouteChoice | null>();
  for (const region of scenario.regions) {
    const candidate = fresh.routes.get(region.id) ?? null;
    const previous = memory.committedRoutes.get(region.id) ?? null;
    const persons = observedCount(snapshot, region.id);

    if (!previous) {
      selected.set(region.id, candidate);
      reasons.set(region.id, candidate ? 'initial_candidate_no_previous_route' : 'no_route_available');
      continue;
    }
    if (!candidate) {
      selected.set(region.id, null);
      reasons.set(region.id, 'no_candidate_route_available');
      continue;
    }

    const previousCost = committedObjective(scenario, snapshot, previous, persons);
    const candidateCost = candidateObjective(scenario, snapshot, candidate, persons);
    if (!Number.isFinite(previousCost)) {
      selected.set(region.id, candidate);
      reasons.set(region.id, 'previous_route_physically_invalid_emergency_override');
      continue;
    }
    if (!Number.isFinite(candidateCost)) {
      selected.set(region.id, previous);
      reasons.set(region.id, 'candidate_route_invalid_keep_previous');
      continue;
    }

    const withinCommit = isV74
      && (() => {
        const lastSwitch = memory.lastSwitchMinute.get(region.id);
        return lastSwitch !== undefined && minute - lastSwitch < stabilityConfig.commitMinutes;
      })();
    const riskRelease = isV74 && maxDensity >= config.v74RiskReleaseThreshold;
    const congested = queueTotal >= stabilityConfig.adaptiveQueueThreshold;

    const sameExit = candidate.exit_id === previous.exit_id && candidate.next_hop_region_id === previous.next_hop_region_id;
    if (sameExit) {
      selected.set(region.id, candidate);
      reasons.set(region.id, isV74 ? 'same_route_commitment_reaffirmed' : 'same_route_no_switch');
      continue;
    }

    if (riskRelease) {
      selected.set(region.id, candidate);
      reasons.set(region.id, `v74_risk_release_${maxDensity.toFixed(2)}>=${config.v74RiskReleaseThreshold}`);
      continue;
    }

    const decision = shouldUseCommitment({
      mode: stabilityConfig.mode,
      config: stabilityConfig,
      withinCommit,
      congested,
      baseObjective: candidateCost,
      committedObjective: previousCost,
      baseSwitchPersons: persons,
      committedSwitchPersons: 0,
    });
    if (decision.use) {
      selected.set(region.id, previous);
      reasons.set(region.id, `${isV74 ? 'v74' : 'v73'}_${decision.reason}_risk_penalty_${riskPenalty.toFixed(2)}`);
    } else {
      selected.set(region.id, candidate);
      reasons.set(region.id, `${isV74 ? 'v74' : 'v73'}_${decision.reason}`);
    }
  }

  return {
    computation: {
      routes: selected,
      solve_ms: fresh.solve_ms,
      graph_nodes: fresh.graph_nodes,
      graph_edges: fresh.graph_edges,
    },
    reasons,
  };
}

/**
 * Called by the engine after validation.  Only validated or explicitly
 * continued routes become the next "previous route"; rejected candidates never
 * contaminate the stability memory.
 */
export function commitValidatedRoutes(
  memory: StrategyMemory,
  decisions: Map<string, { route: RouteChoice | null; mode: 'validated' | 'degraded_continue' | 'rejected' | 'no_route' }>,
  minute: number,
): { switches: number; switchedPersons: number } {
  let switches = 0;
  let switchedPersons = 0;
  for (const [regionId, decision] of decisions) {
    if (decision.mode !== 'validated' && decision.mode !== 'degraded_continue') continue;
    if (!decision.route) continue;
    const previous = memory.committedRoutes.get(regionId);
    const changed = !previous
      || previous.exit_id !== decision.route.exit_id
      || previous.next_hop_region_id !== decision.route.next_hop_region_id;
    if (changed && previous) {
      switches += 1;
      switchedPersons += Math.max(0, decision.route.path_regions.length > 0 ? 1 : 0);
      memory.lastSwitchMinute.set(regionId, minute);
    }
    memory.committedRoutes.set(regionId, decision.route);
  }
  return { switches, switchedPersons };
}
