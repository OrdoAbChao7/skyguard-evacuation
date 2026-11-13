import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdaptiveCusumDetector,
  CusumDetector,
  ReliabilityDualDetector,
  SprtDetector,
  ThreeSigmaDetector,
  fuseDetectorSensors,
} from '../../src/services/safety/detection/surge';

function stableSeries(points = 30): number[] {
  return Array.from({ length: points }, (_, index) => 300 + Math.sin(index) * 2);
}

test('3σ 与 CUSUM 在稳定序列上不报警，在突增后确认', () => {
  for (const detector of [new ThreeSigmaDetector(), new CusumDetector()]) {
    for (const value of stableSeries()) detector.update({ value });
    const stableAlarm = detector.update({ value: 302 });
    assert.equal(stableAlarm.alarm, false);
    let detected = false;
    for (let step = 0; step < 8; step += 1) {
      if (detector.update({ value: 340 + step * 4 }).alarm) detected = true;
    }
    assert.equal(detected, true, `${detector.name} should detect a step surge`);
  }
});

test('双阈值检测器需要持续确认，单点尖峰不报警', () => {
  const detector = new ReliabilityDualDetector({ persist: 2 });
  for (const value of stableSeries()) detector.update({ value });
  const spike = detector.update({ value: 360 });
  assert.equal(spike.alarm, false);
  assert.equal(spike.warning, true);
  const recovered = detector.update({ value: 301 });
  assert.equal(recovered.alarm, false);
});

test('双阈值检测器在传感器冲突时抑制单传感器报警', () => {
  const detector = new ReliabilityDualDetector({ persist: 2, conflictZ: 3 });
  for (const value of stableSeries()) detector.update({ value });
  let alarm = false;
  for (let step = 0; step < 6; step += 1) {
    const decision = detector.update({
      value: 300,
      sensors: [
        { sensorId: 'a', value: 300, reliability: 0.95 },
        { sensorId: 'b', value: 420 + step, reliability: 0.9 },
        { sensorId: 'c', value: 302, reliability: 0.8 },
      ],
    });
    alarm = alarm || decision.alarm;
  }
  assert.equal(alarm, false);
});

test('双阈值检测器在多数传感器确认时报警', () => {
  const detector = new ReliabilityDualDetector({ persist: 2 });
  for (const value of stableSeries()) detector.update({ value });
  let alarm = false;
  for (let step = 0; step < 5; step += 1) {
    const decision = detector.update({
      value: 340 + step,
      sensors: [
        { sensorId: 'a', value: 340 + step, reliability: 0.95 },
        { sensorId: 'b', value: 338 + step, reliability: 0.9 },
        { sensorId: 'c', value: 304, reliability: 0.6 },
      ],
    });
    alarm = alarm || decision.alarm;
  }
  assert.equal(alarm, true);
});

test('SPRT 与自适应 CUSUM 可检测持续变化，且重置后恢复稳定', () => {
  for (const detector of [new SprtDetector(), new AdaptiveCusumDetector()]) {
    for (const value of stableSeries()) detector.update({ value });
    let detected = false;
    for (let step = 0; step < 12; step += 1) {
      if (detector.update({ value: 350 + step * 2 }).alarm) detected = true;
    }
    assert.equal(detected, true, `${detector.name} should detect`);
    detector.reset();
    for (const value of stableSeries()) detector.update({ value });
    assert.equal(detector.update({ value: 302 }).alarm, false);
  }
});

test('融合函数在冲突时返回中位数并标记 conflict', () => {
  const result = fuseDetectorSensors([
    { sensorId: 'a', value: 300, reliability: 0.9 },
    { sensorId: 'b', value: 500, reliability: 0.9 },
  ]);
  assert.equal(result.conflict, true);
  assert.equal(result.value, 400);
  const missing = fuseDetectorSensors([
    { sensorId: 'a', value: 300, reliability: 0.9 },
    { sensorId: 'b', value: 0, reliability: 0.9, missing: true },
  ]);
  assert.equal(missing.conflict, false);
  assert.equal(missing.value, 300);
});
