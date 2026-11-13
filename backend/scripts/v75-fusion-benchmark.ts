/**
 * V7.5 Track E：多传感器不确定性融合实验。
 *
 *   npm run benchmark:v75 --prefix backend -- --only=fusion
 *
 * 30 种子 × 9 条件 × 5 方法；合成读数。
 * 条件覆盖：干净、噪声、单传感器偏置、丢包、时延、冲突、时钟偏移、重复、过期。
 * 指标：可用率、MAE/RMSE、冲突/时钟偏移 fail-closed 率、过期/重复拒绝率、
 * 以及在“应当拒绝”的条件下仍输出数值的 unsafe fusion 次数。
 *
 * 边界：传感器噪声/可靠度/时间戳均为合成；不代表真实摄像机或无人机测量精度。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DEFAULT_FUSION_CONFIG,
  fuseSensorReadings,
  type SensorReading,
} from '../src/services/safety/fusion/fusion';

const RUN_ID = process.env.V75_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v75', RUN_ID);
const SEEDS = Array.from({ length: 30 }, (_, index) => 20261111 + index);

const CONDITIONS = [
  'clean', 'noisy', 'biased', 'dropout', 'delayed',
  'conflict', 'clock_skew', 'duplicate', 'stale',
] as const;
type Condition = (typeof CONDITIONS)[number];

/** 在这些条件下必须 fail-closed：冲突无法消解、时钟偏移超出容差。 */
const STRICT_CONDITIONS: Condition[] = ['conflict', 'clock_skew'];
/** 在这些条件下应给出可用的融合值。 */
const BENIGN_CONDITIONS: Condition[] = ['clean', 'noisy', 'biased', 'dropout', 'delayed', 'duplicate'];

const STEPS = 40;
const BASE_TIME = Date.UTC(2026, 10, 10, 1, 0, 0);
const REGION = 'R_PLATFORM';

interface SensorSpec { id: string; reliability: number; confidence: number; sigma: number; kind: 'camera' | 'drone' }
const SENSORS: SensorSpec[] = [
  { id: 'cam-1', reliability: 0.9, confidence: 0.9, sigma: 4, kind: 'camera' },
  { id: 'cam-2', reliability: 0.8, confidence: 0.85, sigma: 6, kind: 'camera' },
  { id: 'drone-1', reliability: 0.6, confidence: 0.7, sigma: 9, kind: 'drone' },
];

const METHODS = ['best_single', 'mean', 'median', 'reliability_weighted', 'pipeline'] as const;
type MethodId = (typeof METHODS)[number];

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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface StepFixture {
  now: number;
  trueValue: number;
  readings: SensorReading[];
}

function generate(condition: Condition, seed: number): StepFixture[] {
  const rng = mulberry32(seed * 1009 + CONDITIONS.indexOf(condition) * 104_729 + 7);
  // 故障传感器按种子轮换（10/10/10），避免故障总是落在权重最低的传感器上。
  const fault = SENSORS[seed % SENSORS.length];
  const fixtures: StepFixture[] = [];
  for (let t = 0; t < STEPS; t += 1) {
    const now = BASE_TIME + t * 1000;
    const trueValue = 300 + 12 * Math.sin(t / 5) + gaussian(rng) * 3;
    const noiseScale = condition === 'noisy' ? 4 : 1;
    const readings: SensorReading[] = [];
    for (const sensor of SENSORS) {
      if (condition === 'dropout' && rng() < 0.3) continue;
      let value = trueValue + gaussian(rng) * sensor.sigma * noiseScale;
      let observedAt = now;
      if (condition === 'biased' && sensor.id === fault.id) value += 40;
      if (condition === 'conflict' && sensor.id === fault.id) value += 200;
      if (condition === 'delayed' && sensor.id === fault.id) observedAt = now - 3000;
      if (condition === 'clock_skew' && sensor.id === fault.id) observedAt = now - 9000;
      if (condition === 'stale' && sensor.id === fault.id) observedAt = now - 40_000;
      const reading: SensorReading = {
        sensorId: sensor.id,
        regionId: REGION,
        value: Number(value.toFixed(3)),
        observedAt,
        receivedAt: now,
        confidence: sensor.confidence,
        reliability: sensor.reliability,
        kind: sensor.kind,
      };
      readings.push(reading);
      if (condition === 'duplicate') {
        // 同一传感器同一观测时间重复上报，但数值略有差异：若被平均会引入噪声。
        readings.push({ ...reading, value: Number((value + gaussian(rng) * 2).toFixed(3)) });
      }
    }
    fixtures.push({ now, trueValue, readings });
  }
  return fixtures;
}

