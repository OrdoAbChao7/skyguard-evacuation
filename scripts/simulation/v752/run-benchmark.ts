/**
 * V7.5.2 benchmark of record.
 *
 * 4 independent strategies x 5 stress scenarios x 30 seeds = 600 runs.
 * There are no aliases and no duplicated "strategy" labels: each of the four
 * entries below executes a different route-decision code path.
 *
 * Outputs are written to `evaluation/realworld_hankou/v752/` only.  Historical
 * V7.x evidence is never read or overwritten by this script.
 */
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadScenarioSet } from './scenario';
import { runSimulation } from './engine';
import { mulberry32 } from './sensors';
import {
  STRATEGIES,
  STRATEGY_LABELS,
  type RunRecord,
  type StrategyId,
} from './types';

const SEEDS = Array.from({ length: 30 }, (_, index) => index + 1);
const ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = path.join(ROOT, 'evaluation/realworld_hankou/v752');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const LOG_DIR = path.join(OUT_DIR, 'decision-logs');
const EVIDENCE_DIR = path.join(OUT_DIR, 'evidence');

const METRICS = [
  'completed_persons',
  'unserved_persons',
  'makespan_minute',
  'p95_evacuation_minute',
  'throughput_persons_per_min',
  'max_density',
  'max_exit_queue_persons',
  'queue_person_minutes',
  'backpressure_activations',
  'route_switches',
  'switched_persons',
  'rerouted_persons_after_event',
  'decisions_rejected',
  'decisions_degraded',
  'closed_corridor_attempts',
  'closed_exit_attempts',
  'untrusted_observations',
  'solve_ms_mean',
] as const;

type MetricName = typeof METRICS[number];

interface Stats {
  n: number;
  mean: number;
  std: number;
  median: number;
  min: number;
  max: number;
  ci95: [number, number];
}

interface PairedComparison {
  baseline: StrategyId;
  treatment: StrategyId;
  metric: MetricName;
  n: number;
  mean_difference: number;
  ci95: [number, number];
  permutation_p: number;
  treatment_better_count: number;
  baseline_better_count: number;
  ties: number;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function hashString(text: string): number {
  return Number.parseInt(crypto.createHash('sha256').update(text).digest('hex').slice(0, 8), 16) >>> 0;
}

function summarize(values: number[], key: string): Stats {
  const rng = mulberry32(hashString(`bootstrap|${key}`));
  const resampled: number[] = [];
  for (let iteration = 0; iteration < 500; iteration += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(rng() * values.length)] ?? 0;
    }
    resampled.push(total / Math.max(1, values.length));
  }
  return {
    n: values.length,
    mean: Number(mean(values).toFixed(6)),
    std: Number(std(values).toFixed(6)),
    median: Number(percentile(values, 0.5).toFixed(6)),
    min: Number(Math.min(...values).toFixed(6)),
    max: Number(Math.max(...values).toFixed(6)),
    ci95: [Number(percentile(resampled, 0.025).toFixed(6)), Number(percentile(resampled, 0.975).toFixed(6))],
  };
}

function signFlipPValue(differences: number[], key: string): number {
  const observed = Math.abs(mean(differences));
  if (observed === 0) return 1;
  const rng = mulberry32(hashString(`permutation|${key}`));
  let atLeastAsExtreme = 0;
  const iterations = 2000;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (const difference of differences) total += rng() < 0.5 ? -difference : difference;
    if (Math.abs(total / differences.length) >= observed - 1e-12) atLeastAsExtreme += 1;
  }
  return Number(((atLeastAsExtreme + 1) / (iterations + 1)).toFixed(6));
}

function metricValue(record: RunRecord, metric: MetricName): number {
  if (metric === 'completed_persons') return record.completed_persons;
  if (metric === 'unserved_persons') return record.unserved_persons;
  if (metric === 'p95_evacuation_minute') return record.metrics.p95_evacuation_minute ?? record.metrics.makespan_minute;
  return record.metrics[metric] as number;
}

