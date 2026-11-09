import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRegionGraph } from '../../src/services/mvp/risk-graph';
import { priorBeliefsForRegions } from '../../src/services/mvp/multi-voi';
import { decideJointInvestigation } from '../../src/services/mvp/joint-voi';
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

test('联合 VoI 产生联合信息增益、最坏区域风险与可复现推荐', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const graph = buildRegionGraph(fixture.scenario);
    const risks = fixture.scenario.regions.map(region =>
      risk(region.id, region.id === 'R_EAST_STAND' ? 'critical' : 'watch', region.id !== 'R_EAST_STAND'));
    const beliefs = priorBeliefsForRegions(policy, risks);
    const options = { particleCount: 600, outcomeSamples: 80, seed: 42 };
    const first = decideJointInvestigation(policy, 'R_EAST_STAND', beliefs, graph, {}, options);
    const second = decideJointInvestigation(policy, 'R_EAST_STAND', beliefs, graph, {}, options);
    assert.equal(first.engine_version, 'joint-voi-v1');
    assert.ok(first.evaluations.length >= 1);
    for (const evaluation of first.evaluations) {
      assert.ok(evaluation.joint_information_gain_bits >= 0);
      assert.ok(evaluation.risk_reduction >= 0);
      assert.ok(evaluation.risk_before_worst >= evaluation.expected_risk_after_worst - 1e-9);
    }
    assert.equal(first.recommended_action_id, second.recommended_action_id);
    assert.deepEqual(first.ranked_action_ids, second.ranked_action_ids);
    const best = first.evaluations.find(item => item.action_id === first.recommended_action_id);
    assert.ok(best && best.joint_information_gain_bits > 0);
  } finally {
    fixture.cleanup();
  }
});

test('联合 VoI 强制执行最大调查轮次', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const graph = buildRegionGraph(fixture.scenario);
    const beliefs = priorBeliefsForRegions(policy, fixture.scenario.regions.map(region => risk(region.id, 'watch')));
    const decision = decideJointInvestigation(policy, 'R_EAST_STAND', beliefs, graph, {}, {
      usedActions: policy.max_investigations,
      particleCount: 300,
      outcomeSamples: 50,
    });
    assert.equal(decision.should_investigate, false);
    assert.equal(decision.stop_reason, 'max_investigations_reached');
  } finally {
    fixture.cleanup();
  }
});
