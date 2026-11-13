import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../../src/services/safety/network';
import { planEvacuation } from '../../src/services/safety/planning/evacuation-planner';
import { runShadowComparison } from '../../src/services/safety/planning/v7-adapter';
import { solveTimeExpandedPlan } from '../../src/services/safety/planning/strategies';
import { checkPlanCapacity } from '../../src/services/safety/planning/route-stability';
import {
  adaptAuthorizedRealRows,
  adaptPublicDatasetRows,
  adaptVideoFrames,
  parseCsv,
  parseObservationCsv,
  toDensityObservations,
} from '../../src/services/safety/calibration/importers';
import { buildObservation } from '../../src/services/safety/observations';
import type { DensityObservation } from '../../src/services/safety/types';

const scenarioPath = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

test('CSV 异常 received_at 不再抛错，而是返回明确错误', () => {
  const csv = 'region_id,observed_at,received_at,count,confidence\nR_NORTH_STAND,2026-11-10T01:00:00Z,not-a-date,300,0.9\n';
  const parsed = parseObservationCsv(csv);
  assert.equal(parsed.rows.length, 0);
  assert.ok(parsed.errors.some(item => item.code === 'csv_invalid_timestamp'));
});

test('异常大人数被拒绝：CSV/视频适配器均有上限', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const region = scenario.regions.find(item => item.enabled)!;
  const parsed = parseObservationCsv('region_id,observed_at,count,confidence\nR_NORTH_STAND,2026-11-10T01:00:00Z,1000000000,0.9\n');
  assert.equal(parsed.errors.length, 0);
  const converted = toDensityObservations(scenario, parsed.rows, { mode: 'replay', now: new Date('2026-11-10T01:00:10Z') });
  assert.equal(converted.observations.length, 0);
  assert.equal(converted.rejected[0].reason, 'count_out_of_range');

  const video = adaptVideoFrames({
    kind: 'video', adapter_id: 'x', cameraToRegion: { CAM: region.id },
    frames: [{ camera_id: 'CAM', timestamp: '2026-11-10T01:00:05Z', count: 1e12, confidence: 0.9 }],
  }, scenario, { cameras: [{ camera_id: 'CAM', region_id: region.id, roi: { x: 0, y: 0, w: 1, h: 1 }, calibration_status: 'uncalibrated', calibration_version: 'v1' }] } as any,
  { mode: 'live', now: new Date('2026-11-10T01:00:10Z') });
  assert.equal(video.rejected[0].reason, 'count_out_of_range');
});

test('公开/授权适配器遇到非法时间戳返回错误而非崩溃', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const rows = [{ region: 'R_NORTH_STAND', count: '300', timestamp: 'not-a-date' }];
  const mapping = { regionColumn: 'region', countColumn: 'count', timestampColumn: 'timestamp' };
  const publicResult = adaptPublicDatasetRows(rows, {
    name: 'fixture', license: 'TEST', license_verified: true, citation: 'fixture', data_nature: 'public_dataset',
  }, mapping, scenario, { mode: 'replay', now: new Date() });
  assert.ok(publicResult.errors.some(item => item.code === 'public_row_invalid'));
  const authorized = adaptAuthorizedRealRows(rows, {
    reference: 'AUTH', legal_basis: 'test', operator: 'op', verified_at: '2026-11-10T00:00:00Z',
  }, mapping, scenario, { now: new Date() });
  assert.ok(authorized.errors.some(item => item.code === 'authorized_row_invalid'));
});

test('双向动态容量：求解结果不超逐分钟物理容量', () => {
  const base = loadSafetyScenario(scenarioPath);
  const scenario = JSON.parse(JSON.stringify(base)) as typeof base;
  for (const corridor of scenario.corridors) if (corridor.capacity_per_min !== null) corridor.direction = 'both';
  const network = resolveEffectiveNetwork(scenario, []);
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const corridorFactor = (id: string, minute: number) => (minute >= 3 && (id === 'C_NE' || id === 'C_NW') ? 0.5 : 1);
  for (let round = 0; round < 4; round += 1) {
    const demand = new Map(scenario.regions.map(region => [region.id, region.enabled ? 200 + round * 40 : 0]));
    const solved = solveTimeExpandedPlan({
      scenario, network, demandByRegion: demand, horizonMinutes: 10, versions,
      now: new Date('2026-11-10T01:00:00Z'), corridorCapacityFactor: corridorFactor,
    });
    assert.deepEqual(checkPlanCapacity(scenario, solved.plan.routes, 0, { corridorCapacityFactor: corridorFactor }), []);
  }
});

test('快照人数不一致被标记，禁止 eligible', () => {
  const scenario = loadSafetyScenario(scenarioPath);
  const network = resolveEffectiveNetwork(scenario, []);
  const now = new Date('2026-11-10T01:00:00.000Z');
  const demand = new Map(scenario.regions.map(region => [region.id, region.enabled ? 220 : 0]));
  const observations = new Map<string, DensityObservation>();
  for (const region of scenario.regions) {
    if (!region.enabled) continue;
    observations.set(region.id, buildObservation({
      region, count: 220, confidence: 0.95, source: 'simulation', provider: 'redteam',
      modelVersion: 'redteam/1', observedAt: now, receivedAt: now,
    }));
  }
  const versions = { scenarioVersion: scenario.version, constraintVersion: 0, observationVersion: 0 };
  const tamperedDemand = new Map(demand);
  for (const [regionId, persons] of tamperedDemand) tamperedDemand.set(regionId, persons + 50);
  const legacyPlan = planEvacuation({ scenario, network, demandByRegion: tamperedDemand, ...versions, now }).plan;
  const comparison = runShadowComparison({
    scenario, network, demandByRegion: demand, versions, latestObservations: observations,
    config: scenario.config, legacyPlan, legacySolveMs: 1, now,
    configOverride: { enabled: true, strategy: 'solver', maxSolveMs: 500, maxComparisons: 20, maxSnapshotAgeMs: 5000, source: 'redteam' },
  });
  assert.equal(comparison.integrity.legacy_persons_match_snapshot, false);
  assert.equal(comparison.decision, 'legacy_only');
  assert.equal(comparison.fallback_reason, 'legacy_snapshot_mismatch');
});
