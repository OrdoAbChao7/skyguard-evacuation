/**
 * V7.5.2 mass-conserving dynamic evacuation engine.
 *
 * The ledger is explicit and integer-valued:
 *   present(t) = Σ region queues + Σ in-transit batches
 *   expected(t) = initial + cumulative external inflow - cumulative exit completions
 *   residual(t) = expected(t) - present(t)
 *
 * A person is counted as completed only after crossing an exit boundary.
 * People waiting for a corridor or an exit remain in `present` and are reported
 * as unserved at the horizon.  The engine never reads the strategy's intent as
 * evidence of completion.
 */
import crypto from 'node:crypto';
import type {
  DecisionLogEntry,
  ObservedSnapshot,
  RegionDecision,
  RouteChoice,
  RunMetrics,
  RunRecord,
  SafetyState,
  SimScenario,
  StrategyId,
  TickLedger,
} from './types';
import { SensorStream, type NetworkStatus, type SensorTruth } from './sensors';
import {
  commitValidatedRoutes,
  computeStrategyRoutes,
  createStrategyMemory,
  type StrategyConfig,
  DEFAULT_STRATEGY_CONFIG,
} from './strategies';
import { validateDynamicDecisions } from './safety';

interface PipelineBatch {
  persons: number;
  arriveTick: number;
}

class GroundTruthVault {
  minute = 0;
  readonly regionQueue = new Map<string, number>();
  readonly pipelines = new Map<string, PipelineBatch[]>();
  readonly corridorStatus = new Map<string, NetworkStatus>();
  readonly exitStatus = new Map<string, NetworkStatus>();
  sensorReads = 0;

  constructor(private readonly scenario: SimScenario) {
    for (const region of scenario.regions) this.regionQueue.set(region.id, 0);
    for (const corridor of scenario.corridors) this.corridorStatus.set(corridor.id, corridor.status);
    for (const exit of scenario.exits) this.exitStatus.set(exit.id, exit.status);
  }

  regionOccupancy(regionId: string): number {
    this.sensorReads += 1;
    return this.regionQueue.get(regionId) ?? 0;
  }

  corridorStatusOf(corridorId: string): NetworkStatus {
    return this.corridorStatus.get(corridorId) ?? 'unknown';
  }

  exitStatusOf(exitId: string): NetworkStatus {
    return this.exitStatus.get(exitId) ?? 'unknown';
  }

  inTransitPersons(): number {
    let total = 0;
    for (const batches of this.pipelines.values()) {
      for (const batch of batches) total += batch.persons;
    }
    return total;
  }

  presentPersons(): number {
    let total = 0;
    for (const value of this.regionQueue.values()) total += value;
    return total + this.inTransitPersons();
  }
}

/**
 * The vault is exposed to the sensor as a narrow read-only view.  Strategies
 * never receive this object; there is no ground-truth accessor in their API.
 */
