import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import {
  adaptAuthorizedRealRows,
  adaptPublicDatasetRows,
  adaptVideoFrames,
  compareVenueConstraints,
  directionalCapacityFactor,
  importScenarioFromJson,
  parseCsv,
  parseObservationCsv,
  toDensityObservations,
  validateScenarioTopology,
} from '../../src/services/safety/calibration/importers';
import { validateVenueProfile, type VenueProfile } from '../../src/services/safety/calibration/venue-calibration';

const scenarioPath = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');
const profilePath = path.resolve(__dirname, '../../../data/venues/stadium-synthetic-profile.json');
const csvPath = path.resolve(__dirname, '../../../data/venues/fixtures/observations-sample.csv');
const publicCsvPath = path.resolve(__dirname, '../../../data/venues/fixtures/public-sample.csv');

function loadProfile(): VenueProfile {
  return JSON.parse(fs.readFileSync(profilePath, 'utf8')) as VenueProfile;
}

test('CSV 解析支持 BOM、引号、CRLF，并拒绝非法数值', () => {
  const csv = '﻿region_id,observed_at,count,confidence\r\n"R_NORTH_STAND","2026-11-10T01:00:00Z",320,0.95\r\nR_SOUTH_STAND,2026-11-10T01:00:00Z,not-a-number,0.9\r\n';
  const parsed = parseObservationCsv(csv);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].region_id, 'R_NORTH_STAND');
  assert.equal(parsed.rows[0].count, 320);
  assert.ok(parsed.errors.some(item => item.code === 'csv_invalid_count'));
});

test('CSV 文本通过独立解析器得到表头与行号', () => {
  const table = parseCsv('a,b\n1,2\n3,"x,y"\n');
  assert.deepEqual(table.header, ['a', 'b']);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[1].values.b, 'x,y');
  assert.equal(table.rows[1].line, 3);
});

test('观测导入：replay 允许历史数据，live 拒绝过期/未来时间戳', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const text = fs.readFileSync(csvPath, 'utf8');
  const parsed = parseObservationCsv(text);
  assert.equal(parsed.errors.length, 0);
  const now = new Date('2026-11-10T01:00:10Z');
  const replay = toDensityObservations(scenario, parsed.rows, { now, mode: 'replay' });
  assert.equal(replay.observations.length, parsed.rows.length);
  assert.equal(replay.observations[0].source, 'live_video');
  const live = toDensityObservations(scenario, parsed.rows, { now, mode: 'live' });
  assert.equal(live.observations.length, parsed.rows.length);
  const stale = toDensityObservations(scenario, [{
    region_id: 'R_NORTH_STAND',
    observed_at: '2026-11-10T00:50:00Z',
    count: 300,
    confidence: 0.95,
    source: 'live_video',
  }], { now, mode: 'live' });
  assert.equal(stale.observations.length, 0);
  assert.equal(stale.rejected[0].reason, 'stale_observation');
  const future = toDensityObservations(scenario, [{
    region_id: 'R_NORTH_STAND',
    observed_at: '2026-11-10T01:10:00Z',
    count: 300,
    confidence: 0.95,
    source: 'live_video',
  }], { now, mode: 'live' });
  assert.equal(future.rejected[0].reason, 'timestamp_in_future');
});

test('场景 JSON 导入与拓扑校验：缺失端点/重复 ID 被拒绝', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const imported = importScenarioFromJson(JSON.stringify(scenario));
  assert.ok(imported.scenario);
  assert.equal(imported.topology.errors.length, 0);
  const broken = JSON.parse(JSON.stringify(scenario));
  broken.corridors[0].to_region_id = 'R_NOT_EXIST';
  broken.regions.push({ ...broken.regions[0] });
  const result = importScenarioFromJson(JSON.stringify(broken));
  assert.ok(result.scenario);
  assert.ok(result.topology.errors.some(item => item.code === 'corridor_endpoint_missing'));
  assert.ok(result.topology.errors.some(item => item.code === 'duplicate_region'));
  const invalid = importScenarioFromJson('{ not json');
  assert.equal(invalid.scenario, null);
  assert.equal(invalid.errors[0].code, 'scenario_json_invalid');
});

