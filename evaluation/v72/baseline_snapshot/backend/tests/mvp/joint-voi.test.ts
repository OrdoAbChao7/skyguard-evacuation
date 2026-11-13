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

test('联合 VoI 使用场景参数并返回逐轮候选评估', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const graph = buildRegionGraph(fixture.scenario);
    const risks = fixture.scenario.regions.map(region => risk(region.id, 'watch'));
    const beliefs = priorBeliefsForRegions(policy, risks);
    const decision = decideJointInvestigation(policy, 'R_EAST_STAND', beliefs, graph);
    assert.equal(decision.config.source, 'scenario');
    assert.equal(decision.config.correlation, 0.5);
    assert.ok(decision.evaluations_by_round.length >= 1);
    assert.ok(decision.selected.length >= 1);
    assert.ok(decision.selected.length <= decision.config.max_sequence);
    assert.ok(decision.total_expected_risk_reduction >= 0);
  } finally {
    fixture.cleanup();
  }
});

test('选择动作后，同覆盖动作出现冗余折扣', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const graph = buildRegionGraph(fixture.scenario);
    const risks = fixture.scenario.regions.map(region => risk(region.id, 'critical'));
    const beliefs = priorBeliefsForRegions(policy, risks);
    const decision = decideJointInvestigation(policy, 'R_EAST_STAND', beliefs, graph, {}, { maxSequence: 2 });
    const secondRound = decision.evaluations_by_round[1];
    if (secondRound) {
      const selectedId = decision.selected[0]?.action_id;
      const repeatedKind = secondRound.find(item => item.kind === decision.selected[0]?.kind);
      assert.ok(repeatedKind);
      assert.ok(repeatedKind!.redundancy < 1, `冗余系数应小于 1，实际 ${repeatedKind!.redundancy}`);
      void selectedId;
    }
  } finally {
    fixture.cleanup();
  }
});

test('相关性让未直接覆盖的邻居获得间接信息价值', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const graph = buildRegionGraph(fixture.scenario);
    const risks = fixture.scenario.regions.map(region => risk(region.id, 'critical'));
    const beliefs = priorBeliefsForRegions(policy, risks);
    const decision = decideJointInvestigation(policy, 'R_NORTH_STAND', beliefs, graph, {}, { maxSequence: 1 });
    const camera = decision.evaluations_by_round[0].find(item => item.action_id === 'A_CAMERA')!;
    const indirect = camera.contributions.filter(item => item.indirect_weight > 0);
    assert.ok(indirect.length > 0, '目标区域动作应对相关邻居产生间接权重');
  } finally {
    fixture.cleanup();
  }
});

test('预算耗尽后停止联合选择', () => {
  const fixture = makeMvpFixture();
  try {
    const policy = fixture.scenario.investigation!;
    const graph = buildRegionGraph(fixture.scenario);
    const risks = fixture.scenario.regions.map(region => risk(region.id, 'critical'));
    const beliefs = priorBeliefsForRegions(policy, risks);
    const decision = decideJointInvestigation(policy, 'R_EAST_STAND', beliefs, graph, {}, {
      usedActions: policy.budget?.max_actions ?? 3,
      usedCost: policy.budget?.max_total_cost ?? 1.2,
      usedTimeMinutes: policy.budget?.max_total_time_minutes ?? 8,
    });
    assert.equal(decision.selected.length, 0);
    assert.equal(decision.stop_reason, 'budget_exhausted');
  } finally {
    fixture.cleanup();
  }
});