function weightOf(reading: SensorReading): number {
  return clamp01(reading.reliability ?? 0.5) * clamp01(reading.confidence ?? 0.5);
}

interface MethodOutput {
  usable: boolean;
  value: number | null;
  status: string;
  uncertainty: number | null;
  rejected: string[];
}

function runMethod(method: MethodId, readings: SensorReading[], now: number): MethodOutput {
  if (method === 'pipeline') {
    const result = fuseSensorReadings(readings, now);
    return {
      usable: result.usable,
      value: result.value,
      status: result.status,
      uncertainty: result.uncertainty,
      rejected: result.rejected.map(item => item.reason),
    };
  }
  if (readings.length === 0) {
    return { usable: false, value: null, status: 'no_readings', uncertainty: null, rejected: [] };
  }
  const values = readings.map(reading => reading.value);
  if (method === 'best_single') {
    const best = [...readings].sort((a, b) => weightOf(b) - weightOf(a))[0];
    return { usable: true, value: best.value, status: 'raw', uncertainty: null, rejected: [] };
  }
  if (method === 'mean') {
    return { usable: true, value: mean(values), status: 'raw', uncertainty: null, rejected: [] };
  }
  if (method === 'median') {
    return { usable: true, value: median(values), status: 'raw', uncertainty: null, rejected: [] };
  }
  const totalWeight = readings.reduce((sum, reading) => sum + weightOf(reading), 0);
  const value = readings.reduce((sum, reading) => sum + reading.value * weightOf(reading), 0) / Math.max(1e-6, totalWeight);
  return { usable: true, value, status: 'raw', uncertainty: null, rejected: [] };
}

const REJECT_REASONS = [
  'stale', 'duplicate', 'clock_skew_exceeds_limit', 'low_reliability',
  'future_timestamp', 'invalid_value', 'invalid_timestamp', 'region_mismatch',
] as const;

interface Row {
  condition: Condition;
  seed: number;
  method: MethodId;
  /** 被注入故障的传感器；无故障条件为 null。 */
  fault_sensor: string | null;
  steps: number;
  usable_steps: number;
  availability: number;
  /** 平均绝对误差（仅在给出可用数值的步上统计）。 */
  mae: number | null;
  /** 平均带符号误差，正值表示高估。 */
  bias: number | null;
  rmse: number | null;
  mean_uncertainty: number | null;
  unsafe_fusions: number;
  false_failcloses: number;
  status_counts: Record<string, number>;
  rejected: Record<string, number>;
}

const rows: Row[] = [];
const FAULT_CONDITIONS: Condition[] = ['biased', 'conflict', 'delayed', 'clock_skew', 'stale'];
for (const condition of CONDITIONS) {
  for (const seed of SEEDS) {
    const fixtures = generate(condition, seed);
    const faultSensorId = FAULT_CONDITIONS.includes(condition) ? SENSORS[seed % SENSORS.length].id : null;
    for (const method of METHODS) {
      let usableSteps = 0;
      let absErrSum = 0;
      let signedErrSum = 0;
      let sqErrSum = 0;
      let errCount = 0;
      let uncertaintySum = 0;
      let uncertaintyCount = 0;
      let unsafeFusions = 0;
      let falseFailcloses = 0;
      const statusCounts: Record<string, number> = {};
      const rejected: Record<string, number> = Object.fromEntries(REJECT_REASONS.map(reason => [reason, 0]));

      for (const fixture of fixtures) {
        const output = runMethod(method, fixture.readings, fixture.now);
        statusCounts[output.status] = (statusCounts[output.status] ?? 0) + 1;
        for (const reason of output.rejected) {
          if (reason in rejected) rejected[reason] += 1;
        }
        if (output.usable) {
          usableSteps += 1;
          if (STRICT_CONDITIONS.includes(condition)) unsafeFusions += 1;
          if (output.value !== null) {
            const error = output.value - fixture.trueValue;
            absErrSum += Math.abs(error);
            signedErrSum += error;
            sqErrSum += error * error;
            errCount += 1;
          }
          if (output.uncertainty !== null) {
            uncertaintySum += output.uncertainty;
            uncertaintyCount += 1;
          }
        } else if (BENIGN_CONDITIONS.includes(condition)) {
          falseFailcloses += 1;
        }
      }

      rows.push({
        condition,
        seed,
        method,
        fault_sensor: faultSensorId,
        steps: fixtures.length,
        usable_steps: usableSteps,
        availability: Number((usableSteps / Math.max(1, fixtures.length)).toFixed(4)),
        mae: errCount ? Number((absErrSum / errCount).toFixed(4)) : null,
        bias: errCount ? Number((signedErrSum / errCount).toFixed(4)) : null,
        rmse: errCount ? Number(Math.sqrt(sqErrSum / errCount).toFixed(4)) : null,
        mean_uncertainty: uncertaintyCount ? Number((uncertaintySum / uncertaintyCount).toFixed(4)) : null,
        unsafe_fusions: unsafeFusions,
        false_failcloses: falseFailcloses,
        status_counts: statusCounts,
        rejected,
      });
    }
  }
}

