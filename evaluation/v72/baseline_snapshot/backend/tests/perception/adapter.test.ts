import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptDisplayFrame,
  adaptImageCount,
  ingestPerceptionDraft,
  runPerceptionDecisionLoop,
  zoneAreaM2,
  type RegionMapping,
} from '../../src/services/perception/adapter';
import { loadDisplayPackage } from '../../src/services/perception/display';
import { makeMvpFixture, ADMIN } from '../mvp/fixtures';
import { PredictionService } from '../../src/services/mvp/prediction';

const PACKAGE = 'citystreet-display';

test('鞋带公式计算米制多边形面积', () => {
  const area = zoneAreaM2([[0, 0], [10, 0], [10, 20], [0, 20]]);
  assert.equal(area, 200);
  assert.equal(zoneAreaM2([[0, 0], [1, 1]]), null);
});

test('图像人数缺少区域映射时不能生成密度，也不能进入安全域', () => {
  const draft = adaptImageCount({
    image_id: 'IMG_1.jpg',
    predicted_count: 420,
    model: 'P2PNet SHTechA',
    model_version: 'official',
    confidence: 0.9,
    ground_truth: 430,
  });
  assert.equal(draft.estimated_count, 420);
  assert.equal(draft.density_per_m2, null);
  assert.equal(draft.valid_for_safety, false);
  assert.equal(draft.quality.status, 'unusable');
  assert.ok(draft.quality.reasons.includes('missing_region_mapping'));
  assert.ok(draft.limitations.some(item => item.includes('不是区域密度')));
});

test('CityStreet 派生帧可计算演示密度，但无真值/未标定时 fail closed', () => {
  const loaded = loadDisplayPackage(PACKAGE);
  const frame = loaded.frames[0];
  const drafts = adaptDisplayFrame(loaded, frame);
  assert.equal(drafts.length, frame.zone_stats.length);
  const north = drafts.find(item => item.provenance.zone_id === 'N')!;
  assert.ok(north.area_m2 && north.area_m2 > 0);
  assert.ok(north.density_per_m2 !== null && north.density_per_m2 >= 0);
  assert.equal(north.valid_for_safety, false);
  assert.equal(north.quality.ground_truth_available, false);
  assert.equal(north.quality.license_status !== 'VERIFIED', true);
  assert.ok(north.quality.reasons.includes('derived_display_data'));
  assert.ok(north.quality.reasons.includes('missing_region_mapping'));
});

test('即使区域映射为 assumed_demo 也不得进入安全域', () => {
  const loaded = loadDisplayPackage(PACKAGE);
  const frame = loaded.frames[0];
  const mapping: RegionMapping = {
    region_id: 'R_EAST_STAND',
    zone_id: 'N',
    area_m2: 750,
    calibration: 'assumed_demo',
    source: 'demo-mapping',
  };
  const draft = adaptDisplayFrame(loaded, frame, { mappings: [mapping] })
    .find(item => item.region_id === 'R_EAST_STAND')!;
  assert.equal(draft.quality.demo_mapping, true);
  assert.equal(draft.valid_for_safety, false);
});

test('surveyed 映射且面积一致、置信度足够时才写入可信观测', () => {
  const fixture = makeMvpFixture();
  try {
    const region = fixture.scenario.regions.find(item => item.id === 'R_EAST_STAND')!;
    const mapping: RegionMapping = {
      region_id: region.id,
      zone_id: 'demo',
      area_m2: region.area_m2,
      calibration: 'surveyed',
      calibration_id: 'test-calibration',
      source: 'unit-test',
    };
    const draft = adaptImageCount({
      image_id: 'demo.jpg',
      predicted_count: 600,
      model: 'test-model',
      model_version: '1.0.0',
      confidence: 0.9,
      mapping,
    });
    assert.equal(draft.valid_for_safety, true);
    const result = ingestPerceptionDraft(fixture.safety, draft, ADMIN);
    assert.ok(result.observation);
    assert.equal(result.observation?.valid, true);
    assert.equal(result.observation?.estimated_count, 600);
    assert.equal(result.observation?.estimated_density, Number((600 / region.area_m2).toFixed(4)));
  } finally {
    fixture.cleanup();
  }
});

test('面积与场景区域不一致或置信度不足时降级为不可信观测', () => {
  const fixture = makeMvpFixture();
  try {
    const region = fixture.scenario.regions.find(item => item.id === 'R_EAST_STAND')!;
    const wrongArea = adaptImageCount({
      image_id: 'demo.jpg',
      predicted_count: 600,
      model: 'test-model',
      model_version: '1.0.0',
      confidence: 0.9,
      mapping: {
        region_id: region.id,
        zone_id: 'demo',
        area_m2: region.area_m2 * 2,
        calibration: 'surveyed',
        source: 'unit-test',
      },
    });
    const wrongAreaResult = ingestPerceptionDraft(fixture.safety, wrongArea, ADMIN);
    assert.equal(wrongAreaResult.observation?.valid, false);
    assert.match(wrongAreaResult.observation?.invalid_reason ?? '', /area_mismatch/);

    const lowConfidence = adaptImageCount({
      image_id: 'demo.jpg',
      predicted_count: 600,
      model: 'test-model',
      model_version: '1.0.0',
      confidence: 0.3,
      mapping: {
        region_id: region.id,
        zone_id: 'demo',
        area_m2: region.area_m2,
        calibration: 'surveyed',
        source: 'unit-test',
      },
    });
    const lowResult = ingestPerceptionDraft(fixture.safety, lowConfidence, ADMIN);
    assert.equal(lowResult.observation?.valid, false);
    assert.match(lowResult.observation?.invalid_reason ?? '', /confidence_below_safety_threshold/);
  } finally {
    fixture.cleanup();
  }
});

test('感知→观测→预测→VoI→风险链路可运行，且不可信输入使安全域降级', () => {
  const fixture = makeMvpFixture();
  try {
    const loaded = loadDisplayPackage(PACKAGE);
    const drafts = adaptDisplayFrame(loaded, loaded.frames[0])
      .filter(item => item.provenance.zone_id === 'N')
      .map(item => ({
        ...item,
        region_id: 'R_EAST_STAND',
      }));
    const prediction = new PredictionService(fixture.scenario, fixture.safety.getObservationStore());
    const result = runPerceptionDecisionLoop({
      scenario: fixture.scenario,
      safety: fixture.safety,
      prediction,
      drafts,
      target_region_id: 'R_EAST_STAND',
      actor: ADMIN,
    });
    assert.equal(result.ingest.length, 1);
    assert.equal(result.ingest[0].observation?.valid, false);
    assert.equal(result.safety_state, 'DEGRADED');
    assert.ok(result.prediction);
    assert.equal(result.prediction?.reliability.status, 'failed');
    assert.ok(result.risk);
    assert.ok(result.voi);
    assert.ok(Array.isArray((result.voi as { evaluations: unknown[] }).evaluations));
    assert.ok(result.limitations.some(item => item.includes('无真值')));
  } finally {
    fixture.cleanup();
  }
});
