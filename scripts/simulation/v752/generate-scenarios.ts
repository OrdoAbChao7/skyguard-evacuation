/**
 * V7.5.2 synthetic stress-scenario generator.
 *
 * The base geometry is copied byte-for-byte from the V7.5 scenario
 * (`data/scenarios/hankou-marshland-v752-base.json`).  This script only adds
 * explicitly synthetic population / event / sensor profiles.  It does not
 * claim that any initial count is an observed attendance figure.
 */
import fs from 'node:fs';
import path from 'node:path';

interface BaseScenario {
  regions: Array<{ id: string; area_m2: number; holding_capacity_persons: number }>;
  corridors: Array<{ id: string; from_region_id: string; to_region_id: string; status: string; capacity_per_min: number | null }>;
  exits: Array<{ id: string; region_id: string; capacity_per_min: number | null }>;
  simulation_baseline?: Record<string, { count: number; confidence: number }>;
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
  events: Array<{
    at_minute: number;
    action: 'close' | 'reopen';
    corridor_ids?: string[];
    exit_ids?: string[];
    reason: string;
  }>;
  corridor_capacity_factor: number;
  exit_capacity_factor: number;
  sensor_profile: Record<string, unknown>;
  acceptance: Record<string, unknown>;
  geometry_provenance: string;
  capacity_provenance: string;
  population_provenance: string;
  event_provenance: string;
  sensor_provenance: string;
}

interface ScenarioSpec {
  scenario_id: string;
  name: string;
  description: string;
  expected_state: 'NORMAL' | 'REROUTE' | 'DEGRADED';
  duration_minutes: number;
  total: number;
  weight: (regionId: string, baseline: number) => number;
  events?: ScenarioDefinition['events'];
  corridorCapacityFactor?: number;
  exitCapacityFactor?: number;
  sensor: Record<string, unknown>;
  acceptance: Record<string, unknown>;
}

