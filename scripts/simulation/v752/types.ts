/**
 * V7.5.2 simulation domain types.
 *
 * Safety boundary: `GroundTruthState` is private to the simulation kernel and
 * the sensor model.  Strategies and the dynamic safety validator receive only
 * `ObservedSnapshot` / authoritative incident status; they never receive
 * ground-truth occupancy.
 */
export type StrategyId =
  | 'STATIC_SHORTEST_PATH'
  | 'GREEDY_DYNAMIC'
  | 'V73_STABILITY'
  | 'V74_COMMITMENT';

export const STRATEGIES: StrategyId[] = [
  'STATIC_SHORTEST_PATH',
  'GREEDY_DYNAMIC',
  'V73_STABILITY',
  'V74_COMMITMENT',
];

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  STATIC_SHORTEST_PATH: 'Static shortest path (frozen at t=0)',
  GREEDY_DYNAMIC: 'Greedy dynamic least-cost reassignment',
  V73_STABILITY: 'V7.3 switch-penalty / hysteresis',
  V74_COMMITMENT: 'V7.4 commitment window + risk release',
};

export type SafetyState = 'NORMAL' | 'REROUTE' | 'DEGRADED' | 'REJECT';

export interface RegionDef {
  id: string;
  name: string;
  area_m2: number;
  holding_capacity_persons: number;
}

export interface CorridorDef {
  id: string;
  name: string;
  from_region_id: string;
  to_region_id: string;
  status: 'open' | 'closed' | 'unknown';
  capacity_per_min: number | null;
  traversal_seconds: number;
  direction: 'forward' | 'reverse' | 'both';
}

export interface ExitDef {
  id: string;
  name: string;
  region_id: string;
  status: 'open' | 'closed' | 'unknown';
  capacity_per_min: number | null;
}

export interface ScenarioEvent {
  at_minute: number;
  action: 'close' | 'reopen';
  corridor_ids?: string[];
  exit_ids?: string[];
  reason: string;
}

export interface SensorProfile {
  mode: string;
  noise_relative_std: number;
  bias_relative: number;
  delay_minutes: number;
  dropout_rate: number;
  conflict_rate: number;
  base_confidence: number;
  degraded_region_prefixes: string[];
  degradation_start_minute: number;
  degraded_confidence: number;
  degraded_noise_relative_std: number;
  degraded_dropout_rate: number;
  degraded_conflict_rate: number;
  degraded_bias_relative: number;
  degraded_delay_minutes: number;
  recovery_minute: number | null;
}

export interface ScenarioDefinition {
  scenario_id: string;
  name: string;
  description: string;
  expected_state: 'NORMAL' | 'REROUTE' | 'DEGRADED';
  duration_minutes: number;
  initial_populations: Record<string, number>;
  inflow_schedule: Array<{
    start_minute: number;
    end_minute: number;
    persons_per_minute: Record<string, number>;
  }>;
  events: ScenarioEvent[];
  /** Scenario-level capacity derating (e.g. holiday one-way crowd management). */
  corridor_capacity_factor: number;
  exit_capacity_factor: number;
  sensor_profile: SensorProfile;
  acceptance: Record<string, unknown>;
}

export interface SimScenario {
  scenario_id: string;
  name: string;
  description: string;
  expected_state: 'NORMAL' | 'REROUTE' | 'DEGRADED';
  duration_minutes: number;
  regions: RegionDef[];
  corridors: CorridorDef[];
  exits: ExitDef[];
  regionById: Map<string, RegionDef>;
  corridorById: Map<string, CorridorDef>;
  exitById: Map<string, ExitDef>;
  exitsByRegion: Map<string, ExitDef[]>;
  initialPopulations: Map<string, number>;
  inflow_schedule: ScenarioDefinition['inflow_schedule'];
  events: ScenarioEvent[];
  corridor_capacity_factor: number;
  exit_capacity_factor: number;
  sensorProfile: SensorProfile;
  acceptance: Record<string, unknown>;
  rhoCrit: number;
  rhoJam: number;
}

