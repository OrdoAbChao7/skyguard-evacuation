/**
 * Dynamic safety validation for V7.5.2.
 *
 * This is intentionally independent of the strategy: it reconstructs corridor
 * status, capacity, topology and observation trust from the observed snapshot
 * and authoritative incident status, and never trusts a strategy's self-report.
 * It uses the project's four-state priority (`DEGRADED > REJECT > REROUTE >
 * NORMAL`) through `decideSafetyState`.
 */
import { decideSafetyState } from '../../../backend/src/services/safety/state-machine';
import type {
  EvacuationPlan,
  SafetyValidationResult,
  SafetyViolation,
} from '../../../backend/src/services/safety/types';
import { regionDensity } from './network';
import type {
  ObservedRegionState,
  ObservedSnapshot,
  RegionDecision,
  RouteChoice,
  SafetyState,
  SafetyTickSnapshot,
  SimScenario,
} from './types';

export interface DynamicSafetyInput {
  scenario: SimScenario;
  observed: ObservedSnapshot;
  corridorStatus: Map<string, 'open' | 'closed' | 'unknown'>;
  exitStatus: Map<string, 'open' | 'closed' | 'unknown'>;
  routes: Map<string, RouteChoice | null>;
  previousValidatedRoutes: Map<string, RouteChoice>;
  activeIncidentIds: string[];
  minute: number;
}

export interface DynamicSafetyResult {
  state: SafetyTickSnapshot;
  decisions: Map<string, RegionDecision>;
  closed_corridor_attempts: number;
  closed_exit_attempts: number;
  unknown_corridor_attempts: number;
  dangerous_route_attempts: number;
}

function observationTrusted(observation: ObservedRegionState | undefined): boolean {
  return Boolean(
    observation
    && observation.count !== null
    && observation.valid
    && !observation.conflict
    && observation.confidence >= 0.6
    && observation.age_seconds <= 90,
  );
}

function trustedReasons(observation: ObservedRegionState | undefined): string[] {
  if (!observation) return ['observation_missing'];
  if (observation.count === null) return ['observation_missing'];
  const reasons: string[] = [];
  if (!observation.valid) reasons.push('observation_invalid');
  if (observation.conflict) reasons.push('multi_provider_conflict');
  if (observation.confidence < 0.6) reasons.push(`low_confidence_${observation.confidence.toFixed(2)}`);
  if (observation.age_seconds > 90) reasons.push(`stale_${Math.round(observation.age_seconds)}s`);
  reasons.push(...observation.untrusted_reasons.filter(reason => !reasons.includes(reason)));
  return reasons;
}

