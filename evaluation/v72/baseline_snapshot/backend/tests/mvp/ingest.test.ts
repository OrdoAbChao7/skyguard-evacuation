import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReplayService, allCameraHealth, cameraHealthFor, parseReplayCsv } from '../../src/services/mvp/ingest';
import { makeMvpFixture } from './fixtures';

const CSV = [
  'timestamp,region_id,count,confidence,source',
  '2026-11-05T12:00:00.000Z,R_EAST_STAND,420,0.91,simulation',
  '2026-11-05T12:01:00.000Z,R_EAST_STAND,460,0.92,csv_replay',
].join('\n');

test('CSV 回放解析支持标准列与来源列', () => {
  const rows = parseReplayCsv(CSV);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].region_id, 'R_EAST_STAND');
  assert.equal(rows[1].count, 460);
  assert.equal(rows[1].source, 'csv_replay');
});

test('CSV 缺少必需列或行格式错误时显式报错', () => {
  assert.throws(() => parseReplayCsv('timestamp,count\n2026-11-05T12:00:00.000Z,1'), /缺少列/);
  assert.throws(() => parseReplayCsv('timestamp,region_id,count,confidence\nbad,R_EAST_STAND,1,0.9'), /第 2 行/);
});

test('回放数据引用未知区域时拒绝加载', () => {
  const fixture = makeMvpFixture();
  try {
    const replay = new ReplayService(fixture.scenario);
    assert.throws(() => replay.loadRows([
      { timestamp: '2026-11-05T12:00:00.000Z', region_id: 'R_UNKNOWN', count: 1, confidence: 0.9 },
    ], { name: 'bad', provenance: 'test' }), /未知区域/);
  } finally {
    fixture.cleanup();
  }
});

test('回放游标与完成状态正确推进', () => {
  const fixture = makeMvpFixture();
  try {
    const replay = new ReplayService(fixture.scenario);
    replay.loadRows([
      { timestamp: '2026-11-05T12:00:00.000Z', region_id: 'R_EAST_STAND', count: 400, confidence: 0.9 },
      { timestamp: '2026-11-05T12:01:00.000Z', region_id: 'R_EAST_STAND', count: 450, confidence: 0.9 },
    ], { name: 'demo', provenance: 'test' });
    assert.equal(replay.status().total_rows, 2);
    assert.equal(replay.next(1).length, 1);
    assert.equal(replay.status().cursor, 1);
    assert.equal(replay.next(5).length, 1);
    assert.equal(replay.status().completed, true);
    replay.reset();
    assert.equal(replay.status().cursor, 0);
  } finally {
    fixture.cleanup();
  }
});

test('JSON 与 CSV 文件回放可用', () => {
  const fixture = makeMvpFixture();
  const previous = process.env.DATA_ROOT;
  try {
    const replays = path.join(fixture.dataRoot, 'replays');
    fs.mkdirSync(replays, { recursive: true });
    fs.writeFileSync(path.join(replays, 'demo.json'), JSON.stringify({
      name: 'demo-json',
      provenance: 'synthetic',
      rows: [
        { timestamp: '2026-11-05T12:00:00.000Z', region_id: 'R_EAST_STAND', count: 400, confidence: 0.9 },
      ],
    }));
    fs.writeFileSync(path.join(replays, 'demo.csv'), CSV);
    process.env.DATA_ROOT = fixture.dataRoot;
    const replay = new ReplayService(fixture.scenario);
    assert.equal(replay.loadJsonFile('demo.json').dataset_name, 'demo-json');
    assert.equal(replay.loadCsvFile('demo.csv').total_rows, 2);
    assert.throws(() => replay.loadJsonFile('../evil.json'), /不存在|越界/);
  } finally {
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
    fixture.cleanup();
  }
});

test('摄像头健康状态区分无观测、低置信与在线', () => {
  const fixture = makeMvpFixture();
  try {
    const store = fixture.safety.getObservationStore();
    const unknown = cameraHealthFor(fixture.scenario, store, 'R_NORTH_STAND');
    assert.equal(unknown.state, 'unknown');

    fixture.safety.ingestObservation({
      regionId: 'R_NORTH_STAND',
      count: 300,
      confidence: 0.3,
      source: 'simulation',
      provider: 'test',
      modelVersion: 'test',
      observedAt: new Date(),
    }, { username: 'test', role: 'admin' });
    const degraded = cameraHealthFor(fixture.scenario, store, 'R_NORTH_STAND');
    assert.equal(degraded.state, 'degraded');
    assert.match(degraded.reason, /置信度/);

    fixture.safety.ingestObservation({
      regionId: 'R_SOUTH_STAND',
      count: 300,
      confidence: 0.95,
      source: 'simulation',
      provider: 'test',
      modelVersion: 'test',
      observedAt: new Date(),
    }, { username: 'test', role: 'admin' });
    const online = cameraHealthFor(fixture.scenario, store, 'R_SOUTH_STAND');
    assert.equal(online.state, 'online');
    assert.equal(allCameraHealth(fixture.scenario, store).length, fixture.scenario.regions.length);
  } finally {
    fixture.cleanup();
  }
});