export interface ObservedRegionState {
  region_id: string;
  /** null means no observation arrived in this control interval. */
  count: number | null;
  confidence: number;
  age_seconds: number;
  valid: boolean;
  source: 'simulation';
  provider: string;
  conflict: boolean;
  untrusted_reasons: string[];
}

export interface ObservedSnapshot {
  at_minute: number;
  regions: Map<string, ObservedRegionState>;
  corridor_status: Map<string, 'open' | 'closed' | 'unknown'>;
  exit_status: Map<string, 'open' | 'closed' | 'unknown'>;
}

export interface RouteChoice {
  region_id: string;
  exit_id: string;
  /** null when the region already contains the chosen exit. */
  next_hop_region_id: string | null;
  path_regions: string[];
  path_corridors: string[];
  eta_minutes: number;
  cost: number;
}

export interface RouteComputation {
  routes: Map<string, RouteChoice | null>;
  solve_ms: number;
  graph_nodes: number;
  graph_edges: number;
}

export interface RegionDecision {
  region_id: string;
  route: RouteChoice | null;
  mode: 'validated' | 'degraded_continue' | 'rejected' | 'no_route';
  reasons: string[];
}

export interface SafetyTickSnapshot {
  state: SafetyState;
  reasons: string[];
  untrusted_regions: string[];
  hard_violation_count: number;
}

export interface DecisionLogEntry {
  tick: number;
  minute: number;
  strategy: StrategyId;
  region_id: string;
  observed_count: number | null;
  observed_confidence: number | null;
  observed_age_seconds: number | null;
  observed_valid: boolean;
  requested_exit: string | null;
  requested_next_hop: string | null;
  eta_minutes: number | null;
  mode: RegionDecision['mode'];
  reasons: string[];
  safety_state: SafetyState;
}

export interface TickLedger {
  tick: number;
  minute: number;
  region_queue: number;
  in_transit: number;
  exit_queue: number;
  completed_cumulative: number;
  inflow_cumulative: number;
  present: number;
  expected_present: number;
  residual: number;
  max_density: number;
  max_density_region: string | null;
  backpressure_activations: number;
}

export interface RunMetrics {
  makespan_minute: number;
  p50_evacuation_minute: number | null;
  p95_evacuation_minute: number | null;
  throughput_persons_per_min: number;
  max_queue_persons: number;
  max_exit_queue_persons: number;
  queue_person_minutes: number;
  queue_duration_minutes: number;
  corridor_utilization: number;
  exit_utilization: number;
  capacity_exceedances: number;
  backpressure_activations: number;
  max_density: number;
  max_density_region: string | null;
  route_switches: number;
  switched_persons: number;
  route_switches_per_1000_persons: number;
  mean_route_dwell_minutes: number;
  decisions_total: number;
  decisions_validated: number;
  decisions_degraded: number;
  decisions_rejected: number;
  decisions_no_route: number;
  unvalidated_executions: number;
  unknown_corridor_entries: number;
  unknown_corridor_attempts: number;
  dangerous_route_publications: number;
  dangerous_route_attempts: number;
  physical_closure_blocks: number;
  oracle_reads: number;
  solve_ms_mean: number;
  solve_ms_p50: number;
  solve_ms_p95: number;
  state_distribution: Record<SafetyState, number>;
  final_state: SafetyState;
  closure_windows_applied: number;
  closed_corridor_attempts: number;
  closed_exit_attempts: number;
  rerouted_persons_after_event: number;
  untrusted_observations: number;
  degraded_control_ticks: number;
}

export interface RunRecord {
  scenario_id: string;
  scenario_name: string;
  strategy: StrategyId;
  seed: number;
  initial_persons: number;
  external_inflow_persons: number;
  completed_persons: number;
  unserved_persons: number;
  mass_balance_residual: number;
  mass_balance_ok: boolean;
  min_region_queue: number;
  min_exit_queue: number;
  final_region_queues: Record<string, number>;
  final_in_transit_persons: number;
  metrics: RunMetrics;
  acceptance: Record<string, boolean | number | string | null>;
  decision_log_hash: string;
  tick_ledger_hash: string;
}