function routeCheck(input: DynamicSafetyInput, route: RouteChoice): {
  hard: SafetyViolation[];
  closedCorridorAttempt: boolean;
  closedExitAttempt: boolean;
  unknownAttempt: boolean;
  dangerous: boolean;
} {
  const hard: SafetyViolation[] = [];
  let closedCorridorAttempt = false;
  let closedExitAttempt = false;
  let unknownAttempt = false;
  let dangerous = false;

  for (let index = 0; index < route.path_corridors.length; index += 1) {
    const corridorId = route.path_corridors[index];
    const corridor = input.scenario.corridorById.get(corridorId);
    if (!corridor) {
      hard.push({
        code: 'unknown_corridor',
        severity: 'hard',
        message: `路线 ${route.region_id} 引用了不存在的通道 ${corridorId}`,
        corridor_id: corridorId,
      });
      continue;
    }
    const status = input.corridorStatus.get(corridorId) ?? corridor.status;
    if (status === 'closed') {
      closedCorridorAttempt = true;
      hard.push({
        code: 'closed_corridor_used',
        severity: 'hard',
        message: `区域 ${route.region_id} 的候选路线使用已关闭通道 ${corridorId}`,
        corridor_id: corridorId,
      });
    } else if (status === 'unknown' || corridor.capacity_per_min === null || corridor.capacity_per_min <= 0) {
      unknownAttempt = true;
      hard.push({
        code: 'unknown_corridor_used',
        severity: 'hard',
        message: `区域 ${route.region_id} 的候选路线使用未知/无容量通道 ${corridorId}`,
        corridor_id: corridorId,
      });
    }
  }

  const exit = input.scenario.exitById.get(route.exit_id);
  if (!exit) {
    hard.push({
      code: 'unknown_exit',
      severity: 'hard',
      message: `区域 ${route.region_id} 的候选路线引用不存在出口 ${route.exit_id}`,
      exit_id: route.exit_id,
    });
  } else {
    const status = input.exitStatus.get(exit.id) ?? exit.status;
    if (status === 'closed') {
      closedExitAttempt = true;
      hard.push({
        code: 'closed_exit_used',
        severity: 'hard',
        message: `区域 ${route.region_id} 的候选路线使用已关闭出口 ${exit.id}`,
        exit_id: exit.id,
      });
    } else if (status === 'unknown' || exit.capacity_per_min === null || exit.capacity_per_min <= 0) {
      unknownAttempt = true;
      hard.push({
        code: 'unknown_exit_used',
        severity: 'hard',
        message: `区域 ${route.region_id} 的候选路线使用未知/无容量出口 ${exit.id}`,
        exit_id: exit.id,
      });
    }
  }

  for (const regionId of route.path_regions) {
    const density = regionDensity(input.scenario, input.observed, regionId);
    if (density >= input.scenario.rhoJam * 1.5) {
      dangerous = true;
      hard.push({
        code: 'dangerous_destination_density',
        severity: 'hard',
        message: `区域 ${regionId} 的观测密度 ${density.toFixed(2)} 人/m² 过高，禁止发布进入路线`,
        region_id: regionId,
      });
      break;
    }
  }

  return { hard, closedCorridorAttempt, closedExitAttempt, unknownAttempt, dangerous };
}

function minimalPlan(scenario: SimScenario, observed: ObservedSnapshot): EvacuationPlan {
  return {
    plan_id: `V752-${scenario.scenario_id}-${observed.at_minute.toFixed(2)}`,
    created_at: new Date(0).toISOString(),
    scenario_version: `${scenario.scenario_id}-v752`,
    constraint_version: 1,
    observation_version: 1,
    horizon_minutes: Math.max(1, Math.round(scenario.duration_minutes)),
    status: 'partial',
    routes: [],
    unresolved: [],
    exit_totals: [],
    corridor_totals: [],
    demand_by_region: [],
    total_persons: 0,
    evacuated_persons: 0,
    unresolved_persons: 0,
    planner: { algorithm: 'v752-dynamic-safety-check', model: 'four-state priority', notes: [] },
  };
}

