import assert from 'node:assert/strict';
import test from 'node:test';
import { PredictionService } from '../../src/services/mvp/prediction';
import { makeMvpFixture } from './fixtures';

function seed(fixture: ReturnType<typeof makeMvpFixture>, now: Date, counts: number[]) {
  counts.forEach((count, index) => {
    fixture.safety.ingestObservation({
      regionId: 'R_EAST_STAND',
      count,
      confidence: 0.92,
      source: 'simulation',
      provider: 'test-harness',
      modelVersion: 'test/1.0.0',
      observedAt: new Date(now.getTime() - (counts.length - 1 - index) * 60_000),
    }, { username: 'test', role: 'admin' });
  });
}

test('线性上升序列预测为上升趋势且区间包住预测值', () => {
  const fixture = makeMvpFixture();
  try {
    const now = new Date('2026-11-05T12:00:00.000Z');
    seed(fixture, now, [300, 330, 360, 390, 420, 450]);
    const service = new PredictionService(fixture.scenario, fixture.safety.getObservationStore());
    const result = service.predict('R_EAST_STAND', { now, horizonMinutes: 5 });
    assert.equal(result.sufficient, true);
    assert.equal(result.algorithm, 'adaptive-forecast-v3');
    assert.equal(result.trend.direction, 'rising');
    assert.ok((result.trend.rate_per_minute ?? 0) > 10);
    assert.ok(result.predicted_count !== null && result.current_count !== null);
    assert.ok((result.predicted_count ?? 0) > (result.current_count ?? 0));
    assert.ok(result.interval !== null);
    assert.ok(result.interval.lower <= (result.predicted_count ?? 0));
    assert.ok(result.interval.upper >= (result.predicted_count ?? 0));
    assert.equal(result.input.points, 6);
    assert.deepEqual(result.input.sources, ['simulation']);
    assert.match(result.uncertainty_note, /不是安全保证/);
    assert.equal(result.selection.selected_by, 'rolling_validation');
    assert.ok(['persistence', 'ema', 'damped', 'blend', 'linear'].includes(result.selection.method));
    assert.ok(result.selection.candidates.length >= 5);
  } finally {
    fixture.cleanup();
  }
});

test('数据不足时明确标记 insufficient 并回退最近有效观测', () => {
  const fixture = makeMvpFixture();
  try {
    const now = new Date('2026-11-05T12:00:00.000Z');
    seed(fixture, now, [520]);
    const service = new PredictionService(fixture.scenario, fixture.safety.getObservationStore());
    const result = service.predict('R_EAST_STAND', { now, horizonMinutes: 5 });
    assert.equal(result.sufficient, false);
    assert.equal(result.trend.direction, 'unknown');
    assert.equal(result.predicted_count, 520);
    assert.match(result.uncertainty_note, /数据不足/);
  } finally {
    fixture.cleanup();
  }
});

test('低置信度观测被排除在预测输入之外', () => {
  const fixture = makeMvpFixture();
  try {
    const now = new Date('2026-11-05T12:00:00.000Z');
    for (let index = 0; index < 5; index += 1) {
      fixture.safety.ingestObservation({
        regionId: 'R_EAST_STAND',
        count: 300 + index * 20,
        confidence: 0.3,
        source: 'simulation',
        provider: 'test-harness',
        modelVersion: 'test/1.0.0',
        observedAt: new Date(now.getTime() - (4 - index) * 60_000),
      }, { username: 'test', role: 'admin' });
    }
    const service = new PredictionService(fixture.scenario, fixture.safety.getObservationStore());
    const result = service.predict('R_EAST_STAND', { now });
    assert.equal(result.sufficient, false);
    assert.equal(result.input.points, 0);
    assert.ok(result.input.excluded_low_confidence >= 5);
    assert.equal(result.data_quality.low_confidence, true);
  } finally {
    fixture.cleanup();
  }
});

test('未知区域预测抛错', () => {
  const fixture = makeMvpFixture();
  try {
    const service = new PredictionService(fixture.scenario, fixture.safety.getObservationStore());
    assert.throws(() => service.predict('R_UNKNOWN'), /unknown region/);
  } finally {
    fixture.cleanup();
  }
});
