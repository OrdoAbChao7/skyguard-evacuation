import assert from 'node:assert/strict';
import test from 'node:test';
import { planEvacuation } from '../../src/services/safety/planning/evacuation-planner';
import {
  DEFAULT_CONGESTION_POLICY,
  effectiveCapacity,
  planWithCongestion,
  simulateCongestion,
} from '../../src/services/safety/planning/congestion';
import { resolveEffectiveNetwork } from '../../src/services/safety/network';
import { loadScenario } from './fixtures';

test('BPR 容量随利用率下降且有下限', () => {
  const policy = { ...DEFAULT_CONGESTION_POLICY, enabled: true, bpr_alpha: 0.15, bpr_beta: 4, max_capacity_reduction: 0.6 };
  const low = effectiveCapacity(100, 0.2, policy);
  const high = effectiveCapacity(100, 2, policy);
  assert.ok(low <= 100 && low > 60);
  assert.ok(high < low);
  assert.ok(high >= 40 - 1e-9);
});

test('拥堵仿真：出口容量不足时队列结转并计入未服务人数', () => {
  const scenario = loadScenario();
  const network = resolveEffectiveNetwork(scenario, []);
  const region = scenario.regions.find(item => item.id === 'R_MAIN')!;
  const exit = scenario.exits.find(item => item.region_id === region.id)!;
  exit.capacity_per_min = 1;
  const plan = planEvacuation({
    scenario,
    network,
    demandByRegion: new Map([[region.id, 50]]),
    scenarioVersion: scenario.version,
    constraintVersion: 0,
    observationVersion: 0,
  }).plan;
  const simulation = simulateCongestion({ scenario, plan });
  assert.ok(simulation.max_exit_queue > 0);
  assert.ok(simulation.abandoned_persons > 0);
  assert.ok(simulation.served_persons < simulation.scheduled_persons);
});

test('拥堵感知规划会折减容量并给出迭代与有效容量证据', () => {
  const scenario = loadScenario();
  const network = resolveEffectiveNetwork(scenario, []);
  const demand = new Map(scenario.regions.map(region => [region.id, 300]));
  const input = {
    scenario,
    network,
    demandByRegion: demand,
    scenarioVersion: scenario.version,
    constraintVersion: 0,
    observationVersion: 0,
  };
  const staticPlan = planEvacuation(input);
  const aware = planWithCongestion(input, {
    enabled: true,
    bpr_alpha: 0.15,
    bpr_beta: 4,
    max_capacity_reduction: 0.6,
    max_iterations: 3,
  });
  assert.ok(aware.congestion.iterations >= 1);
  assert.ok(aware.congestion.effective_capacity.every(item =>
    item.effective === null || item.base === null || item.effective <= item.base));
  assert.ok(aware.plan.unresolved_persons >= staticPlan.plan.unresolved_persons,
    '容量折减不得让方案更乐观');
});
