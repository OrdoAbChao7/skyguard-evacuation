/**
 * V7.2 场馆标定流水线演示/证据生成。
 *
 *   npm run benchmark:v72 --prefix backend -- --only=calibration
 *
 * 输入：data/venues/stadium-synthetic-profile.json（合成、未标定档案）
 * 输出：evaluation/v72/<run>/calibration_*.json|md
 *
 * 本脚本不修改场景文件、不写入安全状态；所有估计值来自合成样本，
 * provenance 会被数据性质降级为 estimated，不得表述为真实标定。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import {
  adaptCameraCount,
  applyVenueProfile,
  estimateServiceRate,
  estimateWalkingSpeed,
  validateVenueProfile,
  type VenueProfile,
} from '../src/services/safety/calibration/venue-calibration';

const RUN_ID = process.env.V72_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v72', RUN_ID);
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const PROFILE_PATH = path.resolve(__dirname, '../../data/venues/stadium-synthetic-profile.json');

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

const scenario = loadSafetyScenario(SCENARIO_PATH);
const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8')) as VenueProfile;
fs.mkdirSync(OUT, { recursive: true });

const validation = validateVenueProfile(profile, scenario);
const scenarioVersionBeforeApply = scenario.version;
const applied = validation.valid
  ? applyVenueProfile(scenario, profile)
  : { scenario, changes: [], blocked: [], version: scenario.version };

// 合成样本：每个出口 16 个 1 分钟窗口，服务率围绕名义容量 ±8%。
const rng = mulberry32(20261110);
const exitEstimates = scenario.exits.map(exit => {
  const nominal = exit.capacity_per_min ?? 0;
  const samples = Array.from({ length: 16 }, () => ({
    served: Math.max(0, Math.round(nominal * (0.92 + rng() * 0.16))),
    minutes: 1,
    queue: Math.round(rng() * 120),
  }));
  return {
    exit_id: exit.id,
    nominal_capacity_per_min: nominal,
    estimate: estimateServiceRate(samples, 'synthetic throughput windows (deterministic seed)', profile.data_nature),
    samples,
  };
});

// 步行速度样本：60 米通道，48~56 秒。
const walkingSamples = Array.from({ length: 16 }, () => ({ distance_m: 60, seconds: 48 + Math.round(rng() * 8) }));
const walking = estimateWalkingSpeed(walkingSamples, 'synthetic walking samples (deterministic seed)', profile.data_nature);

const firstRegion = scenario.regions.find(region => region.enabled)!;
const now = new Date();
const adapterCases = [
  {
    id: 'fresh_live',
    input: {
      adapter_id: 'camera-count-demo',
      region_id: firstRegion.id,
      count: 320,
      confidence: 0.95,
      observed_at: new Date(now.getTime() - 10_000).toISOString(),
      received_at: now.toISOString(),
      calibration_version: `camera-count-${firstRegion.id.toLowerCase()}`,
      provider: 'synthetic-adapter',
      model_version: 'synthetic/1.0.0',
    },
    source: 'live_video' as const,
  },
  {
    id: 'stale',
    input: {
      adapter_id: 'camera-count-demo',
      region_id: firstRegion.id,
      count: 320,
      confidence: 0.95,
      observed_at: new Date(now.getTime() - 10 * 60_000).toISOString(),
      received_at: now.toISOString(),
      calibration_version: `camera-count-${firstRegion.id.toLowerCase()}`,
      provider: 'synthetic-adapter',
      model_version: 'synthetic/1.0.0',
    },
    source: 'live_video' as const,
  },
  {
    id: 'low_confidence',
    input: {
      adapter_id: 'camera-count-demo',
      region_id: firstRegion.id,
      count: 320,
      confidence: 0.2,
      observed_at: now.toISOString(),
      received_at: now.toISOString(),
      calibration_version: `camera-count-${firstRegion.id.toLowerCase()}`,
      provider: 'synthetic-adapter',
      model_version: 'synthetic/1.0.0',
    },
    source: 'recorded_video' as const,
  },
];
const adapterResults = adapterCases.map(item => {
  const adapted = adaptCameraCount(item.input, scenario, { now, source: item.source });
  return {
    case: item.id,
    accepted: adapted.observation !== null,
    rejected_reason: adapted.rejected_reason,
    source: adapted.observation?.source ?? null,
    calibration_version: adapted.observation?.calibration_version ?? null,
    estimated_count: adapted.observation?.estimated_count ?? null,
  };
});

const evidence = {
  generated_at: now.toISOString(),
  run_id: RUN_ID,
  data_nature: profile.data_nature,
  boundary: '合成档案与合成样本；估计值被降级为 estimated，不代表真实场馆标定。',
  validation,
  application: {
    version: applied.version,
    changes: applied.changes,
    blocked: applied.blocked,
    scenario_unchanged: scenario.version === scenarioVersionBeforeApply,
  },
  exit_estimates: exitEstimates,
  walking_speed: { estimate: walking, samples: walkingSamples },
  adapter_results: adapterResults,
};

const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('calibration_validation.json', validation);
write('calibration_application.json', evidence.application);
write('calibration_estimates.json', {
  exit_estimates: exitEstimates,
  walking_speed: evidence.walking_speed,
});
write('calibration_observations.json', adapterResults);
write('calibration_evidence.json', evidence);

const report = `# V7.2 场馆标定流水线证据

> 运行 ID：\`${RUN_ID}\`。数据性质：**${profile.data_nature}**。
> 合成档案与合成样本；估计值被降级为 estimated，不代表真实场馆标定。

## 1. 档案校验

- 有效：${validation.valid}
- 错误：${validation.errors.length}；警告：${validation.warnings.length}
- 覆盖：${validation.checked_regions} 区域 / ${validation.checked_corridors} 通道 / ${validation.checked_exits} 出口 / ${validation.checked_cameras} 相机
- 来源计数：${JSON.stringify(validation.provenance_counts)}

${validation.errors.map(item => `- ERROR \`${item.code}\`：${item.message}`).join('\n')}
${validation.warnings.map(item => `- WARN \`${item.code}\`：${item.message}`).join('\n')}

## 2. 应用结果

- 档案版本：${applied.version}
- 变更 ${applied.changes.length} 项，阻止 ${applied.blocked.length} 项
${applied.changes.map(change => `  - ${change.kind} ${change.id}.${change.field}: ${change.before} → ${change.after}（${change.provenance}）`).join('\n')}
${applied.blocked.map(item => `  - blocked ${item.id}.${item.field}: ${item.reason}`).join('\n')}

## 3. 参数估计（合成样本）

| 出口 | 名义容量 | 估计值 | 来源等级 | 95% CI | 样本 |
| --- | --- | --- | --- | --- | --- |
${exitEstimates.map(item => `| ${item.exit_id} | ${item.nominal_capacity_per_min} | ${item.estimate.value} | ${item.estimate.provenance} | [${item.estimate.confidence_interval?.lower}, ${item.estimate.confidence_interval?.upper}] | ${item.estimate.samples} |`).join('\n')}

- 步行速度：${walking.value} m/s（${walking.provenance}，n=${walking.samples}）
- 结论：合成数据即使统计稳定也不得标记 calibrated；真实标定需要授权实测样本。

## 4. 观测适配器

| 用例 | 接受 | 拒绝原因 | 来源 | 标定版本 |
| --- | --- | --- | --- | --- |
${adapterResults.map(item => `| ${item.case} | ${item.accepted} | ${item.rejected_reason ?? '-'} | ${item.source ?? '-'} | ${item.calibration_version ?? '-'} |`).join('\n')}

## 5. 边界

- 未接入真实摄像机、真实场馆时序或授权数据；
- 参数估计只用于演示流水线行为，不得用于真实疏散指挥；
- 应用标定会改变场景版本，使既有计划失效；默认演示不落盘场景。
`;
fs.writeFileSync(path.join(OUT, 'calibration_README.md'), report);
fs.writeFileSync(path.join(OUT, 'calibration_metadata.json'), `${JSON.stringify({
  generated_at: now.toISOString(),
  run_id: RUN_ID,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);

const files = fs.readdirSync(OUT).filter(name => name.startsWith('calibration_')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'calibration_MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, note: 'V7.2 场馆标定流水线独立清单（合成数据）。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.2 calibration evidence complete: evaluation/v72/${RUN_ID}/`);
console.log(`validation valid=${validation.valid}, errors=${validation.errors.length}, warnings=${validation.warnings.length}`);
console.log(`walking speed=${walking.value} ${walking.unit} (${walking.provenance})`);
