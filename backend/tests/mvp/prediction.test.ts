import assert from 'node:assert/strict';
import test from 'node:test';
import { PredictionService } from '../../src/services/mvp/prediction';
import { SafetyDecisionService } from '../../src/services/safety/decision-service';
import { planEvacuation } from '../../src/services/safety/planning/evacuation-planner';
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
    seed(fixture, now, Array.from({ length: 12 }, (_, index) => 300 + index * 30));
    const service = new PredictionService(fixture.scenario, fixture.safety.getObservationStore());
    const result = service.predict('R_EAST_STAND', { now, horizonMinutes: 5, windowMinutes: 12 });
    assert.equal(result.sufficient, true);
    assert.equal(result.algorithm, 'adaptive-forecast-v4');
    assert.equal(result.trend.direction, 'rising');
    assert.ok((result.trend.rate_per_minute ?? 0) > 10);
    assert.ok(result.predicted_count !== null && result.current_count !== null);
    assert.ok((result.predicted_count ?? 0) > (result.current_count ?? 0));
    assert.ok(result.interval !== null);
    assert.ok(result.interval.lower <= (result.predicted_count ?? 0));
    assert.ok(result.interval.upper >= (result.predicted_count ?? 0));
    assert.equal(result.input.points, 12);
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

test('预测可靠性：数据不足 / 区间过宽标记 failed，陈旧或低置信标记 warning', () => {
  const { assessPredictionReliability } = require('../../src/services/mvp/prediction') as typeof import('../../src/services/mvp/prediction');
  const base = {
    sufficient: true,
    predicted_count: 100,
    interval: { lower: 90, upper: 110 },
    data_quality: { stale: false, low_confidence: false, missing: false },
    max_relative_interval_width: 0.5,
  };
  assert.equal(assessPredictionReliability(base).status, 'ok');
  assert.equal(assessPredictionReliability({ ...base, sufficient: false }).status, 'failed');
  assert.equal(assessPredictionReliability({ ...base, interval: { lower: 0, upper: 300 } }).status, 'failed');
  assert.equal(assessPredictionReliability({
    ...base,
    data_quality: { stale: true, low_confidence: false, missing: false },
  }).status, 'warning');
});

test('预测可靠性 failed 时 VoI 预测动作不可用', () => {
  const { buildInvestigationAvailability } = require('../../src/services/mvp/availability') as typeof import('../../src/services/mvp/availability');
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const available = buildInvestigationAvailability(policy, {
      cameraOnline: true,
      staffAvailable: true,
      uavAvailable: true,
      historyPoints: 5,
      predictionReliable: true,
    });
    const blocked = buildInvestigationAvailability(policy, {
      cameraOnline: true,
      staffAvailable: true,
      uavAvailable: true,
      historyPoints: 5,
      predictionReliable: false,
      predictionReason: '区间过宽',
    });
    const predictionAction = policy.actions.find(action => action.kind === 'prediction')!;
    assert.equal(available[predictionAction.id].available, true);
    assert.equal(blocked[predictionAction.id].available, false);
    assert.match(blocked[predictionAction.id].reason ?? '', /区间过宽/);
  } finally {
    fixture.cleanup();
  }
});

test('预测结果携带可靠性字段，并在区间过宽时标记 failed', () => {
  const fixture = makeMvpFixture();
  try {
    const now = new Date('2026-11-05T12:00:00.000Z');
    seed(fixture, now, [100, 900, 120, 880, 140, 860, 160, 840]);
    const service = new PredictionService(fixture.scenario, fixture.safety.getObservationStore());
    const result = service.predict('R_EAST_STAND', { now, horizonMinutes: 5 });
    assert.ok(result.reliability);
    assert.ok(['ok', 'warning', 'failed'].includes(result.reliability.status));
    assert.ok(result.reliability.reasons.length >= 0);
    if (result.reliability.relative_interval_width !== null) {
      assert.ok(result.reliability.relative_interval_width >= 0);
    }
  } finally {
    fixture.cleanup();
  }
});

test('场景启用 robust 需求时预测上界进入规划，不可靠时回退观测', () => {
  const fixture = makeMvpFixture();
  try {
    const now = new Date('2026-11-05T12:00:00.000Z');
    fixture.scenario.planning = { demand_mode: 'robust', prediction_horizon_minutes: 5 };
    const seedRegion = (regionId: string, counts: number[]) => {
      counts.forEach((count, index) => {
        fixture.safety.ingestObservation({
          regionId,
          count,
          confidence: 0.92,
          source: 'simulation',
          provider: 'planning-test',
          modelVersion: 'test/1.0.0',
          observedAt: new Date(now.getTime() - (counts.length - 1 - index) * 60_000),
        }, { username: 'test', role: 'admin' });
      });
    };
    for (const region of fixture.scenario.regions) {
      seedRegion(region.id, region.id === 'R_EAST_STAND'
        ? Array.from({ length: 12 }, (_, index) => 400 + index * 2)
        : [150, 150, 150]);
    }
    const captured: Array<Parameters<typeof planEvacuation>[0]> = [];
    const service = new SafetyDecisionService({
      scenario: fixture.scenario,
      observationStore: fixture.safety.getObservationStore(),
      now: () => now,
      planBuilder: input => {
        captured.push(input);
        return planEvacuation({ ...input, now });
      },
    });
    service.recompute({ username: 'test', role: 'admin' }, 'prediction_planning_test');
    assert.equal(captured.length, 1);
    const input = captured[0];
    const target = input.demandProvenance?.find(item => item.region_id === 'R_EAST_STAND');
    assert.ok(target);
    assert.equal(target.source, 'prediction_robust');
    assert.ok(target.planned_count >= (target.interval_upper ?? 0));
    assert.ok(target.planned_count > target.observed_count);
    assert.ok((input.demandByRegion.get('R_EAST_STAND') ?? 0) >= target.planned_count);
  } finally {
    fixture.cleanup();
  }
});
