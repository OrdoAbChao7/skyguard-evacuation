/**
 * 实时流 provider 集成测试。
 *
 * 用本机 HTTP 服务暴露一段真实生成的视频，走 OpenCV/FFmpeg 的网络流解码路径。
 * 这能证明“网络流 → 推理 → 观测”链路可用，但**不能**证明真实 RTSP 摄像头已验证；
 * 测试名称与断言都保留这个边界。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { LiveVideoCrowdProvider } from '../../src/services/safety/providers/live-video';
import { ProviderUnavailableError } from '../../src/services/safety/providers/types';
import { loadScenario } from './fixtures';
import { makeTempStreamVideo, serveVideo } from './stream-fixtures';

test('实时流 provider 状态如实报告 FFMPEG 后端与实机验证状态', async () => {
  const provider = new LiveVideoCrowdProvider();
  const status = await provider.status();
  assert.equal(status.kind, 'live_video');
  assert.equal(status.source, 'live_video');
  assert.ok(status.checks.some(check => check.name === 'python'));
  assert.ok(status.checks.some(check => check.name === 'opencv'));
  assert.ok(status.checks.some(check => check.name === 'ffmpeg_backend'));
  assert.ok(status.notes.some(note => note.includes('RTSP')));
  if (!status.available) {
    assert.equal(status.verified_on_this_host, false);
  }
});

test('HTTP 网络流真实推理：有检出、标注未标定、证据中不含凭据', async () => {
  const provider = new LiveVideoCrowdProvider();
  const status = await provider.status();
  if (!status.available) {
    console.warn('[skip] 本机缺少 OpenCV/FFmpeg，实时流链路未验证：', status.checks);
    return;
  }

  const scenario = loadScenario();
  const region = scenario.regions.find(item => item.id === 'R_MAIN')!;
  const { dir, videoPath } = makeTempStreamVideo();
  const server = await serveVideo(videoPath);
  try {
    const result = await provider.infer({
      region,
      streamId: 'test-http-cam',
      streamUrl: server.url,
      maxFrames: 15,
      sampleEvery: 1,
      maxSeconds: 10,
      reconnectAttempts: 0,
    });

    assert.ok(result.count > 0, `应从网络流中检出运动目标，实际 ${result.count}`);
    assert.equal(result.provider, 'live-video-opencv-v1');
    assert.equal(result.evidence?.simulated, false);
    assert.equal(result.evidence?.source_type, 'live_stream');
    assert.equal(result.evidence?.stream_id, 'test-http-cam');
    assert.ok(String(result.evidence?.stream_url_redacted).startsWith('http://127.0.0.1:'));
    assert.ok(!String(result.evidence?.stream_url_redacted).includes('token='));
    assert.ok(result.warnings.includes('uncalibrated_camera'), '未标定摄像机必须标注');
    assert.ok(result.confidence <= 0.35, `未标定摄像机下置信度应被压低，实际 ${result.confidence}`);
    assert.ok(result.calibrationVersion.length > 0);

    const after = await provider.status();
    assert.equal(after.verified_on_this_host, true, '成功读取网络流后应标记为本机已验证');
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('流不可读时明确失败，不返回 0 人冒充安全', async () => {
  const provider = new LiveVideoCrowdProvider();
  const status = await provider.status();
  if (!status.available) return;

  const scenario = loadScenario();
  const region = scenario.regions.find(item => item.id === 'R_MAIN')!;
  await assert.rejects(
    () =>
      provider.infer({
        region,
        streamId: 'dead-stream',
        streamUrl: 'rtsp://127.0.0.1:1/nope',
        maxFrames: 1,
        maxSeconds: 2,
        reconnectAttempts: 0,
        openTimeoutMs: 1000,
        readTimeoutMs: 1000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderUnavailableError);
      assert.match((error as Error).message, /实时流分析失败|无法打开视频流|未能从视频流/);
      return true;
    },
  );
});
