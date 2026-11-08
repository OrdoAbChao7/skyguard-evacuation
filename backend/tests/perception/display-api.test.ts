/**
 * 感知回放展示包：数据一致性 + HTTP 契约 + fail-closed 行为。
 *
 * 这里的断言有两个目的：
 *  1. 展示数据不得被悄悄篡改（PROVENANCE 哈希 + 跨字段一致性）；
 *  2. 展示数据不得被误当作"已校验/有真值"的证据（notice、license_status、真值标记）。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestServer } from '../helpers/api-fixtures';
import {
  DisplayPackageError,
  loadDisplayPackage,
  resetDisplayCacheForTests,
} from '../../src/services/perception/display';

const REPO_PACKAGE = path.resolve(__dirname, '../../../data/perception/citystreet-display');
const PACKAGE_ID = 'citystreet-display';

/** 1×1 像素合法 JPEG，仅用于验证 basemap 路由的 Content-Type。 */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmgA/9k=',
  'base64',
);

function readProvenance(): any {
  return JSON.parse(fs.readFileSync(path.join(REPO_PACKAGE, 'PROVENANCE.json'), 'utf8'));
}

/** 把仓库里的展示包复制进测试 DATA_ROOT，可按需裁剪/篡改。 */
function seedPackage(
  dataRoot: string,
  options: { withBasemap?: boolean; mutate?: (payload: any) => void; omitPayload?: boolean } = {},
): string {
  const target = path.join(dataRoot, 'perception', PACKAGE_ID);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(REPO_PACKAGE, 'PROVENANCE.json'), path.join(target, 'PROVENANCE.json'));
  if (!options.omitPayload) {
    const payload = JSON.parse(fs.readFileSync(path.join(REPO_PACKAGE, 'citystreet_display.json'), 'utf8'));
    options.mutate?.(payload);
    fs.writeFileSync(path.join(target, 'citystreet_display.json'), JSON.stringify(payload));
  }
  if (options.withBasemap) fs.writeFileSync(path.join(target, 'orthophoto-z20.jpg'), TINY_JPEG);
  resetDisplayCacheForTests();
  return target;
}

test('PROVENANCE 中登记的 SHA-256 与仓库内实际文件一致', () => {
  const provenance = readProvenance();
  assert.equal(provenance.package_id, PACKAGE_ID);
  assert.equal(provenance.usage_tier, 'demo_only');

  const tracked = (provenance.files as any[]).filter(file => file.tracked);
  assert.ok(tracked.length >= 2, 'PROVENANCE 必须登记至少数据文件与说明文件');

  for (const file of tracked) {
    const filePath = path.join(REPO_PACKAGE, file.name);
    assert.ok(fs.existsSync(filePath), `缺少登记文件：${file.name}`);
    const buffer = fs.readFileSync(filePath);
    if (typeof file.bytes === 'number') assert.equal(buffer.length, file.bytes, `${file.name} 字节数不符`);
    assert.equal(
      crypto.createHash('sha256').update(buffer).digest('hex'),
      file.sha256,
      `${file.name} 的 SHA-256 与 PROVENANCE 不一致（数据被改动或 PROVENANCE 未更新）`,
    );
  }
});

test('数据自述数字可复算：第 2300 帧 S-A 区 4 人 / 中位速度 1.963 m/s / 播放第 5 秒', () => {
  const payload = JSON.parse(fs.readFileSync(path.join(REPO_PACKAGE, 'citystreet_display.json'), 'utf8'));
  const frame = payload.frames.find((item: any) => item.frame_id === 2300);
  assert.ok(frame, '缺少 frame 2300');
  assert.equal(frame.timestamp_ms, 5000, '第 2300 帧应处于片段起点后 5 秒');

  const zone = frame.zone_stats.find((item: any) => item.zone_id === 'S-A');
  assert.equal(zone.estimated_people, 4);
  assert.equal(zone.speed_sample_count, 3);
  assert.equal(zone.median_speed_mps, 1.963);
  assert.deepEqual(zone.direction_counts, { toward_junction: 1, away_from_junction: 2, unknown: 1 });
});

test('去重后的总点位数与帧数可复算（60 帧 / 4119 条点位）', () => {
  const payload = JSON.parse(fs.readFileSync(path.join(REPO_PACKAGE, 'citystreet_display.json'), 'utf8'));
  assert.equal(payload.frames.length, 60);
  assert.equal(payload.zones.length, 13);
  const total = payload.frames.reduce((sum: number, frame: any) => sum + frame.people.length, 0);
  assert.equal(total, 4119);
});

test('非法包 ID 直接拒绝，不允许路径穿越', () => {
  for (const candidate of ['../../etc', '..', 'a/b', 'CityStreet', 'city street', '']) {
    assert.throws(
      () => loadDisplayPackage(candidate),
      (error: unknown) => error instanceof DisplayPackageError,
      `应当拒绝包 ID：${JSON.stringify(candidate)}`,
    );
  }
});

test('HTTP：展示包列表只给摘要，且显式标注 demo_only / 无真值', async () => {
  const server = await startTestServer();
  try {
    seedPackage(server.dataRoot);
    const response = await server.request('/api/v1/perception/displays');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const display = response.body.displays.find((item: any) => item.package_id === PACKAGE_ID);
    assert.ok(display, '列表中应包含 citystreet-display');
    assert.equal(display.usage_tier, 'demo_only');
    assert.equal(display.license_status, 'UNVERIFIED');
    assert.equal(display.ground_truth_available, false);
    assert.equal(display.provenance_complete, true);
    assert.equal(display.frame_count, 60);
    assert.equal(display.zone_count, 13);
    assert.equal(display.frames, undefined, '列表不应携带逐帧点位');
    assert.ok(display.limitations.length >= 3, '必须透出已知误差');
  } finally {
    await server.close();
  }
});

