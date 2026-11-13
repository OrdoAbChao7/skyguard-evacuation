/**
 * V7.5.2 simulation-integrity regression tests.
 *
 * These tests exercise the properties the audit depends on:
 *  - integer mass conservation, including inflow and capacity limits;
 *  - queues are never counted as completions;
 *  - a real closure invalidates routes and is visible in the ledger;
 *  - all four strategy code paths are distinct;
 *  - degraded observations fail closed and never reach ground truth;
 *  - deterministic runs under common random numbers.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSimulation } from '../../../scripts/simulation/v752/engine';
import { loadScenarioSet } from '../../../scripts/simulation/v752/scenario';
import { computeStrategyRoutes, createStrategyMemory } from '../../../scripts/simulation/v752/strategies';
import { validateDynamicDecisions } from '../../../scripts/simulation/v752/safety';
import type {
  CorridorDef,
  ExitDef,
  ObservedRegionState,
  ObservedSnapshot,
  RegionDef,
  SensorProfile,
  SimScenario,
} from '../../../scripts/simulation/v752/types';

const SENSOR: SensorProfile = {
  mode: 'nominal',
  noise_relative_std: 0,
  bias_relative: 0,
  delay_minutes: 0,
  dropout_rate: 0,
  conflict_rate: 0,
  base_confidence: 0.95,
  degraded_region_prefixes: [],
  degradation_start_minute: 0,
  degraded_confidence: 0.4,
  degraded_noise_relative_std: 0.1,
  degraded_dropout_rate: 0.3,
  degraded_conflict_rate: 0.2,
  degraded_bias_relative: 0.15,
  degraded_delay_minutes: 2,
  recovery_minute: null,
};

interface ScenarioOptions {
  duration?: number;
  regions: RegionDef[];
  corridors?: CorridorDef[];
  exits: ExitDef[];
  initial: Record<string, number>;
  events?: SimScenario['events'];
  inflow?: SimScenario['inflow_schedule'];
  exitCapacityFactor?: number;
  corridorCapacityFactor?: number;
}

function makeScenario(options: ScenarioOptions): SimScenario {
  const corridors = options.corridors ?? [];
  const regions = options.regions;
  const exits = options.exits;
  const regionById = new Map(regions.map(region => [region.id, region]));
  const corridorById = new Map(corridors.map(corridor => [corridor.id, corridor]));
  const exitById = new Map(exits.map(exit => [exit.id, exit]));
  const exitsByRegion = new Map<string, ExitDef[]>();
  for (const exit of exits) {
    const list = exitsByRegion.get(exit.region_id) ?? [];
    list.push(exit);
    exitsByRegion.set(exit.region_id, list);
  }
  return {
    scenario_id: 'TEST',
    name: 'synthetic test scenario',
    description: 'unit-test geometry',
    expected_state: 'NORMAL',
    duration_minutes: options.duration ?? 30,
    regions,
    corridors,
    exits,
    regionById,
    corridorById,
    exitById,
    exitsByRegion,
    initialPopulations: new Map(Object.entries(options.initial)),
    inflow_schedule: options.inflow ?? [],
    events: options.events ?? [],
    corridor_capacity_factor: options.corridorCapacityFactor ?? 1,
    exit_capacity_factor: options.exitCapacityFactor ?? 1,
    sensorProfile: SENSOR,
    acceptance: {},
    rhoCrit: 2,
    rhoJam: 4.5,
  };
}

function region(id: string, area = 1000): RegionDef {
  return { id, name: id, area_m2: area, holding_capacity_persons: area * 4 };
}

function corridor(
  id: string,
  from: string,
  to: string,
  capacity = 600,
  traversalSeconds = 30,
  direction: CorridorDef['direction'] = 'forward',
): CorridorDef {
  return {
    id,
    name: id,
    from_region_id: from,
    to_region_id: to,
    status: 'open',
    capacity_per_min: capacity,
    traversal_seconds: traversalSeconds,
    direction,
  };
}

function exit(id: string, regionId: string, capacity = 600): ExitDef {
  return { id, name: id, region_id: regionId, status: 'open', capacity_per_min: capacity };
}

function observation(regionId: string, count: number | null, overrides: Partial<ObservedRegionState> = {}): ObservedRegionState {
  return {
    region_id: regionId,
    count,
    confidence: 0.95,
    age_seconds: 15,
    valid: true,
    source: 'simulation',
    provider: 'test',
    conflict: false,
    untrusted_reasons: [],
    ...overrides,
  };
}

function snapshot(
  scenario: SimScenario,
  counts: Record<string, number>,
  statuses?: { corridor?: Record<string, 'open' | 'closed' | 'unknown'>; exit?: Record<string, 'open' | 'closed' | 'unknown'> },
): ObservedSnapshot {
  return {
    at_minute: 0,
    regions: new Map(scenario.regions.map(item => [item.id, observation(item.id, counts[item.id] ?? 0)])),
    corridor_status: new Map(scenario.corridors.map(item => [item.id, statuses?.corridor?.[item.id] ?? item.status])),
    exit_status: new Map(scenario.exits.map(item => [item.id, statuses?.exit?.[item.id] ?? item.status])),
  };
}

test('mass conservation holds with external inflow and integer persons', () => {
  const scenario = makeScenario({
    duration: 40,
    regions: [region('A'), region('G')],
    corridors: [corridor('AG', 'A', 'G', 1200)],
    exits: [exit('E1', 'G', 600)],
    initial: { A: 500, G: 0 },
    inflow: [{ start_minute: 0, end_minute: 10, persons_per_minute: { A: 60 } }],
  });
  const { record, trace } = runSimulation(scenario, 'GREEDY_DYNAMIC', 1, { collectTrace: true });
  assert.equal(record.initial_persons, 500);
  assert.equal(record.external_inflow_persons, 600);
  assert.equal(record.completed_persons + record.unserved_persons, 1100);
  assert.equal(record.mass_balance_residual, 0);
  assert.equal(record.mass_balance_ok, true);
  for (const tick of trace?.ledger ?? []) {
    assert.equal(tick.residual, 0, `tick ${tick.tick} residual`);
    assert.ok(tick.present >= 0);
    assert.ok(tick.region_queue >= 0);
    assert.ok(tick.in_transit >= 0);
  }
});

test('an insufficient exit leaves people in the ledger instead of inventing completions', () => {
  const scenario = makeScenario({
    duration: 5,
    regions: [region('A')],
    exits: [exit('E1', 'A', 60)],
    initial: { A: 1000 },
  });
  const { record } = runSimulation(scenario, 'STATIC_SHORTEST_PATH', 1);
  assert.equal(record.completed_persons, 300);
  assert.equal(record.unserved_persons, 700);
  assert.equal(record.mass_balance_residual, 0);
  // The peak is sampled after that tick's exit service, so it is 985 rather
  // than the initial 1000; the point is that the queue is real and large.
  assert.ok(record.metrics.max_queue_persons >= 900);
  assert.ok(record.metrics.queue_person_minutes > 0);
  assert.ok(record.metrics.max_exit_queue_persons >= 900);
});

test('a real corridor closure invalidates the frozen route and recovery resumes flow', () => {
  const scenario = makeScenario({
    duration: 40,
    regions: [region('A'), region('G')],
    corridors: [corridor('AG', 'A', 'G', 600)],
    exits: [exit('E1', 'G', 600)],
    initial: { A: 600, G: 0 },
    events: [
      { at_minute: 2, action: 'close', corridor_ids: ['AG'], reason: 'test closure' },
      { at_minute: 5, action: 'reopen', corridor_ids: ['AG'], reason: 'test reopen' },
    ],
  });
  const { record, trace } = runSimulation(scenario, 'STATIC_SHORTEST_PATH', 1, { collectTrace: true });
  assert.equal(record.metrics.closure_windows_applied, 1);
  assert.ok(record.metrics.closed_corridor_attempts > 0);
  assert.equal(record.mass_balance_residual, 0);
  assert.equal(record.completed_persons, 600);
  assert.equal(record.metrics.final_state, 'NORMAL');
  assert.ok(trace);
});

test('multiple exits are actually used by the router', () => {
  const scenario = makeScenario({
    duration: 30,
    regions: [region('A'), region('B'), region('C'), region('G1'), region('G2')],
    corridors: [
      corridor('AB', 'A', 'B', 600),
      corridor('AC', 'A', 'C', 600),
      corridor('BG1', 'B', 'G1', 600),
      corridor('CG2', 'C', 'G2', 600),
    ],
    exits: [exit('E1', 'G1', 600), exit('E2', 'G2', 600)],
    initial: { A: 0, B: 300, C: 300, G1: 0, G2: 0 },
  });
  const { record, trace } = runSimulation(scenario, 'GREEDY_DYNAMIC', 1, { collectTrace: true });
  assert.equal(record.completed_persons, 600);
  const exitsUsed = new Set((trace?.decisions ?? []).map(item => item.requested_exit).filter(Boolean));
  assert.ok(exitsUsed.has('E1'));
  assert.ok(exitsUsed.has('E2'));
});

test('runs are deterministic for the same strategy and seed', () => {
  const set = loadScenarioSet();
  const scenario = set.scenarios.find(item => item.scenario_id === 'ST-02');
  assert.ok(scenario);
  const first = runSimulation(scenario, 'GREEDY_DYNAMIC', 7);
  const second = runSimulation(scenario, 'GREEDY_DYNAMIC', 7);
  assert.equal(first.record.decision_log_hash, second.record.decision_log_hash);
  assert.equal(first.record.tick_ledger_hash, second.record.tick_ledger_hash);
  assert.equal(first.record.completed_persons, second.record.completed_persons);
});

test('ST-02 triggers real backpressure and event-driven rerouting', () => {
  const set = loadScenarioSet();
  const scenario = set.scenarios.find(item => item.scenario_id === 'ST-02');
  assert.ok(scenario);
  const { record } = runSimulation(scenario, 'GREEDY_DYNAMIC', 1);
  assert.equal(record.mass_balance_ok, true);
  assert.ok(record.metrics.backpressure_activations > 0);
  assert.ok(record.metrics.max_density >= 2.0);
  assert.ok(record.metrics.rerouted_persons_after_event > 0);
  assert.equal(record.metrics.unvalidated_executions, 0);
  assert.equal(record.metrics.dangerous_route_publications, 0);
  assert.equal(record.metrics.oracle_reads, 0);
});

test('ST-04 static keeps a blocked route while greedy reroutes', () => {
  const set = loadScenarioSet();
  const scenario = set.scenarios.find(item => item.scenario_id === 'ST-04');
  assert.ok(scenario);
  const staticRun = runSimulation(scenario, 'STATIC_SHORTEST_PATH', 1).record;
  const greedyRun = runSimulation(scenario, 'GREEDY_DYNAMIC', 1).record;
  assert.equal(staticRun.metrics.closure_windows_applied, 1);
  assert.ok(staticRun.metrics.closed_corridor_attempts > 0);
  assert.equal(staticRun.metrics.rerouted_persons_after_event, 0);
  assert.ok(greedyRun.metrics.rerouted_persons_after_event > 0);
  assert.equal(staticRun.mass_balance_residual, 0);
  assert.equal(greedyRun.mass_balance_residual, 0);
  assert.equal(staticRun.metrics.final_state, 'NORMAL');
});

test('ST-05 fails closed under degraded observations without oracle access', () => {
  const set = loadScenarioSet();
  const scenario = set.scenarios.find(item => item.scenario_id === 'ST-05');
  assert.ok(scenario);
  const { record, trace } = runSimulation(scenario, 'GREEDY_DYNAMIC', 1, { collectTrace: true });
  assert.ok(record.metrics.untrusted_observations > 0);
  assert.ok(record.metrics.decisions_degraded > 0);
  assert.ok(record.metrics.state_distribution.DEGRADED > 0);
  assert.equal(record.metrics.oracle_reads, 0);
  assert.equal(record.metrics.unvalidated_executions, 0);
  assert.equal(record.mass_balance_ok, true);
  const degradedDecision = (trace?.decisions ?? []).find(item =>
    item.minute === 10
    && item.region_id.startsWith('R_S01_')
    && item.mode === 'degraded_continue'
    && item.reasons.some(reason => reason.includes('untrusted_observation')));
  assert.ok(degradedDecision);
});

test('strategy code paths differ: static freezes, greedy reacts, V73/V74 keep a committed route', () => {
  const scenario = makeScenario({
    duration: 30,
    regions: [region('A'), region('B'), region('C'), region('G1'), region('G2')],
    corridors: [
      corridor('AB', 'A', 'B', 600, 10),
      corridor('AC', 'A', 'C', 600, 30),
    ],
    exits: [exit('E1', 'G1', 600), exit('E2', 'G2', 600)],
    initial: { A: 1000, B: 0, C: 0, G1: 0, G2: 0 },
  });
  // B and C are the gate regions for this test; connect them to A.
  scenario.corridors[0].to_region_id = 'G1';
  scenario.corridors[1].to_region_id = 'G2';
  const snap1 = snapshot(scenario, { A: 1000, B: 0, C: 0, G1: 0, G2: 0 });
  const snap2 = snapshot(scenario, { A: 1000, B: 0, C: 0, G1: 900, G2: 0 });

  const staticMemory = createStrategyMemory();
  const staticFirst = computeStrategyRoutes('STATIC_SHORTEST_PATH', scenario, snap1, staticMemory, 0);
  const staticSecond = computeStrategyRoutes('STATIC_SHORTEST_PATH', scenario, snap2, staticMemory, 1);
  const staticRoute1 = staticFirst.computation.routes.get('A');
  const staticRoute2 = staticSecond.computation.routes.get('A');
  assert.ok(staticRoute1);
  assert.equal(staticRoute2?.exit_id, staticRoute1?.exit_id);

  const greedyMemory = createStrategyMemory();
  const greedyFirst = computeStrategyRoutes('GREEDY_DYNAMIC', scenario, snap1, greedyMemory, 0);
  const greedySecond = computeStrategyRoutes('GREEDY_DYNAMIC', scenario, snap2, greedyMemory, 1);
  const greedyRoute1 = greedyFirst.computation.routes.get('A');
  const greedyRoute2 = greedySecond.computation.routes.get('A');
  assert.ok(greedyRoute1);
  assert.ok(greedyRoute2);
  assert.notEqual(greedyRoute2?.exit_id, greedyRoute1?.exit_id);

  const stableMemory = createStrategyMemory();
  const stableRoute = computeStrategyRoutes('GREEDY_DYNAMIC', scenario, snap1, stableMemory, 0).computation.routes.get('A');
  assert.ok(stableRoute);
  stableMemory.committedRoutes.set('A', stableRoute);
  stableMemory.lastSwitchMinute.set('A', 0);
  const stableSecond = computeStrategyRoutes('V73_STABILITY', scenario, snap2, stableMemory, 1, {
    v73SwitchPenaltyPerPerson: 1000,
    v73HysteresisGap: 0.1,
    v74SwitchPenaltyPerPerson: 1000,
    v74CommitMinutes: 60,
    v74HysteresisGap: 0.1,
    v74AdaptiveQueueThreshold: 1,
    v74MaxObjectiveDegradation: 0.3,
    v74RiskReleaseThreshold: 100,
  });
  assert.equal(stableSecond.computation.routes.get('A')?.exit_id, stableRoute.exit_id);
});

test('safety validation rejects closed corridors and untrusted observations', () => {
  const scenario = makeScenario({
    duration: 30,
    regions: [region('A'), region('G')],
    corridors: [corridor('AG', 'A', 'G', 600)],
    exits: [exit('E1', 'G', 600)],
    initial: { A: 100, G: 0 },
  });
  const current = snapshot(scenario, { A: 100, G: 0 });
  const route = {
    region_id: 'A',
    exit_id: 'E1',
    next_hop_region_id: 'G',
    path_regions: ['A', 'G'],
    path_corridors: ['AG'],
    eta_minutes: 0.5,
    cost: 1,
  };
  const closed = snapshot(scenario, { A: 100, G: 0 }, { corridor: { AG: 'closed' } });
  const result = validateDynamicDecisions({
    scenario,
    observed: closed,
    corridorStatus: new Map([['AG', 'closed']]),
    exitStatus: new Map([['E1', 'open']]),
    routes: new Map([['A', route], ['G', null]]),
    previousValidatedRoutes: new Map(),
    activeIncidentIds: ['EVT-TEST'],
    minute: 2,
  });
  assert.equal(result.decisions.get('A')?.mode, 'rejected');
  assert.equal(result.decisions.get('A')?.route, null);

  const untrustedCurrent = snapshot(scenario, { A: 100, G: 0 });
  untrustedCurrent.regions.set('A', observation('A', null, {
    valid: false,
    confidence: 0.2,
    untrusted_reasons: ['dropout'],
  }));
  const untrustedResult = validateDynamicDecisions({
    scenario,
    observed: untrustedCurrent,
    corridorStatus: new Map([['AG', 'open']]),
    exitStatus: new Map([['E1', 'open']]),
    routes: new Map([['A', route], ['G', null]]),
    previousValidatedRoutes: new Map([['A', route]]),
    activeIncidentIds: [],
    minute: 3,
  });
  assert.equal(untrustedResult.decisions.get('A')?.mode, 'degraded_continue');
  assert.deepEqual(untrustedResult.decisions.get('A')?.route, route);
});
