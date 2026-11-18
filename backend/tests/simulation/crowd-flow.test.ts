/**
 * 算法人群仿真测试。
 *
 * 重点：
 *  - 同一 seed 完全可复现；
 *  - 人数守恒（初始 + 到达 = 场内 + 在途 + 已疏散）；
 *  - 通道/出口容量不被突破，未知容量通道不被使用；
 *  - 闸口关闭会改变路径并降低疏散量，全部出口关闭会明确留下未疏散人数；
 *  - 所有回放行标记为 simulation，且时间有序、区域合法。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { simulateCrowdFlow } from '../../src/services/simulation/crowd-flow';
import { DEFAULT_SCENARIO_PATH } from '../mvp/fixtures';

const scenario = loadSafetyScenario(DEFAULT_SCENARIO_PATH);
const START = new Date('2026-11-18T10:00:00.000Z');

test('同一 seed 与起始时间输出完全可复现', () => {
  const a = simulateCrowdFlow(scenario, { minutes: 6, seed: 7, start_at: START });
  const b = simulateCrowdFlow(scenario, { minutes: 6, seed: 7, start_at: START });
  assert.deepEqual(a, b);
  assert.equal(a.summary.conservation_ok, true);
});

test('不同 seed 只改变置信度噪声，不改变人数轨迹', () => {
  const a = simulateCrowdFlow(scenario, { minutes: 4, seed: 1, start_at: START });
  const b = simulateCrowdFlow(scenario, { minutes: 4, seed: 2, start_at: START });
  assert.deepEqual(
    a.samples.map(sample => sample.regions.map(region => region.count)),
    b.samples.map(sample => sample.regions.map(region => region.count)),
  );
  assert.notDeepEqual(
    a.samples.map(sample => sample.regions.map(region => region.confidence)),
    b.samples.map(sample => sample.regions.map(region => region.confidence)),
  );
});

test('每个样本都满足人数守恒', () => {
  const result = simulateCrowdFlow(scenario, { minutes: 10, seed: 11, start_at: START });
  for (const sample of result.samples) {
    assert.equal(
      result.summary.initial_total + sample.totals.arrivals,
      sample.totals.inside + sample.totals.in_transit + sample.totals.evacuated,
      `第 ${sample.minute} 分钟不守恒`,
    );
  }
  assert.equal(result.summary.conservation_ok, true);
  assert.equal(
    result.summary.initial_total,
    Object.values(scenario.simulation_baseline ?? {}).reduce((sum, item) => sum + item.count, 0),
  );
});

test('通道与出口容量不被突破，未知容量通道不被使用', () => {
  const result = simulateCrowdFlow(scenario, { minutes: 8, seed: 3, start_at: START });
  const corridorById = new Map(scenario.corridors.map(corridor => [corridor.id, corridor]));
  for (const sample of result.samples) {
    for (const exit of sample.exits) {
      assert.ok(
        exit.discharged <= exit.capacity_per_min,
        `出口 ${exit.exit_id} 超容量：${exit.discharged}/${exit.capacity_per_min}`,
      );
    }
    for (const corridor of sample.corridors) {
      const definition = corridorById.get(corridor.corridor_id);
      assert.ok(definition, `未知通道 ${corridor.corridor_id}`);
      assert.ok(
        definition.capacity_per_min !== null
        && definition.capacity_per_min !== undefined
        && corridor.moved <= definition.capacity_per_min,
        `通道 ${corridor.corridor_id} 超容量`,
      );
    }
    assert.ok(!sample.corridors.some(item => item.corridor_id === 'C_FLOOD_ESCAPE_UNKNOWN'));
  }
});

test('闸口关闭会记录事件、停止对应出口放行并降低疏散量', () => {
  const normal = simulateCrowdFlow(scenario, { minutes: 10, seed: 42, start_at: START });
  const closure = simulateCrowdFlow(scenario, {
    minutes: 10,
    seed: 42,
    preset: 'gate_closure',
    start_at: START,
  });
  assert.ok(closure.summary.events.some(event => event.includes('GATE_03_G03')));
  assert.ok(closure.summary.events.some(event => event.includes('GATE_04_G04')));
  assert.ok(closure.summary.evacuated < normal.summary.evacuated);

  for (const sample of closure.samples.filter(item => item.minute >= 3)) {
    for (const exitId of ['GATE_03_G03', 'GATE_04_G04']) {
      const exit = sample.exits.find(item => item.exit_id === exitId);
      assert.ok(exit, `缺少出口 ${exitId}`);
      assert.equal(exit.discharged, 0, `关闭后 ${exitId} 仍在放行`);
    }
  }
});

test('全部出口关闭后不再疏散，并明确留下未解决区域', () => {
  const result = simulateCrowdFlow(scenario, {
    minutes: 6,
    seed: 5,
    start_at: START,
    events: scenario.exits.map(exit => ({
      minute: 1,
      kind: 'exit_close' as const,
      exit_id: exit.id,
      reason: '测试：全部关闭',
    })),
  });
  const afterClosure = result.samples.filter(sample => sample.minute >= 2);
  for (const sample of afterClosure) {
    assert.equal(sample.totals.evacuated, 0);
  }
  assert.ok(result.summary.stranded > 0);
  assert.ok(result.summary.unresolved_regions.length > 0);
  assert.equal(result.summary.conservation_ok, true);
});

test('人群激增预设增加到达人数，并在目标区域形成峰值', () => {
  const normal = simulateCrowdFlow(scenario, { minutes: 6, seed: 9, start_at: START });
  const surge = simulateCrowdFlow(scenario, {
    minutes: 6,
    seed: 9,
    preset: 'surge',
    start_at: START,
  });
  assert.equal(surge.summary.arrivals_total, 3300);
  assert.ok(surge.summary.events.some(event => event.includes('R_GATE_04_PLAZA')));
  const normalSample = normal.samples[2].regions.find(region => region.region_id === 'R_GATE_04_PLAZA');
  const surgeSample = surge.samples[2].regions.find(region => region.region_id === 'R_GATE_04_PLAZA');
  assert.ok(normalSample && surgeSample);
  assert.ok(surgeSample.count > normalSample.count + 2000);
  assert.ok(surgeSample.confidence <= 0.35);
  assert.equal(surge.summary.conservation_ok, true);
});

test('回放行覆盖全部区域、时间有序且标记为 simulation', () => {
  const result = simulateCrowdFlow(scenario, { minutes: 3, seed: 2, start_at: START });
  const enabled = scenario.regions.filter(region => region.enabled);
  assert.equal(result.replay_rows.length, enabled.length * result.samples.length);
  assert.ok(result.replay_rows.every(row => row.source === 'simulation'));
  assert.ok(result.replay_rows.every(row => row.confidence >= 0 && row.confidence <= 1));
  assert.ok(result.replay_rows.every(row => Number.isInteger(row.count) && row.count >= 0));
  assert.ok(result.replay_rows.every(row => scenario.regions.some(region => region.id === row.region_id)));
  const timestamps = result.replay_rows.map(row => row.timestamp);
  assert.deepEqual(timestamps, [...timestamps].sort());
  assert.equal(
    result.samples[result.samples.length - 1].at,
    new Date(START.getTime() + result.samples.length * 60_000).toISOString(),
  );
});
