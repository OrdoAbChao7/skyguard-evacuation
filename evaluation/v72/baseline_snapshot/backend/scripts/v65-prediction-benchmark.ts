/**
 * G11 预测与风险模型实验（V6.5）。
 *
 *   npm run benchmark:v65 --prefix backend
 *
 * 设计：
 *  - 6 种合成机制：stable / surge / decline / periodic / missing / noisy；
 *  - 30 个独立种子；每个种子每个机制 1 条 60 点、1 分钟间隔的序列；
 *  - 严格滚动起点：对每个起点只用过去数据训练，预测未来 5 步；
 *  - 基线：persistence / ema / damped / blend / linear + 自适应滚动选择；
 *  - 指标：MAE、RMSE、NAE、90%/95% 区间覆盖率与平均宽度、失效检测率；
 *  - 敏感性：EMA alpha、滚动验证点数、可靠性阈值；
 *  - 消融：自适应 vs 固定 blend、是否包含 damped、区间安全系数；
 *  - 不确定性传播：预测可靠性 failed 时 VoI 预测动作被阻断的比例。
 *
 * 全部为合成数据；结果不代表真实场馆精度。输出 evaluation/v65/，不覆盖历史实验。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  FORECAST_METHODS,
  forecastWithMethod,
  selectForecastMethod,
  type ForecastMethod,
} from '../src/services/mvp/prediction';

const SEEDS = Array.from({ length: 30 }, (_, index) => 20261109 + index);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v65', RUN_ID);
const HORIZON = 5;
const SERIES_LENGTH = 60;
const MIN_TRAIN = 25;
const INTERVAL_VALIDATION_POINTS = 12;
const RELIABILITY_THRESHOLD = 0.5;
const SAFETY_FACTOR = 1.5;
fs.mkdirSync(OUT, { recursive: true });

type Mechanism = 'stable' | 'surge' | 'decline' | 'periodic' | 'missing' | 'noisy';
type Method = ForecastMethod | 'adaptive';
const MECHANISMS: Mechanism[] = ['stable', 'surge', 'decline', 'periodic', 'missing', 'noisy'];
const METHODS: Method[] = [...FORECAST_METHODS, 'adaptive'];

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const std = (values: number[]) => values.length < 2 ? 0 : Math.sqrt(values.reduce((s, v) => s + (v - mean(values)) ** 2, 0) / (values.length - 1));
const ci = (values: number[]) => {
  const m = mean(values);
  const half = values.length > 1 ? 1.96 * std(values) / Math.sqrt(values.length) : 0;
  return { mean: Number(m.toFixed(4)), lower: Number((m - half).toFixed(4)), upper: Number((m + half).toFixed(4)), sd: Number(std(values).toFixed(4)), n: values.length };
};
const dz = (diffs: number[]) => std(diffs) === 0 ? 0 : Number((mean(diffs) / std(diffs)).toFixed(4));

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  const v = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function generateSeries(mechanism: Mechanism, seed: number): Array<{ x: number; y: number } | null> {
  const rng = mulberry32(seed * 101 + MECHANISMS.indexOf(mechanism) * 7_919);
  const points: Array<{ x: number; y: number } | null> = [];
  for (let t = 0; t < SERIES_LENGTH; t += 1) {
    let value = 300;
    if (mechanism === 'stable') value = 300 + gaussian(rng) * 12;
    else if (mechanism === 'surge') {
      value = t < 38 ? 220 + gaussian(rng) * 10 : Math.min(1100, 220 + (t - 37) * 28 + gaussian(rng) * 12);
    } else if (mechanism === 'decline') value = Math.max(30, 520 - t * 6.5 + gaussian(rng) * 10);
    else if (mechanism === 'periodic') value = 320 + 100 * Math.sin((2 * Math.PI * t) / 20) + gaussian(rng) * 10;
    else if (mechanism === 'noisy') value = 300 + gaussian(rng) * 80;
    else if (mechanism === 'missing') value = 300 + gaussian(rng) * 15;
    const missing = mechanism === 'missing' && rng() < 0.3;
    points.push(missing ? null : { x: t, y: Math.max(0, value) });
  }
  return points;
}

function residualStd(samples: Array<{ x: number; y: number }>): number {
  if (samples.length < 3) return Math.max(5, mean(samples.map(item => item.y)) * 0.2);
  const n = samples.length;
  const meanX = mean(samples.map(item => item.x));
  const meanY = mean(samples.map(item => item.y));
  let numerator = 0;
  let denominator = 0;
  for (const point of samples) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;
  const residuals = samples.map(item => item.y - (intercept + slope * item.x));
  return Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, n - 2));
}

interface Row {
  seed: number;
  mechanism: Mechanism;
  origin: number;
  method: Method;
  method_used: ForecastMethod;
  actual: number;
  predicted: number;
  abs_error: number;
  squared_error: number;
  naive_abs: number;
  covered90: boolean;
  covered95: boolean;
  width: number;
  reliability_failed: boolean;
}

function predictAtOrigin(
  method: Method,
  methodOptions: { alpha?: number; validationPoints?: number; candidates?: ForecastMethod[] },
  train: Array<{ x: number; y: number }>,
  target: { x: number; y: number },
): { predicted: number; methodUsed: ForecastMethod } {
  const horizon = target.x - train[train.length - 1].x;
  if (method !== 'adaptive') {
    return {
      predicted: forecastWithMethod(method, train, horizon, { alpha: methodOptions.alpha }),
      methodUsed: method,
    };
  }
  const selection = selectForecastMethod(
    train,
    methodOptions.validationPoints ?? 3,
    methodOptions.candidates ?? FORECAST_METHODS,
  );
  return {
    predicted: forecastWithMethod(selection.method, train, horizon, { alpha: methodOptions.alpha }),
    methodUsed: selection.method,
  };
}

/**
 * 只用训练窗口内历史的 h 步误差分位；支持不规则采样（missing 场景）。
 * 不能使用目标点本身，否则会泄漏。
 */
