import assert from 'node:assert/strict';
import test from 'node:test';
import { countMetrics, evaluateDataset, matchPoints } from '../../src/services/perception/metrics';

test('定位匹配按半径统计 TP/FP/FN', () => {
  const result = matchPoints(
    [{ x: 10, y: 10 }, { x: 100, y: 100 }],
    [{ x: 12, y: 11 }, { x: 200, y: 200 }],
    5,
  );
  assert.equal(result.true_positives, 1);
  assert.equal(result.false_positives, 1);
  assert.equal(result.false_negatives, 1);
  assert.equal(result.precision, 0.5);
  assert.equal(result.recall, 0.5);
  assert.equal(result.f1, 0.5);
});

test('最大匹配优于贪心，避免因匹配顺序漏配', () => {
  const result = matchPoints(
    [{ x: 0.5, y: 0 }, { x: 0, y: 0.1 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    1,
  );
  assert.equal(result.true_positives, 2);
  assert.equal(result.false_negatives, 0);
});

test('计数指标 MAE/RMSE/NAE 正确', () => {
  const metrics = countMetrics([
    { region_id: 'a', ground_truth: 10, predicted: 12 },
    { region_id: 'b', ground_truth: 20, predicted: 18 },
  ]);
  assert.equal(metrics.n, 2);
  assert.equal(metrics.mae, 2);
  assert.equal(metrics.rmse, 2);
  assert.ok(Math.abs(metrics.nae - 4 / 30) < 1e-4);
});

test('数据集评测汇总计数与定位', () => {
  const result = evaluateDataset([
    {
      image: 'synthetic-1',
      ground_truth_points: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
      predicted_points: [{ x: 1.5, y: 1.5 }],
      ground_truth_count: 2,
      predicted_count: 1,
    },
  ], 3, 'synthetic-test');
  assert.equal(result.images, 1);
  assert.equal(result.count_metrics.mae, 1);
  assert.equal(result.localization.true_positives, 1);
  assert.equal(result.localization.false_negatives, 1);
  assert.equal(result.provenance, 'synthetic-test');
});
