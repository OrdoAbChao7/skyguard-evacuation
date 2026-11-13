import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateClockOffsets, fuseSensorReadings, type SensorReading } from '../../src/services/safety/fusion/fusion';

const now = Date.parse('2026-11-10T01:00:00Z');
const base = (overrides: Partial<SensorReading> = {}): SensorReading => ({
  sensorId: 'cam-1',
  regionId: 'R1',
  value: 300,
  observedAt: now - 1_000,
  receivedAt: now,
  confidence: 0.9,
  reliability: 0.9,
  kind: 'camera',
  ...overrides,
});

test('可靠性加权融合：高可靠传感器权重更大', () => {
  const result = fuseSensorReadings([
    base({ sensorId: 'a', value: 300, reliability: 0.9 }),
    base({ sensorId: 'b', value: 320, reliability: 0.3 }),
    base({ sensorId: 'c', value: 310, reliability: 0.6 }),
  ], now);
  assert.equal(result.status, 'fused');
  assert.ok(result.value !== null && result.value < 310);
  assert.equal(result.usable, true);
  assert.equal(result.participants.length, 3);
});

test('时钟偏移超限 fail-closed', () => {
  const result = fuseSensorReadings([
    base({ sensorId: 'a', observedAt: now - 1_000 }),
    base({ sensorId: 'b', observedAt: now - 9_000 }),
  ], now);
  assert.equal(result.status, 'stale');
  assert.equal(result.value, null);
  assert.equal(result.usable, false);
  assert.ok(result.rejected.some(item => item.reason === 'clock_skew_exceeds_limit'));
});

test('过期、未来、重复与低可靠度被拒绝', () => {
  const result = fuseSensorReadings([
    base({ sensorId: 'a', observedAt: now - 60_000 }),
    base({ sensorId: 'b', observedAt: now + 5_000 }),
    base({ sensorId: 'c' }),
    base({ sensorId: 'c' }),
    base({ sensorId: 'd', reliability: 0.05 }),
    base({ sensorId: 'e', value: 305 }),
  ], now, { maxSkewMs: 60_000 });
  assert.equal(result.status, 'fused');
  assert.ok(result.rejected.some(item => item.reason === 'stale'));
  assert.ok(result.rejected.some(item => item.reason === 'future_timestamp'));
  assert.ok(result.rejected.some(item => item.reason === 'duplicate'));
  assert.ok(result.rejected.some(item => item.reason === 'low_reliability'));
  assert.deepEqual(result.participants.sort(), ['c', 'e']);
});

test('无法消解的传感器冲突 fail-closed', () => {
  const result = fuseSensorReadings([
    base({ sensorId: 'a', value: 300, reliability: 0.95 }),
    base({ sensorId: 'b', value: 520, reliability: 0.95 }),
  ], now);
  assert.equal(result.status, 'conflict');
  assert.equal(result.value, null);
  assert.equal(result.usable, false);
  assert.equal(result.conflicts.length, 1);
});

test('少于最小传感器数时不可用', () => {
  const result = fuseSensorReadings([base()], now);
  assert.equal(result.status, 'insufficient');
  assert.equal(result.usable, false);
});

test('时钟偏移估计使用中位数', () => {
  const batches = [
    [{ sensorId: 'ref', observedAt: 1000 }, { sensorId: 'b', observedAt: 1300 }],
    [{ sensorId: 'ref', observedAt: 2000 }, { sensorId: 'b', observedAt: 2200 }],
  ];
  const offsets = estimateClockOffsets(batches, 'ref');
  assert.equal(offsets.b.samples, 2);
  assert.ok(offsets.b.offsetMs >= 200 && offsets.b.offsetMs <= 300);
});

test('显式期望区域时，不匹配的读数全部拒绝，而不是以第一条读数为准', () => {
  const result = fuseSensorReadings([
    base({ sensorId: 'a', regionId: 'R1' }),
    base({ sensorId: 'b', regionId: 'R1' }),
  ], now, { regionId: 'R2' });
  assert.equal(result.status, 'insufficient');
  assert.equal(result.value, null);
  assert.equal(result.usable, false);
  assert.ok(result.rejected.every(item => item.reason === 'region_mismatch'));
});
