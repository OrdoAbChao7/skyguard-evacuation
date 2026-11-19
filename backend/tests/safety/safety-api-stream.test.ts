/**
 * 实时流 HTTP API 集成测试。
 *
 * 覆盖：运维权限、配置元数据脱敏、真实网络流推理写回、未知/禁用/未配置/配置错误。
 * 网络流由本机 HTTP 服务提供，不是真实 RTSP 摄像头；测试结论只到“链路可用”。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { jsonBody, startTestServer, type TestServer } from '../helpers/api-fixtures';
import { resetSafetyServiceForTests } from '../../src/services/safety';
import { resetStreamRegistryForTests } from '../../src/services/safety/streams';
import { SECRET } from '../../src/api/v1/auth';
import { REPO_SCENARIO_PATH } from './fixtures';
import { makeTempStreamVideo, serveVideo } from './stream-fixtures';

async function startSafetyServer(): Promise<TestServer> {
  resetSafetyServiceForTests();
  resetStreamRegistryForTests();
  const server = await startTestServer();
  const scenarioDir = path.join(server.dataRoot, 'scenarios');
  fs.mkdirSync(scenarioDir, { recursive: true });
  const scenarioFile = path.join(scenarioDir, 'venue-default.json');
  fs.copyFileSync(REPO_SCENARIO_PATH, scenarioFile);
  process.env.SAFETY_SCENARIO_FILE = scenarioFile;
  return server;
}

async function authHeaders(server: TestServer): Promise<Record<string, string>> {
  const response = await server.request('/api/v1/auth/login', jsonBody({
    username: process.env.SKYGUARD_ADMIN_USERNAME || 'admin',
    password: process.env.SKYGUARD_ADMIN_PASSWORD || 'skyguard2026',
  }));
  assert.equal(response.status, 200, '管理员登录应成功');
  return {
    Authorization: `Bearer ${response.body.access_token}`,
    'Content-Type': 'application/json',
  };
}

function viewerToken(): string {
  return jwt.sign({ username: 'viewer-7', role: 'viewer' }, SECRET, { expiresIn: '1h' });
}

test('实时流观测写入 live_video，配置元数据不泄漏完整 URL', async () => {
  const { dir, videoPath } = makeTempStreamVideo();
  const videoServer = await serveVideo(videoPath);
  process.env.SKYGUARD_STREAMS = JSON.stringify([
    {
      id: 'cam-main',
      label: '主入口',
      region_id: 'R_MAIN',
      url: `${videoServer.url}?token=stream-secret`,
      max_frames: 15,
      sample_every: 1,
      max_seconds: 10,
    },
  ]);

  const server = await startSafetyServer();
  try {
    const admin = await authHeaders(server);

    const metadata = await server.request('/api/v1/safety/streams');
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.configured, true);
    assert.equal(metadata.body.streams[0].id, 'cam-main');
    assert.equal(metadata.body.streams[0].label, '主入口');
    assert.equal(metadata.body.streams[0].region_id, 'R_MAIN');
    assert.ok(metadata.body.streams[0].region_name, '应解析出绑定区域的名称');
    assert.ok(!('url' in metadata.body.streams[0]), 'API 不得返回完整 URL');
    assert.ok(!JSON.stringify(metadata.body).includes('127.0.0.1'), 'API 不得泄漏流主机地址');

    const providers = await server.request('/api/v1/safety/providers');
    assert.equal(providers.status, 200);
    const live = providers.body.providers.find((provider: any) => provider.kind === 'live_video');
    assert.ok(live, 'provider 列表必须包含实时流 provider');
    assert.equal(live.source, 'live_video');

    const response = await server.request('/api/v1/safety/observations/stream', {
      ...jsonBody({ stream_id: 'cam-main', recompute: false }),
      headers: admin,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.observation.source, 'live_video');
    assert.equal(response.body.observation.region_id, 'R_MAIN');
    assert.equal(response.body.observation.provider, 'live-video-opencv-v1');
    assert.ok(response.body.observation.estimated_count > 0);
    assert.equal(response.body.inference.evidence.simulated, false);
    assert.equal(response.body.inference.evidence.stream_id, 'cam-main');
    assert.ok(
      String(response.body.inference.evidence.stream_url_redacted).startsWith('http://127.0.0.1:'),
      '观测证据保留脱敏后的主机/路径，便于排障',
    );
    assert.ok(!JSON.stringify(response.body).includes('stream-secret'), '观测响应不得包含 query 凭据');
    assert.ok(!String(response.body.inference.evidence.stream_url_redacted).includes('token='));
    assert.ok(response.body.observation.evidence.warnings.includes('uncalibrated_camera'));
  } finally {
    await server.close();
    await videoServer.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.SKYGUARD_STREAMS;
    resetStreamRegistryForTests();
  }
});

test('实时流观测需要运维权限；未知、禁用、未配置、配置错误都明确拒绝', async () => {
  process.env.SKYGUARD_STREAMS = JSON.stringify([
    { id: 'disabled-cam', region_id: 'R_MAIN', url: 'rtsp://10.0.0.9:554/live', enabled: false },
  ]);

  const server = await startSafetyServer();
  try {
    const anonymous = await server.request('/api/v1/safety/observations/stream', jsonBody({ stream_id: 'disabled-cam' }));
    assert.equal(anonymous.status, 401);

    const viewer = await server.request('/api/v1/safety/observations/stream', {
      ...jsonBody({ stream_id: 'disabled-cam' }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken()}` },
    });
    assert.equal(viewer.status, 403);
    assert.equal(viewer.body.error.code, 'FORBIDDEN');

    const admin = await authHeaders(server);
    const disabled = await server.request('/api/v1/safety/observations/stream', {
      ...jsonBody({ stream_id: 'disabled-cam' }),
      headers: admin,
    });
    assert.equal(disabled.status, 409);
    assert.equal(disabled.body.error.code, 'STREAM_DISABLED');

    const unknown = await server.request('/api/v1/safety/observations/stream', {
      ...jsonBody({ stream_id: 'not-configured' }),
      headers: admin,
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'UNKNOWN_STREAM');

    delete process.env.SKYGUARD_STREAMS;
    resetStreamRegistryForTests();
    const notConfigured = await server.request('/api/v1/safety/observations/stream', {
      ...jsonBody({ stream_id: 'cam-main' }),
      headers: admin,
    });
    assert.equal(notConfigured.status, 503);
    assert.equal(notConfigured.body.error.code, 'STREAM_NOT_CONFIGURED');

    process.env.SKYGUARD_STREAMS = JSON.stringify([
      { id: 'bad', region_id: 'R_MAIN', url: 'file:///etc/passwd' },
    ]);
    resetStreamRegistryForTests();
    const invalid = await server.request('/api/v1/safety/observations/stream', {
      ...jsonBody({ stream_id: 'bad' }),
      headers: admin,
    });
    assert.equal(invalid.status, 503);
    assert.equal(invalid.body.error.code, 'STREAM_CONFIG_INVALID');
    assert.ok(!JSON.stringify(invalid.body).includes('/etc/passwd'), '错误详情不得回显敏感路径');
  } finally {
    await server.close();
    delete process.env.SKYGUARD_STREAMS;
    resetStreamRegistryForTests();
  }
});

test('实时流绑定的区域不存在时拒绝写入', async () => {
  process.env.SKYGUARD_STREAMS = JSON.stringify([
    { id: 'orphan-cam', region_id: 'R_DOES_NOT_EXIST', url: 'rtsp://10.0.0.10:554/live' },
  ]);

  const server = await startSafetyServer();
  try {
    const admin = await authHeaders(server);
    const response = await server.request('/api/v1/safety/observations/stream', {
      ...jsonBody({ stream_id: 'orphan-cam' }),
      headers: admin,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'UNKNOWN_REGION');
  } finally {
    await server.close();
    delete process.env.SKYGUARD_STREAMS;
    resetStreamRegistryForTests();
  }
});