test('HTTP：元信息含区域边界、来源与"不得据此报告精度"的声明', async () => {
  const server = await startTestServer();
  try {
    seedPackage(server.dataRoot);
    const response = await server.request(`/api/v1/perception/displays/${PACKAGE_ID}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.zones.length, 13);
    assert.equal(response.body.map.width_px, 768);
    assert.equal(response.body.map.height_px, 768);
    assert.equal(response.body.basemap.available, false, '未提供底图时应如实报告不可用');
    assert.match(response.body.notice, /不得用于报告精度/);
    assert.ok(
      response.body.prohibited_claims.some((claim: string) => claim.includes('精度')),
      'PROVENANCE 的可禁止主张必须透出到 API',
    );
    assert.ok(response.body.provenance.source.dataset.includes('CityStreet'));
  } finally {
    await server.close();
  }
});

test('HTTP：逐帧分页按 frame_id 起点切片并给出 next_from', async () => {
  const server = await startTestServer();
  try {
    seedPackage(server.dataRoot);

    const first = await server.request(`/api/v1/perception/displays/${PACKAGE_ID}/frames`);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.returned, 60);
    assert.equal(first.body.truncated, false);
    assert.equal(first.body.frames[0].frame_id, 2280);
    assert.equal(first.body.frames[0].zone_stats.length, 13);

    const page = await server.request(`/api/v1/perception/displays/${PACKAGE_ID}/frames?from=2300&limit=10`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.equal(page.body.frames[0].frame_id, 2300);
    assert.equal(page.body.returned, 10);
    assert.equal(page.body.truncated, true);
    assert.equal(page.body.next_from, 2310);

    const beyond = await server.request(`/api/v1/perception/displays/${PACKAGE_ID}/frames?from=9999`);
    assert.equal(beyond.status, 200);
    assert.equal(beyond.body.returned, 0);
    assert.equal(beyond.body.next_from, null);
  } finally {
    await server.close();
  }
});

test('HTTP：分页参数非法时返回 400 而不是静默降级', async () => {
  const server = await startTestServer();
  try {
    seedPackage(server.dataRoot);
    for (const query of ['limit=0', 'limit=241', 'limit=abc', 'from=1.5']) {
      const response = await server.request(`/api/v1/perception/displays/${PACKAGE_ID}/frames?${query}`);
      assert.equal(response.status, 400, `${query} 应被拒绝`);
      assert.equal(response.body.error.code, 'INVALID_QUERY');
    }
  } finally {
    await server.close();
  }
});

test('HTTP：未知展示包返回 404，缺少数据文件返回 422', async () => {
  const server = await startTestServer();
  try {
    seedPackage(server.dataRoot);
    const missing = await server.request('/api/v1/perception/displays/no-such-package');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'DISPLAY_NOT_FOUND');

    seedPackage(server.dataRoot, { omitPayload: true });
    const broken = await server.request(`/api/v1/perception/displays/${PACKAGE_ID}`);
    assert.equal(broken.status, 422);
    assert.equal(broken.body.error.code, 'DISPLAY_PACKAGE_INVALID');
  } finally {
    await server.close();
  }
});

test('HTTP：内部一致的包被篡改后 fail closed（方向人数超过总人数）', async () => {
  const server = await startTestServer();
  try {
    seedPackage(server.dataRoot, {
      mutate: payload => {
        payload.frames[0].zone_stats[0].direction_counts.toward_junction = 99;
      },
    });
    const response = await server.request(`/api/v1/perception/displays/${PACKAGE_ID}`);
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'DISPLAY_PACKAGE_INVALID');
    assert.ok(
      (response.body.error.detail as string[]).some(item => item.startsWith('direction_counts_exceed_people')),
      `应指出具体违规：${JSON.stringify(response.body.error.detail)}`,
    );
  } finally {
    await server.close();
  }
});

test('HTTP：包内缺失 PROVENANCE 时降级为 UNKNOWN，不冒充已核验来源', async () => {
  const server = await startTestServer();
  try {
    const target = seedPackage(server.dataRoot);
    fs.rmSync(path.join(target, 'PROVENANCE.json'));
    resetDisplayCacheForTests();
    const response = await server.request(`/api/v1/perception/displays/${PACKAGE_ID}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.license_status, 'UNKNOWN');
    assert.equal(response.body.provenance_complete, false);
    assert.equal(response.body.ground_truth_available, false);
  } finally {
    await server.close();
  }
});

test('HTTP：底图未分发时返回 BASEMAP_NOT_BUNDLED，分发后正常返回图片', async () => {
  const server = await startTestServer();
  try {
    seedPackage(server.dataRoot);
    const absent = await server.request(`/api/v1/perception/displays/${PACKAGE_ID}/basemap`);
    assert.equal(absent.status, 404);
    assert.equal(absent.body.error.code, 'BASEMAP_NOT_BUNDLED');
    assert.equal(absent.body.error.detail.expected_file, 'orthophoto-z20.jpg');

    seedPackage(server.dataRoot, { withBasemap: true });
    const present = await server.request(`/api/v1/perception/displays/${PACKAGE_ID}/basemap`);
    assert.equal(present.status, 200);
    assert.equal(present.headers.get('content-type'), 'image/jpeg');
    assert.equal(present.rawBody.length, TINY_JPEG.length);
  } finally {
    await server.close();
  }
});