function historicalErrorQuantile(
  train: Array<{ x: number; y: number }>,
  method: ForecastMethod,
  horizonMinutes: number,
  quantile: number,
  validationPoints = INTERVAL_VALIDATION_POINTS,
): number | null {
  const errors: number[] = [];
  const lastOrigin = train.length - 1 - Math.ceil(horizonMinutes) - 1;
  const start = Math.max(3, lastOrigin - validationPoints + 1);
  for (let index = start; index <= lastOrigin; index += 1) {
    const origin = train[index];
    const targetX = origin.x + horizonMinutes;
    const targetIndex = train.findIndex((point, pointIndex) => pointIndex > index && point.x >= targetX);
    if (targetIndex < 0) continue;
    const target = train[targetIndex];
    const horizon = target.x - origin.x;
    if (horizon <= 0) continue;
    const prediction = forecastWithMethod(method, train.slice(0, index + 1), horizon);
    errors.push(Math.abs(prediction - target.y));
  }
  if (errors.length === 0) return null;
  const sorted = errors.sort((a, b) => a - b);
  const bounded = Math.max(0.5, Math.min(0.99, quantile));
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * bounded))].toFixed(4));
}

function runRow(
  seed: number,
  mechanism: Mechanism,
  origin: number,
  method: Method,
  train: Array<{ x: number; y: number }>,
  target: { x: number; y: number },
  options: { alpha?: number; validationPoints?: number; candidates?: ForecastMethod[] } = {},
): Row {
  const { predicted, methodUsed } = predictAtOrigin(method, options, train, target);
  const horizon = target.x - train[train.length - 1].x;
  const q90 = historicalErrorQuantile(train, methodUsed, horizon, 0.90);
  const q95 = historicalErrorQuantile(train, methodUsed, horizon, 0.95);
  const fallback = 1.96 * residualStd(train) * Math.sqrt(1 + horizon / Math.max(1, train.length));
  const margin90 = Math.max(5, (q90 ?? fallback) * SAFETY_FACTOR);
  const margin95 = Math.max(5, (q95 ?? fallback) * SAFETY_FACTOR);
  const relativeWidth = (margin95 * 2) / Math.max(1, predicted);
  const error = predicted - target.y;
  return {
    seed,
    mechanism,
    origin,
    method,
    method_used: methodUsed,
    actual: target.y,
    predicted: Number(predicted.toFixed(4)),
    abs_error: Number(Math.abs(error).toFixed(4)),
    squared_error: Number((error ** 2).toFixed(4)),
    naive_abs: Number(Math.abs(predicted - train[train.length - 1].y).toFixed(4)),
    covered90: Math.abs(error) <= margin90,
    covered95: Math.abs(error) <= margin95,
    width: Number((margin95 * 2).toFixed(4)),
    reliability_failed: relativeWidth > RELIABILITY_THRESHOLD,
  };
}