const nonNull = (values: Array<number | null>): number[] => values.filter((value): value is number => value !== null);
const meanOrNull = (values: Array<number | null>): number | null => {
  const present = nonNull(values);
  return present.length ? Number(mean(present).toFixed(4)) : null;
};

const byMethodCondition: Record<string, Record<string, unknown>> = {};
for (const method of METHODS) {
  byMethodCondition[method] = {};
  for (const condition of CONDITIONS) {
    const subset = rows.filter(row => row.method === method && row.condition === condition);
    byMethodCondition[method][condition] = {
      n: subset.length,
      availability: Number(mean(subset.map(row => row.availability)).toFixed(4)),
      mae: meanOrNull(subset.map(row => row.mae)),
      bias: meanOrNull(subset.map(row => row.bias)),
      rmse: meanOrNull(subset.map(row => row.rmse)),
      mean_uncertainty: meanOrNull(subset.map(row => row.mean_uncertainty)),
      mean_unsafe_fusions: Number(mean(subset.map(row => row.unsafe_fusions)).toFixed(3)),
      mean_false_failcloses: Number(mean(subset.map(row => row.false_failcloses)).toFixed(3)),
      rejections: Object.fromEntries(REJECT_REASONS.map(reason => [
        reason,
        subset.reduce((sum, row) => sum + row.rejected[reason], 0),
      ])),
    };
  }
}

const overall: Record<string, unknown> = {};
for (const method of METHODS) {
  const subset = rows.filter(row => row.method === method);
  const stepsTotal = subset.reduce((sum, row) => sum + row.steps, 0);
  const unsafe = subset.reduce((sum, row) => sum + row.unsafe_fusions, 0);
  const falseFail = subset.reduce((sum, row) => sum + row.false_failcloses, 0);
  const strictSteps = subset.filter(row => STRICT_CONDITIONS.includes(row.condition)).reduce((sum, row) => sum + row.steps, 0);
  const benignSteps = subset.filter(row => BENIGN_CONDITIONS.includes(row.condition)).reduce((sum, row) => sum + row.steps, 0);
  overall[method] = {
    availability: Number(mean(subset.map(row => row.availability)).toFixed(4)),
    // MAE/RMSE/偏差只在给出可用数值的步上统计（覆盖-精度权衡需与可用率一起看）。
    mae: meanOrNull(subset.map(row => row.mae)),
    bias: meanOrNull(subset.map(row => row.bias)),
    rmse: meanOrNull(subset.map(row => row.rmse)),
    unsafe_fusions: unsafe,
    unsafe_fuse_rate_on_strict: strictSteps ? Number((unsafe / strictSteps).toFixed(4)) : 0,
    false_failcloses: falseFail,
    false_failclose_rate_on_benign: benignSteps ? Number((falseFail / benignSteps).toFixed(4)) : 0,
    decision_accuracy: stepsTotal ? Number((1 - (unsafe + falseFail) / stepsTotal).toFixed(4)) : 0,
  };
}

const pipeline = (condition: Condition, key: string) => (byMethodCondition.pipeline[condition] as any)[key];
const pipelineDiagnostics = {
  conflict_failclosed_rate: Number((1 - pipeline('conflict', 'availability')).toFixed(4)),
  clock_skew_failclosed_rate: Number((1 - pipeline('clock_skew', 'availability')).toFixed(4)),
  stale_rejections_total: (byMethodCondition.pipeline.stale as any).rejections.stale,
  duplicate_rejections_total: (byMethodCondition.pipeline.duplicate as any).rejections.duplicate,
  low_reliability_rejections_total: Object.fromEntries(REJECT_REASONS.map(reason => [
    reason,
    (Object.values(byMethodCondition.pipeline) as any[]).reduce((sum, entry) => sum + entry.rejections[reason], 0),
  ])),
  benign_failclose_rate: Number(mean(BENIGN_CONDITIONS.map(condition => 1 - pipeline(condition, 'availability'))).toFixed(4)),
  biased_condition_mae_by_method: Object.fromEntries(METHODS.map(method => [
    method,
    (byMethodCondition[method].biased as any).mae,
  ])),
};

