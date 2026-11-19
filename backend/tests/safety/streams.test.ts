/**
 * 实时流注册表单元测试。
 *
 * 重点不是“能解析 JSON”，而是安全边界：
 *  - 只接受网络流协议，拒绝 file/gopher 等；
 *  - API 永远拿不到完整 URL 或凭据；
 *  - 任意一条配置错误都会让整份配置 fail-closed。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import {
  loadStreamRegistry,
  redactStreamUrl,
  resetStreamRegistryForTests,
  sanitizeStreamText,
  validateStreamUrl,
} from '../../src/services/safety/streams';

const ENV_KEYS = ['SKYGUARD_STREAMS', 'SKYGUARD_STREAMS_FILE', 'DATA_ROOT'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
let tempDataRoot: string;

beforeEach(() => {
  delete process.env.SKYGUARD_STREAMS;
  delete process.env.SKYGUARD_STREAMS_FILE;
  tempDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-streams-data-'));
  process.env.DATA_ROOT = tempDataRoot;
  resetStreamRegistryForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetStreamRegistryForTests();
  fs.rmSync(tempDataRoot, { recursive: true, force: true });
});

test('内联配置解析出区域、ROI 与短窗口参数', () => {
  process.env.SKYGUARD_STREAMS = JSON.stringify([
    {
      id: 'gate-02',
      label: '2 号门',
      region_id: 'R_MAIN',
      url: 'rtsp://10.0.0.5:554/live',
      roi: [0.1, 0.2, 0.5, 0.6],
      max_frames: 20,
      sample_every: 4,
      max_seconds: 12,
    },
  ]);

  const registry = loadStreamRegistry();
  assert.equal(registry.source, 'env');
  assert.deepEqual(registry.errors, []);
  assert.equal(registry.streams.length, 1);
  assert.equal(registry.streams[0].id, 'gate-02');
  assert.equal(registry.streams[0].label, '2 号门');
  assert.equal(registry.streams[0].regionId, 'R_MAIN');
  assert.deepEqual(registry.streams[0].roi, { x: 0.1, y: 0.2, w: 0.5, h: 0.6 });
  assert.equal(registry.streams[0].maxFrames, 20);
  assert.equal(registry.streams[0].sampleEvery, 4);
  assert.equal(registry.streams[0].maxSeconds, 12);
  assert.equal(registry.streams[0].enabled, true);
});

test('URL 脱敏去掉用户名、密码、query 和 fragment', () => {
  const secret = 'p@ss';
  const token = 'abc123';
  const raw = `rtsp://operator:${encodeURIComponent(secret)}@10.0.0.5:554/live?token=${token}#frag`;
  const redacted = redactStreamUrl(raw);
  assert.ok(!redacted.includes('operator'), '不得保留用户名');
  assert.ok(!redacted.includes(encodeURIComponent(secret)), '不得保留密码');
  assert.ok(!redacted.includes(token), '不得保留 query token');
  assert.ok(!redacted.includes('#frag'), '不得保留 fragment');
  assert.ok(redacted.includes('10.0.0.5:554'), '保留主机便于排障');
  assert.ok(redacted.includes('/live'), '保留路径便于排障');
});

test('任意文本中的流 URL 都会被脱敏', () => {
  const exampleSecret = 'example-secret';
  const text = `OpenCV error: rtsp://operator:${exampleSecret}@10.0.0.5:554/live?token=abc failed`;
  const sanitized = sanitizeStreamText(text);
  assert.ok(!sanitized.includes('operator'));
  assert.ok(!sanitized.includes(exampleSecret));
  assert.ok(!sanitized.includes('token=abc'));
  assert.ok(sanitized.includes('rtsp://10.0.0.5:554/live'));
});

test('拒绝 file/gopher 等非网络协议，并作废整份配置', () => {
  assert.match(validateStreamUrl('file:///etc/passwd') ?? '', /不受支持/);
  assert.match(validateStreamUrl('gopher://127.0.0.1:70/') ?? '', /不受支持/);
  assert.equal(validateStreamUrl('rtsp://10.0.0.5:554/live'), null);
  assert.equal(validateStreamUrl('https://camera.example.com/live.m3u8'), null);

  process.env.SKYGUARD_STREAMS = JSON.stringify([
    { id: 'bad', region_id: 'R_MAIN', url: 'file:///etc/passwd' },
  ]);
  const registry = loadStreamRegistry();
  assert.equal(registry.streams.length, 0, '配置错误时必须 fail-closed');
  assert.ok(registry.errors.some(error => error.includes('不受支持')));
});

test('重复 id 与越界 ROI 都会使配置整体不可用', () => {
  process.env.SKYGUARD_STREAMS = JSON.stringify([
    { id: 'dup', region_id: 'R_MAIN', url: 'rtsp://10.0.0.5/live' },
    { id: 'dup', region_id: 'R_EAST', url: 'rtsp://10.0.0.6/live' },
    { id: 'bad-roi', region_id: 'R_WEST', url: 'rtsp://10.0.0.7/live', roi: [0.8, 0.2, 0.5, 0.2] },
  ]);
  const registry = loadStreamRegistry();
  assert.equal(registry.streams.length, 0);
  assert.ok(registry.errors.some(error => error.includes('重复')));
  assert.ok(registry.errors.some(error => error.includes('ROI')));
});

test('支持从独立 JSON 文件读取配置，且不把文件内容写进错误信息', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-streams-config-'));
  const file = path.join(dir, 'streams.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      streams: [
        { id: 'file-cam', region_id: 'R_MAIN', url: 'rtsp://10.0.0.8:554/live', enabled: false },
      ],
    }),
    'utf8',
  );
  try {
    process.env.SKYGUARD_STREAMS_FILE = file;
    const registry = loadStreamRegistry();
    assert.equal(registry.source, 'file');
    assert.deepEqual(registry.errors, []);
    assert.equal(registry.streams[0].id, 'file-cam');
    assert.equal(registry.streams[0].enabled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('显式相对路径在仓库根不存在时按 DATA_ROOT 解析', () => {
  fs.writeFileSync(
    path.join(tempDataRoot, 'streams.json'),
    JSON.stringify({
      streams: [{ id: 'data-root-cam', region_id: 'R_MAIN', url: 'rtsp://10.0.0.9:554/live' }],
    }),
    'utf8',
  );
  process.env.SKYGUARD_STREAMS_FILE = 'streams.json';

  const registry = loadStreamRegistry();
  assert.equal(registry.source, 'file');
  assert.deepEqual(registry.errors, []);
  assert.equal(registry.streams[0].id, 'data-root-cam');
});

test('未配置时返回空注册表而不是抛错', () => {
  const registry = loadStreamRegistry();
  assert.equal(registry.source, 'none');
  assert.deepEqual(registry.streams, []);
  assert.deepEqual(registry.errors, []);
});