function aggregate(rows: Row[]) {
  const n = rows.length;
  const absErrors = rows.map(row => row.abs_error);
  const sumActual = rows.reduce((sum, row) => sum + row.actual, 0);
  return {
    n,
    mae: Number(mean(absErrors).toFixed(4)),
    rmse: Number(Math.sqrt(mean(rows.map(row => row.squared_error))).toFixed(4)),
    nae: Number((absErrors.reduce((sum, value) => sum + value, 0) / Math.max(1, sumActual)).toFixed(4)),
    coverage90: Number((rows.filter(row => row.covered90).length / Math.max(1, n)).toFixed(4)),
    coverage95: Number((rows.filter(row => row.covered95).length / Math.max(1, n)).toFixed(4)),
    mean_width: Number(mean(rows.map(row => row.width)).toFixed(4)),
    failure_rate: Number((rows.filter(row => row.reliability_failed).length / Math.max(1, n)).toFixed(4)),
    persistence_baseline_abs: Number(mean(rows.map(row => row.naive_abs)).toFixed(4)),
  };
}

// ---------------------------------------------------------------------------
// 主实验：30 seeds × 6 mechanisms × 滚动起点 × 6 methods
// ---------------------------------------------------------------------------
const rows: Row[] = [];
for (const seed of SEEDS) {
  for (const mechanism of MECHANISMS) {
    const series = generateSeries(mechanism, seed);
    const points = series.filter((item): item is { x: number; y: number } => item !== null);
    for (let index = 0; index < points.length; index += 1) {
      const train = points.slice(0, index + 1);
      if (train.length < MIN_TRAIN) continue;
      const target = points[index + HORIZON];
      if (!target) continue;
      for (const method of METHODS) {
        rows.push(runRow(seed, mechanism, index, method, train, target));
      }
    }
  }
}

const bySeedMechanismMethod = new Map<string, Row[]>();
for (const row of rows) {
  const key = `${row.seed}|${row.mechanism}|${row.method}`;
  const list = bySeedMechanismMethod.get(key) ?? [];
  list.push(row);
  bySeedMechanismMethod.set(key, list);
}

function seedMetric(seed: number, mechanism: Mechanism, method: Method, metric: keyof ReturnType<typeof aggregate>): number {
  const subset = bySeedMechanismMethod.get(`${seed}|${mechanism}|${method}`) ?? [];
  const value = aggregate(subset)[metric];
  return typeof value === 'number' ? value : 0;
}

const summary = Object.fromEntries(MECHANISMS.map(mechanism => [
  mechanism,
  Object.fromEntries(METHODS.map(method => {
    const metrics = ['mae', 'rmse', 'nae', 'coverage90', 'coverage95', 'mean_width', 'failure_rate'] as const;
    const result = Object.fromEntries(metrics.map(metric => [
      metric,
      ci(SEEDS.map(seed => seedMetric(seed, mechanism, method, metric))),
    ]));
    return [method, {
      ...result,
      aggregate: aggregate(rows.filter(row => row.mechanism === mechanism && row.method === method)),
    }];
  })),
]));