export function validateDynamicDecisions(input: DynamicSafetyInput): DynamicSafetyResult {
  const decisions = new Map<string, RegionDecision>();
  const hardViolations: SafetyViolation[] = [];
  const untrustedRegions: Array<{ regionId: string; reasons: string[] }> = [];
  let closedCorridorAttempts = 0;
  let closedExitAttempts = 0;
  let unknownCorridorAttempts = 0;
  let dangerousRouteAttempts = 0;

  for (const region of input.scenario.regions) {
    const observation = input.observed.regions.get(region.id);
    const route = input.routes.get(region.id) ?? null;
    const previous = input.previousValidatedRoutes.get(region.id) ?? null;
    const trusted = observationTrusted(observation);
    const reasons = trusted ? [] : trustedReasons(observation);
    if (!trusted && observation && (observation.count === null || observation.count > 0)) {
      untrustedRegions.push({ regionId: region.id, reasons });
    }

    if (!route) {
      if (previous) {
        const previousCheck = routeCheck(input, previous);
        if (previousCheck.hard.length === 0) {
          decisions.set(region.id, {
            region_id: region.id,
            route: previous,
            mode: 'degraded_continue',
            reasons: ['no_candidate_continue_last_validated_route', ...reasons],
          });
          continue;
        }
        decisions.set(region.id, {
          region_id: region.id,
          route: null,
          mode: 'no_route',
          reasons: ['no_candidate_previous_route_invalid', ...reasons],
        });
        continue;
      }
      decisions.set(region.id, {
        region_id: region.id,
        route: null,
        mode: 'no_route',
        reasons: ['no_route_available', ...reasons],
      });
      continue;
    }

    if (!trusted) {
      // Fail closed for this region: no new route based on untrusted data.
      if (previous) {
        const previousCheck = routeCheck(input, previous);
        if (previousCheck.hard.length === 0) {
          decisions.set(region.id, {
            region_id: region.id,
            route: previous,
            mode: 'degraded_continue',
            reasons: ['untrusted_observation_continue_last_validated_route', ...reasons],
          });
          continue;
        }
      }
      decisions.set(region.id, {
        region_id: region.id,
        route: null,
        mode: 'rejected',
        reasons: ['untrusted_observation_blocks_new_route', ...reasons],
      });
      continue;
    }

    const check = routeCheck(input, route);
    if (check.hard.length > 0) {
      hardViolations.push(...check.hard);
      if (check.closedCorridorAttempt) closedCorridorAttempts += 1;
      if (check.closedExitAttempt) closedExitAttempts += 1;
      if (check.unknownAttempt) unknownCorridorAttempts += 1;
      if (check.dangerous) dangerousRouteAttempts += 1;
      decisions.set(region.id, {
        region_id: region.id,
        route: null,
        mode: 'rejected',
        reasons: check.hard.map(item => item.code),
      });
      continue;
    }

    // A route must not pass through a region whose observation is untrusted:
    // downstream occupancy and gate availability would be unverified.
    const pathUntrusted = route.path_regions.find(regionId => !observationTrusted(input.observed.regions.get(regionId)));
    if (pathUntrusted) {
      decisions.set(region.id, {
        region_id: region.id,
        route: null,
        mode: 'rejected',
        reasons: [`path_through_untrusted_region_${pathUntrusted}`],
      });
      continue;
    }

    decisions.set(region.id, {
      region_id: region.id,
      route,
      mode: 'validated',
      reasons: ['topology_capacity_and_observation_checks_passed'],
    });
  }

  const validation: SafetyValidationResult = {
    valid: hardViolations.length === 0,
    checked_at: new Date(0).toISOString(),
    plan_id: `V752-${input.scenario.scenario_id}-${input.minute.toFixed(2)}`,
    violations: hardViolations,
    checks_run: [
      'version_match',
      'corridor_status',
      'corridor_capacity',
      'exit_status',
      'exit_capacity',
      'observation_trust',
      'dangerous_destination_density',
    ],
    versions: {
      scenario_version: `${input.scenario.scenario_id}-v752`,
      constraint_version: 1,
      observation_version: 1,
    },
  };

  const stateDecision = decideSafetyState({
    hasObservations: [...input.observed.regions.values()].some(item => item.count !== null),
    inferenceHealthy: true,
    untrustedRegions,
    activeIncidentIds: input.activeIncidentIds,
    plan: minimalPlan(input.scenario, input.observed),
    validation,
    planInvalidated: input.activeIncidentIds.length > 0,
    lastValidObservationAt: new Date(0).toISOString(),
  });

  // A global REJECT means no new route may be published.  Only a previously
  // validated route that is still physically valid may continue.
  if (stateDecision.state === 'REJECT') {
    for (const [regionId, decision] of decisions) {
      if (decision.mode !== 'validated') continue;
      const previous = input.previousValidatedRoutes.get(regionId);
      if (previous && routeCheck(input, previous).hard.length === 0) {
        decisions.set(regionId, {
          region_id: regionId,
          route: previous,
          mode: 'degraded_continue',
          reasons: ['global_reject_continue_last_validated_route'],
        });
      } else {
        decisions.set(regionId, {
          region_id: regionId,
          route: null,
          mode: 'rejected',
          reasons: ['global_reject_no_previous_validated_route'],
        });
      }
    }
  }

  return {
    state: {
      state: stateDecision.state as SafetyState,
      reasons: stateDecision.reasons.map(reason => reason.code),
      untrusted_regions: untrustedRegions.map(item => item.regionId),
      hard_violation_count: hardViolations.length,
    },
    decisions,
    closed_corridor_attempts: closedCorridorAttempts,
    closed_exit_attempts: closedExitAttempts,
    unknown_corridor_attempts: unknownCorridorAttempts,
    dangerous_route_attempts: dangerousRouteAttempts,
  };
}