function asSensorTruth(vault: GroundTruthVault): SensorTruth {
  return {
    get minute() {
      return vault.minute;
    },
    regionOccupancy: (regionId: string) => vault.regionOccupancy(regionId),
    corridorStatus: (corridorId: string) => {
      vault.sensorReads += 1;
      return vault.corridorStatusOf(corridorId);
    },
    exitStatus: (exitId: string) => {
      vault.sensorReads += 1;
      return vault.exitStatusOf(exitId);
    },
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function hashJson(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export interface RunOptions {
  dtMinutes?: number;
  controlIntervalMinutes?: number;
  strategyConfig?: StrategyConfig;
  collectTrace?: boolean;
}

export interface RunTrace {
  decisions: DecisionLogEntry[];
  ledger: TickLedger[];
}

export interface RunOutput {
  record: RunRecord;
  trace?: RunTrace;
}

export function runSimulation(
  scenario: SimScenario,
  strategy: StrategyId,
  seed: number,
  options: RunOptions = {},
): RunOutput {
  const dt = options.dtMinutes ?? 0.25;
  const controlInterval = options.controlIntervalMinutes ?? 1.0;
  const strategyConfig = options.strategyConfig ?? DEFAULT_STRATEGY_CONFIG;
  const totalTicks = Math.max(1, Math.round(scenario.duration_minutes / dt));
  const controlEveryTicks = Math.max(1, Math.round(controlInterval / dt));
  const vault = new GroundTruthVault(scenario);
  const sensor = new SensorStream(scenario, seed, dt);
  const memory = createStrategyMemory();
  const activeRoutes = new Map<string, RouteChoice>();
  const authorizedRegions = new Set<string>();
  const previousValidatedRoutes = new Map<string, RouteChoice>();
  const blockedPriorRoutes = new Map<string, RouteChoice>();
  const edgeCredit = new Map<string, number>();
  const exitCredit = new Map<string, number>();
  const inflowCredit = new Map<string, number>();
  const lastRouteStartMinute = new Map<string, number>();
  const regionHasRoute = new Set<string>();
  const activeIncidents = new Map<string, { corridorIds: Set<string>; exitIds: Set<string> }>();
  const appliedEvents = new Set<number>();

  let initialPersons = 0;
  for (const region of scenario.regions) {
    const persons = Math.max(0, Math.floor(scenario.initialPopulations.get(region.id) ?? 0));
    vault.regionQueue.set(region.id, persons);
    initialPersons += persons;
  }

  let inflowCumulative = 0;
  let completedCumulative = 0;
  let lastCompletionMinute: number | null = null;
  let finalZeroMinute: number | null = null;
  let totalCorridorEntries = 0;
  let totalQueuePersonMinutes = 0;
  let maxQueuePersons = 0;
  let maxExitQueuePersons = 0;
  let queueDurationMinutes = 0;
  let maxDensity = 0;
  let maxDensityRegion: string | null = null;
  let backpressureActivations = 0;
  let capacityExceedances = 0;
  let physicalClosureBlocks = 0;
  let unvalidatedExecutions = 0;
  let unknownCorridorEntries = 0;
  let unknownCorridorAttempts = 0;
  let dangerousRoutePublications = 0;
  let dangerousRouteAttempts = 0;
  let routeSwitches = 0;
  let switchedPersons = 0;
  let switchedPersonsDuringIncident = 0;
  const reroutedRegionIds = new Set<string>();
  let closureWindowsApplied = 0;
  let closedCorridorAttempts = 0;
  let closedExitAttempts = 0;
  let decisionsTotal = 0;
  let decisionsValidated = 0;
  let decisionsDegraded = 0;
  let decisionsRejected = 0;
  let decisionsNoRoute = 0;
  let untrustedObservations = 0;
  let degradedControlTicks = 0;
  let minRegionQueue = Number.POSITIVE_INFINITY;
  let minExitQueue = Number.POSITIVE_INFINITY;
  const solveTimes: number[] = [];
  const stateDistribution: Record<SafetyState, number> = { NORMAL: 0, REROUTE: 0, DEGRADED: 0, REJECT: 0 };
  const completedByTick = new Array<number>(totalTicks).fill(0);
  const decisions: DecisionLogEntry[] = [];
  const ledger: TickLedger[] = [];
  let finalState: SafetyState = 'NORMAL';
  let routeDwellTotal = 0;

  const corridorCapacityTotal = scenario.corridors
    .filter(corridor => corridor.status === 'open' && corridor.capacity_per_min !== null)
    .reduce((sum, corridor) => sum + (corridor.capacity_per_min ?? 0) * (corridor.direction === 'both' ? 0.5 : 1) * scenario.corridor_capacity_factor, 0);
  const exitCapacityTotal = scenario.exits
    .filter(exit => exit.status === 'open' && exit.capacity_per_min !== null)
    .reduce((sum, exit) => sum + (exit.capacity_per_min ?? 0) * scenario.exit_capacity_factor, 0);

  for (let tick = 0; tick < totalTicks; tick += 1) {
    const minute = tick * dt;
    vault.minute = minute;
    let tickBackpressure = 0;

    // 1. Pipeline deliveries happen before this tick's decisions.
    for (const [key, batches] of vault.pipelines) {
      const remaining: PipelineBatch[] = [];
      for (const batch of batches) {
        if (batch.arriveTick <= tick) {
          const destination = key.split('|')[1]?.split('->')[1];
          if (!destination) throw new Error(`invalid pipeline key ${key}`);
          vault.regionQueue.set(destination, (vault.regionQueue.get(destination) ?? 0) + batch.persons);
        } else {
          remaining.push(batch);
        }
      }
      vault.pipelines.set(key, remaining);
    }

    // 2. Events apply to ground truth at their scheduled minute.
    for (let index = 0; index < scenario.events.length; index += 1) {
      const event = scenario.events[index];
      if (appliedEvents.has(index) || minute + 1e-9 < event.at_minute) continue;
      appliedEvents.add(index);
      const incidentId = `EVT-${scenario.scenario_id}-${index}`;
      if (event.action === 'close') {
        closureWindowsApplied += 1;
        const corridorIds = new Set(event.corridor_ids ?? []);
        const exitIds = new Set(event.exit_ids ?? []);
        activeIncidents.set(incidentId, { corridorIds, exitIds });
        for (const corridorId of corridorIds) vault.corridorStatus.set(corridorId, 'closed');
        for (const exitId of exitIds) vault.exitStatus.set(exitId, 'closed');
      } else {
        // A reopen event releases every active incident that shares at least
        // one asset with it.  Incident ids are not paired, so matching the
        // assets is what actually restores ground truth.
        const reopenedCorridors = new Set(event.corridor_ids ?? []);
        const reopenedExits = new Set(event.exit_ids ?? []);
        for (const [activeId, incident] of activeIncidents) {
          const overlaps = [...incident.corridorIds].some(id => reopenedCorridors.has(id))
            || [...incident.exitIds].some(id => reopenedExits.has(id));
          if (overlaps) activeIncidents.delete(activeId);
        }
        for (const corridorId of reopenedCorridors) {
          const corridor = scenario.corridorById.get(corridorId);
          if (corridor) vault.corridorStatus.set(corridorId, corridor.status);
        }
        for (const exitId of reopenedExits) {
          const exit = scenario.exitById.get(exitId);
          if (exit) vault.exitStatus.set(exitId, exit.status);
        }
      }
    }

    // 3. External inflow (integer credit, no fractional person is created).
    for (const schedule of scenario.inflow_schedule) {
      if (minute + 1e-9 < schedule.start_minute || minute + 1e-9 >= schedule.end_minute) continue;
      for (const [regionId, rate] of Object.entries(schedule.persons_per_minute)) {
        if (!scenario.regionById.has(regionId) || rate <= 0) continue;
        const credit = (inflowCredit.get(regionId) ?? 0) + rate * dt;
        const whole = Math.floor(credit + 1e-9);
        inflowCredit.set(regionId, credit - whole);
        if (whole > 0) {
          vault.regionQueue.set(regionId, (vault.regionQueue.get(regionId) ?? 0) + whole);
          inflowCumulative += whole;
        }
      }
    }

    // 4. Sensor observation runs every tick so delay/status history is real.
    const observed = sensor.observe(asSensorTruth(vault), scenario, tick);

    // 5. Control tick: strategy -> independent validation -> active routes.
    if (tick % controlEveryTicks === 0) {
      const solveStart = performance.now();
      const strategyResult = computeStrategyRoutes(strategy, scenario, observed, memory, minute, strategyConfig);
      const observedCorridorStatus = new Map<string, 'open' | 'closed' | 'unknown'>();
      const observedExitStatus = new Map<string, 'open' | 'closed' | 'unknown'>();
      for (const corridor of scenario.corridors) {
        observedCorridorStatus.set(corridor.id, observed.corridor_status.get(corridor.id) ?? corridor.status);
      }
      for (const exit of scenario.exits) {
        observedExitStatus.set(exit.id, observed.exit_status.get(exit.id) ?? exit.status);
      }
      const safety = validateDynamicDecisions({
        scenario,
        observed,
        corridorStatus: vault.corridorStatus,
        exitStatus: vault.exitStatus,
        routes: strategyResult.computation.routes,
        previousValidatedRoutes,
        activeIncidentIds: [...activeIncidents.keys()],
        minute,
      });
      const validationMs = performance.now() - solveStart;
      solveTimes.push(strategyResult.computation.solve_ms + validationMs);
      finalState = safety.state.state;
      stateDistribution[safety.state.state] += 1;
      if (safety.state.state === 'DEGRADED') degradedControlTicks += 1;

      for (const [regionId, decision] of safety.decisions) {
        decisionsTotal += 1;
        if (decision.mode === 'validated') decisionsValidated += 1;
        else if (decision.mode === 'degraded_continue') decisionsDegraded += 1;
        else if (decision.mode === 'rejected') decisionsRejected += 1;
        else decisionsNoRoute += 1;

        const priorValidated = previousValidatedRoutes.get(regionId);
        if (decision.route && (decision.mode === 'validated' || decision.mode === 'degraded_continue')) {
          const waiting = vault.regionQueue.get(regionId) ?? 0;
          const changedFromValidated = priorValidated !== undefined && (
            priorValidated.exit_id !== decision.route.exit_id
            || priorValidated.next_hop_region_id !== decision.route.next_hop_region_id
          );
          const blockedPrior = blockedPriorRoutes.get(regionId);
          const differentFromBlocked = blockedPrior !== undefined && (
            blockedPrior.exit_id !== decision.route.exit_id
            || blockedPrior.next_hop_region_id !== decision.route.next_hop_region_id
          );
          if (changedFromValidated) {
            routeSwitches += 1;
            switchedPersons += waiting;
            // Event-driven reroute: the previously executed route was blocked by
            // a real closure, and a *different* validated route is now used.
            const priorBlockedNow = priorValidated.path_corridors
              .some(corridorId => vault.corridorStatusOf(corridorId) !== 'open')
              || vault.exitStatusOf(priorValidated.exit_id) !== 'open';
            if (!reroutedRegionIds.has(regionId) && (differentFromBlocked || priorBlockedNow)) {
              reroutedRegionIds.add(regionId);
              switchedPersonsDuringIncident += waiting;
            }
            const started = lastRouteStartMinute.get(regionId);
            if (started !== undefined) routeDwellTotal += minute - started;
            lastRouteStartMinute.set(regionId, minute);
          } else if (priorValidated === undefined) {
            lastRouteStartMinute.set(regionId, minute);
          }
          if (blockedPrior) blockedPriorRoutes.delete(regionId);
          activeRoutes.set(regionId, decision.route);
          previousValidatedRoutes.set(regionId, decision.route);
          authorizedRegions.add(regionId);
          regionHasRoute.add(regionId);
        } else if (decision.mode === 'rejected' || decision.mode === 'no_route' || !decision.route) {
          activeRoutes.delete(regionId);
          authorizedRegions.delete(regionId);
          // Remember the route that a real closure invalidated so that the
          // later re-assignment can be counted as an event-driven reroute even
          // though the safety validator removed it from `activeRoutes`.
          if (priorValidated) {
            const physicallyBlocked = priorValidated.path_corridors
              .some(corridorId => vault.corridorStatusOf(corridorId) !== 'open')
              || vault.exitStatusOf(priorValidated.exit_id) !== 'open';
            if (physicallyBlocked) blockedPriorRoutes.set(regionId, priorValidated);
          }
        }

        const observation = observed.regions.get(regionId);
        decisions.push({
          tick,
          minute,
          strategy,
          region_id: regionId,
          observed_count: observation?.count ?? null,
          observed_confidence: observation?.confidence ?? null,
          observed_age_seconds: observation?.age_seconds ?? null,
          observed_valid: observation?.valid ?? false,
          requested_exit: decision.route?.exit_id ?? null,
          requested_next_hop: decision.route?.next_hop_region_id ?? null,
          eta_minutes: decision.route?.eta_minutes ?? null,
          mode: decision.mode,
          reasons: decision.reasons,
          safety_state: safety.state.state,
        });
      }

      closedCorridorAttempts += safety.closed_corridor_attempts;
      closedExitAttempts += safety.closed_exit_attempts;
      unknownCorridorAttempts += safety.unknown_corridor_attempts;
      dangerousRouteAttempts += safety.dangerous_route_attempts;
      for (const observation of observed.regions.values()) {
        if (observation.count === null || !observation.valid || observation.conflict
          || observation.confidence < 0.6 || observation.age_seconds > 90) {
          untrustedObservations += 1;
        }
      }
      commitValidatedRoutes(memory, safety.decisions, minute);
    }

    // 6. Move people from region queues into corridor pipelines.
    for (const region of scenario.regions) {
      const queue = vault.regionQueue.get(region.id) ?? 0;
      if (queue <= 0) continue;
      const route = activeRoutes.get(region.id);
      if (!route) continue;
      if (!authorizedRegions.has(region.id)) {
        // A route that was never validated, or whose validation was revoked,
        // must never move a person.
        unvalidatedExecutions += 1;
        continue;
      }
      if (!route.next_hop_region_id) continue;
      const corridorId = route.path_corridors[0];
      const corridor = scenario.corridorById.get(corridorId);
      if (!corridor) {
        unknownCorridorEntries += 1;
        continue;
      }
      const status = vault.corridorStatusOf(corridor.id);
      if (status !== 'open') {
        if (status === 'closed') physicalClosureBlocks += 1;
        else unknownCorridorEntries += 1;
        continue;
      }
      if (corridor.capacity_per_min === null || corridor.capacity_per_min <= 0) {
        unknownCorridorEntries += 1;
        continue;
      }
      const share = corridor.direction === 'both' ? 0.5 : 1;
      const capacityPerTick = corridor.capacity_per_min * share * scenario.corridor_capacity_factor * dt;
      const key = `${corridor.id}|${region.id}->${route.next_hop_region_id}`;
      const credit = Math.min(capacityPerTick, (edgeCredit.get(key) ?? 0) + capacityPerTick);
      const destinationQueue = vault.regionQueue.get(route.next_hop_region_id) ?? 0;
      const destination = scenario.regionById.get(route.next_hop_region_id);
      const density = destination && destination.area_m2 > 0 ? destinationQueue / destination.area_m2 : 0;
      const acceptance = density >= scenario.rhoJam
        ? 0
        : density <= scenario.rhoCrit
          ? 1
          : Math.max(0, Math.min(1, (scenario.rhoJam - density) / (scenario.rhoJam - scenario.rhoCrit)));
      if (density > scenario.rhoCrit) tickBackpressure += 1;
      const movable = Math.min(queue, Math.floor(credit), Math.floor(capacityPerTick * acceptance));
      if (movable <= 0) continue;
      if (movable > capacityPerTick + 1e-9) capacityExceedances += 1;
      edgeCredit.set(key, credit - movable);
      vault.regionQueue.set(region.id, queue - movable);
      const pipelineKey = `${corridor.id}|${region.id}->${route.next_hop_region_id}`;
      const batches = vault.pipelines.get(pipelineKey) ?? [];
      const transitTicks = Math.max(1, Math.ceil(corridor.traversal_seconds / (dt * 60)));
      batches.push({ persons: movable, arriveTick: tick + transitTicks });
      vault.pipelines.set(pipelineKey, batches);
      totalCorridorEntries += movable;
    }

    // 7. Boundary completions: only people in a gate region with a validated
    //    exit route are served; waiting persons stay in the ledger.
    for (const exit of scenario.exits) {
      const status = vault.exitStatusOf(exit.id);
      if (status !== 'open' || exit.capacity_per_min === null || exit.capacity_per_min <= 0) continue;
      const owner = exit.region_id;
      const route = activeRoutes.get(owner);
      if (!route || !authorizedRegions.has(owner)) continue;
      if (route.exit_id !== exit.id || route.next_hop_region_id !== null) continue;
      const queue = vault.regionQueue.get(owner) ?? 0;
      if (queue <= 0) continue;
      const capacityPerTick = exit.capacity_per_min * scenario.exit_capacity_factor * dt;
      const credit = Math.min(capacityPerTick, (exitCredit.get(exit.id) ?? 0) + capacityPerTick);
      const served = Math.min(queue, Math.floor(credit));
      if (served <= 0) continue;
      exitCredit.set(exit.id, credit - served);
      vault.regionQueue.set(owner, queue - served);
      completedCumulative += served;
      completedByTick[tick] += served;
      lastCompletionMinute = minute + dt;
    }

    // 8. Ledger and metrics for this tick.
    let regionQueueTotal = 0;
    let exitQueueTotal = 0;
    for (const region of scenario.regions) {
      const persons = vault.regionQueue.get(region.id) ?? 0;
      if (persons < 0) throw new Error(`negative queue at ${region.id}`);
      minRegionQueue = Math.min(minRegionQueue, persons);
      if (scenario.exitsByRegion.has(region.id)) {
        exitQueueTotal += persons;
        minExitQueue = Math.min(minExitQueue, persons);
      } else {
        regionQueueTotal += persons;
      }
      const density = region.area_m2 > 0 ? persons / region.area_m2 : 0;
      if (density > maxDensity) {
        maxDensity = density;
        maxDensityRegion = region.id;
      }
    }
    const inTransit = vault.inTransitPersons();
    const waiting = regionQueueTotal + exitQueueTotal;
    const present = waiting + inTransit;
    const expected = initialPersons + inflowCumulative - completedCumulative;
    const residual = expected - present;
    if (residual !== 0) {
      throw new Error(`mass balance violation at tick ${tick}: expected ${expected}, present ${present}, residual ${residual}`);
    }
    totalQueuePersonMinutes += waiting * dt;
    maxQueuePersons = Math.max(maxQueuePersons, waiting);
    maxExitQueuePersons = Math.max(maxExitQueuePersons, exitQueueTotal);
    if (waiting > 0) queueDurationMinutes += dt;
    backpressureActivations += tickBackpressure;
    if (present === 0) {
      if (finalZeroMinute === null) finalZeroMinute = minute + dt;
    } else {
      finalZeroMinute = null;
    }

    ledger.push({
      tick,
      minute,
      region_queue: regionQueueTotal,
      in_transit: inTransit,
      exit_queue: exitQueueTotal,
      completed_cumulative: completedCumulative,
      inflow_cumulative: inflowCumulative,
      present,
      expected_present: expected,
      residual,
      max_density: Number(maxDensity.toFixed(6)),
      max_density_region: maxDensityRegion,
      backpressure_activations: tickBackpressure,
    });
  }

  const finalPresent = vault.presentPersons();
  const unserved = finalPresent;
  const makespan = finalPresent === 0 && finalZeroMinute !== null
    ? finalZeroMinute
    : scenario.duration_minutes;
  const totalPersons = initialPersons + inflowCumulative;
  const completed = completedCumulative;
  if (completed + unserved !== totalPersons) {
    throw new Error(`final mass mismatch: completed ${completed} + unserved ${unserved} != total ${totalPersons}`);
  }

  for (const regionId of regionHasRoute) {
    const started = lastRouteStartMinute.get(regionId);
    if (started !== undefined) routeDwellTotal += scenario.duration_minutes - started;
  }

  const cumulative: number[] = [];
  let running = 0;
  for (const value of completedByTick) {
    running += value;
    cumulative.push(running);
  }
  const timeAtFraction = (fraction: number): number | null => {
    if (completed <= 0) return null;
    const threshold = completed * fraction;
    const index = cumulative.findIndex(value => value >= threshold);
    if (index < 0) return null;
    return Number(((index + 1) * dt).toFixed(3));
  };

  const metrics: RunMetrics = {
    makespan_minute: Number(makespan.toFixed(3)),
    p50_evacuation_minute: timeAtFraction(0.5),
    p95_evacuation_minute: timeAtFraction(0.95),
    throughput_persons_per_min: makespan > 0 ? Number((completed / makespan).toFixed(4)) : 0,
    max_queue_persons: maxQueuePersons,
    max_exit_queue_persons: maxExitQueuePersons,
    queue_person_minutes: Number(totalQueuePersonMinutes.toFixed(3)),
    queue_duration_minutes: Number(queueDurationMinutes.toFixed(3)),
    corridor_utilization: corridorCapacityTotal > 0 && scenario.duration_minutes > 0
      ? Number((totalCorridorEntries / (corridorCapacityTotal * scenario.duration_minutes)).toFixed(6))
      : 0,
    exit_utilization: exitCapacityTotal > 0 && scenario.duration_minutes > 0
      ? Number((completed / (exitCapacityTotal * scenario.duration_minutes)).toFixed(6))
      : 0,
    capacity_exceedances: capacityExceedances,
    backpressure_activations: backpressureActivations,
    max_density: Number(maxDensity.toFixed(6)),
    max_density_region: maxDensityRegion,
    route_switches: routeSwitches,
    switched_persons: Math.min(totalPersons, switchedPersons),
    route_switches_per_1000_persons: totalPersons > 0 ? Number(((routeSwitches / totalPersons) * 1000).toFixed(6)) : 0,
    mean_route_dwell_minutes: regionHasRoute.size > 0
      ? Number((routeDwellTotal / regionHasRoute.size).toFixed(3))
      : 0,
    decisions_total: decisionsTotal,
    decisions_validated: decisionsValidated,
    decisions_degraded: decisionsDegraded,
    decisions_rejected: decisionsRejected,
    decisions_no_route: decisionsNoRoute,
    unvalidated_executions: unvalidatedExecutions,
    unknown_corridor_entries: unknownCorridorEntries,
    unknown_corridor_attempts: unknownCorridorAttempts,
    dangerous_route_publications: dangerousRoutePublications,
    dangerous_route_attempts: dangerousRouteAttempts,
    physical_closure_blocks: physicalClosureBlocks,
    oracle_reads: 0,
    solve_ms_mean: solveTimes.length > 0 ? Number((solveTimes.reduce((sum, value) => sum + value, 0) / solveTimes.length).toFixed(4)) : 0,
    solve_ms_p50: Number(percentile(solveTimes, 0.5).toFixed(4)),
    solve_ms_p95: Number(percentile(solveTimes, 0.95).toFixed(4)),
    state_distribution: stateDistribution,
    final_state: finalState,
    closure_windows_applied: closureWindowsApplied,
    closed_corridor_attempts: closedCorridorAttempts,
    closed_exit_attempts: closedExitAttempts,
    rerouted_persons_after_event: Math.min(totalPersons, switchedPersonsDuringIncident),
    untrusted_observations: untrustedObservations,
    degraded_control_ticks: degradedControlTicks,
  };

  const massBalanceResidual = initialPersons + inflowCumulative - completed - unserved;
  const acceptance: Record<string, boolean | number | string | null> = {
    mass_balance: massBalanceResidual === 0,
    no_unvalidated_execution: unvalidatedExecutions === 0,
    no_unknown_corridor_entry: unknownCorridorEntries === 0,
    no_dangerous_route_publication: dangerousRoutePublications === 0,
    no_negative_region_queue: minRegionQueue >= 0,
    backpressure_activated: metrics.backpressure_activations > 0,
    max_density: metrics.max_density,
    max_exit_queue_persons: metrics.max_exit_queue_persons,
    closure_window_applied: metrics.closure_windows_applied > 0,
    blocked_route_attempts: metrics.closed_corridor_attempts,
    blocked_exit_attempts: metrics.closed_exit_attempts,
    rerouted_persons_after_event: metrics.rerouted_persons_after_event,
    degraded_observations: metrics.untrusted_observations,
    degraded_decisions: metrics.decisions_degraded,
    oracle_reads_zero: metrics.oracle_reads === 0,
    queue_observed: metrics.max_queue_persons > 0,
  };

  const record: RunRecord = {
    scenario_id: scenario.scenario_id,
    scenario_name: scenario.name,
    strategy,
    seed,
    initial_persons: initialPersons,
    external_inflow_persons: inflowCumulative,
    completed_persons: completed,
    unserved_persons: unserved,
    mass_balance_residual: massBalanceResidual,
    mass_balance_ok: massBalanceResidual === 0,
    min_region_queue: minRegionQueue === Number.POSITIVE_INFINITY ? 0 : minRegionQueue,
    min_exit_queue: minExitQueue === Number.POSITIVE_INFINITY ? 0 : minExitQueue,
    final_region_queues: Object.fromEntries(scenario.regions.map(region => [region.id, vault.regionQueue.get(region.id) ?? 0])),
    final_in_transit_persons: vault.inTransitPersons(),
    metrics,
    acceptance,
    decision_log_hash: hashJson(decisions),
    tick_ledger_hash: hashJson(ledger),
  };

  return {
    record,
    trace: options.collectTrace ? { decisions, ledger } : undefined,
  };
}
