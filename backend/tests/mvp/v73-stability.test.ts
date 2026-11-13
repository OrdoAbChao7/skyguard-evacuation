import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../../src/services/safety/network';
import { planEvacuationMpc } from '../../src/services/safety/planning/mpc-planner';
import { solveTimeExpandedPlan } from '../../src/services/safety/planning/strategies';
import { checkPlanCapacity } from '../../src/services/safety/planning/route-stability';
import {
  adaptiveSwitchPenalty,
  detectOscillatingRegions,
  resolveAdaptiveStability,
  scorePlan,
  weightedSwitchPersons,
  DEFAULT_ADAPTIVE_STABILITY,
} from '../../src/services/safety/planning/v73-stability';
import type { EvacuationRoute } from '../../src/services/safety/types';

const scenarioPath = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

function route(regionId: string, exitId: string, persons: number, arrive = 2): EvacuationRoute {
  return {
    route_id: `RT-${regionId}-${exitId}`,
    from_region_id: regionId,
    exit_id: exitId,
    persons,
    depart_minute: 0,
    arrive_minute: arrive,
    steps: [],
  };
}

test('自适应配置夹紧；异常输入不会打开功能或产生负惩罚', () => {
  const config = resolveAdaptiveStability({
    enabled: true,
    basePenaltyPerPerson: -5,
    queueThreshold: 0,
    riskDiscount: 9,
    oscillationPenaltyPerPerson: Number.NaN,
    weights: { arrival: Number.POSITIVE_INFINITY },
  });
  assert.equal(config.enabled, true);
  assert.equal(config.basePenaltyPerPerson, 0);
  assert.equal(config.queueThreshold, 1);
  assert.equal(config.riskDiscount, 1);
  assert.equal(config.oscillationPenaltyPerPerson, DEFAULT_ADAPTIVE_STABILITY.oscillationPenaltyPerPerson);
  assert.equal(config.weights.arrival, DEFAULT_ADAPTIVE_STABILITY.weights.arrival);
  assert.equal(resolveAdaptiveStability({ enabled: false }).enabled, false);
});

test('自适应惩罚随队列压力上升、随风险上升而下降', () => {
  const config = { ...DEFAULT_ADAPTIVE_STABILITY, enabled: true, basePenaltyPerPerson: 10, queueThreshold: 100, riskDiscount: 0.5 };
  const lowQueue = adaptiveSwitchPenalty(config, { queueTotal: 0, worstRiskRatio: 0 });
  const highQueue = adaptiveSwitchPenalty(config, { queueTotal: 300, worstRiskRatio: 0 });
  const highRisk = adaptiveSwitchPenalty(config, { queueTotal: 300, worstRiskRatio: 1 });
  assert.ok(highQueue > lowQueue);
  assert.ok(highRisk < highQueue);
  assert.ok(highRisk >= 0);
});

test('A→B→A 振荡检测', () => {
  const history = new Map([['R_NORTH_STAND', ['E_NORTH', 'E_EAST']]]);
  const candidate = [route('R_NORTH_STAND', 'E_NORTH', 200)];
  const detected = detectOscillatingRegions(history, candidate);
  assert.deepEqual(detected.regions, ['R_NORTH_STAND']);
  assert.equal(detected.persons, 200);
  const nonOscillating = detectOscillatingRegions(history, [route('R_NORTH_STAND', 'E_SOUTH', 200)]);
  assert.deepEqual(nonOscillating.regions, []);
});

test('风险加权切换人数不低于普通切换人数，且计划评分有限', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const occupancy = new Map([['R_NORTH_STAND', 600], ['R_EAST_STAND', 500]]);
  const previous = new Map([['R_NORTH_STAND', 'E_NORTH'], ['R_EAST_STAND', 'E_EAST']]);
  const routes = [route('R_NORTH_STAND', 'E_SOUTH', 400), route('R_EAST_STAND', 'E_WEST', 300)];
  const raw = weightedSwitchPersons({ candidateRoutes: routes, previousExits: previous, scenario, occupancy, riskWeight: 0 });
  const weighted = weightedSwitchPersons({ candidateRoutes: routes, previousExits: previous, scenario, occupancy, riskWeight: 1 });
  assert.equal(raw, 700);
  assert.ok(weighted >= raw);
  const score = scorePlan({
    plan_id: 'P', created_at: new Date().toISOString(),
    scenario_version: scenario.version, constraint_version: 0, observation_version: 0,
    horizon_minutes: scenario.config.horizon_minutes, status: 'feasible', routes,
    unresolved: [], exit_totals: [], corridor_totals: [], demand_by_region: [],
    total_persons: 700, evacuated_persons: 700, unresolved_persons: 0,
    planner: { algorithm: 'test', model: 'test', notes: [] },
  }, { previousExits: previous, config: DEFAULT_ADAPTIVE_STABILITY });
  assert.ok(Number.isFinite(score.score));
  assert.equal(score.switchPersons, 700);
});

test('动态容量因子进入求解器与容量复核口径', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const demand = new Map(scenario.regions.map(region => [region.id, region.enabled ? 260 : 0]));
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const corridorFactor = (id: string, minute: number) => (minute >= 3 && (id === 'C_NE' || id === 'C_NW') ? 0.5 : 1);
  const exitFactor = (id: string, minute: number) => (minute >= 4 && id === 'E_NORTH' ? 0.7 : 1);
  const solved = solveTimeExpandedPlan({
    scenario, network, demandByRegion: demand, horizonMinutes: 10, versions, now: new Date(),
    corridorCapacityFactor: corridorFactor, exitCapacityFactor: exitFactor,
  });
  const violations = checkPlanCapacity(scenario, solved.plan.routes, 0, {
    corridorCapacityFactor: corridorFactor, exitCapacityFactor: exitFactor,
  });
  assert.deepEqual(violations, []);
});

test('V7.3 自适应策略在振荡压力下不增加未疏散与容量冲突（固定种子）', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const demand = new Map(scenario.regions.map(region => [region.id, region.enabled ? 700 : 0]));
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const actualArrivals = new Map<string, Array<{ offsetMinute: number; persons: number }>>();
  const regions = scenario.regions.filter(region => region.enabled);
  for (let index = 0; index < 6; index += 1) {
    const regionId = regions[index % regions.length].id;
    const list = actualArrivals.get(regionId) ?? [];
    list.push({ offsetMinute: 1 + index * 2, persons: 220 });
    actualArrivals.set(regionId, list);
  }
  const base = {
    scenario, network, initialDemandByRegion: demand, versions,
    controlIntervalMinutes: 2, planningHorizonMinutes: 10, maxExecutionMinutes: 24, maxSteps: 24,
    useForecast: true, queueFeedback: true, actualArrivals, solver: 'v7' as const,
  };
  const standard = planEvacuationMpc({ ...base, stability: { mode: 'none' } });
  const adaptive = planEvacuationMpc({
    ...base,
    stability: { mode: 'adaptive', commitMinutes: 4, adaptiveQueueThreshold: 100, hysteresisGap: 0.02 },
    adaptiveStability: { enabled: true, basePenaltyPerPerson: 10, oscillationPenaltyPerPerson: 20, riskWeightedSwitching: true },
  });
  assert.ok(adaptive.unserved_persons <= standard.unserved_persons);
  assert.equal(adaptive.capacity_violations, 0);
  assert.ok(adaptive.switch_persons <= standard.switch_persons,
    `adaptive=${adaptive.switch_persons}, standard=${standard.switch_persons}`);
});
