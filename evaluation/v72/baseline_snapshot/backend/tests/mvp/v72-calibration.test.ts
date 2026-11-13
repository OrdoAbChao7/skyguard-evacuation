import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import {
  adaptCameraCount,
  applyVenueProfile,
  estimateServiceRate,
  estimateWalkingSpeed,
  validateVenueProfile,
  type VenueProfile,
} from '../../src/services/safety/calibration/venue-calibration';

const scenarioPath = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');
const profilePath = path.resolve(__dirname, '../../../data/venues/stadium-synthetic-profile.json');

function loadProfile(): VenueProfile {
  return JSON.parse(fs.readFileSync(profilePath, 'utf8')) as VenueProfile;
}

test('合成标定档案通过结构校验，并覆盖场景的全部启用区域', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const profile = loadProfile();
  const validation = validateVenueProfile(profile, scenario);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(validation.checked_regions, scenario.regions.filter(region => region.enabled).length);
  assert.equal(validation.checked_exits, scenario.exits.length);
  assert.ok(!validation.warnings.some(item => item.code === 'scenario_region_uncovered'));
});

test('合成数据冒充实测/标定会被拒绝', () => {
  const profile = loadProfile();
  profile.regions[0].area_m2 = {
    ...profile.regions[0].area_m2,
    provenance: 'measured',
    measured_at: new Date().toISOString(),
  };
  const validation = validateVenueProfile(profile);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(item => item.code === 'synthetic_claims_measured'));
});

test('calibrated 参数缺少样本量或置信区间会被拒绝', () => {
  const profile = loadProfile();
  profile.flow.walking_speed_mps = {
    ...profile.flow.walking_speed_mps,
    provenance: 'calibrated',
    measured_at: new Date().toISOString(),
    samples: 3,
  };
  const validation = validateVenueProfile(profile);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(item => item.code === 'calibrated_without_samples'));
});

test('引用完整性：通道端点、相机区域与 ROI 越界校验', () => {
  const profile = loadProfile();
  profile.corridors[0].from_region_id = 'R_NOT_EXIST';
  profile.cameras[0].region_id = 'R_NOT_EXIST';
  profile.cameras[1].roi = { x: 0.9, y: 0, w: 0.5, h: 1 };
  const validation = validateVenueProfile(profile);
  assert.equal(validation.valid, false);
  const codes = validation.errors.map(item => item.code);
  assert.ok(codes.includes('corridor_endpoint_missing'));
  assert.ok(codes.includes('camera_region_missing'));
  assert.ok(codes.includes('roi_out_of_bounds'));
});

test('应用标定档案生成变更清单、来源与版本，不修改原场景', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const beforeVersion = scenario.version;
  const profile = loadProfile();
  const targetRegion = profile.regions[0];
  targetRegion.area_m2 = {
    ...targetRegion.area_m2,
    value: targetRegion.area_m2.value + 100,
    provenance: 'estimated',
  };
  const result = applyVenueProfile(scenario, profile);
  assert.equal(scenario.version, beforeVersion, '输入场景不得被修改');
  assert.notEqual(result.version, beforeVersion);
  assert.ok(result.changes.some(change => change.id === targetRegion.region_id && change.field === 'area_m2'));
  assert.equal(result.scenario.version, result.version);
});

test('应用未通过校验的档案会失败，unknown 参数被阻止', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const invalid = loadProfile();
  invalid.corridors[0].from_region_id = 'R_NOT_EXIST';
  assert.throws(() => applyVenueProfile(scenario, invalid), /未通过校验/);

  const profile = loadProfile();
  profile.exits[0].capacity_per_min = {
    ...profile.exits[0].capacity_per_min,
    provenance: 'unknown',
    value: 120,
  };
  const result = applyVenueProfile(scenario, profile);
  assert.ok(result.blocked.some(item => item.id === profile.exits[0].exit_id && item.reason === 'unknown_provenance'));
  assert.ok(result.changes.every(change => change.provenance !== 'unknown'));
});

test('服务率估计：样本充足且稳定才标记 calibrated，否则 estimated', () => {
  const stableSamples = Array.from({ length: 12 }, (_, index) => ({ served: 200 + (index % 3), minutes: 1 }));
  const calibrated = estimateServiceRate(stableSamples, 'test');
  assert.equal(calibrated.provenance, 'calibrated');
  assert.ok((calibrated.confidence_interval?.lower ?? 0) <= calibrated.value);
  assert.ok((calibrated.confidence_interval?.upper ?? 0) >= calibrated.value);

  const fewSamples = Array.from({ length: 3 }, () => ({ served: 200, minutes: 1 }));
  const estimated = estimateServiceRate(fewSamples, 'test');
  assert.equal(estimated.provenance, 'estimated');

  const speed = estimateWalkingSpeed(Array.from({ length: 12 }, (_, index) => ({ distance_m: 60, seconds: 48 + (index % 2) })), 'test');
  assert.equal(speed.provenance, 'calibrated');
  assert.ok(speed.value > 1 && speed.value < 2);
});

test('相机计数适配器保留来源与标定版本，并拒绝过期/低置信度输入', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const region = scenario.regions.find(item => item.enabled)!;
  const now = new Date();
  const fresh = adaptCameraCount({
    adapter_id: 'test-adapter',
    region_id: region.id,
    count: 320,
    confidence: 0.95,
    observed_at: new Date(now.getTime() - 10_000).toISOString(),
    received_at: now.toISOString(),
    calibration_version: 'cam-test-1',
    provider: 'test',
    model_version: 'test/1.0.0',
  }, scenario, { now, source: 'live_video' });
  assert.ok(fresh.observation);
  assert.equal(fresh.observation!.source, 'live_video');
  assert.equal(fresh.observation!.calibration_version, 'cam-test-1');
  assert.equal(fresh.observation!.estimated_count, 320);

  const stale = adaptCameraCount({
    adapter_id: 'test-adapter',
    region_id: region.id,
    count: 320,
    confidence: 0.95,
    observed_at: new Date(now.getTime() - 10 * 60_000).toISOString(),
    received_at: now.toISOString(),
    calibration_version: 'cam-test-1',
    provider: 'test',
    model_version: 'test/1.0.0',
  }, scenario, { now, source: 'live_video' });
  assert.equal(stale.observation, null);
  assert.equal(stale.rejected_reason, 'stale_observation');

  const lowConfidence = adaptCameraCount({
    adapter_id: 'test-adapter',
    region_id: region.id,
    count: 320,
    confidence: 0.1,
    observed_at: now.toISOString(),
    received_at: now.toISOString(),
    calibration_version: 'cam-test-1',
    provider: 'test',
    model_version: 'test/1.0.0',
  }, scenario, { now, source: 'live_video' });
  assert.equal(lowConfidence.rejected_reason, 'low_confidence');
});
