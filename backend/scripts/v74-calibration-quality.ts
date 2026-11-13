/**
 * V7.4 Phase 3：标定质量证据（时钟/缺失/可靠性/动态容量）。
 *
 *   npm run benchmark:v74 --prefix backend -- --only=calibration
 *
 * 合成观测/夹具；不包含真实场馆数据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { buildObservation } from '../src/services/safety/observations';
import {
  detectMissingIntervals,
  estimateSensorReliability,
  observationQualityReport,
  scheduleToFactor,
  synchronizeTimestamps,
  validateCapacitySchedule,
} from '../src/services/safety/calibration/quality';
import type { DensityObservation } from '../src/services/safety/types';

const RUN_ID = process.env.V74_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v74', RUN_ID);
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
fs.mkdirSync(OUT, { recursive: true });

const scenario = loadSafetyScenario(SCENARIO_PATH);
const now = new Date('2026-11-10T01:05:00Z');
const region = scenario.regions.find(item => item.enabled)!;
const observations: DensityObservation[] = [
  buildObservation({ region, count: 300, confidence: 0.95, source: 'simulation', provider: 'provider-a', modelVersion: 'a/1', observedAt: new Date('2026-11-10T01:04:50Z'), receivedAt: new Date('2026-11-10T01:04:51Z') }),
  buildObservation({ region, count: 310, confidence: 0.92, source: 'simulation', provider: 'provider-a', modelVersion: 'a/1', observedAt: new Date('2026-11-10T01:03:00Z'), receivedAt: new Date('2026-11-10T01:03:01Z') }),
  buildObservation({ region, count: 305, confidence: 0.7, source: 'simulation', provider: 'provider-b', modelVersion: 'b/1', observedAt: new Date('2026-11-10T01:04:55Z'), receivedAt: new Date('2026-11-10T01:04:56Z') }),
  buildObservation({ region, count: 300, confidence: 0.95, source: 'simulation', provider: 'provider-slow', modelVersion: 's/1', observedAt: new Date('2026-11-10T01:04:00Z'), receivedAt: new Date('2026-11-10T01:04:01Z') }),
];
const sync = synchronizeTimestamps(observations, [
  { provider: 'provider-a', offset_seconds: 0, samples: 20 },
  { provider: 'provider-b', offset_seconds: 3, samples: 8 },
  { provider: 'provider-slow', offset_seconds: 90, samples: 8 },
], 30);
const gaps = detectMissingIntervals(sync.observations, 60, 10);
const reliability = estimateSensorReliability(sync.observations, 300, now);
const quality = observationQualityReport(scenario, sync.observations, now);
const schedule = {
  entries: [
    { from_minute: 4, to_minute: 10, corridor_factor: 0.5, reason: '合成演练：走廊维护' },
    { from_minute: 10, to_minute: 15, exit_factor: 0.7, reason: '合成演练：出口受限' },
  ],
};
const scheduleValidation = validateCapacitySchedule(schedule);
const corridorFactor = scheduleToFactor(schedule, 'corridor');
const exitFactor = scheduleToFactor(schedule, 'exit');

const evidence = {
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  data_nature: 'synthetic/fixture；无真实场馆数据。',
  timestamp_sync: {
    accepted: sync.observations.length,
    rejected: sync.rejected,
    applied_offsets: sync.applied_offsets,
  },
  missing_intervals: gaps,
  sensor_reliability: reliability,
  observation_quality: quality,
  dynamic_capacity_schedule: {
    entries: schedule.entries,
    validation: scheduleValidation,
    samples: [
      { minute: 5, corridor_factor: corridorFactor('C_NE', 5), exit_factor: exitFactor('E_NORTH', 5) },
      { minute: 12, corridor_factor: corridorFactor('C_NE', 12), exit_factor: exitFactor('E_NORTH', 12) },
      { minute: 20, corridor_factor: corridorFactor('C_NE', 20), exit_factor: exitFactor('E_NORTH', 20) },
    ],
  },
  boundaries: [
    '可靠性是可用性×置信度×稳定性的代理，不是准确率；无 ground truth。',
    '动态容量计划是合成演练值，未用真实容量数据标定。',
    '时钟偏移是人为设定，用于验证同步/拒绝逻辑。',
  ],
};
fs.writeFileSync(path.join(OUT, 'calibration_quality.json'), `${JSON.stringify(evidence, null, 2)}\n`);

const report = `# V7.4 标定质量证据

> 运行 ID：\`${RUN_ID}\`。合成观测/夹具；无真实场馆数据。

## 1. 时钟同步

- 接受：${sync.observations.length}；拒绝：${sync.rejected.length}
${sync.rejected.map(item => `  - ${item.provider}: ${item.reason} (${item.skew_seconds}s)`).join('\n')}

## 2. 缺失区间

${gaps.length === 0 ? '- 未检测到缺口' : gaps.map(gap => `- ${gap.region_id}: ${gap.from} → ${gap.to}（${gap.gap_seconds}s，预期缺失 ${gap.expected_samples} 条）`).join('\n')}

## 3. 传感器可靠性（代理分数，不是准确率）

| provider | 观测数 | 区域 | 可用性 | 平均置信度 | 稳定性代理 | 可靠性 |
| --- | --- | --- | --- | --- | --- | --- |
${reliability.map(item => `| ${item.provider} | ${item.observations} | ${item.regions} | ${item.availability_ratio} | ${item.mean_confidence} | ${1 / (1 + item.confidence_sd * 4)} | ${item.reliability_score} |`).join('\n')}

## 4. 观测质量

- 覆盖：${quality.coverage_ratio}；缺失区域：${quality.missing_regions.join(',') || '无'}；
- 过期：${quality.stale}；低置信度：${quality.low_confidence}；无效：${quality.invalid}；重复时间戳：${quality.duplicate_timestamps}。

## 5. 动态容量计划

- 校验：错误 ${scheduleValidation.errors.length}，警告 ${scheduleValidation.warnings.length}
- 示例：t=5 corridor=${corridorFactor('C_NE', 5)}，t=12 exit=${exitFactor('E_NORTH', 12)}，t=20 corridor=${corridorFactor('C_NE', 20)}

## 6. 边界

- 可靠性不是准确率；无真实 ground truth；
- 时钟偏移和容量计划都是合成演练参数；
- 不得表述为真实标定。
`;
fs.writeFileSync(path.join(OUT, 'calibration_quality_README.md'), report);
fs.writeFileSync(path.join(OUT, 'calibration_quality_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(), run_id: RUN_ID,
  node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);
const files = fs.readdirSync(OUT).filter(name => name.startsWith('calibration_quality')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'calibration_quality_MANIFEST.json'), `${JSON.stringify({ version: 1, run_id: RUN_ID, note: 'V7.4 标定质量证据（合成）。', file_count: manifest.length, files: manifest }, null, 2)}\n`);

console.log(`V7.4 calibration quality complete: evaluation/v74/${RUN_ID}/`);
console.log(`sync accepted=${sync.observations.length} rejected=${sync.rejected.length} gaps=${gaps.length} reliability=${reliability.length}`);