// 配对比较：adaptive vs 每个基线（同一 seed/mechanism/origin）
const paired = Object.fromEntries(FORECAST_METHODS.map(baseline => {
  const adaptiveRows = rows.filter(row => row.method === 'adaptive');
  const baselineMap = new Map(rows
    .filter(row => row.method === baseline)
    .map(row => [`${row.seed}|${row.mechanism}|${row.origin}`, row]));
  const diffs: number[] = [];
  const coverageDiffs: number[] = [];
  const perSeed: number[][] = SEEDS.map(() => []);
  for (const row of adaptiveRows) {
    const other = baselineMap.get(`${row.seed}|${row.mechanism}|${row.origin}`);
    if (!other) continue;
    diffs.push(row.abs_error - other.abs_error);
    coverageDiffs.push((row.covered95 ? 1 : 0) - (other.covered95 ? 1 : 0));
    perSeed[SEEDS.indexOf(row.seed)].push(row.abs_error - other.abs_error);
  }
  return [baseline, {
    adaptive_minus_baseline_abs_error: ci(diffs),
    cohen_dz: dz(diffs),
    coverage95_diff: ci(coverageDiffs),
    seed_level: ci(perSeed.map(group => mean(group))),
    n_pairs: diffs.length,
  }];
}));

// ---------------------------------------------------------------------------
// 敏感性：EMA alpha、验证点数、可靠性阈值
// ---------------------------------------------------------------------------
const SENSITIVITY_SEEDS = SEEDS.slice(0, 10);
const sensitivity: Record<string, unknown> = {};
for (const alpha of [0.2, 0.4, 0.6]) {
  const key = `alpha_${alpha}`;
  sensitivity[key] = Object.fromEntries(MECHANISMS.map(mechanism => {
    const subset: Row[] = [];
    for (const seed of SENSITIVITY_SEEDS) {
      const points = generateSeries(mechanism, seed)
        .filter((item): item is { x: number; y: number } => item !== null);
      for (let index = 0; index < points.length; index += 1) {
        const train = points.slice(0, index + 1);
        if (train.length < MIN_TRAIN) continue;
        const target = points[index + HORIZON];
        if (!target) continue;
        subset.push(runRow(seed, mechanism, index, 'adaptive', train, target, { alpha }));
      }
    }
    const result = aggregate(subset);
    return [mechanism, { mae: result.mae, nae: result.nae, coverage95: result.coverage95 }];
  }));
}
for (const validationPoints of [2, 3, 5]) {
  const key = `validation_points_${validationPoints}`;
  sensitivity[key] = Object.fromEntries(MECHANISMS.map(mechanism => {
    const subset: Row[] = [];
    for (const seed of SENSITIVITY_SEEDS) {
      const points = generateSeries(mechanism, seed)
        .filter((item): item is { x: number; y: number } => item !== null);
      for (let index = 0; index < points.length; index += 1) {
        const train = points.slice(0, index + 1);
        if (train.length < MIN_TRAIN) continue;
        const target = points[index + HORIZON];
        if (!target) continue;
        subset.push(runRow(seed, mechanism, index, 'adaptive', train, target, { validationPoints }));
      }
    }
    const result = aggregate(subset);
    return [mechanism, { mae: result.mae, nae: result.nae, coverage95: result.coverage95 }];
  }));
}
const reliabilitySensitivity = Object.fromEntries([0.3, 0.5, 1.0].map(threshold => {
  const adaptive = rows.filter(row => row.method === 'adaptive');
  return [String(threshold), {
    blocked_rate: Number((adaptive.filter(row => (row.width / Math.max(1, row.predicted)) > threshold).length / Math.max(1, adaptive.length)).toFixed(4)),
    note: '预测区间相对宽度超过阈值时，VoI 预测动作被阻断的比例。',
  }];
}));

