import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { buildObservation } from '../../src/services/safety/observations';
import {
  capacityFactorAt,
  detectMissingIntervals,
  estimateSensorReliability,
  observationQualityReport,
  scheduleToFactor,
  synchronizeTimestamps,
  validateCapacitySchedule,
} from '../../src/services/safety/calibration/quality';

const scenarioPath = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

function observation(regionId: string, count: number, observedAt: string, provider = 'p1', confidence = 0.95) {
  const scenario = loadSafetyScenario(scenarioPath);
  const region = scenario.regions.find(item => item.id === regionId)!;
  return buildObservation({
    region, count, confidence, source: 'simulation', provider, modelVersion: 'test/1',
    observedAt: new Date(observedAt), receivedAt: new Date(observedAt),
  });
}

test('时钟同步按 provider 校正并拒绝超限偏移', () => {
  const observations = [
    observation('R_NORTH_STAND', 300, '2026-11-10T01:00:00Z', 'fast'),
    observation('R_SOUTH_STAND', 280, '2026-11-10T01:00:00Z', 'slow'),
  ];
  const result = synchronizeTimestamps(observations, [
    { provider: 'fast', offset_seconds: -5, samples: 10 },
    { provider: 'slow', offset_seconds: 120, samples: 10 },
  ], 30);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].observed_at, '2026-11-10T01:00:05.000Z');
  assert.equal(result.rejected[0].provider, 'slow');
  assert.equal(result.rejected[0].reason, 'clock_skew_exceeds_limit');
});

test('缺失区间检测按期望间隔与容差', () => {
  const observations = [
    observation('R_NORTH_STAND', 300, '2026-11-10T01:00:00Z'),
    observation('R_NORTH_STAND', 310, '2026-11-10T01:00:60Z'.replace(':60', ':59')),
    observation('R_NORTH_STAND', 320, '2026-11-10T01:03:00Z'),
  ];
  const gaps = detectMissingIntervals(observations, 60, 10);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].region_id, 'R_NORTH_STAND');
  assert.ok(gaps[0].gap_seconds > 60);
  assert.ok(gaps[0].expected_samples >= 1);
});

test('传感器可靠性是 estimated 代理分数，不是准确率', () => {
  const now = new Date('2026-11-10T01:05:00Z');
  const observations = [
    observation('R_NORTH_STAND', 300, '2026-11-10T01:04:00Z', 'good', 0.95),
    observation('R_SOUTH_STAND', 300, '2026-11-10T01:04:00Z', 'good', 0.94),
    observation('R_NORTH_STAND', 300, '2026-11-10T01:04:30Z', 'bad', 0.7),
  ];
  const reliability = estimateSensorReliability(observations, 300, now);
  assert.equal(reliability.length, 2);
  assert.equal(reliability[0].provider, 'good');
  assert.equal(reliability[0].provenance, 'estimated');
  assert.ok(reliability[0].reliability_score > reliability[1].reliability_score);
  assert.ok(reliability[0].note.includes('不是准确率'));
});

test('动态容量计划校验重叠/越界并生成因子函数', () => {
  const schedule = {
    entries: [
      { from_minute: 4, to_minute: 10, corridor_factor: 0.5, reason: '维护' },
      { from_minute: 10, to_minute: 15, exit_factor: 0.7, reason: '出口受限' },
    ],
  };
  assert.deepEqual(validateCapacitySchedule(schedule).errors, []);
  assert.equal(capacityFactorAt(schedule, 5, 'corridor'), 0.5);
  assert.equal(capacityFactorAt(schedule, 5, 'exit'), 1);
  assert.equal(capacityFactorAt(schedule, 12, 'exit'), 0.7);
  assert.equal(scheduleToFactor(schedule, 'corridor')('C_NE', 5), 0.5);
  const invalid = { entries: [
    { from_minute: 4, to_minute: 10, corridor_factor: 1.5, reason: '' },
    { from_minute: 8, to_minute: 12, exit_factor: 0.5, reason: '' },
  ] };
  const validation = validateCapacitySchedule(invalid);
  assert.ok(validation.errors.some(item => item.includes('must be in [0,1]')));
  assert.ok(validation.errors.some(item => item.includes('overlapping')));
});

test('观测质量报告覆盖缺失/过期/低置信度/重复时间戳', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const now = new Date('2026-11-10T01:05:00Z');
  const observations = [
    observation('R_NORTH_STAND', 300, '2026-11-10T01:04:50Z', 'p1', 0.95),
    observation('R_NORTH_STAND', 300, '2026-11-10T01:04:50Z', 'p2', 0.95),
    observation('R_SOUTH_STAND', 300, '2026-11-10T00:50:00Z', 'p1', 0.2),
  ];
  const report = observationQualityReport(scenario, observations, now);
  assert.ok(report.missing_regions.length > 0);
  assert.equal(report.stale, 1);
  assert.equal(report.low_confidence, 1);
  assert.equal(report.duplicate_timestamps, 0);
  assert.ok(report.coverage_ratio < 1);
});