fs.mkdirSync(OUT, { recursive: true });
const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);

write('fusion_rows.json', rows);
write('fusion_summary.json', {
  config: {
    seeds: SEEDS,
    conditions: CONDITIONS,
    steps: STEPS,
    sensors: SENSORS,
    methods: METHODS,
    fusion_config: DEFAULT_FUSION_CONFIG,
    strict_conditions: STRICT_CONDITIONS,
    benign_conditions: BENIGN_CONDITIONS,
    data_nature: 'synthetic readings；不代表真实视频/无人机测量精度。',
  },
  by_method_condition: byMethodCondition,
  overall,
  pipeline_diagnostics: pipelineDiagnostics,
});

const formatValue = (value: unknown): string => (value === null ? '-' : String(value));
const report = `# V7.5 Track E 多传感器融合实验

> 运行 ID：\`${RUN_ID}\`。30 种子 × 9 条件 × 5 方法；合成读数。
> 严格条件（${STRICT_CONDITIONS.join('、')}）必须 fail-closed；其余条件应给出可用融合值。
> 故障传感器按种子轮换（cam-1/cam-2/drone-1 各 10 个种子），避免故障总落在权重最低的传感器上。
> MAE/RMSE/偏差只统计给出可用数值的步，必须与可用率一起解读。

## 可用率（条件 × 方法）

| 条件 | ${METHODS.join(' | ')} |
| --- | ${METHODS.map(() => '---').join(' | ')} |
${CONDITIONS.map(condition => `| ${condition} | ${METHODS.map(method => (byMethodCondition[method][condition] as any).availability).join(' | ')} |`).join('\n')}

## MAE（条件 × 方法）

| 条件 | ${METHODS.join(' | ')} |
| --- | ${METHODS.map(() => '---').join(' | ')} |
${CONDITIONS.map(condition => `| ${condition} | ${METHODS.map(method => formatValue((byMethodCondition[method][condition] as any).mae)).join(' | ')} |`).join('\n')}

## 总体

| 方法 | 可用率 | MAE | 偏差 | RMSE | 严格条件下 unsafe fuse 率 | 良性条件 false fail-close 率 | 决策准确率 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${METHODS.map(method => {
  const value = overall[method] as any;
  return `| ${method} | ${value.availability} | ${formatValue(value.mae)} | ${formatValue(value.bias)} | ${formatValue(value.rmse)} | ${value.unsafe_fuse_rate_on_strict} | ${value.false_failclose_rate_on_benign} | ${value.decision_accuracy} |`;
}).join('\n')}

## 融合管线诊断

- 冲突条件 fail-closed 率：${pipelineDiagnostics.conflict_failclosed_rate}
- 时钟偏移条件 fail-closed 率：${pipelineDiagnostics.clock_skew_failclosed_rate}
- 过期读数拒绝总数（stale 条件）：${pipelineDiagnostics.stale_rejections_total}
- 重复读数拒绝总数（duplicate 条件）：${pipelineDiagnostics.duplicate_rejections_total}
- 良性条件平均 false fail-close 率：${pipelineDiagnostics.benign_failclose_rate}
- 偏置条件下各方法 MAE：${JSON.stringify(pipelineDiagnostics.biased_condition_mae_by_method)}

## 解释边界

- 传感器噪声、可靠度、时间戳偏移均为合成注入；
- “决策准确率”只衡量是否在该拒绝时拒绝、该融合时融合，不衡量真实安全后果；
- 偏置条件用于检验可靠性加权对持续偏置的敏感性：偏置不是冲突，加权无法消除；
- 不得表述为真实摄像机/无人机融合精度。
`;
fs.writeFileSync(path.join(OUT, 'fusion_README.md'), report);
fs.writeFileSync(path.join(OUT, 'fusion_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);

const files = fs.readdirSync(OUT).filter(name => name.startsWith('fusion_')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'fusion_MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, note: 'V7.5 Track E 融合证据（合成）。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.5 fusion benchmark complete: evaluation/v75/${RUN_ID}/`);
for (const method of METHODS) console.log(method, JSON.stringify(overall[method]));
console.log('pipeline', JSON.stringify(pipelineDiagnostics));
