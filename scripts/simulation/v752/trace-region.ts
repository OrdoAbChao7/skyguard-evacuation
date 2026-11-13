/**
 * Per-region decision trace diagnostic.
 *
 * Usage: tsx scripts/simulation/v752/trace-region.ts <scenario> <strategy> <region> [seed]
 */
import { loadScenarioSet } from './scenario';
import { runSimulation } from './engine';
import type { StrategyId } from './types';

function main(): void {
  const scenarioId = process.argv[2] ?? 'ST-03';
  const strategy = (process.argv[3] ?? 'STATIC_SHORTEST_PATH') as StrategyId;
  const regionId = process.argv[4] ?? 'R_S01_L1_CREST';
  const seed = Number(process.argv[5] ?? 1);
  const set = loadScenarioSet();
  const scenario = set.scenarios.find(item => item.scenario_id === scenarioId);
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`);
  const { record, trace } = runSimulation(scenario, strategy, seed, { collectTrace: true });
  console.log(`completed=${record.completed_persons} unserved=${record.unserved_persons}`);
  for (const decision of trace?.decisions ?? []) {
    if (decision.region_id !== regionId) continue;
    if (decision.minute % 2 !== 0) continue;
    console.log(
      `t=${decision.minute.toFixed(2)} mode=${decision.mode} exit=${decision.requested_exit ?? '-'} next=${decision.requested_next_hop ?? '-'} state=${decision.safety_state} reasons=${decision.reasons.join('|')}`,
    );
  }
  const ledger = trace?.ledger ?? [];
  for (const tick of ledger.filter(item => item.minute % 10 === 0)) {
    console.log(`ledger t=${tick.minute} present=${tick.present} transit=${tick.in_transit} exitQ=${tick.exit_queue} completed=${tick.completed_cumulative}`);
  }
}

main();