test('方向性容量与场馆约束：不得弱化场景安全配置', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const profile = loadProfile();
  const corridor = profile.corridors[0];
  const physical = corridor.capacity_per_min.value;
  corridor.directional_capacity = {
    forward: { ...corridor.capacity_per_min, value: physical * 0.6 },
    reverse: { ...corridor.capacity_per_min, value: physical * 0.4 },
  };
  assert.ok(directionalCapacityFactor(profile, corridor.corridor_id, 'forward') <= 0.61);
  assert.ok(directionalCapacityFactor(profile, corridor.corridor_id, 'reverse') <= 0.41);
  const invalid = loadProfile();
  invalid.corridors[0].directional_capacity = {
    forward: { ...invalid.corridors[0].capacity_per_min, value: physical },
    reverse: { ...invalid.corridors[0].capacity_per_min, value: physical },
  };
  const validation = validateVenueProfile(invalid);
  assert.ok(validation.errors.some(item => item.code === 'directional_capacity_exceeds_physical'));

  const constrained = loadProfile();
  constrained.constraints = { min_confidence: 0.1, max_observation_age_seconds: 3600, forbidden_corridor_ids: [scenario.corridors[0].id] };
  const compared = compareVenueConstraints(scenario, constrained);
  assert.ok(compared.errors.some(item => item.code === 'constraint_weakens_min_confidence'));
  assert.ok(compared.errors.some(item => item.code === 'constraint_weakens_observation_age'));
});

test('视频计数接口：相机映射、过期与未来时间戳', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const profile = loadProfile();
  const camera = profile.cameras[0];
  const now = new Date('2026-11-10T01:00:10Z');
  const base = {
    kind: 'video' as const,
    adapter_id: 'video-fixture',
    cameraToRegion: { [camera.camera_id]: camera.region_id },
  };
  const ok = adaptVideoFrames({
    ...base,
    frames: [{ camera_id: camera.camera_id, timestamp: '2026-11-10T01:00:05Z', count: 240, confidence: 0.92 }],
  }, scenario, profile, { now, mode: 'live' });
  assert.equal(ok.observations.length, 1);
  assert.equal(ok.observations[0].source, 'live_video');
  const stale = adaptVideoFrames({
    ...base,
    frames: [{ camera_id: camera.camera_id, timestamp: '2026-11-10T00:50:00Z', count: 240, confidence: 0.92 }],
  }, scenario, profile, { now, mode: 'live' });
  assert.equal(stale.rejected[0].reason, 'stale_observation');
  const unmapped = adaptVideoFrames({
    ...base,
    frames: [{ camera_id: 'CAM-UNKNOWN', timestamp: '2026-11-10T01:00:05Z', count: 10, confidence: 0.9 }],
  }, scenario, profile, { now, mode: 'live' });
  assert.equal(unmapped.rejected[0].reason, 'unmapped_camera');
});

test('公开数据集必须有已核验许可；授权真实数据必须有授权依据', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const table = parseCsv(fs.readFileSync(publicCsvPath, 'utf8'));
  const rows = table.rows.map(row => row.values);
  const mapping = { regionColumn: 'region', countColumn: 'count', timestampColumn: 'timestamp', confidenceColumn: 'confidence' };
  const unverified = adaptPublicDatasetRows(rows, {
    name: 'fixture-public-schema',
    license: 'TEST FIXTURE',
    license_verified: false,
    citation: 'fixture only',
    data_nature: 'public_dataset',
  }, mapping, scenario, { mode: 'replay', now: new Date('2026-11-10T01:00:10Z') });
  assert.ok(unverified.errors.some(item => item.code === 'public_dataset_license_unverified'));

  const verified = adaptPublicDatasetRows(rows, {
    name: 'fixture-public-schema',
    license: 'TEST FIXTURE (no real dataset content)',
    license_verified: true,
    citation: 'fixture only',
    data_nature: 'public_dataset',
  }, mapping, scenario, { mode: 'replay', now: new Date('2026-11-10T01:00:10Z') });
  assert.equal(verified.observations.length, rows.length);
  assert.equal(verified.observations[0].evidence?.data_nature, 'public_dataset');

  const authorizedMissing = adaptAuthorizedRealRows(rows, undefined, mapping, scenario, { now: new Date('2026-11-10T01:00:10Z') });
  assert.ok(authorizedMissing.errors.some(item => item.code === 'real_world_authorization_missing'));
  const authorized = adaptAuthorizedRealRows(rows, {
    reference: 'AUTH-FIXTURE-001',
    legal_basis: 'test fixture only',
    operator: 'fixture-operator',
    verified_at: '2026-11-10T00:00:00Z',
  }, mapping, scenario, { now: new Date('2026-11-10T01:00:10Z') });
  assert.equal(authorized.observations.length, rows.length);
  assert.equal(authorized.observations[0].source, 'field_report');
});

test('real_world_calibrated 档案缺少授权依据被拒绝', () => {
  const profile = loadProfile();
  profile.data_nature = 'real_world_calibrated';
  delete profile.authorization;
  const validation = validateVenueProfile(profile);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(item => item.code === 'real_world_authorization_missing'));
  profile.authorization = {
    reference: 'AUTH-FIXTURE-001',
    legal_basis: 'test fixture only',
    operator: 'fixture-operator',
    verified_at: '2026-11-10T00:00:00Z',
  };
  const withAuth = validateVenueProfile(profile);
  assert.ok(!withAuth.errors.some(item => item.code === 'real_world_authorization_missing'));
});
