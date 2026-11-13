/**
 * Single-seed diagnostic comparison for V7.5.2.
 *
 * This is a development aid, not the benchmark of record.  The benchmark of
 * record is `scripts/simulation/v752/run-benchmark.ts` (4 strategies x 5
 * scenarios x 30 seeds = 600 runs).
 */
import { loadScenarioSet } from './scenario';
import { runSimulation } from './engine';
import { STRATEGIES, type StrategyId } from './types';

function main(): void {
  const seed = Number(process.argv[2] ?? 1);
  const set = loadScenarioSet();
  console.log(`scenario\tstrategy\tcompleted\tunserved\tmakespan\tmaxDensity\tbackpressure\tstateDistribution\tswitches\trerouted\trejected\tdegraded\tuntrustedObs`);
  for (const scenario of set.scenarios) {
    for (const strategy of STRATEGIES) {
      const { record } = runSimulation(scenario, strategy, seed);
      const m = record.metrics;
      const dist = (Object.entries(m.state_distribution) as Array<[StrategyId | string, number]>)
        .map(([state, count]) => `${state}:${count}`)
        .join(',');
      console.log([
        scenario.scenario_id,
        strategy,
        record.completed_persons,
        record.unserved_persons,
        m.makespan_minute.toFixed(2),
        m.max_density.toFixed(3),
        m.backpressure_activations,
        dist,
        m.route_switches,
        m.rerouted_persons_after_event,
        m.decisions_rejected,
        m.decisions_degraded,
        m.untrusted_observations,
      ].join('\t'));
      if (record.unserved_persons > 0) {
        const top = Object.entries(record.final_region_queues)
          .filter(([, persons]) => persons > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([id, persons]) => `${id}:${persons}`)
          .join(',');
        console.log(`  unserved_detail\ttransit=${record.final_in_transit_persons}\tqueues=${top}`);
      }
    }
  }
}

main();
