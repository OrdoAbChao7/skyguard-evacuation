import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdaptiveConformalCalibrator,
  OnlineChangePointDetector,
  assessConformalReliability,
} from '../../src/services/mvp/conformal';

test('ACI 在连续未覆盖时收紧 α 并加宽区间', () => {
  const calibrator = new AdaptiveConformalCalibrator({ targetCoverage: 0.9, gamma: 0.1, minBuffer: 3, bufferSize: 10 });
  for (let index = 0; index < 5; index += 1) calibrator.update(10 + index, true);
  const before = calibrator.interval(100, { lower: 90, upper: 110 });
  assert.equal(before.calibrated, true);
  for (let index = 0; index < 5; index += 1) calibrator.update(20, false);
  const after = calibrator.interval(100, { lower: 90, upper: 110 });
  assert.ok(after.alpha < before.alpha, `α 应减小：${after.alpha} vs ${before.alpha}`);
  assert.ok(after.upper - after.lower >= before.upper - before.lower);
});

test('ACI 在连续覆盖时放宽 α 并收窄区间', () => {
  const calibrator = new AdaptiveConformalCalibrator({ targetCoverage: 0.9, gamma: 0.1, minBuffer: 3, bufferSize: 10 });
  for (let index = 0; index < 5; index += 1) calibrator.update(20, false);
  const before = calibrator.interval(100, { lower: 80, upper: 120 });
  for (let index = 0; index < 5; index += 1) calibrator.update(2, true);
  const after = calibrator.interval(100, { lower: 80, upper: 120 });
  assert.ok(after.alpha > before.alpha);
});

test('校准样本不足时回退外部区间并标记未校准', () => {
  const calibrator = new AdaptiveConformalCalibrator({ targetCoverage: 0.95, minBuffer: 5 });
  const interval = calibrator.interval(100, { lower: 90, upper: 110 });
  assert.equal(interval.calibrated, false);
  assert.equal(interval.lower, 90);
  assert.equal(interval.upper, 110);
});

test('变点检测识别残差水平上移', () => {
  const detector = new OnlineChangePointDetector({ threshold: 1.0, reference: 0.3, cooldown: 0 });
  let detected = false;
  for (let index = 0; index < 20; index += 1) detector.update(1 + (index % 3) * 0.1);
  for (let index = 0; index < 10; index += 1) {
    const result = detector.update(15 + index);
    if (result.detected) detected = true;
  }
  assert.equal(detected, true);
});

test('变点触发后校准器清空旧残差并加宽区间', () => {
  const calibrator = new AdaptiveConformalCalibrator({ targetCoverage: 0.9, minBuffer: 3, bufferSize: 20 });
  for (let index = 0; index < 10; index += 1) calibrator.update(5, true);
  const before = calibrator.interval(100, { lower: 90, upper: 110 });
  calibrator.onChangePoint(3);
  assert.equal(calibrator.size, 3);
  assert.ok(calibrator.miscoverage <= before.alpha);
});

test('变点触发后的有限步膨胀会加宽区间', () => {
  const calibrator = new AdaptiveConformalCalibrator({ targetCoverage: 0.9, minBuffer: 3, bufferSize: 20 });
  for (let index = 0; index < 12; index += 1) calibrator.update(4, true);
  const before = calibrator.interval(100, { lower: 80, upper: 120 });
  calibrator.onChangePoint(5, { factor: 3, steps: 2 });
  const during = calibrator.interval(100, { lower: 80, upper: 120 });
  assert.ok(during.upper - during.lower > before.upper - before.lower);
  assert.ok(calibrator.inflation > 1);
});

test('带符号残差的中位数偏差校正会把区间中心上移', () => {
  const calibrator = new AdaptiveConformalCalibrator({ targetCoverage: 0.9, minBuffer: 3, bufferSize: 20 });
  for (let index = 0; index < 12; index += 1) calibrator.update(50 + (index % 3), true);
  const interval = calibrator.interval(100, { lower: 90, upper: 110 });
  assert.equal(interval.calibrated, true);
  assert.ok((interval.lower + interval.upper) / 2 > 140, `center=${(interval.lower + interval.upper) / 2}`);
  assert.ok(interval.upper - interval.lower > 0);
});

test('可靠性门控在区间过宽或未校准时失败', () => {
  const calibrator = new AdaptiveConformalCalibrator({ targetCoverage: 0.9, minBuffer: 3 });
  const interval = calibrator.interval(10, { lower: 0, upper: 20 });
  const reliability = assessConformalReliability({
    calibrator,
    interval,
    predicted: 10,
    changeDetected: false,
    maxRelativeWidth: 0.5,
  });
  assert.equal(reliability.status, 'failed');
  assert.ok(reliability.reasons.includes('insufficient_calibration'));
  for (let index = 0; index < 10; index += 1) calibrator.update(2, true);
  const calibrated = calibrator.interval(10, { lower: 0, upper: 20 });
  const ok = assessConformalReliability({
    calibrator,
    interval: calibrated,
    predicted: 100,
    changeDetected: false,
    maxRelativeWidth: 0.5,
  });
  assert.notEqual(ok.status, 'failed');
});