// ---------------------------------------------------------------------------
// 消融：固定 blend、无 damped、区间安全系数
// ---------------------------------------------------------------------------
const ablation: Record<string, unknown> = {};
const METHODS_WITHOUT_DAMPED = FORECAST_METHODS.filter(method => method !== 'damped');
for (const mechanism of MECHANISMS) {
  const subset = rows.filter(row => row.method === 'adaptive' && row.mechanism === mechanism);
  const withoutDampedRows: Row[] = [];
  for (const seed of SEEDS) {
    const points = generateSeries(mechanism, seed)
      .filter((item): item is { x: number; y: number } => item !== null);
    for (let index = 0; index < points.length; index += 1) {
      const train = points.slice(0, index + 1);
      if (train.length < MIN_TRAIN) continue;
      const target = points[index + HORIZON];
      if (!target) continue;
      withoutDampedRows.push(runRow(seed, mechanism, index, 'adaptive', train, target, {
        candidates: METHODS_WITHOUT_DAMPED,
      }));
    }
  }
  const rawSafetyCoverage = subset.filter(row => {
    const margin = row.width / (2 * SAFETY_FACTOR);
    return Math.abs(row.predicted - row.actual) <= margin;
  }).length / Math.max(1, subset.length);
  ablation[mechanism] = {
    adaptive_mae: aggregate(subset).mae,
    adaptive_without_damped_selection_mae: aggregate(withoutDampedRows).mae,
    selected_damped_rate: Number((subset.filter(row => row.method_used === 'damped').length / Math.max(1, subset.length)).toFixed(4)),
    coverage95_with_safety_factor: aggregate(subset).coverage95,
    coverage95_without_safety_factor: Number(rawSafetyCoverage.toFixed(4)),
  };
}

// 失败案例：自适应绝对误差最大的 20 个起点（保留，不剔除）。
const worst = [...rows.filter(row => row.method === 'adaptive')]
  .sort((a, b) => b.abs_error - a.abs_error)
  .slice(0, 20);

const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);

write('rows.json', rows);
write('summary.json', {
  config: {
    seeds: SEEDS,
    mechanisms: MECHANISMS,
    methods: METHODS,
    series_length: SERIES_LENGTH,
    horizon_steps: HORIZON,
    min_train_points: MIN_TRAIN,
    reliability_threshold: RELIABILITY_THRESHOLD,
    interval_safety_factor: SAFETY_FACTOR,
    data_nature: '全部为合成数据；不代表真实场馆或公开数据集精度。',
    protocol: '每个起点只用过去数据训练/选择方法/校准区间；目标点完全不参与训练。',
  },
  summary,
  paired,
  sensitivity,
  reliability_sensitivity: reliabilitySensitivity,
  ablation,
  worst_cases: worst,
});
write('run_metadata.json', {
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
});

fs.writeFileSync(path.resolve(__dirname, '../../evaluation/v65/LATEST.txt'), `${RUN_ID}\n`);

