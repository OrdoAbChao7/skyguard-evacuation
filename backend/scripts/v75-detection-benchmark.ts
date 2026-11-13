/**
 * V7.5 Track A：低误报突增检测对照实验。
 *
 *   npm run benchmark:v75 --prefix backend -- --only=detection
 *
 * 30 种子 × 7 机制 × 7 检测器；合成多传感器序列。
 * 指标：检测召回、误报率、延迟、精确率/F1、噪声/缺失/延迟/冲突下的表现。
 * 不代表真实人群或视频检测精度。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  AdaptiveCusumDetector,
  CusumDetector,
  ReliabilityDualDetector,
  SprtDetector,
  ThreeSigmaDetector,
  fuseDetectorSensors,
  type Detector,
  type SensorObservation,
} from '../src/services/safety/detection/surge';

const RUN_ID = process.env.V75_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v75', RUN_ID);
const SEEDS = Array.from({ length: 30 }, (_, index) => 20261111 + index);
const MECHANISMS = ['stable', 'surge', 'regime_shift', 'noisy', 'missing', 'delayed', 'conflicting'] as const;
type Mechanism = (typeof MECHANISMS)[number];
const STEPS = 60;
const CHANGE_STEP = 30;
const WINDOW = 15;

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

interface SensorSpec { id: string; reliability: number; sigma: number }
const SENSORS: SensorSpec[] = [
  { id: 'cam-1', reliability: 0.9, sigma: 4 },
  { id: 'cam-2', reliability: 0.75, sigma: 6 },
  { id: 'drone-1', reliability: 0.55, sigma: 9 },
];

interface SeriesResult {
  steps: Array<{ trueValue: number; observations: SensorObservation[] }>;
  changeStep: number | null;
}

function seriesFor(mechanism: Mechanism, seed: number): SeriesResult {
  const rng = mulberry32(seed * 1009 + MECHANISMS.indexOf(mechanism) * 104_729);
  const delayedBuffer: Array<Array<{ sensorId: string; value: number; reliability: number }>> = [];
  const steps: SeriesResult['steps'] = [];
  for (let t = 0; t < STEPS; t += 1) {
    let trueValue = 300 + gaussian(rng) * 5;
    if (mechanism === 'noisy') trueValue = 300 + gaussian(rng) * 25;
    if ((mechanism === 'surge' || mechanism === 'missing' || mechanism === 'delayed') && t >= CHANGE_STEP) {
      trueValue += 26 + 2 * (t - CHANGE_STEP);
    }
    if (mechanism === 'regime_shift' && t >= CHANGE_STEP) trueValue += 40;
    if (mechanism === 'conflicting') trueValue = 300 + gaussian(rng) * 5;

    const observations: SensorObservation[] = SENSORS.map((sensor, index) => {
      let value = trueValue + gaussian(rng) * sensor.sigma;
      if (mechanism === 'conflicting' && index === 1 && t >= 10) value += 90 + gaussian(rng) * 5;
      const missing = mechanism === 'missing' && rng() < 0.3;
      if (mechanism === 'delayed' && index === 1) {
        const history = delayedBuffer[Math.max(0, t - 3)]?.[index];
        if (history) value = history.value;
      }
      return {
        sensorId: sensor.id,
        value: Number(value.toFixed(3)),
        reliability: sensor.reliability,
        missing,
      };
    });
    delayedBuffer.push(observations.map(item => ({ sensorId: item.sensorId, value: item.value, reliability: item.reliability })));
    steps.push({ trueValue, observations });
  }
  return {
    steps,
    changeStep: mechanism === 'stable' || mechanism === 'noisy' || mechanism === 'conflicting' ? null : CHANGE_STEP,
  };
}

type DetectorKind = 'naive3sigma' | 'cusum' | 'adaptive_cusum' | 'sprt' | 'reliability_dual' | 'dual_persist1' | 'dual_no_multisensor';

function detectorFor(kind: DetectorKind): Detector {
  switch (kind) {
    case 'naive3sigma': return new ThreeSigmaDetector();
    case 'cusum': return new CusumDetector();
    case 'adaptive_cusum': return new AdaptiveCusumDetector();
    case 'sprt': return new SprtDetector();
    case 'reliability_dual': return new ReliabilityDualDetector({ persist: 2 });
    case 'dual_persist1': return new ReliabilityDualDetector({ persist: 1 });
    case 'dual_no_multisensor': return new ReliabilityDualDetector({ persist: 2 });
    default: return new ThreeSigmaDetector();
  }
}

interface Outcome {
  mechanism: Mechanism;
  seed: number;
  detector: DetectorKind;
  detected: boolean;
  latency: number | null;
  alarms_before_change: number;
  alarms_total: number;
  false_alarms_per_100: number;
  any_false_alarm: boolean;
  fused_conflicts: number;
}

function runDetector(mechanism: Mechanism, seed: number, kind: DetectorKind): Outcome {
  const series = seriesFor(mechanism, seed);
  const detector = detectorFor(kind);
  const useSensors = kind !== 'dual_no_multisensor';
  let detected = false;
  let latency: number | null = null;
  let alarmsBefore = 0;
  let alarmsTotal = 0;
  let fusedConflicts = 0;
  for (let t = 0; t < series.steps.length; t += 1) {
    const step = series.steps[t];
    const fused = fuseDetectorSensors(step.observations);
    if (fused.conflict) fusedConflicts += 1;
    const decision = detector.update({
      value: fused.value,
      sensors: useSensors ? step.observations : undefined,
    });
    if (decision.alarm) {
      alarmsTotal += 1;
      if (series.changeStep === null || t < series.changeStep) alarmsBefore += 1;
      if (series.changeStep !== null && !detected && t >= series.changeStep && t < series.changeStep + WINDOW) {
        detected = true;
        latency = t - series.changeStep;
      }
    }
  }
  const baselineSteps = series.changeStep ?? series.steps.length;
  return {
    mechanism,
    seed,
    detector: kind,
    detected,
    latency,
    alarms_before_change: alarmsBefore,
    alarms_total: alarmsTotal,
    false_alarms_per_100: Number((alarmsBefore / Math.max(1, baselineSteps) * 100).toFixed(4)),
    any_false_alarm: alarmsBefore > 0,
    fused_conflicts: fusedConflicts,
  };
}

const rows: Outcome[] = [];
for (const mechanism of MECHANISMS) {
  for (const seed of SEEDS) {
    for (const kind of ['naive3sigma', 'cusum', 'adaptive_cusum', 'sprt', 'reliability_dual', 'dual_persist1', 'dual_no_multisensor'] as DetectorKind[]) {
      rows.push(runDetector(mechanism, seed, kind));
    }
  }
}

const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const changed = (mechanism: Mechanism) => mechanism === 'surge' || mechanism === 'regime_shift' || mechanism === 'missing' || mechanism === 'delayed';

const summary = Object.fromEntries((['naive3sigma', 'cusum', 'adaptive_cusum', 'sprt', 'reliability_dual', 'dual_persist1', 'dual_no_multisensor'] as DetectorKind[]).map(kind => {
  const perMechanism = Object.fromEntries(MECHANISMS.map(mechanism => {
    const subset = rows.filter(row => row.detector === kind && row.mechanism === mechanism);
    const latencies = subset.map(row => row.latency).filter((value): value is number => value !== null);
    return [mechanism, {
      n: subset.length,
      detection_rate: Number((subset.filter(row => row.detected).length / Math.max(1, subset.length)).toFixed(4)),
      median_latency: median(latencies),
      mean_latency: Number(mean(latencies).toFixed(2)),
      false_alarms_per_100: Number(mean(subset.map(row => row.false_alarms_per_100)).toFixed(4)),
      false_positive_rate: mechanism === 'stable' || mechanism === 'noisy' || mechanism === 'conflicting'
        ? Number((subset.filter(row => row.any_false_alarm).length / Math.max(1, subset.length)).toFixed(4))
        : null,
      mean_alarms: Number(mean(subset.map(row => row.alarms_total)).toFixed(2)),
      conflict_rate: mechanism === 'conflicting'
        ? Number((subset.filter(row => row.fused_conflicts > 0).length / Math.max(1, subset.length)).toFixed(4))
        : null,
    }];
  }));
  const changedRuns = rows.filter(row => row.detector === kind && changed(row.mechanism));
  const noChangeRuns = rows.filter(row => row.detector === kind && !changed(row.mechanism));
  const tp = changedRuns.filter(row => row.detected).length;
  const fn = changedRuns.length - tp;
  const fp = noChangeRuns.filter(row => row.any_false_alarm).length;
  const tn = noChangeRuns.length - fp;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  return [kind, {
    per_mechanism: perMechanism,
    aggregate: {
      changed_runs: changedRuns.length,
      no_change_runs: noChangeRuns.length,
      true_positive: tp,
      false_negative: fn,
      false_positive: fp,
      true_negative: tn,
      recall: Number(recall.toFixed(4)),
      precision: Number(precision.toFixed(4)),
      f1: Number(f1.toFixed(4)),
      false_positive_rate: noChangeRuns.length ? Number((fp / noChangeRuns.length).toFixed(4)) : 0,
      mean_false_alarms_per_100: Number(mean(rows.filter(row => row.detector === kind).map(row => row.false_alarms_per_100)).toFixed(4)),
    },
  }];
}));

fs.mkdirSync(OUT, { recursive: true });
const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('detection_rows.json', rows);
write('detection_summary.json', {
  config: {
    seeds: SEEDS, mechanisms: MECHANISMS, steps: STEPS, change_step: CHANGE_STEP, detection_window: WINDOW,
    sensors: SENSORS, data_nature: 'synthetic multi-sensor；不代表真实视频/人群检测精度。',
  },
  summary,
});

const report = `# V7.5 Track A 检测实验

> 运行 ID：\`${RUN_ID}\`。30 种子 × 7 机制 × 7 检测器；合成多传感器序列。

## 聚合指标（4 个有变化机制 + 3 个无变化机制）

| 检测器 | 召回 | 精确率 | F1 | 无变化误报率 | 误报/100 步 |
| --- | --- | --- | --- | --- | --- |
${(Object.entries(summary) as Array<[string, any]>).map(([kind, value]) => {
  const a = value.aggregate;
  return `| ${kind} | ${a.recall} | ${a.precision} | ${a.f1} | ${a.false_positive_rate} | ${a.mean_false_alarms_per_100} |`;
}).join('\n')}

## 分机制检测率 / 延迟 / 误报

| 检测器 | 机制 | 检测率 | 中位延迟 | 误报/100 | 误报率 |
| --- | --- | --- | --- | --- | --- |
${(Object.entries(summary) as Array<[string, any]>).flatMap(([kind, value]) => MECHANISMS.map(mechanism => {
  const v = value.per_mechanism[mechanism];
  return `| ${kind} | ${mechanism} | ${v.detection_rate} | ${v.median_latency} | ${v.false_alarms_per_100} | ${v.false_positive_rate ?? '-'} |`;
})).join('\n')}

## 解释边界

- 序列、传感器噪声/可靠性、缺失/延迟/偏置均为合成；
- 召回与误报按“运行级”统计：一次运行内报警即计为阳性；
- 不得表述为真实人群突增预警精度。
`;
fs.writeFileSync(path.join(OUT, 'detection_README.md'), report);
fs.writeFileSync(path.join(OUT, 'detection_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(), run_id: RUN_ID,
  node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);
const files = fs.readdirSync(OUT).filter(name => name.startsWith('detection_')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'detection_MANIFEST.json'), `${JSON.stringify({ version: 1, run_id: RUN_ID, note: 'V7.5 Track A 检测证据（合成）。', file_count: manifest.length, files: manifest }, null, 2)}\n`);

console.log(`V7.5 detection benchmark complete: evaluation/v75/${RUN_ID}/`);
for (const [kind, value] of Object.entries(summary) as Array<[string, any]>) {
  console.log(kind, JSON.stringify(value.aggregate));
}
