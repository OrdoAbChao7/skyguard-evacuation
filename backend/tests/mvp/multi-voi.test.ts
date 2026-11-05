import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRegionGraph } from '../../src/services/mvp/risk-graph';
import {
  decideMultiRegionInvestigation,
  priorBeliefsForRegions,
} from '../../src/services/mvp/multi-voi';
import { priorBelief, entropy } from '../../src/services/mvp/voi';
import { makeMvpFixture } from './fixtures';
import type { RegionRisk } from '../../src/services/safety/risk';

function risk(regionId: string, level: RegionRisk['level'], trusted = true): RegionRisk {
  return {
    regionId, level, count: 900, density: 1.2, confidence: 0.9,
    observedAt: new Date().toISOString(), ageSeconds: 5, trusted, signals: [],
    thresholds: { watch_density: 1, high_density: 2, critical_density: 3, rise_rate_watch: 0.5, source: 'test' },
    thresholdsSource: 'test',
  };
}

test('相邻覆盖动作同时评估目标区域与邻居区域', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const graph = buildRegionGraph(fixture.scenario);
    const risks = fixture.scenario.regions.map(region =>
      risk(region.id, region.id === 'R_EAST_STAND' ? 'critical' : 'watch', region.id !== 'R_EAST_STAND'));
    const beliefs = priorBeliefsForRegions(policy, risks);
    const decision = decideMultiRegionInvestigation(policy, 'R_EAST_STAND', beliefs, graph);

    const uav = decision.evaluations.find(item => item.action_id === 'A_UAV')!;
    assert.equal(uav.kind, 'uav_request');
    assert.ok(uav.covered_regions.length > 1);
    assert.ok(uav.covered_regions.some(item => item.region_id === 'R_EAST_STAND'));
    assert.ok(uav.covered_regions.some(item => ['R_NORTH_CONCOURSE', 'R_SOUTH_CONCOURSE'].includes(item.region_id)));
    assert.ok(uav.weighted_risk_reduction > 0);
    assert.ok(uav.weighted_information_gain_bits > 0);

    const camera = decision.evaluations.find(item => item.action_id === 'A_CAMERA')!;
    assert.equal(camera.covered_regions.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('可信观测会更新区域信念，不可信观测保持先验', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const risks = [
      risk('R_EAST_STAND', 'critical', false),
      risk('R_NORTH_STAND', 'normal', true),
    ];
    const beliefs = priorBeliefsForRegions(policy, risks);
    const prior = priorBelief(policy);
    assert.deepEqual(beliefs.get('R_EAST_STAND'), prior);
    assert.notDeepEqual(beliefs.get('R_NORTH_STAND'), prior);
    assert.ok(entropy(beliefs.get('R_NORTH_STAND')!) < entropy(prior));
  } finally {
    fixture.cleanup();
  }
});

test('预算耗尽时停止调查', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const graph = buildRegionGraph(fixture.scenario);
    const risks = fixture.scenario.regions.map(region => risk(region.id, 'watch'));
    const beliefs = priorBeliefsForRegions(policy, risks);
    const decision = decideMultiRegionInvestigation(policy, 'R_EAST_STAND', beliefs, graph, {}, {
      usedActions: policy.budget?.max_actions ?? 3,
    });
    assert.equal(decision.should_investigate, false);
    assert.equal(decision.stop_reason, 'budget_exhausted');
    assert.equal(decision.recommended_action_id, null);
  } finally {
    fixture.cleanup();
  }
});