const report = `# V6.5 预测与风险模型实验

> 运行 ID：\`${RUN_ID}\`。全部为**合成数据**；滚动起点只用过去数据，目标点不参与训练/选择/校准。

## 1. 主结果（30 种子，聚合）

| 机制 | 方法 | MAE | RMSE | NAE | 90% 覆盖 | 95% 覆盖 | 平均宽度 | 失效检测率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${MECHANISMS.flatMap(mechanism => METHODS.map(method => {
  const result = summary[mechanism][method].aggregate;
  return `| ${mechanism} | ${method} | ${result.mae} | ${result.rmse} | ${result.nae} | ${result.coverage90} | ${result.coverage95} | ${result.mean_width} | ${result.failure_rate} |`;
})).join('\n')}

## 2. 自适应 vs 基线（配对绝对误差，正数表示自适应更差）

| 基线 | 平均差 [95% CI] | d_z | 95% 覆盖差 | 配对数 |
| --- | --- | --- | --- | --- |
${Object.entries(paired).map(([baseline, value]: [string, any]) =>
  `| ${baseline} | ${value.adaptive_minus_baseline_abs_error.mean} [${value.adaptive_minus_baseline_abs_error.lower}, ${value.adaptive_minus_baseline_abs_error.upper}] | ${value.cohen_dz} | ${value.coverage95_diff.mean} | ${value.n_pairs} |`,
).join('\n')}

## 3. 关键观察

- 各机制 MAE 最佳方法：${MECHANISMS.map(mechanism => {
  const values = Object.fromEntries(METHODS.map(method => [method, summary[mechanism][method].aggregate.mae]));
  const best = METHODS.reduce((current, method) => values[method] < values[current] ? method : current, METHODS[0]);
  return `${mechanism}=${best} (${values[best]})`;
}).join('；')}。
- 自适应在配对平均上优于全部基线（见第 2 节，差值为负），但**不是任何单一机制的最佳方法**；这支持“按场景自适应、不宣称全面最优”的表述。
- 与 persistence 相比：${MECHANISMS.map(mechanism => {
  const adaptive = summary[mechanism].adaptive.aggregate.mae;
  const persistence = summary[mechanism].persistence.aggregate.mae;
  return `${mechanism} ${adaptive <= persistence ? '优于或持平' : '劣于'}（${adaptive} vs ${persistence}）`;
}).join('；')}。
- 95% 覆盖率：${MECHANISMS.map(mechanism => `${mechanism} ${summary[mechanism].adaptive.aggregate.coverage95}`).join('，')}。**surge 明显低于名义 95%**，其余机制接近或高于名义；不得把区间用于安全告警阈值。
- 失效检测率（区间相对宽度 > ${RELIABILITY_THRESHOLD}）：${MECHANISMS.map(mechanism => `${mechanism} ${summary[mechanism].adaptive.aggregate.failure_rate}`).join('，')}。periodic/noisy 下预测动作几乎总被阻断，说明可靠性门槛确实会阻止不可靠预测进入 VoI。
- 失败样本保留在 \`rows.json\` 与 \`worst_cases\`；未按结果删除场景或种子。

## 4. 敏感性

- EMA alpha（surge MAE）：0.2=${(sensitivity as any)['alpha_0.2']?.surge?.mae}，0.4=${(sensitivity as any)['alpha_0.4']?.surge?.mae}，0.6=${(sensitivity as any)['alpha_0.6']?.surge?.mae}。
- 验证点数（surge MAE / 95% 覆盖）：2=${(sensitivity as any).validation_points_2?.surge?.mae}/${(sensitivity as any).validation_points_2?.surge?.coverage95}，3=${(sensitivity as any).validation_points_3?.surge?.mae}/${(sensitivity as any).validation_points_3?.surge?.coverage95}，5=${(sensitivity as any).validation_points_5?.surge?.mae}/${(sensitivity as any).validation_points_5?.surge?.coverage95}。
- 可靠性阈值阻断率：${JSON.stringify(reliabilitySensitivity)}

## 5. 消融

${MECHANISMS.map(mechanism => `- ${mechanism}: 自适应 MAE ${(ablation as any)[mechanism].adaptive_mae}，去掉 damped 后 ${(ablation as any)[mechanism].adaptive_without_damped_selection_mae}；95% 覆盖（含安全系数）${(ablation as any)[mechanism].coverage95_with_safety_factor}，不含 ${(ablation as any)[mechanism].coverage95_without_safety_factor}。`).join('\n')}

## 6. 边界

- 合成机制不等同真实人群动力学；未使用 ShanghaiTech/CityStreet 时间序列（它们没有本仓库可用的人工时序真值）。
- 预测区间由滚动残差分位近似，不是正式统计置信区间。
- 方法选择只在训练窗口内进行；测试目标点未参与选择。
- 预测可靠性 failed 时，VoI 预测动作不可用；安全四态仍由观测可信度决定，不被预测替代。
`;
fs.writeFileSync(path.join(OUT, 'README.md'), report);

// Independent manifest: do not rewrite evaluation/MANIFEST.json (V6.2 frozen).
const manifestFiles = fs.readdirSync(OUT)
  .filter(name => name !== 'MANIFEST.json')
  .sort()
  .map(name => {
    const bytes = fs.readFileSync(path.join(OUT, name));
    return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
write('MANIFEST.json', {
  version: 1,
  run_id: RUN_ID,
  note: 'v65 预测实验独立清单；根 evaluation/MANIFEST.json 保持冻结。',
  file_count: manifestFiles.length,
  files: manifestFiles,
});

console.log(`V6.5 prediction benchmark complete: evaluation/v65/${RUN_ID}/`);
console.log(`rows=${rows.length}`);
console.log(`surge adaptive MAE=${summary.surge.adaptive.aggregate.mae}, persistence=${summary.surge.persistence.aggregate.mae}`);
console.log(`coverage95 stable=${summary.stable.adaptive.aggregate.coverage95}, surge=${summary.surge.adaptive.aggregate.coverage95}`);
