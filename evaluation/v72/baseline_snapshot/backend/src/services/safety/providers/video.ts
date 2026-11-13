/**
 * 视频人群感知 provider（CPU 真实推理路径）。
 *
 * 实际执行链路：Node → `python backend/python/crowd_service.py` → OpenCV(MOG2) → JSON。
 * 输出的人数来自真实像素分析，不是预设值；但方法本身有明确局限（见 crowd_service.py）。
 *
 * 标定语义：区域摄像机未标定时，置信度被强制压低并附带 `uncalibrated_camera` 警告，
 * 避免把"像素里的前景块数量"包装成"已标定的人数"。
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import type {
  CrowdInferenceProvider,
  CrowdInferenceRequest,
  CrowdInferenceResult,
  ProviderCheck,
  ProviderStatus,
} from './types';
import { ProviderUnavailableError } from './types';

const SCRIPT_PATH = path.resolve(__dirname, '../../../../python/crowd_service.py');
const PYTHON_BIN = process.env.SKYGUARD_PYTHON || 'python';

interface CrowdServiceOutput {
  ok?: boolean;
  error?: string;
  message?: string;
  mean_count?: number;
  confidence?: number;
  frames_analyzed?: number;
  coefficient_of_variation?: number;
  mean_blob_area_px?: number;
  warnings?: string[];
  limitations?: string[];
  method?: string;
}

function runPython(args: string[], timeoutMs = 120000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export class RecordedVideoCrowdProvider implements CrowdInferenceProvider {
  readonly id = 'recorded-video-opencv-v1';
  private cachedChecks?: { checks: ProviderCheck[]; available: boolean };

  async probe(): Promise<{ checks: ProviderCheck[]; available: boolean }> {
    if (this.cachedChecks) return this.cachedChecks;

    const checks: ProviderCheck[] = [];

    try {
      const { stdout } = await runPython(['--version'], 15000);
      checks.push({ name: 'python', ok: true, detail: stdout.trim() || 'python 可执行' });
    } catch (error) {
      checks.push({ name: 'python', ok: false, detail: `无法执行 ${PYTHON_BIN}：${(error as Error).message}` });
      this.cachedChecks = { checks, available: false };
      return this.cachedChecks;
    }

    try {
      const { stdout } = await runPython(
        ['-I', '-c', 'import cv2, numpy; print(cv2.__version__, numpy.__version__)'],
        30000,
      );
      checks.push({ name: 'opencv', ok: true, detail: `cv2/numpy ${stdout.trim()}` });
    } catch (error) {
      checks.push({ name: 'opencv', ok: false, detail: `未安装 opencv-python 或 numpy：${(error as Error).message}` });
    }

    const available = checks.every(check => check.ok);
    this.cachedChecks = { checks, available };
    return this.cachedChecks;
  }

  async status(): Promise<ProviderStatus> {
    const { checks, available } = await this.probe();
    return {
      id: this.id,
      kind: 'recorded_video',
      source: 'recorded_video',
      available,
      verified_on_this_host: available,
      model_version: 'opencv-mog2/1.0.0',
      checks,
      notes: [
        '真实读取视频像素进行运动前景连通域计数，不是随机数或预设值。',
        '需要固定机位；镜头移动或光照剧变会导致背景建模失效。',
        '多人粘连时计数偏低，高密度场景下只能视为下界。',
        '脚本路径：backend/python/crowd_service.py',
      ],
    };
  }

  async infer(request: CrowdInferenceRequest): Promise<CrowdInferenceResult> {
    const { checks, available } = await this.probe();
    if (!available) {
      throw new ProviderUnavailableError(this.id, '本机缺少可用的 OpenCV 运行环境', checks);
    }
    if (!request.videoPath) {
      throw new ProviderUnavailableError(this.id, '缺少 videoPath 参数', checks);
    }

    const args = [
      '-I',
      SCRIPT_PATH,
      '--video',
      request.videoPath,
      '--max-frames',
      String(request.maxFrames ?? 90),
      '--sample-every',
      String(request.sampleEvery ?? 15),
    ];
    const roi = request.region.camera.roi;
    if (roi) {
      args.push('--roi', `${roi.x},${roi.y},${roi.w},${roi.h}`);
    }

    let stdout: string;
    try {
      const result = await runPython(args);
      stdout = result.stdout;
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string };
      let parsed: CrowdServiceOutput | undefined;
      try {
        parsed = JSON.parse(err.stdout ?? '');
      } catch {
        parsed = undefined;
      }
      throw new ProviderUnavailableError(
        this.id,
        `视频分析失败：${parsed?.message ?? err.message}`,
        [{ name: 'crowd_service', ok: false, detail: (err.stderr ?? '').slice(0, 400) || err.message }],
      );
    }

    let payload: CrowdServiceOutput;
    try {
      payload = JSON.parse(stdout) as CrowdServiceOutput;
    } catch {
      throw new ProviderUnavailableError(this.id, 'crowd_service 输出不是合法 JSON', [
        { name: 'crowd_service', ok: false, detail: stdout.slice(0, 400) },
      ]);
    }

    if (!payload.ok) {
      throw new ProviderUnavailableError(this.id, payload.message ?? payload.error ?? '视频分析失败', [
        { name: 'crowd_service', ok: false, detail: String(payload.error ?? 'unknown') },
      ]);
    }

    const warnings = [...(payload.warnings ?? [])];
    let confidence = payload.confidence ?? 0;

    const calibrationStatus = request.region.camera.calibration_status;
    if (calibrationStatus === 'uncalibrated') {
      confidence = Math.min(confidence, 0.35);
      warnings.push('uncalibrated_camera');
    } else if (calibrationStatus === 'estimated') {
      confidence = Math.min(confidence, 0.65);
      warnings.push('estimated_calibration');
    }

    return {
      count: Math.max(0, Math.round(payload.mean_count ?? 0)),
      confidence: Number(confidence.toFixed(4)),
      provider: this.id,
      modelVersion: `opencv-mog2/1.0.0`,
      calibrationVersion: request.region.camera.calibration_version,
      evidence: {
        simulated: false,
        method: payload.method,
        frames_analyzed: payload.frames_analyzed,
        coefficient_of_variation: payload.coefficient_of_variation,
        mean_blob_area_px: payload.mean_blob_area_px,
        limitations: payload.limitations,
        video: request.videoPath,
      },
      warnings,
    };
  }
}
