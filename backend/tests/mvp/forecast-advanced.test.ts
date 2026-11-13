import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arimaForecast,
  baseModelForecast,
  detectRegime,
  ensembleForecast,
  holtWintersForecast,
  kalmanForecastHorizon,
  lstmForecast,
  type SeriesPoint,
} from '../../src/services/mvp/forecast-advanced';

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number): number {
  const u = Math.max(1e-9, random());
  const v = Math.max(1e-9, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function series(values: number[]): SeriesPoint[] {
  return values.map((value, index) => ({ x: index, y: value }));
}

test('ensemble 确定性：同样输入产生完全相同输出', () => {
  const random = rng(7);
  const data = series(Array.from({ length: 40 }, (_, index) => 300 + index * 2 + gaussian(random) * 8));
  const first = ensembleForecast(data, { horizonMinutes: 5, seed: 42 });
  const second = ensembleForecast(data, { horizonMinutes: 5, seed: 42 });
  assert.deepEqual(first, second);
  assert.ok(Number.isFinite(first.predicted) && first.predicted >= 0);
});

test('Kalman 对线性趋势序列外推接近真实值', () => {
  const data = series(Array.from({ length: 30 }, (_, index) => 100 + 5 * index));
  const result = kalmanForecastHorizon(data, 5);
  assert.ok(Math.abs(result.predicted - (100 + 5 * 29 + 25)) < 10, `predicted=${result.predicted}`);
});

test('ARIMA 对常数序列保持常数', () => {
  const result = arimaForecast(series(new Array(30).fill(250)), 5);
  assert.ok(Math.abs(result.predicted - 250) < 1e-6, `predicted=${result.predicted}`);
});

test('Holt-Winters 在周期性序列上输出有限且非负', () => {
  const values = Array.from({ length: 60 }, (_, index) => 320 + 80 * Math.sin((2 * Math.PI * index) / 20));
  const result = holtWintersForecast(series(values), 5);
  assert.ok(Number.isFinite(result.predicted));
  assert.ok(result.predicted >= 0);
});

test('LSTM 基线确定性且输出有限', () => {
  const random = rng(11);
  const data = series(Array.from({ length: 40 }, () => 200 + gaussian(random) * 20));
  const first = lstmForecast(data, 5, 99);
  const second = lstmForecast(data, 5, 99);
  assert.equal(first.predicted, second.predicted);
  assert.ok(Number.isFinite(first.predicted) && first.predicted >= 0);
});

test('regime 检测区分稳定、突增与周期性序列', () => {
  const stableRandom = rng(5);
  const stable = detectRegime(series(Array.from({ length: 40 }, () => 300 + gaussian(stableRandom) * 3)));
  const surge = detectRegime(series(Array.from({ length: 40 }, (_, index) => (index < 30 ? 200 : 200 + (index - 29) * 25))));
  const periodic = detectRegime(series(Array.from({ length: 60 }, (_, index) => 320 + 90 * Math.sin((2 * Math.PI * index) / 20))));
  assert.equal(stable.label, 'stable');
  assert.equal(surge.label, 'surge');
  assert.equal(periodic.label, 'periodic');
});

test('数据不足时回退为最近观测并标记 failed', () => {
  const result = ensembleForecast(series([100, 102]), { horizonMinutes: 5 });
  assert.equal(result.predicted, 102);
  assert.equal(result.reliability.status, 'failed');
  assert.deepEqual(result.effective_methods, ['persistence']);
});

test('conformal 区间在稳定噪声序列上接近名义覆盖率', () => {
  const covered: boolean[] = [];
  for (let seed = 0; seed < 25; seed += 1) {
    const random = rng(1000 + seed);
    const values = Array.from({ length: 70 }, () => 300 + gaussian(random) * 10);
    const data = series(values);
    for (let origin = 45; origin <= 60; origin += 1) {
      const prefix = data.slice(0, origin + 1);
      const target = values[origin + 5];
      const result = ensembleForecast(prefix, { horizonMinutes: 5, seed: 7 });
      covered.push(target >= result.interval90.lower && target <= result.interval90.upper);
    }
  }
  const coverage = covered.filter(Boolean).length / covered.length;
  assert.ok(coverage >= 0.8, `90% 区间经验覆盖率 ${coverage.toFixed(3)} 低于 0.8`);
});

test('基础模型 dispatch 覆盖全部方法且不抛错', () => {
  const data = series(Array.from({ length: 25 }, (_, index) => 200 + index));
  for (const method of ['persistence', 'ema', 'damped', 'blend', 'linear', 'kalman', 'arima', 'holt_winters'] as const) {
    const value = baseModelForecast(method, data, 5, 1);
    assert.ok(Number.isFinite(value), `${method} 返回非有限值`);
    assert.ok(value >= 0, `${method} 返回负值`);
  }
});
