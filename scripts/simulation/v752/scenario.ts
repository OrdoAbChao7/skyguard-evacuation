/**
 * V7.5.2 scenario loader.
 *
 * Geometry comes from the frozen V7.5 base file, copied byte-for-byte into
 * `data/scenarios/hankou-marshland-v752-base.json`.  All added population,
 * event and sensor fields live in `data/scenarios/hankou-v752-stress.json`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  CorridorDef,
  ExitDef,
  RegionDef,
  ScenarioDefinition,
  SensorProfile,
  SimScenario,
} from './types';

interface BaseScenarioJson {
  scenario_id: string;
  name: string;
  version: string;
  description: string;
  config: {
    default_thresholds: {
      high_density: number;
      critical_density: number;
    };
  };
  regions: Array<{
    id: string;
    name: string;
    area_m2: number;
    holding_capacity_persons: number;
  }>;
  corridors: Array<{
    id: string;
    name: string;
    from_region_id: string;
    to_region_id: string;
    status: 'open' | 'closed' | 'unknown';
    capacity_per_min: number | null;
    traversal_seconds: number;
    direction: 'forward' | 'reverse' | 'both';
  }>;
  exits: Array<{
    id: string;
    name: string;
    region_id: string;
    status: 'open' | 'closed' | 'unknown';
    capacity_per_min: number | null;
  }>;
}

interface StressScenarioJson {
  scenario_set_id: string;
  base_scenario_file: string;
  notice: string;
  scenarios: ScenarioDefinition[];
}

export interface ScenarioSet {
  scenario_set_id: string;
  notice: string;
  base_scenario_file: string;
  base_scenario_sha256: string;
  scenarios: SimScenario[];
}

const DEFAULT_SCENARIO_DIR = path.resolve(__dirname, '../../../data/scenarios');
const DEFAULT_BASE_FILE = 'hankou-marshland-v752-base.json';
const DEFAULT_STRESS_FILE = 'hankou-v752-stress.json';

function requireFinite(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`);
  return parsed;
}

function parseSensorProfile(raw: Record<string, unknown>): SensorProfile {
  return {
    mode: String(raw.mode ?? 'nominal'),
    noise_relative_std: requireFinite(raw.noise_relative_std, 'sensor.noise_relative_std'),
    bias_relative: requireFinite(raw.bias_relative, 'sensor.bias_relative'),
    delay_minutes: requireFinite(raw.delay_minutes, 'sensor.delay_minutes'),
    dropout_rate: requireFinite(raw.dropout_rate, 'sensor.dropout_rate'),
    conflict_rate: requireFinite(raw.conflict_rate, 'sensor.conflict_rate'),
    base_confidence: requireFinite(raw.base_confidence, 'sensor.base_confidence'),
    degraded_region_prefixes: Array.isArray(raw.degraded_region_prefixes)
      ? raw.degraded_region_prefixes.map(String)
      : [],
    degradation_start_minute: raw.degradation_start_minute === undefined
      ? 0
      : requireFinite(raw.degradation_start_minute, 'sensor.degradation_start_minute'),
    degraded_confidence: requireFinite(raw.degraded_confidence, 'sensor.degraded_confidence'),
    degraded_noise_relative_std: requireFinite(raw.degraded_noise_relative_std, 'sensor.degraded_noise_relative_std'),
    degraded_dropout_rate: requireFinite(raw.degraded_dropout_rate, 'sensor.degraded_dropout_rate'),
    degraded_conflict_rate: requireFinite(raw.degraded_conflict_rate, 'sensor.degraded_conflict_rate'),
    degraded_bias_relative: requireFinite(raw.degraded_bias_relative, 'sensor.degraded_bias_relative'),
    degraded_delay_minutes: requireFinite(raw.degraded_delay_minutes, 'sensor.degraded_delay_minutes'),
    recovery_minute: raw.recovery_minute === null || raw.recovery_minute === undefined
      ? null
      : requireFinite(raw.recovery_minute, 'sensor.recovery_minute'),
  };
}

export function loadScenarioSet(
  scenarioDir: string = DEFAULT_SCENARIO_DIR,
  baseFile: string = DEFAULT_BASE_FILE,
  stressFile: string = DEFAULT_STRESS_FILE,
): ScenarioSet {
  const basePath = path.join(scenarioDir, baseFile);
  const stressPath = path.join(scenarioDir, stressFile);
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8')) as BaseScenarioJson;
  const stress = JSON.parse(fs.readFileSync(stressPath, 'utf8')) as StressScenarioJson;

  const regions: RegionDef[] = base.regions.map(region => ({
    id: region.id,
    name: region.name,
    area_m2: region.area_m2,
    holding_capacity_persons: region.holding_capacity_persons,
  }));
  const regionById = new Map(regions.map(region => [region.id, region]));
  const corridors: CorridorDef[] = base.corridors.map(corridor => ({
    id: corridor.id,
    name: corridor.name,
    from_region_id: corridor.from_region_id,
    to_region_id: corridor.to_region_id,
    status: corridor.status,
    capacity_per_min: corridor.capacity_per_min,
    traversal_seconds: corridor.traversal_seconds,
    direction: corridor.direction,
  }));
  const corridorById = new Map(corridors.map(corridor => [corridor.id, corridor]));
  const exits: ExitDef[] = base.exits.map(exit => ({
    id: exit.id,
    name: exit.name,
    region_id: exit.region_id,
    status: exit.status,
    capacity_per_min: exit.capacity_per_min,
  }));
  const exitById = new Map(exits.map(exit => [exit.id, exit]));
  const exitsByRegion = new Map<string, ExitDef[]>();
  for (const exit of exits) {
    const list = exitsByRegion.get(exit.region_id) ?? [];
    list.push(exit);
    exitsByRegion.set(exit.region_id, list);
  }

  const scenarios: SimScenario[] = stress.scenarios.map(definition => {
    const initialPopulations = new Map<string, number>();
    for (const [regionId, persons] of Object.entries(definition.initial_populations)) {
      if (!regionById.has(regionId)) throw new Error(`${definition.scenario_id}: unknown initial region ${regionId}`);
      const value = Math.max(0, Math.floor(requireFinite(persons, `${definition.scenario_id}.${regionId}`)));
      initialPopulations.set(regionId, value);
    }
    for (const event of definition.events) {
      for (const corridorId of event.corridor_ids ?? []) {
        if (!corridorById.has(corridorId)) throw new Error(`${definition.scenario_id}: unknown event corridor ${corridorId}`);
      }
      for (const exitId of event.exit_ids ?? []) {
        if (!exitById.has(exitId)) throw new Error(`${definition.scenario_id}: unknown event exit ${exitId}`);
      }
    }
    return {
      scenario_id: definition.scenario_id,
      name: definition.name,
      description: definition.description,
      expected_state: definition.expected_state,
      duration_minutes: definition.duration_minutes,
      regions,
      corridors,
      exits,
      regionById,
      corridorById,
      exitById,
      exitsByRegion,
      initialPopulations,
      inflow_schedule: definition.inflow_schedule ?? [],
      events: definition.events,
      corridor_capacity_factor: Math.max(0, Math.min(1, definition.corridor_capacity_factor ?? 1)),
      exit_capacity_factor: Math.max(0, Math.min(1, definition.exit_capacity_factor ?? 1)),
      sensorProfile: parseSensorProfile(definition.sensor_profile as unknown as Record<string, unknown>),
      acceptance: definition.acceptance,
      rhoCrit: base.config.default_thresholds.high_density,
      rhoJam: 4.5,
    };
  });

  return {
    scenario_set_id: stress.scenario_set_id,
    notice: stress.notice,
    base_scenario_file: baseFile,
    base_scenario_sha256: '9e3c10988289e6804d08b7c4d88166c1af947b73d2f0bc1c5c732c7d47a95b24',
    scenarios,
  };
}
