import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../../src/services/safety/network';
import { planEvacuation } from '../../src/services/safety/planning/evacuation-planner';
import { simulatePlanExecution, simulateRoutesExecution } from '../../src/services/safety/planning/congestion';
import { planEvacuationMpc } from '../../src/services/safety/planning/mpc-planner';
import { planMaxFlow, planRestrictedMilp, planShortestPath } from '../../src/services/safety/planning/strategies';
import { validateSafetyPlan } from '../../src/services/safety/validator';
import { buildObservation } from '../../src/services/safety/observations';
import type { DensityObservation } from '../../src/services/safety/types';

const scenarioPath = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

function setup() {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const demand = new Map<string, number>();
  for (const region of scenario.regions) demand.set(region.id, region.enabled ? 250 : 0);
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  return { scenario, network, demand, versions };
}

function observationsFor(scenario: ReturnType<typeof setup>['scenario'], demand: Map<string, number>, now: Date): Map<string, DensityObservation> {
  const map = new Map<string, DensityObservation>();
  for (const region of scenario.regions) {
    const count = demand.get(region.id) ?? 0;
    if (count <= 0) continue;
    map.set(region.id, buildObservation({
      region,
      count,
      confidence: 0.95,
      source: 'simulation',
      provider: 'test',
      modelVersion: 'test/1.0.0',
      observedAt: now,
      receivedAt: now,
    }));
  }
  return map;
}

test('执行模拟：基准方案可完成疏散且指标自洽', () => {
  const { scenario, network, demand, versions } = setup();
  const plan = planEvacuation({ scenario, network, demandByRegion: demand, ...versions }).plan;
  const metrics = simulatePlanExecution(scenario, plan);
  assert.equal(metrics.completed_persons + metrics.unserved_persons, metrics.total_persons);
  assert.equal(metrics.unserved_persons, 0);
  assert.ok(metrics.makespan_minute >= 0 && metrics.makespan_minute <= scenario.config.horizon_minutes * 2 + 30);
  assert.ok(metrics.total_queue_person_minutes >= 0);
  assert.equal(metrics.queue_series.length, metrics.makespan_minute + 1);
});

test('拥堵放大：更强的 BPR 系数不会缩短完成时间', () => {
  const { scenario, network, demand, versions } = setup();
  const plan = planEvacuation({ scenario, network, demandByRegion: demand, ...versions }).plan;
  const light = simulatePlanExecution(scenario, plan, { bprA: 0.0, exitServiceDegradation: false });
  const heavy = simulatePlanExecution(scenario, plan, { bprA: 1.5, exitServiceDegradation: false });
  assert.ok(heavy.makespan_minute >= light.makespan_minute);
  assert.ok(heavy.total_queue_person_minutes >= light.total_queue_person_minutes);
});

test('容量盲最短路径基线在执行模型中产生更多排队', () => {
  const { scenario, network, demand, versions } = setup();
  const baseline = planEvacuation({ scenario, network, demandByRegion: demand, ...versions }).plan;
  const shortest = planShortestPath({ scenario, network, demandByRegion: demand, versions }).plan;
  const baselineMetrics = simulatePlanExecution(scenario, baseline);
  const shortestMetrics = simulatePlanExecution(scenario, shortest);
  assert.ok(shortestMetrics.total_queue_person_minutes >= baselineMetrics.total_queue_person_minutes);
});

test('最大流与受限 MILP 都能得到完整的可行分配', () => {
  const { scenario, network, demand, versions } = setup();
  const maxFlow = planMaxFlow({ scenario, network, demandByRegion: demand, versions });
  assert.equal(maxFlow.plan.unresolved_persons, 0);
  const milp = planRestrictedMilp({ scenario, network, demandByRegion: demand, versions });
  assert.equal(milp.plan.unresolved_persons, 0);
  assert.ok(milp.enumerated > 0 && milp.enumerated <= 64);
  assert.ok(milp.enumeration_note.length > 0);
});

