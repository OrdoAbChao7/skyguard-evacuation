/**
 * Development diagnostics for the V7.5.2 simulation.
 *
 * Prints the t=0 route table and detects cycles in the concatenation of
 * per-region routes.  This is a diagnostic aid, not part of the benchmark.
 */
import { loadScenarioSet } from './scenario';
import { computeAllRoutes } from './network';
import type { ObservedSnapshot, SimScenario } from './types';

function nominalSnapshot(scenario: SimScenario): ObservedSnapshot {
  const regions = new Map();
  for (const region of scenario.regions) {
    regions.set(region.id, {
      region_id: region.id,
      count: scenario.initialPopulations.get(region.id) ?? 0,
      confidence: 0.95,
      age_seconds: 15,
      valid: true,
      source: 'simulation' as const,
      provider: 'diagnostic',
      conflict: false,
      untrusted_reasons: [],
    });
  }
  return {
    at_minute: 0,
    regions,
    corridor_status: new Map(scenario.corridors.map(corridor => [corridor.id, corridor.status])),
    exit_status: new Map(scenario.exits.map(exit => [exit.id, exit.status])),
  };
}

function main(): void {
  const set = loadScenarioSet();
  for (const scenario of set.scenarios) {
    const routes = computeAllRoutes(scenario, nominalSnapshot(scenario));
    const cycleRegions: string[] = [];
    for (const region of scenario.regions) {
      const seen = new Set<string>();
      let cursor: string | null = region.id;
      let steps = 0;
      while (cursor && steps <= scenario.regions.length + 1) {
        if (seen.has(cursor)) {
          cycleRegions.push(region.id);
          break;
        }
        seen.add(cursor);
        const route = routes.routes.get(cursor);
        cursor = route?.next_hop_region_id ?? null;
        steps += 1;
      }
    }
    console.log(`${scenario.scenario_id}: cycle-starts=${cycleRegions.length}${cycleRegions.length ? ` [${cycleRegions.slice(0, 10).join(', ')}]` : ''}`);
    for (const regionId of ['R_S01_L1_CREST', 'R_S06_L1_CREST']) {
      const route = routes.routes.get(regionId);
      console.log(`  ${regionId}: exit=${route?.exit_id ?? 'null'} next=${route?.next_hop_region_id ?? 'null'} path=${route?.path_regions.join('>') ?? '-'}`);
      if (route?.next_hop_region_id) {
        const next = routes.routes.get(route.next_hop_region_id);
        console.log(`    next route: exit=${next?.exit_id ?? 'null'} next=${next?.next_hop_region_id ?? 'null'} path=${next?.path_regions.join('>') ?? '-'}`);
      }
    }
  }
}

main();
