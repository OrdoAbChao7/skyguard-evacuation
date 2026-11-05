import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRegionGraph, neighborsOf, propagateRisk, rankInvestigationPriorities, riskValue } from '../../src/services/mvp/risk-graph';
import { makeMvpFixture } from './fixtures';
import type { RegionRisk } from '../../src/services/safety/risk';

function risk(regionId: string, level: RegionRisk['level'], trusted = true): RegionRisk {
  return {
    regionId,
    level,
    count: 500,
    density: 0.8,
    confidence: 0.9,
    observedAt: new Date().toISOString(),
    ageSeconds: 5,
    trusted,
    signals: [],
    thresholds: {
      watch_density: 1,
      high_density: 2,
      critical_density: 3,
      rise_rate_watch: 0.5,
      source: 'test',
    },
    thresholdsSource: 'test',
  };
}

test('风险沿开放通道传播，未知通道被排除', () => {
  const fixture = makeMvpFixture();
  try {
    const graph = buildRegionGraph(fixture.scenario);
    assert.ok(neighborsOf(graph, 'R_EAST_STAND').includes('R_NORTH_CONCOURSE'));
    assert.ok(!neighborsOf(graph, 'R_EAST_PLAZA').includes('R_WEST_PLAZA'), 'unknown corridor must be excluded');

    const risks = fixture.scenario.regions.map(region =>
      risk(region.id, region.id === 'R_EAST_STAND' ? 'critical' : 'normal'));
    const propagated = propagateRisk(fixture.scenario, risks);
    const east = propagated.find(item => item.regionId === 'R_EAST_STAND')!;
    const neighbour = propagated.find(item => item.regionId === 'R_NORTH_CONCOURSE')!;
    assert.equal(east.localRisk, riskValue('critical'));
    assert.ok(neighbour.propagatedRisk > neighbour.localRisk);
    assert.ok(neighbour.contributors.some(item => item.regionId === 'R_EAST_STAND'));
  } finally {
    fixture.cleanup();
  }
});

test('调查优先级综合传播风险、不确定性与中心性', () => {
  const fixture = makeMvpFixture();
  try {
    const risks = fixture.scenario.regions.map(region =>
      risk(region.id, region.id === 'R_EAST_STAND' ? 'critical' : 'watch', region.id !== 'R_EAST_STAND'));
    const propagated = propagateRisk(fixture.scenario, risks);
    const ranked = rankInvestigationPriorities(fixture.scenario, risks, propagated);
    assert.equal(ranked.length, fixture.scenario.regions.length);
    assert.ok(ranked[0].priority >= ranked[ranked.length - 1].priority);
    const east = ranked.find(item => item.regionId === 'R_EAST_STAND')!;
    assert.equal(east.uncertainty, 1);
    assert.ok(east.priority > 0);
  } finally {
    fixture.cleanup();
  }
});