function allocate(total: number, weights: Map<string, number>): Record<string, number> {
  const rows = [...weights.entries()]
    .map(([id, weight]) => ({ id, weight: Math.max(0, weight) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const weightSum = rows.reduce((sum, row) => sum + row.weight, 0);
  if (weightSum <= 0) throw new Error('scenario weights must have a positive sum');
  const raw = rows.map(row => ({ id: row.id, exact: (total * row.weight) / weightSum }));
  const floors = raw.map(row => ({ id: row.id, value: Math.floor(row.exact), fraction: row.exact - Math.floor(row.exact) }));
  let assigned = floors.reduce((sum, row) => sum + row.value, 0);
  const remainder = total - assigned;
  const ranked = [...floors].sort((a, b) => b.fraction - a.fraction || a.id.localeCompare(b.id));
  for (let i = 0; i < remainder; i += 1) ranked[i % ranked.length].value += 1;
  const result: Record<string, number> = {};
  for (const row of floors) result[row.id] = row.value;
  assigned = Object.values(result).reduce((sum, value) => sum + value, 0);
  if (assigned !== total) throw new Error(`allocation mismatch: ${assigned} != ${total}`);
  return result;
}

const L3_CORRIDORS = Array.from({ length: 11 }, (_, index) => `C_S${String(index + 1).padStart(2, '0')}_L3_L2`);

const SPECS: ScenarioSpec[] = [
  {
    scenario_id: 'ST-01',
    name: '日常客流基线',
    description: '工作日傍晚的合成基线客流；所有通道与出口可用，传感器处于标称状态。',
    expected_state: 'NORMAL',
    duration_minutes: 60,
    total: 18_000,
    weight: (_id, baseline) => baseline,
    sensor: {
      mode: 'nominal',
      noise_relative_std: 0.03,
      bias_relative: 0,
      delay_minutes: 0,
      dropout_rate: 0,
      conflict_rate: 0,
      base_confidence: 0.92,
      degraded_region_prefixes: [],
      degradation_start_minute: 0,
      degraded_confidence: 0.45,
      degraded_noise_relative_std: 0.1,
      degraded_dropout_rate: 0.25,
      degraded_conflict_rate: 0.2,
      degraded_bias_relative: 0.15,
      degraded_delay_minutes: 1.5,
      recovery_minute: null,
    },
    acceptance: {
      mass_balance_required: true,
      no_unvalidated_execution: true,
    },
  },
  {
    scenario_id: 'ST-02',
    name: '节假日高峰与辅助闸口管控',
    description: '合成的节假日高峰客流，核心段承担更高份额；出口通行能力按 25% 折算，t=5 分钟关闭 7 个辅助闸口、仅保留 4 个主闸口，用于检验真实改派、闸口排队与下游回压。人数与折减均为压力测试参数，不是实测客流。',
    expected_state: 'REROUTE',
    duration_minutes: 60,
    total: 120_000,
    exitCapacityFactor: 0.25,
    events: [
      {
        at_minute: 5,
        action: 'close',
        exit_ids: [
          'GATE_02_G02',
          'GATE_03_G03',
          'GATE_04_G04',
          'GATE_06_G06',
          'GATE_08_G08',
          'GATE_09_G09',
          'GATE_11_G11',
        ],
        reason: '合成演练：节假日辅助闸口管控，仅保留 G01/G05/G07/G10 四个主闸口',
      },
    ],
    weight: (id, baseline) => {
      const multiplier = id.startsWith('R_S07_') ? 3 : id.startsWith('R_S10_') ? 2 : id.startsWith('R_S03_') ? 1.5 : 1;
      return baseline * multiplier;
    },
    sensor: {
      mode: 'holiday',
      noise_relative_std: 0.05,
      bias_relative: 0,
      delay_minutes: 0.25,
      dropout_rate: 0,
      conflict_rate: 0,
      base_confidence: 0.95,
      degraded_region_prefixes: [],
      degradation_start_minute: 0,
      degraded_confidence: 0.45,
      degraded_noise_relative_std: 0.1,
      degraded_dropout_rate: 0.25,
      degraded_conflict_rate: 0.2,
      degraded_bias_relative: 0.15,
      degraded_delay_minutes: 1.5,
      recovery_minute: null,
    },
    acceptance: {
      mass_balance_required: true,
      no_unvalidated_execution: true,
      require_backpressure_activation: true,
      require_max_density_at_least: 2.0,
    },
  },
  {
    scenario_id: 'ST-03',
    name: '突发激增散场',
    description: '合成的灯光秀熄灯瞬时散场压力，核心段人口集中；用于比较不同策略在容量瓶颈下的吞吐与路径稳定性。该场景没有物理封锁事件，因此安全状态通常保持 NORMAL。',
    expected_state: 'NORMAL',
    duration_minutes: 60,
    total: 80_000,
    weight: (id, baseline) => {
      const multiplier = id.startsWith('R_S03_') || id.startsWith('R_S07_')
        ? 3
        : id.startsWith('R_S01_') || id.startsWith('R_S02_')
          ? 1.5
          : 1;
      return baseline * multiplier;
    },
    sensor: {
      mode: 'surge',
      noise_relative_std: 0.06,
      bias_relative: 0,
      delay_minutes: 0.25,
      dropout_rate: 0,
      conflict_rate: 0,
      base_confidence: 0.95,
      degraded_region_prefixes: [],
      degradation_start_minute: 0,
      degraded_confidence: 0.45,
      degraded_noise_relative_std: 0.1,
      degraded_dropout_rate: 0.25,
      degraded_conflict_rate: 0.2,
      degraded_bias_relative: 0.15,
      degraded_delay_minutes: 1.5,
      recovery_minute: null,
    },
    acceptance: {
      mass_balance_required: true,
      no_unvalidated_execution: true,
      require_queue: true,
    },
  },
  {
    scenario_id: 'ST-04',
    name: '闸口阻断与三级平台封闭',
    description: '合成事件：t=5 分钟关闭三阳门 G07 与 11 条 L3→L2 通道，t=20 分钟恢复；用于检验真实拓扑阻断、改派与恢复。',
    expected_state: 'REROUTE',
    duration_minutes: 60,
    total: 60_000,
    weight: (id, baseline) => {
      const multiplier = id.startsWith('R_S07_') ? 2 : id.startsWith('R_S01_') || id.startsWith('R_S02_') ? 1.5 : 1;
      return baseline * multiplier;
    },
    events: [
      {
        at_minute: 5,
        action: 'close',
        corridor_ids: L3_CORRIDORS,
        exit_ids: ['GATE_07_G07'],
        reason: '合成演练：三级亲水平台临时封闭，三阳门闸口结构故障',
      },
      {
        at_minute: 20,
        action: 'reopen',
        corridor_ids: L3_CORRIDORS,
        exit_ids: ['GATE_07_G07'],
        reason: '合成演练：封闭解除，闸口恢复',
      },
    ],
    sensor: {
      mode: 'closure',
      noise_relative_std: 0.05,
      bias_relative: 0,
      delay_minutes: 0.25,
      dropout_rate: 0,
      conflict_rate: 0,
      base_confidence: 0.95,
      degraded_region_prefixes: [],
      degradation_start_minute: 0,
      degraded_confidence: 0.45,
      degraded_noise_relative_std: 0.1,
      degraded_dropout_rate: 0.25,
      degraded_conflict_rate: 0.2,
      degraded_bias_relative: 0.15,
      degraded_delay_minutes: 1.5,
      recovery_minute: null,
    },
    acceptance: {
      mass_balance_required: true,
      no_unvalidated_execution: true,
      require_closure_window: true,
      require_blocked_route_attempts: true,
      require_reroute: true,
    },
  },
  {
    scenario_id: 'ST-05',
    name: '传感器降级与恢复',
    description: '合成传感器故障：S01/S03/S07 段在 5–30 分钟出现缺失、延迟、偏置与冲突观测，30 分钟后恢复；前 5 分钟已有通过校验的路线，用于检验观测边界、fail-closed 降级与已验证路线延续。',
    expected_state: 'DEGRADED',
    duration_minutes: 60,
    total: 45_000,
    weight: (_id, baseline) => baseline,
    sensor: {
      mode: 'degraded',
      noise_relative_std: 0.08,
      bias_relative: 0,
      delay_minutes: 0.25,
      dropout_rate: 0,
      conflict_rate: 0,
      base_confidence: 0.95,
      degraded_region_prefixes: ['R_S01_', 'R_S03_', 'R_S07_'],
      degradation_start_minute: 5,
      degraded_confidence: 0.42,
      degraded_noise_relative_std: 0.12,
      degraded_dropout_rate: 0.3,
      degraded_conflict_rate: 0.25,
      degraded_bias_relative: 0.2,
      degraded_delay_minutes: 2,
      recovery_minute: 30,
    },
    acceptance: {
      mass_balance_required: true,
      no_unvalidated_execution: true,
      require_degraded_observations: true,
      require_degraded_decisions: true,
      require_oracle_reads_zero: true,
    },
  },
];

function main(): void {
  const root = path.resolve(__dirname, '../../..');
  const basePath = path.join(root, 'data/scenarios/hankou-marshland-v752-base.json');
  const outputPath = path.join(root, 'data/scenarios/hankou-v752-stress.json');
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8')) as BaseScenario;

  const allRegionIds = base.regions.map(region => region.id);
  const baseline = base.simulation_baseline ?? {};
  const definitions: ScenarioDefinition[] = SPECS.map(spec => {
    const weights = new Map<string, number>();
    for (const regionId of allRegionIds) {
      const count = baseline[regionId]?.count ?? 0;
      weights.set(regionId, count > 0 ? spec.weight(regionId, count) : 0);
    }
    const populations = allocate(spec.total, weights);
    return {
      scenario_id: spec.scenario_id,
      name: spec.name,
      description: spec.description,
      expected_state: spec.expected_state,
      duration_minutes: spec.duration_minutes,
      initial_populations: populations,
      inflow_schedule: [],
      events: spec.events ?? [],
      corridor_capacity_factor: spec.corridorCapacityFactor ?? 1,
      exit_capacity_factor: spec.exitCapacityFactor ?? 1,
      sensor_profile: spec.sensor,
      acceptance: spec.acceptance,
      geometry_provenance: 'estimated_manual_digitization (V7.5 base; no OSM file or official survey in repository)',
      capacity_provenance: 'engineering_assumption (nominal flow rates; not measured)',
      population_provenance: 'synthetic_test_data (not measured attendance)',
      event_provenance: 'synthetic_test_data (drill scenario, not a historical event)',
      sensor_provenance: 'synthetic_test_data (simulated observation error)',
    };
  });

  const payload = {
    scenario_set_id: 'hankou-v752-stress',
    generated_by: 'scripts/simulation/v752/generate-scenarios.ts',
    base_scenario_file: 'hankou-marshland-v752-base.json',
    base_scenario_sha256: '9e3c10988289e6804d08b7c4d88166c1af947b73d2f0bc1c5c732c7d47a95b24',
    notice: 'Synthetic stress scenarios. Initial populations are test parameters, not measured attendance. Geometry provenance remains estimated/anchored as documented in the V7.5.1 audit.',
    provenance: {
      classification: 'Geographically Anchored Estimated Scenario',
      official_survey: 'not available in repository',
      osm_source: 'not available in repository; no ODbL extract, download record, or hash',
      manual_digitization: 'region geometry and anchor coordinates inherited from the V7.5 estimated scenario',
      literature: 'density thresholds reference GB 50016-2014 / Fruin LOS E; capacities are not measured field data',
      engineering_assumption: 'holding capacity, corridor capacity, traversal time, exit capacity',
      test_data: 'initial populations, inflow schedules, closure events, sensor noise/dropout profiles',
    },
    scenarios: definitions,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outputPath}`);
  for (const scenario of definitions) {
    const total = Object.values(scenario.initial_populations).reduce((sum, value) => sum + value, 0);
    console.log(`${scenario.scenario_id}: ${total} persons, ${scenario.events.length} events`);
  }
}

if (require.main === module) main();