function pairedComparison(
  baseline: StrategyId,
  treatment: StrategyId,
  metric: MetricName,
  records: RunRecord[],
  key: string,
): PairedComparison {
  const differences: number[] = [];
  let treatmentBetter = 0;
  let baselineBetter = 0;
  let ties = 0;
  for (const record of records) {
    if (record.strategy !== treatment) continue;
    const counterpart = records.find(item => item.scenario_id === record.scenario_id
      && item.seed === record.seed
      && item.strategy === baseline);
    if (!counterpart) continue;
    const difference = metricValue(record, metric) - metricValue(counterpart, metric);
    differences.push(difference);
    // Completion and throughput are the only "larger is better" metrics.
    const higherIsBetter = metric === 'completed_persons' || metric === 'throughput_persons_per_min';
    const treatmentIsBetter = higherIsBetter ? difference > 0 : difference < 0;
    const baselineIsBetter = higherIsBetter ? difference < 0 : difference > 0;
    if (treatmentIsBetter) treatmentBetter += 1;
    else if (baselineIsBetter) baselineBetter += 1;
    else ties += 1;
  }
  const sorted = [...differences].sort((a, b) => a - b);
  const rng = mulberry32(hashString(`paired-bootstrap|${key}`));
  const resampled: number[] = [];
  for (let iteration = 0; iteration < 500; iteration += 1) {
    let total = 0;
    for (let index = 0; index < differences.length; index += 1) {
      total += differences[Math.floor(rng() * differences.length)] ?? 0;
    }
    resampled.push(total / Math.max(1, differences.length));
  }
  return {
    baseline,
    treatment,
    metric,
    n: differences.length,
    mean_difference: Number(mean(differences).toFixed(6)),
    ci95: [Number(percentile(resampled, 0.025).toFixed(6)), Number(percentile(resampled, 0.975).toFixed(6))],
    permutation_p: signFlipPValue(differences, key),
    treatment_better_count: treatmentBetter,
    baseline_better_count: baselineBetter,
    ties,
  };
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function gitValue(command: string): string | null {
  try {
    return execSync(command, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function main(): void {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  const set = loadScenarioSet();
  const records: RunRecord[] = [];
  const startedAt = new Date().toISOString();
  const traces = new Set([
    'ST-01|STATIC_SHORTEST_PATH',
    'ST-02|STATIC_SHORTEST_PATH',
    'ST-02|GREEDY_DYNAMIC',
    'ST-04|STATIC_SHORTEST_PATH',
    'ST-04|GREEDY_DYNAMIC',
    'ST-05|GREEDY_DYNAMIC',
  ]);

  for (const scenario of set.scenarios) {
    for (const strategy of STRATEGIES) {
      for (const seed of SEEDS) {
        const captureTrace = seed === 1 && traces.has(`${scenario.scenario_id}|${strategy}`);
        const { record, trace } = runSimulation(scenario, strategy, seed, { collectTrace: captureTrace });
        records.push(record);
        if (captureTrace && trace) {
          fs.writeFileSync(
            path.join(LOG_DIR, `${scenario.scenario_id}-${strategy}-seed1.json`),
            `${JSON.stringify({
              scenario_id: scenario.scenario_id,
              strategy,
              seed,
              record,
              decisions: trace.decisions,
              ledger: trace.ledger,
            }, null, 2)}\n`,
            'utf8',
          );
        }
        if (record.mass_balance_residual !== 0) {
          throw new Error(`${scenario.scenario_id}/${strategy}/${seed}: mass residual ${record.mass_balance_residual}`);
        }
      }
    }
  }

  fs.writeFileSync(
    path.join(RAW_DIR, 'runs.jsonl'),
    `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );

  const summaries: Record<string, Record<string, Record<MetricName, Stats>>> = {};
  for (const scenario of set.scenarios) {
    summaries[scenario.scenario_id] = {};
    for (const strategy of STRATEGIES) {
      const subset = records.filter(record => record.scenario_id === scenario.scenario_id && record.strategy === strategy);
      summaries[scenario.scenario_id][strategy] = {} as Record<MetricName, Stats>;
      for (const metric of METRICS) {
        summaries[scenario.scenario_id][strategy][metric] = summarize(
          subset.map(record => metricValue(record, metric)),
          `${scenario.scenario_id}|${strategy}|${metric}`,
        );
      }
    }
  }

  const pairs: Array<[StrategyId, StrategyId]> = [
    ['STATIC_SHORTEST_PATH', 'GREEDY_DYNAMIC'],
    ['GREEDY_DYNAMIC', 'V73_STABILITY'],
    ['V73_STABILITY', 'V74_COMMITMENT'],
    ['GREEDY_DYNAMIC', 'V74_COMMITMENT'],
  ];
  const paired: Record<string, PairedComparison[]> = {};
  for (const scenario of set.scenarios) {
    const subset = records.filter(record => record.scenario_id === scenario.scenario_id);
    paired[scenario.scenario_id] = [];
    for (const [baseline, treatment] of pairs) {
      for (const metric of METRICS) {
        paired[scenario.scenario_id].push(pairedComparison(
          baseline,
          treatment,
          metric,
          subset,
          `${scenario.scenario_id}|${baseline}|${treatment}|${metric}`,
        ));
      }
    }
  }

  // Equal-weight normalized comparison: average each scenario's mean
  // difference, so ST-02 does not dominate only because it has more people.
  const normalized: PairedComparison[] = [];
  for (const [baseline, treatment] of pairs) {
    for (const metric of METRICS) {
      const perScenario = set.scenarios.map(scenario => {
        const rows = paired[scenario.scenario_id]
          .filter(item => item.baseline === baseline && item.treatment === treatment && item.metric === metric);
        return rows[0]?.mean_difference ?? 0;
      });
      normalized.push({
        baseline,
        treatment,
        metric,
        n: perScenario.length,
        mean_difference: Number(mean(perScenario).toFixed(6)),
        ci95: [0, 0],
        permutation_p: 1,
        treatment_better_count: 0,
        baseline_better_count: 0,
        ties: 0,
      });
    }
  }

  const acceptanceByRun = records.map(record => ({
    scenario_id: record.scenario_id,
    strategy: record.strategy,
    seed: record.seed,
    ...record.acceptance,
  }));
  const scenarioAcceptance: Record<string, Record<string, boolean | number | null>> = {};
  for (const scenario of set.scenarios) {
    const subset = records.filter(record => record.scenario_id === scenario.scenario_id);
    scenarioAcceptance[scenario.scenario_id] = {
      all_mass_balance: subset.every(record => record.mass_balance_ok),
      all_no_unvalidated_execution: subset.every(record => record.acceptance.no_unvalidated_execution === true),
      all_no_unknown_corridor_entry: subset.every(record => record.acceptance.no_unknown_corridor_entry === true),
      all_no_dangerous_route_publication: subset.every(record => record.acceptance.no_dangerous_route_publication === true),
      any_backpressure_activated: subset.some(record => record.metrics.backpressure_activations > 0),
      max_density: Number(Math.max(...subset.map(record => record.metrics.max_density)).toFixed(6)),
      any_closure_window: subset.some(record => record.metrics.closure_windows_applied > 0),
      any_blocked_route_attempt: subset.some(record => record.metrics.closed_corridor_attempts > 0),
      any_blocked_exit_attempt: subset.some(record => record.metrics.closed_exit_attempts > 0),
      any_reroute: subset.some(record => record.metrics.rerouted_persons_after_event > 0),
      any_degraded_observation: subset.some(record => record.metrics.untrusted_observations > 0),
      any_degraded_decision: subset.some(record => record.metrics.decisions_degraded > 0),
      all_oracle_reads_zero: subset.every(record => record.metrics.oracle_reads === 0),
      runs: subset.length,
    };
  }

  const ledgerProbes: Record<string, unknown> = {};
  for (const scenario of set.scenarios) {
    for (const strategy of STRATEGIES) {
      const file = path.join(LOG_DIR, `${scenario.scenario_id}-${strategy}-seed1.json`);
      if (!fs.existsSync(file)) continue;
      const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as { ledger: Array<Record<string, unknown>> };
      const ledger = payload.ledger;
      ledgerProbes[`${scenario.scenario_id}|${strategy}`] = {
        first: ledger[0],
        middle: ledger[Math.floor(ledger.length / 2)],
        last: ledger[ledger.length - 1],
        violations: ledger.filter(tick => tick.residual !== 0).length,
      };
    }
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'ledger-probes.json'), `${JSON.stringify(ledgerProbes, null, 2)}\n`, 'utf8');

  const codeFiles = [
    'scripts/simulation/v752/types.ts',
    'scripts/simulation/v752/scenario.ts',
    'scripts/simulation/v752/network.ts',
    'scripts/simulation/v752/sensors.ts',
    'scripts/simulation/v752/strategies.ts',
    'scripts/simulation/v752/safety.ts',
    'scripts/simulation/v752/engine.ts',
    'scripts/simulation/v752/generate-scenarios.ts',
    'scripts/simulation/v752/run-benchmark.ts',
    'data/scenarios/hankou-marshland-v752-base.json',
    'data/scenarios/hankou-v752-stress.json',
  ];
  const metadata = {
    protocol: 'SkyGuard V7.5.2 benchmark',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    branch: gitValue('git rev-parse --abbrev-ref HEAD'),
    head: gitValue('git rev-parse HEAD'),
    seeds: SEEDS,
    strategies: STRATEGIES.map(strategy => ({ id: strategy, label: STRATEGY_LABELS[strategy] })),
    scenarios: set.scenarios.map(scenario => ({
      id: scenario.scenario_id,
      name: scenario.name,
      expected_state: scenario.expected_state,
      initial_persons: [...scenario.initialPopulations.values()].reduce((sum, value) => sum + value, 0),
      events: scenario.events.length,
      corridor_capacity_factor: scenario.corridor_capacity_factor,
      exit_capacity_factor: scenario.exit_capacity_factor,
      sensor_mode: scenario.sensorProfile.mode,
    })),
    runs: records.length,
    code_sha256: Object.fromEntries(codeFiles.map(file => [file, sha256File(path.join(ROOT, file))])),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'run-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(OUT_DIR, 'benchmark-summary.json'),
    `${JSON.stringify({ summaries, paired, normalized, scenarioAcceptance, acceptanceByRun }, null, 2)}\n`,
    'utf8',
  );

  console.log(`Wrote ${records.length} runs to ${path.join(RAW_DIR, 'runs.jsonl')}`);
  for (const scenario of set.scenarios) {
    console.log(`${scenario.scenario_id}: ${JSON.stringify(scenarioAcceptance[scenario.scenario_id])}`);
  }
}

main();
