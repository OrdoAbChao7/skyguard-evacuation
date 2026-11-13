/**
 * 疏散规划器与最小费用最大流的单元测试。
 *
 * 使用手工构造的小型场景，逐条验证容量约束、方向约束、守恒与不可行判定，
 * 避免只依赖默认场景的端到端结果。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SafetyScenarioSchema, type SafetyScenario } from '../../src/services/safety/types';
import { resolveEffectiveNetwork, traversalMinutes } from '../../src/services/safety/network';
import { planEvacuation } from '../../src/services/safety/planning/evacuation-planner';
import { MinCostFlowNetwork } from '../../src/services/safety/planning/min-cost-flow';

const T0 = '2026-10-01T00:00:00.000Z';

function region(id: string, capacity = 500) {
  return {
    id,
    name: id,
    area_m2: 100,
    area_provenance: 'estimated' as const,
    geometry: { x: 0, y: 0, width: 10, height: 10 },
    geometry_provenance: 'estimated' as const,
    holding_capacity_persons: capacity,
    enabled: true,
    camera: {
      camera_id: `CAM-${id}`,
      calibration_status: 'uncalibrated' as const,
      calibration_version: 'v0',
    },
    source: 'unit-test',
    verified: false,
  };
}

function corridor(
  id: string,
  from: string,
  to: string,
  capacity: number | null,
  seconds = 60,
  status: 'open' | 'closed' | 'unknown' = 'open',
  direction: 'forward' | 'reverse' | 'both' = 'forward',
) {
  return {
    id,
    name: id,
    from_region_id: from,
    to_region_id: to,
    status,
    direction,
    capacity_per_min: capacity,
    capacity_provenance: (capacity === null ? 'unknown' : 'estimated') as 'unknown' | 'estimated',
    traversal_seconds: seconds,
    status_source: 'unit-test',
    verified: false,
    updated_at: T0,
  };
}

function exit(id: string, regionId: string, capacity: number | null, status: 'open' | 'closed' = 'open') {
  return {
    id,
    name: id,
    region_id: regionId,
    status,
    capacity_per_min: capacity,
    capacity_provenance: 'estimated' as const,
    status_source: 'unit-test',
    verified: false,
    updated_at: T0,
  };
}

function buildScenario(overrides: Partial<SafetyScenario> = {}): SafetyScenario {
  const base = {
    scenario_id: 'unit',
    name: 'unit',
    version: '0.0.1',
    description: 'unit test scenario',
    notice: 'unit test',
    config: {
      horizon_minutes: 4,
      max_observation_age_seconds: 90,
      min_confidence: 0.6,
      trend_window_seconds: 300,
      density_consistency_tolerance: 0.25,
      default_thresholds: {
        watch_density: 1,
        high_density: 2,
        critical_density: 3,
        rise_rate_watch: 0.5,
        source: 'unit-test',
      },
    },
    regions: [region('A'), region('B'), region('C')],
    corridors: [
      corridor('AB', 'A', 'B', 5),
      corridor('BC', 'B', 'C', 5),
    ],
    exits: [exit('E1', 'C', 10)],
    demo_scenarios: [],
  };
  return SafetyScenarioSchema.parse({ ...base, ...overrides });
}

test('min-cost max-flow 在串联瓶颈网络上给出正确最大流', () => {
  const net = new MinCostFlowNetwork(4);
  net.addEdge(0, 1, 10, 0);
  net.addEdge(1, 2, 3, 1);
  net.addEdge(2, 3, 10, 0);
  const result = net.minCostMaxFlow(0, 3);
  assert.equal(result.flow, 3, '瓶颈边容量为 3，最大流只能是 3');
});

test('规划器严格遵守通道容量与时间窗，未解决需求被显式记录', () => {
  const scenario = buildScenario();
  const network = resolveEffectiveNetwork(scenario, []);
  const result = planEvacuation({
    scenario,
    network,
    demandByRegion: new Map([['A', 100]]),
    scenarioVersion: scenario.version,
    constraintVersion: 0,
    observationVersion: 0,
  });

  // horizon=4：AB 可在 t=0..3 出发（4 时隙），但 BC 只能在到达 B 之后（t+1）出发，
  // 且要求 t+1+1 <= 4，即 B 只能在 t=1..3 出发 → 3 时隙 × 5 人/分钟 = 15
  assert.equal(result.plan.evacuated_persons, 15);
  assert.equal(result.plan.unresolved_persons, 85);
  assert.equal(result.plan.status, 'partial');

  const perMinute = new Map<number, number>();
  for (const route of result.plan.routes) {
    for (const step of route.steps) {
      if (step.corridor_id !== 'AB') continue;
      perMinute.set(step.depart_minute, (perMinute.get(step.depart_minute) ?? 0) + route.persons);
    }
  }
  for (const [minute, persons] of perMinute) {
    assert.ok(persons <= 5, `t=${minute} 通过 AB 的 ${persons} 人超过容量 5`);
  }
  assert.equal(result.plan.unresolved[0].region_id, 'A');
});

test('关闭通道流量为零，且从规划中排除', () => {
  const scenario = buildScenario({
    corridors: [corridor('AB', 'A', 'B', 5, 60, 'closed'), corridor('BC', 'B', 'C', 5)],
  });
  const network = resolveEffectiveNetwork(scenario, []);
  const result = planEvacuation({
    scenario,
    network,
    demandByRegion: new Map([['A', 10]]),
    scenarioVersion: scenario.version,
    constraintVersion: 0,
    observationVersion: 0,
  });

  assert.equal(result.plan.evacuated_persons, 0);
  assert.equal(result.plan.status, 'infeasible');
  assert.ok(result.exclusions.some(entry => entry.id === 'AB' && entry.kind === 'corridor'));
  assert.match(result.plan.unresolved[0].reason, /无可达且可用的出口/);
});

test('容量未知的通道不被当作无限容量', () => {
  const scenario = buildScenario({
    corridors: [corridor('AB', 'A', 'B', null), corridor('BC', 'B', 'C', 5)],
  });
  const network = resolveEffectiveNetwork(scenario, []);
  const result = planEvacuation({
    scenario,
    network,
    demandByRegion: new Map([['A', 10]]),
    scenarioVersion: scenario.version,
    constraintVersion: 0,
    observationVersion: 0,
  });

  assert.equal(result.plan.evacuated_persons, 0);
  assert.ok(result.exclusions.some(entry => entry.id === 'AB'));
});

test('反向通道只允许指定方向', () => {
  const scenario = buildScenario({
    corridors: [corridor('BA', 'B', 'A', 5, 60, 'open', 'reverse')],
    exits: [exit('E1', 'A', 10)],
  });
  const network = resolveEffectiveNetwork(scenario, []);
  const result = planEvacuation({
    scenario,
    network,
    demandByRegion: new Map([['B', 10]]),
    scenarioVersion: scenario.version,
    constraintVersion: 0,
    observationVersion: 0,
  });
  // BA 的方向为 reverse（A→B），因此 B 无法经该通道前往 A 的出口
  assert.equal(result.plan.evacuated_persons, 0);
});

test('中间区域满足流量守恒且可缓冲等待', () => {
  const scenario = buildScenario({
    regions: [region('A'), region('B', 2), region('C')],
    corridors: [corridor('AB', 'A', 'B', 6), corridor('BC', 'B', 'C', 3)],
    exits: [exit('E1', 'C', 10)],
  });
  const network = resolveEffectiveNetwork(scenario, []);
  const result = planEvacuation({
    scenario,
    network,
    demandByRegion: new Map([['A', 20]]),
    scenarioVersion: scenario.version,
    constraintVersion: 0,
    observationVersion: 0,
  });

  // BC 瓶颈 3 人/分钟，B 只能在 t=1..3 出发 → 3 时隙 × 3 = 9
  assert.equal(result.plan.evacuated_persons, 9);
  // 途中必须在 B 等待（B 的在留容量为 2，但需求 20 已超过，模型按 max(容量,需求) 放宽避免丢人）
  const waits = result.plan.routes.filter(route => route.steps.length > 1);
  assert.ok(waits.length > 0, '应存在经由 B 中转的路线');
  for (const route of waits) {
    assert.ok(route.steps[0].arrive_minute <= route.steps[1].depart_minute);
  }
});

test('traversalMinutes 向上取整到分钟', () => {
  assert.equal(traversalMinutes({ traversal_seconds: 30 } as never), 1);
  assert.equal(traversalMinutes({ traversal_seconds: 60 } as never), 1);
  assert.equal(traversalMinutes({ traversal_seconds: 61 } as never), 2);
  assert.equal(traversalMinutes({ traversal_seconds: 90 } as never), 2);
});

test('全部需求可在时限内完成时状态为 feasible 且无未解决需求', () => {
  const scenario = buildScenario();
  const network = resolveEffectiveNetwork(scenario, []);
  const result = planEvacuation({
    scenario,
    network,
    demandByRegion: new Map([['A', 8]]),
    scenarioVersion: scenario.version,
    constraintVersion: 0,
    observationVersion: 0,
  });
  assert.equal(result.plan.status, 'feasible');
  assert.equal(result.plan.unresolved_persons, 0);
  assert.equal(result.plan.evacuated_persons, 8);
});
