/**
 * 实时视频流人群感知 provider（CPU 真实推理路径）。
 *
 * 实际执行链路：Node → `python backend/python/crowd_service.py --stream` → OpenCV/FFmpeg
 * → JSON。支持 RTSP/RTMP/HTTP(S)；每次只读取一个短窗口，不是连续后台监控。
 *
 * 安全约束：
 *  - HTTP API 只传 `stream_id`，URL 由服务端注册表解析，本 provider 不直接暴露给前端；
 *  - 所有错误、证据和日志中的 URL 都经过脱敏，凭据不会离开进程；
 *  - 未接入真实摄像头时 `verified_on_this_host=false`，首次成功读取流后才置为 true；
 *  - 浏览器不能直接播放 RTSP；前端展示需要 HLS/WebRTC 网关或服务端快照。
 */
import path from 'node:path';
import { PYTHON_BIN, runPython } from './python-runner';
import { redactStreamUrl, sanitizeStreamText } from '../streams';
import type {
  CrowdInferenceProvider,
  CrowdInferenceRequest,
  CrowdInferenceResult,
  ProviderCheck,
  ProviderStatus,
} from './types';
import { ProviderUnavailableError } from './types';

const SCRIPT_PATH = path.resolve(__dirname, '../../../../python/crowd_service.py');
const MODEL_VERSION = 'opencv-mog2-stream/1.0.0';

interface CrowdServiceOutput {
  ok?: boolean;
  error?: string;
  message?: string;
  source_type?: string;
  stream?: string;
  mean_count?: number;
  confidence?: number;
  frames_analyzed?: number;
  coefficient_of_variation?: number;
  mean_blob_area_px?: number;
  reconnects?: number;
  elapsed_ms?: number;
  effective_fps?: number;
  warnings?: string[];
  limitations?: string[];
  method?: string;
}

export class LiveVideoCrowdProvider implements CrowdInferenceProvider {
  readonly id = 'live-video-opencv-v1';
  private cachedChecks?: { checks: ProviderCheck[]; available: boolean };
  /** 只有在本进程内成功读取过一路真实流，才把 verified_on_this_host 置为 true。 */
  private verified = false;

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

    try {
      const { stdout } = await runPython(
        [
          '-I',
          '-c',
          [
            'import cv2',
            'info = cv2.getBuildInformation()',
            "ok = any(line.strip().startswith('FFMPEG:') and 'YES' in line for line in info.splitlines())",
            "print('yes' if ok else 'no')",
          ].join('\n'),
        ],
        30000,
      );
      const ffmpeg = stdout.trim() === 'yes';
      checks.push({
        name: 'ffmpeg_backend',
        ok: ffmpeg,
        detail: ffmpeg
          ? 'OpenCV 构建包含 FFMPEG 后端，可尝试 RTSP/RTMP/HTTP(S)'
          : 'OpenCV 构建不含 FFMPEG 后端，无法打开实时流',
      });
    } catch (error) {
      checks.push({ name: 'ffmpeg_backend', ok: false, detail: `无法检查 FFMPEG 后端：${(error as Error).message}` });
    }

