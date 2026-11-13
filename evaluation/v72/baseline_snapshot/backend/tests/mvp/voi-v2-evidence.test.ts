import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const EVAL = path.resolve(__dirname, '../../../evaluation/voi-v2');
const LATEST = path.join(EVAL, 'LATEST.txt');

interface Row {
  strategy: string;
  seed: number;
  trial: number;
  initial_risk: number;
  final_risk: number;
  benefit: number;
  cost: number;
}

test('V6.4 公平 VoI 原始数据可复算 benefit/cost/efficiency', () => {
  assert.equal(fs.existsSync(LATEST), true, '缺少 evaluation/voi-v2/LATEST.txt');
  const runId = fs.readFileSync(LATEST, 'utf8').trim();
  const dir = path.join(EVAL, runId);
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'experiment_a_fair.json'), 'utf8')) as {
    summary: Record<string, { efficiency: { mean: number }; benefit: { mean: number }; cost: { mean: number } }>;
    paired: {
      trial_level: { mean: number };
      efficiency_diff: { mean: number };
      cost_diff: { mean: number };
    };
    raw: Row[];
  };
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

  for (const row of result.raw) {
    assert.ok(Math.abs(row.benefit - (row.initial_risk - row.final_risk)) <= 5e-6, `benefit 不复算: ${row.strategy}/${row.seed}/${row.trial}`);
    assert.ok(row.cost >= 0);
  }

  for (const [strategy, summary] of Object.entries(result.summary)) {
    const rows = result.raw.filter(row => row.strategy === strategy);
    const benefit = mean(rows.map(row => row.benefit));
    const cost = mean(rows.map(row => row.cost));
    const efficiency = mean(rows.map(row => row.benefit / Math.max(1e-6, row.cost)));
    assert.ok(Math.abs(summary.benefit.mean - benefit) <= 5e-4, `${strategy} benefit 均值不一致`);
    assert.ok(Math.abs(summary.cost.mean - cost) <= 5e-4, `${strategy} cost 均值不一致`);
    assert.ok(Math.abs(summary.efficiency.mean - efficiency) <= 5e-4, `${strategy} efficiency 均值不一致`);
  }

  const multi = result.raw.filter(row => row.strategy === 'multi');
  const single = result.raw.filter(row => row.strategy === 'single');
  const diff = mean(multi.map((row, index) => row.benefit - single[index].benefit));
  const efficiencyDiff = mean(multi.map((row, index) =>
    row.benefit / Math.max(1e-6, row.cost) - single[index].benefit / Math.max(1e-6, single[index].cost)));
  const costDiff = mean(multi.map((row, index) => row.cost - single[index].cost));
  assert.ok(Math.abs(result.paired.trial_level.mean - diff) <= 5e-4, '配对差不可复算');
  assert.ok(Math.abs(result.paired.efficiency_diff.mean - efficiencyDiff) <= 5e-4, '效率差不可复算');
  assert.ok(Math.abs(result.paired.cost_diff.mean - costDiff) <= 5e-4, '成本差不可复算');
});
