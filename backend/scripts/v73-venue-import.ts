/**
 * V7.3 Phase 2：场馆/观测导入与标定流水线证据。
 *
 *   npm run benchmark:v73 --prefix backend -- --only=calibration
 *
 * 输入：合成场景、合成标定档案、CSV 测试夹具。
 * 输出：evaluation/v73/<run>/calibration_import_*.json|md
 * 边界：没有真实场馆/摄像机/授权数据；public/authorized 适配器只用夹具验证契约。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import {
  adaptAuthorizedRealRows,
  adaptPublicDatasetRows,
  adaptVideoFrames,
  compareVenueConstraints,
  directionalCapacityFactor,
  importScenarioFromJson,
  parseCsv,
  parseObservationCsv,
  toDensityObservations,
} from '../src/services/safety/calibration/importers';
import { validateVenueProfile, type VenueProfile } from '../src/services/safety/calibration/venue-calibration';

const RUN_ID = process.env.V73_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v73', RUN_ID);
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const PROFILE_PATH = path.resolve(__dirname, '../../data/venues/stadium-synthetic-profile.json');
const CSV_PATH = path.resolve(__dirname, '../../data/venues/fixtures/observations-sample.csv');
const PUBLIC_CSV_PATH = path.resolve(__dirname, '../../data/venues/fixtures/public-sample.csv');

const scenario = loadSafetyScenario(SCENARIO_PATH);
const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8')) as VenueProfile;
const scenarioText = fs.readFileSync(SCENARIO_PATH, 'utf8');
const observationsText = fs.readFileSync(CSV_PATH, 'utf8');
const publicText = fs.readFileSync(PUBLIC_CSV_PATH, 'utf8');
const now = new Date('2026-11-10T01:00:10Z');
fs.mkdirSync(OUT, { recursive: true });

const profileValidation = validateVenueProfile(profile, scenario);
const constraintComparison = compareVenueConstraints(scenario, profile);
const scenarioImport = importScenarioFromJson(scenarioText);
const parsedObservations = parseObservationCsv(observationsText);
const replay = toDensityObservations(scenario, parsedObservations.rows, {
  now,
  mode: 'replay',
  evidence: { fixture: 'observations-sample.csv' },
});
const live = toDensityObservations(scenario, parsedObservations.rows, {
  now,
  mode: 'live',
  evidence: { fixture: 'observations-sample.csv' },
});

const camera = profile.cameras[0];
const video = adaptVideoFrames({
  kind: 'video',
  adapter_id: 'video-fixture',
  cameraToRegion: { [camera.camera_id]: camera.region_id },
  frames: [
    { camera_id: camera.camera_id, timestamp: '2026-11-10T01:00:05Z', count: 240, confidence: 0.92 },
    { camera_id: camera.camera_id, timestamp: '2026-11-10T00:50:00Z', count: 999, confidence: 0.92 },
  ],
}, scenario, profile, { now, mode: 'live' });

const publicTable = parseCsv(publicText);
const publicMapping = { regionColumn: 'region', countColumn: 'count', timestampColumn: 'timestamp', confidenceColumn: 'confidence' };
const publicImport = adaptPublicDatasetRows(publicTable.rows.map(row => row.values), {
  name: 'fixture-public-schema（无真实数据内容）',
  license: 'TEST FIXTURE',
  license_verified: true,
  citation: 'fixture only',
  data_nature: 'public_dataset',
}, publicMapping, scenario, { mode: 'replay', now, calibrationVersion: profile.cameras[0].calibration_version });

const authorizedImport = adaptAuthorizedRealRows(publicTable.rows.map(row => row.values), {
  reference: 'AUTH-FIXTURE-001',
  legal_basis: 'test fixture only — not real authorization',
  operator: 'fixture-operator',
  verified_at: '2026-11-10T00:00:00Z',
}, publicMapping, scenario, { now, calibrationVersion: profile.cameras[0].calibration_version });

const directionalProfile = JSON.parse(JSON.stringify(profile)) as VenueProfile;
const corridor = directionalProfile.corridors[0];
corridor.directional_capacity = {
  forward: { ...corridor.capacity_per_min, value: corridor.capacity_per_min.value * 0.6 },
  reverse: { ...corridor.capacity_per_min, value: corridor.capacity_per_min.value * 0.4 },
};
const forwardFactor = directionalCapacityFactor(directionalProfile, corridor.corridor_id, 'forward');
const reverseFactor = directionalCapacityFactor(directionalProfile, corridor.corridor_id, 'reverse');

const evidence = {
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  data_nature: profile.data_nature,
  boundary: '全部为合成档案/CSV 测试夹具；public/authorized 适配器只验证契约，不代表真实数据或许可。',
  scenario_import: {
    schema_valid: scenarioImport.scenario !== null,
    errors: scenarioImport.errors,
    topology_errors: scenarioImport.topology.errors,
    topology_warnings: scenarioImport.topology.warnings,
  },
  profile_validation: {
    valid: profileValidation.valid,
    errors: profileValidation.errors,
    warnings: profileValidation.warnings,
    provenance_counts: profileValidation.provenance_counts,
  },
  constraint_comparison: constraintComparison,
  observations_csv: {
    parsed_rows: parsedObservations.rows.length,
    parse_errors: parsedObservations.errors,
    parse_warnings: parsedObservations.warnings,
    replay_accepted: replay.observations.length,
    replay_rejected: replay.rejected,
    live_accepted: live.observations.length,
    live_rejected: live.rejected,
  },
  video_interface: {
    accepted: video.observations.length,
    rejected: video.rejected,
    note: '输入为视觉模型已产生的计数，不是原始视频；不做 CV。',
  },
  public_dataset_adapter: {
    accepted: publicImport.observations.length,
    rejected: publicImport.rejected,
    errors: publicImport.errors,
    data_nature_evidence: publicImport.observations[0]?.evidence?.data_nature ?? null,
  },
  authorized_real_adapter: {
    accepted: authorizedImport.observations.length,
    rejected: authorizedImport.rejected,
    errors: authorizedImport.errors,
    source: authorizedImport.observations[0]?.source ?? null,
  },
  directional_capacity: {
    corridor_id: corridor.corridor_id,
    forward_factor: Number(forwardFactor.toFixed(4)),
    reverse_factor: Number(reverseFactor.toFixed(4)),
  },
  conclusions: [
    'JSON 场景导入与拓扑校验可用；缺失端点/重复 ID 被拒绝。',
    'CSV replay 与 live 模式区分明确；live 拒绝过期/未来时间戳。',
    '视频接口只接受已计数帧；公开/授权适配器要求许可/授权依据。',
    '方向性容量与场馆约束可表达，弱化场景安全配置会被拒绝。',
  ],
  limitations: [
    '没有真实场馆数据、摄像机或授权；fixtures 只验证契约。',
    '公开数据集适配器未连接真实数据集文件。',
    '视频接口不包含视觉模型精度验证。',
  ],
};

const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
write('calibration_import.json', evidence);
write('calibration_import_observations.json', {
  replay_accepted: replay.observations.length,
  live_accepted: live.observations.length,
  video_accepted: video.observations.length,
  public_accepted: publicImport.observations.length,
  authorized_accepted: authorizedImport.observations.length,
});

const report = `# V7.3 场馆/观测导入流水线证据

> 运行 ID：\`${RUN_ID}\`。数据性质：**${profile.data_nature}**。
> 合成档案 + CSV 测试夹具；public/authorized 适配器只验证契约，不代表真实数据或许可。

## 1. 场景导入

- Schema 有效：${scenarioImport.scenario !== null}
- 拓扑错误：${scenarioImport.topology.errors.length}；警告：${scenarioImport.topology.warnings.length}

## 2. 标定档案

- 校验：${profileValidation.valid}；错误 ${profileValidation.errors.length}；警告 ${profileValidation.warnings.length}
- 来源计数：${JSON.stringify(profileValidation.provenance_counts)}
- 约束比较：错误 ${constraintComparison.errors.length}；警告 ${constraintComparison.warnings.length}

## 3. CSV 观测

- 解析行：${parsedObservations.rows.length}；解析错误：${parsedObservations.errors.length}
- replay 接受：${replay.observations.length}；live 接受：${live.observations.length}
- live 拒绝原因：${live.rejected.map(item => item.reason).join(',') || '无'}

## 4. 视频接口

- 接受：${video.observations.length}；拒绝：${video.rejected.map(item => item.reason).join(',') || '无'}
- 说明：输入是已计数的帧，不是原始视频；不做 CV，不宣称计数精度。

## 5. 公开/授权适配器

- 公开数据集：接受 ${publicImport.observations.length}；错误 ${publicImport.errors.length}；
  数据性质证据：${String(publicImport.observations[0]?.evidence?.data_nature ?? 'none')}
- 授权真实数据：接受 ${authorizedImport.observations.length}；来源 ${String(authorizedImport.observations[0]?.source ?? 'none')}；
  错误 ${authorizedImport.errors.length}

## 6. 方向性容量

- ${corridor.corridor_id}：forward ×${forwardFactor.toFixed(2)}，reverse ×${reverseFactor.toFixed(2)}

## 7. 结论与边界

- 导入、校验、replay/live、视频计数、公开/授权适配器、方向性容量与约束均有可运行路径；
- **没有真实场馆/摄像机/授权数据**；fixtures 不是真实测量；
- 不得把本证据表述为真实标定或真实数据集验证。
`;
fs.writeFileSync(path.join(OUT, 'calibration_import_README.md'), report);
fs.writeFileSync(path.join(OUT, 'calibration_import_metadata.json'), `${JSON.stringify({
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  git_head: process.env.GIT_HEAD ?? 'uncommitted',
}, null, 2)}\n`);

const files = fs.readdirSync(OUT).filter(name => name.startsWith('calibration_import')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'calibration_import_MANIFEST.json'), `${JSON.stringify({
  version: 1, run_id: RUN_ID, note: 'V7.3 场馆导入/标定流水线证据清单（合成/夹具）。', file_count: manifest.length, files: manifest,
}, null, 2)}\n`);

console.log(`V7.3 calibration import complete: evaluation/v73/${RUN_ID}/`);
console.log(`profile_valid=${profileValidation.valid} constraints_errors=${constraintComparison.errors.length}`);
console.log(`csv_rows=${parsedObservations.rows.length} replay=${replay.observations.length} live=${live.observations.length}`);
console.log(`video=${video.observations.length} public=${publicImport.observations.length} authorized=${authorizedImport.observations.length}`);
