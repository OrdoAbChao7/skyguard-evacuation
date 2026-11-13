import assert from 'node:assert/strict';
import test from 'node:test';
import { makeMvpFixture, ingestObservation, ADMIN } from './fixtures';

function seedAll(fixture: ReturnType<typeof makeMvpFixture>, count = 300) {
  for (const region of fixture.scenario.regions) {
    if (!region.enabled) continue;
    ingestObservation(fixture, region.id, count, 0.95);
  }
}

test('Shadow Mode 开启时只记录比较，不替换 legacy 发布方案', () => {
  const fixture = makeMvpFixture();
  const previous = process.env.V7_SHADOW_MODE;
  const previousBudget = process.env.V7_SHADOW_MAX_SOLVE_MS;
  try {
    process.env.V7_SHADOW_MODE = '1';
    process.env.V7_SHADOW_MAX_SOLVE_MS = '500';
    seedAll(fixture);
    const result = fixture.safety.recompute(ADMIN, 'test:shadow-on');
    assert.ok(result.plan);
    assert.ok(result.validation?.valid);
    assert.equal(fixture.safety.getPlan()?.plan_id, result.plan!.plan_id);

    const comparisons = fixture.safety.getShadowComparisons();
    assert.equal(comparisons.length, 1);
    const comparison = comparisons[0];
    assert.equal(comparison.legacy.plan_id, result.plan!.plan_id);
    assert.equal(comparison.snapshot.scenario_version, fixture.scenario.version);
    assert.equal(comparison.snapshot.hash.length, 64);
    assert.ok(comparison.v7);
    assert.notEqual(comparison.v7!.plan_id, comparison.legacy.plan_id);
    assert.equal(comparison.v7!.validation_valid, true, JSON.stringify(comparison.v7!.violation_codes));
    assert.ok(['legacy_only', 'v7_eligible_for_review'].includes(comparison.decision));
    assert.ok(result.trace.stages.some(stage => stage.stage === 'shadow_comparison'));
  } finally {
    if (previous === undefined) delete process.env.V7_SHADOW_MODE;
    else process.env.V7_SHADOW_MODE = previous;
    if (previousBudget === undefined) delete process.env.V7_SHADOW_MAX_SOLVE_MS;
    else process.env.V7_SHADOW_MAX_SOLVE_MS = previousBudget;
    fixture.cleanup();
  }
});

test('Shadow Mode 关闭时不运行 V7 比较', () => {
  const fixture = makeMvpFixture();
  const previous = process.env.V7_SHADOW_MODE;
  try {
    delete process.env.V7_SHADOW_MODE;
    seedAll(fixture);
    const result = fixture.safety.recompute(ADMIN, 'test:shadow-off');
    assert.ok(result.plan);
    assert.equal(fixture.safety.getShadowComparisons().length, 0);
    assert.ok(!result.trace.stages.some(stage => stage.stage === 'shadow_comparison'));
  } finally {
    if (previous === undefined) delete process.env.V7_SHADOW_MODE;
    else process.env.V7_SHADOW_MODE = previous;
    fixture.cleanup();
  }
});

test('Shadow 预算为零时自动回退，legacy 方案不受影响', () => {
  const fixture = makeMvpFixture();
  const previous = process.env.V7_SHADOW_MODE;
  const previousBudget = process.env.V7_SHADOW_MAX_SOLVE_MS;
  try {
    process.env.V7_SHADOW_MODE = '1';
    process.env.V7_SHADOW_MAX_SOLVE_MS = '0';
    seedAll(fixture);
    const result = fixture.safety.recompute(ADMIN, 'test:shadow-timeout');
    assert.ok(result.plan);
    assert.ok(result.validation?.valid);
    const comparisons = fixture.safety.getShadowComparisons();
    assert.equal(comparisons.length, 1);
    assert.equal(comparisons[0].v7, null);
    assert.equal(comparisons[0].fallback_reason, 'solve_budget_zero');
    assert.equal(comparisons[0].decision, 'legacy_only');
    assert.equal(fixture.safety.getPlan()?.plan_id, result.plan!.plan_id);
  } finally {
    if (previous === undefined) delete process.env.V7_SHADOW_MODE;
    else process.env.V7_SHADOW_MODE = previous;
    if (previousBudget === undefined) delete process.env.V7_SHADOW_MAX_SOLVE_MS;
    else process.env.V7_SHADOW_MAX_SOLVE_MS = previousBudget;
    fixture.cleanup();
  }
});

test('Shadow 记录在 reset 后清空', () => {
  const fixture = makeMvpFixture();
  const previous = process.env.V7_SHADOW_MODE;
  try {
    process.env.V7_SHADOW_MODE = '1';
    seedAll(fixture);
    fixture.safety.recompute(ADMIN, 'test:shadow-reset');
    assert.equal(fixture.safety.getShadowComparisons().length, 1);
    fixture.safety.reset(ADMIN);
    assert.equal(fixture.safety.getShadowComparisons().length, 0);
  } finally {
    if (previous === undefined) delete process.env.V7_SHADOW_MODE;
    else process.env.V7_SHADOW_MODE = previous;
    fixture.cleanup();
  }
});
