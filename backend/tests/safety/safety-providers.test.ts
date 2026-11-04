/**
 * 感知 provider 集成测试。
 *
 * 视频用例会**真实生成并解码一段视频**，验证 CPU 推理链路（OpenCV MOG2）在本机可运行，
 * 而不是返回预设值。若本机缺少 OpenCV，用例会显式跳过并报告原因，绝不伪装通过。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecordedVideoCrowdProvider } from '../../src/services/safety/providers/video';
import { AscendCrowdProvider } from '../../src/services/safety/providers/ascend';
import { SimulationCrowdProvider } from '../../src/services/safety/providers/simulation';
import { ProviderUnavailableError } from '../../src/services/safety/providers/types';
import { loadScenario } from './fixtures';

const VIDEO_GENERATOR = `
import sys
import cv2
import numpy as np

out = sys.argv[1]
width, height, fps, frames = 640, 360, 25, 60
writer = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*'mp4v'), fps, (width, height))
if not writer.isOpened():
    print(json_error := 'writer_failed')
    sys.exit(3)
background = np.full((height, width, 3), 90, dtype=np.uint8)
for i in range(frames):
    frame = background.copy()
    for k, (x0, y0) in enumerate([(60, 60), (300, 150), (520, 90)]):
        x = x0 + int(40 * np.sin((i + k * 7) / 8.0))
        cv2.rectangle(frame, (x, y0), (x + 40, y0 + 90), (235, 235, 235), -1)
    writer.write(frame)
writer.release()
print('ok')
`;

function makeTempVideo(): { dir: string; videoPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-video-'));
  const scriptPath = path.join(dir, 'generate.py');
  const videoPath = path.join(dir, 'crowd.avi');
  fs.writeFileSync(scriptPath, VIDEO_GENERATOR, 'utf8');
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  execFileSync(process.env.SKYGUARD_PYTHON || 'python', ['-I', scriptPath, videoPath], { windowsHide: true });
  return { dir, videoPath };
}

test('视频推理链路在本机真实可运行，且产出明确标注为实测而非模拟', async () => {
  const provider = new RecordedVideoCrowdProvider();
  const status = await provider.status();
  if (!status.available) {
    console.warn('[skip] 本机缺少 OpenCV，视频推理链路未验证：', status.checks);
    return;
  }

  const scenario = loadScenario();
  const region = scenario.regions.find(item => item.id === 'R_MAIN')!;
  const { dir, videoPath } = makeTempVideo();
  try {
    const result = await provider.infer({ region, videoPath, maxFrames: 60, sampleEvery: 1 });
    assert.ok(result.count > 0, `应从合成视频中检出运动目标，实际 ${result.count}`);
    assert.ok(result.count <= 6, `检出数量异常：${result.count}`);
    assert.equal(result.evidence?.simulated, false);
    assert.equal(result.provider, 'recorded-video-opencv-v1');
    assert.ok(result.warnings.includes('uncalibrated_camera'), '未标定摄像机必须标注');
    assert.ok(result.confidence <= 0.35, `未标定摄像机下置信度应被压低，实际 ${result.confidence}`);
    assert.ok(result.calibrationVersion.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('已标定摄像机下视频观测可信度不被压低，未标定则被强制压低', async () => {
  const provider = new RecordedVideoCrowdProvider();
  const status = await provider.status();
  if (!status.available) return;

  const scenario = loadScenario();
  const base = scenario.regions.find(item => item.id === 'R_MAIN')!;
  const { dir, videoPath } = makeTempVideo();
  try {
    const calibrated = {
      ...base,
      camera: { ...base.camera, calibration_status: 'measured' as const, calibration_version: 'cam-main-2026-10' },
    };
    const measured = await provider.infer({ region: calibrated, videoPath, maxFrames: 60, sampleEvery: 10 });
    assert.ok(measured.confidence > 0.6, `已标定摄像机应保留真实置信度，实际 ${measured.confidence}`);
    assert.equal(measured.calibrationVersion, 'cam-main-2026-10');
    assert.ok(!measured.warnings.includes('uncalibrated_camera'));

    const uncalibrated = await provider.infer({ region: base, videoPath, maxFrames: 60, sampleEvery: 10 });
    assert.ok(uncalibrated.confidence <= 0.35);
    assert.ok(uncalibrated.warnings.includes('uncalibrated_camera'));
    assert.equal(uncalibrated.count, measured.count, '同一视频的原始检出人数应一致');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('视频不可读时 provider 抛出明确的不可用错误', async () => {
  const provider = new RecordedVideoCrowdProvider();
  const status = await provider.status();
  if (!status.available) return;

  const scenario = loadScenario();
  const region = scenario.regions.find(item => item.id === 'R_EAST')!;
  await assert.rejects(
    () => provider.infer({ region, videoPath: path.join(os.tmpdir(), 'definitely-not-a-video.mp4') }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderUnavailableError);
      assert.match((error as Error).message, /视频分析失败|无法打开/);
      return true;
    },
  );
});

test('昇腾 provider 在无设备环境下如实报告不可用', async () => {
  const provider = new AscendCrowdProvider();
  const status = await provider.status();
  assert.equal(status.kind, 'ascend');
  assert.equal(status.verified_on_this_host, false);
  assert.ok(status.checks.some(check => check.name === 'cann_toolkit'));
  assert.ok(status.checks.some(check => check.name === 'npu_smi'));
  assert.ok(status.checks.some(check => check.name === 'runtime_command'));
  assert.ok(status.checks.some(check => check.name === 'model'));
  assert.ok(status.notes.some(note => note.includes('未经实测')));

  if (!status.available) {
    const scenario = loadScenario();
    const region = scenario.regions[0];
    await assert.rejects(
      () => provider.infer({ region }),
      (error: unknown) => error instanceof ProviderUnavailableError,
    );
  }
});

test('模拟 provider 输出稳定且始终标记为 simulation', async () => {
  const provider = new SimulationCrowdProvider({ R_MAIN: { count: 321, confidence: 0.88 } });
  const scenario = loadScenario();
  const region = scenario.regions.find(item => item.id === 'R_MAIN')!;
  const first = await provider.infer({ region });
  const second = await provider.infer({ region });
  assert.equal(first.count, 321);
  assert.deepEqual(first, second);
  assert.equal(first.evidence?.simulated, true);
  assert.ok(first.warnings.includes('simulated_data'));
  assert.equal((await provider.status()).source, 'simulation');
});