    const available = checks.every(check => check.ok);
    this.cachedChecks = { checks, available };
    return this.cachedChecks;
  }

  async status(): Promise<ProviderStatus> {
    const { checks, available } = await this.probe();
    return {
      id: this.id,
      kind: 'live_video',
      source: 'live_video',
      available,
      verified_on_this_host: this.verified,
      model_version: MODEL_VERSION,
      checks,
      notes: [
        '通过 OpenCV/FFmpeg 打开 RTSP/RTMP/HTTP(S) 视频流，读取短窗口后给出估计人数。',
        '未接入真实摄像头时不会声称已实机验证；首次成功读取流后 verified_on_this_host 才为 true。',
        '浏览器不能直接播放 RTSP；前端展示需要 HLS/WebRTC 网关或服务端快照。',
        '固定机位、已标定 ROI；未标定摄像机置信度会被上层强制压低。',
        '每次只读取短窗口，不是连续后台监控；断流会明确失败，不返回 0 人冒充安全。',
      ],
    };
  }

  async infer(request: CrowdInferenceRequest): Promise<CrowdInferenceResult> {
    const { checks, available } = await this.probe();
    if (!available) {
      throw new ProviderUnavailableError(this.id, '本机缺少可用的 OpenCV/FFmpeg 实时流运行环境', checks);
    }
    if (!request.streamId || !request.streamUrl) {
      throw new ProviderUnavailableError(this.id, '缺少 streamId 或 streamUrl 参数', checks);
    }

    const maxFrames = request.maxFrames ?? 30;
    const sampleEvery = request.sampleEvery ?? 5;
    const maxSeconds = request.maxSeconds ?? 20;
    const openTimeoutMs = request.openTimeoutMs ?? 5000;
    const readTimeoutMs = request.readTimeoutMs ?? 5000;
    const reconnectAttempts = request.reconnectAttempts ?? 2;

    const args = [
      '-I',
      SCRIPT_PATH,
      '--stream',
      request.streamUrl,
      '--max-frames',
      String(maxFrames),
      '--sample-every',
      String(sampleEvery),
      '--max-seconds',
      String(maxSeconds),
      '--open-timeout-ms',
      String(openTimeoutMs),
      '--read-timeout-ms',
      String(readTimeoutMs),
      '--reconnect-attempts',
      String(reconnectAttempts),
    ];
    const roi = request.roi ?? request.region.camera.roi;
    if (roi) {
      args.push('--roi', `${roi.x},${roi.y},${roi.w},${roi.h}`);
    }

    // 给 Python 留出打开、读取窗口和重连的余量；execFile 超时是最后一道兜底。
    const timeoutMs = Math.min(180000, Math.max(15000, Math.ceil((maxSeconds + 10) * 1000)));

    let stdout: string;
    try {
      const result = await runPython(args, timeoutMs);
      stdout = result.stdout;
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string };
      let parsed: CrowdServiceOutput | undefined;
      try {
        parsed = JSON.parse(err.stdout ?? '') as CrowdServiceOutput;
      } catch {
        parsed = undefined;
      }
      const detail = sanitizeStreamText((err.stderr ?? '').slice(0, 400) || err.message);
      throw new ProviderUnavailableError(
        this.id,
        sanitizeStreamText(parsed?.message ?? '实时流分析失败'),
        [{ name: 'crowd_service', ok: false, detail }],
      );
    }

    let payload: CrowdServiceOutput;
    try {
      payload = JSON.parse(stdout) as CrowdServiceOutput;
    } catch {
      throw new ProviderUnavailableError(this.id, 'crowd_service 输出不是合法 JSON', [
        { name: 'crowd_service', ok: false, detail: sanitizeStreamText(stdout.slice(0, 400)) },
      ]);
    }

    if (!payload.ok) {
      throw new ProviderUnavailableError(this.id, sanitizeStreamText(payload.message ?? payload.error ?? '实时流分析失败'), [
        { name: 'crowd_service', ok: false, detail: sanitizeStreamText(String(payload.error ?? 'unknown')) },
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

    this.verified = true;

    return {
      count: Math.max(0, Math.round(payload.mean_count ?? 0)),
      confidence: Number(confidence.toFixed(4)),
      provider: this.id,
      modelVersion: MODEL_VERSION,
      calibrationVersion: request.region.camera.calibration_version,
      evidence: {
        simulated: false,
        source_type: payload.source_type ?? 'live_stream',
        stream_id: request.streamId,
        // 不信任子进程回传的地址：统一用服务端注册表中的 URL 重新脱敏。
        stream_url_redacted: redactStreamUrl(request.streamUrl),
        frames_analyzed: payload.frames_analyzed,
        reconnects: payload.reconnects ?? 0,
        elapsed_ms: payload.elapsed_ms,
        effective_fps: payload.effective_fps,
        coefficient_of_variation: payload.coefficient_of_variation,
        mean_blob_area_px: payload.mean_blob_area_px,
        method: payload.method,
        limitations: payload.limitations,
      },
      warnings,
    };
  }
}