test('MPC 无预测时第一步方案通过独立校验器', () => {
  const { scenario, network, demand, versions } = setup();
  const now = new Date();
  const mpc = planEvacuationMpc({
    scenario,
    network,
    initialDemandByRegion: demand,
    versions,
    useForecast: false,
    queueFeedback: false,
    now,
  });
  assert.ok(mpc.steps.length >= 1);
  const first = mpc.steps[0];
  const validation = validateSafetyPlan({
    plan: first.plan,
    scenario,
    network,
    latestObservations: observationsFor(scenario, demand, now),
    config: scenario.config,
    constraintVersion: versions.constraintVersion,
    observationVersion: versions.observationVersion,
    now,
  });
  assert.equal(validation.valid, true, JSON.stringify(validation.violations));
});

test('MPC 预测到达计入总输入并保守执行', () => {
  const { scenario, network, demand, versions } = setup();
  const predictedArrivals = new Map<string, Array<{ offsetMinute: number; persons: number }>>();
  predictedArrivals.set('R_NORTH_STAND', [{ offsetMinute: 2, persons: 100 }]);
  const mpc = planEvacuationMpc({
    scenario,
    network,
    initialDemandByRegion: demand,
    versions,
    predictedArrivals,
    controlIntervalMinutes: 2,
    useForecast: true,
  });
  const baseTotal = [...demand.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(mpc.total_input_persons, baseTotal + 100);
  assert.equal(mpc.completed_persons + mpc.unserved_persons, mpc.total_input_persons);
});

test('MPC 队列反馈降低出口拥塞下的未疏散人数或排队', () => {
  const { scenario, network, demand, versions } = setup();
  const base = planEvacuationMpc({ scenario, network, initialDemandByRegion: demand, versions, queueFeedback: false, useForecast: false });
  const feedback = planEvacuationMpc({ scenario, network, initialDemandByRegion: demand, versions, queueFeedback: true, useForecast: false });
  assert.equal(feedback.unserved_persons, 0);
  assert.ok(feedback.total_queue_person_minutes >= 0);
  assert.ok(base.completed_persons + base.unserved_persons === base.total_input_persons);
});

test('执行模拟保留步末残差且不重复计数', () => {
  const { scenario, network, demand, versions } = setup();
  const plan = planEvacuation({ scenario, network, demandByRegion: demand, ...versions }).plan;
  const residual = simulateRoutesExecution(scenario, plan.routes, { stopAtMinute: 1 });
  const residualTotal = Object.values(residual.residual_persons_by_region).reduce((sum, value) => sum + value, 0);
  assert.equal(residual.completed_persons + residualTotal, residual.total_persons);
});

test('受限 MILP 在非均匀需求下不会因零费用残量环死循环', () => {
  const { scenario, network, versions } = setup();
  // 该需求组合曾触发 SPFA 路径回溯死循环；Dijkstra 求解器必须快速返回。
  const demand = new Map<string, number>([
    ['R_NORTH_STAND', 239], ['R_SOUTH_STAND', 228], ['R_WEST_STAND', 318], ['R_EAST_STAND', 306],
    ['R_NORTH_CONCOURSE', 243], ['R_SOUTH_CONCOURSE', 228], ['R_EAST_PLAZA', 251], ['R_WEST_PLAZA', 296],
  ]);
  const started = Date.now();
  const milp = planRestrictedMilp({ scenario, network, demandByRegion: demand, versions });
  assert.ok(Date.now() - started < 5000, `受限 MILP 用时过长：${Date.now() - started}ms`);
  assert.ok(milp.enumerated > 0);
  assert.equal(milp.plan.unresolved_persons, 0);
});

test('MPC 在高需求下把在场人员全部疏散且不丢失区域身份', () => {
  const { scenario, network, versions } = setup();
  const demand = new Map<string, number>();
  for (const region of scenario.regions) demand.set(region.id, region.enabled ? 700 : 0);
  const mpc = planEvacuationMpc({
    scenario,
    network,
    initialDemandByRegion: demand,
    versions,
    useForecast: false,
    queueFeedback: true,
    controlIntervalMinutes: 2,
    planningHorizonMinutes: 10,
    maxExecutionMinutes: 24,
    maxSteps: 20,
  });
  assert.equal(mpc.unserved_persons, 0, JSON.stringify(mpc.final_occupancy));
  assert.equal(mpc.completed_persons, mpc.total_input_persons);
  assert.equal(Object.keys(mpc.final_occupancy).length, 0);
});
