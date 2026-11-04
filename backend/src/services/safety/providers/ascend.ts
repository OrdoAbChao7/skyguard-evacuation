/**
 * 昇腾（Ascend）人群感知适配层。
 *
 * 现实约束：本仓库开发环境中**没有可用的昇腾设备与 CANN 运行时**。
 * 因此该 provider 在本机必然报告 `available: false`，并逐项列出未通过的检查，
 * 绝不伪造设备型号、推理时延或性能数据。
 *
 * 它实现的是**真实的适配契约**：一旦现场具备环境，只需：
 *   1) 安装 CANN + 昇腾推理运行时；
 *   2) 导出现成的人群计数模型为 .om；
 *   3) 配置 SKYGUARD_ASCEND_CMD（接收 stdin JSON、输出 stdout JSON 的推理程序）
 *      与 SKYGUARD_ASCEND_MODEL；
 * 即可通过该 provider 产出观测，业务层无需改动。
 *
 * 外部推理程序契约（stdin → stdout）：
 *   请求: { "region_id", "camera_id", "roi", "video_path", "model_path", "max_frames" }
 *   响应: { "ok": true, "count": <int>, "confidence": <0..1>, "model_version": "...", "device": "..." }
 *        或 { "ok": false, "message": "..." }
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { z } from 'zod';
import type {
  CrowdInferenceProvider,
  CrowdInferenceRequest,
  CrowdInferenceResult,
  ProviderCheck,
  ProviderStatus,
} from './types';
import { ProviderUnavailableError } from './types';

const ResponseSchema = z.object({
  ok: z.boolean(),
  count: z.number().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
  model_version: z.string().optional(),
  device: z.string().optional(),
  message: z.string().optional(),
});

export class AscendCrowdProvider implements CrowdInferenceProvider {
  readonly id = 'ascend-npu-v1';

  private checkAscendToolkit(): ProviderCheck {
    const home = process.env.ASCEND_HOME_PATH || process.env.ASCEND_TOOLKIT_HOME;
    if (home && fs.existsSync(home)) {
      return { name: 'cann_toolkit', ok: true, detail: `检测到 CANN 安装目录 ${home}` };
    }
    const fallback = '/usr/local/Ascend';
    if (process.platform !== 'win32' && fs.existsSync(fallback)) {
      return { name: 'cann_toolkit', ok: true, detail: `检测到默认 CANN 目录 ${fallback}` };
    }
    return {
      name: 'cann_toolkit',
      ok: false,
      detail: '未检测到 CANN 环境变量 ASCEND_HOME_PATH / ASCEND_TOOLKIT_HOME，也未找到 /usr/local/Ascend',
    };
  }

  private async checkNpuSmi(): Promise<ProviderCheck> {
    return new Promise(resolve => {
      execFile('npu-smi', ['info'], { timeout: 15000, windowsHide: true }, (error, stdout) => {
        if (error) {
          resolve({ name: 'npu_smi', ok: false, detail: `npu-smi 不可用：${error.message}` });
          return;
        }
        resolve({ name: 'npu_smi', ok: true, detail: stdout.split('\n').slice(0, 3).join(' | ').trim() });
      });
    });
  }

  private checkRuntimeCommand(): ProviderCheck {
    const cmd = process.env.SKYGUARD_ASCEND_CMD;
    if (!cmd) {
      return {
        name: 'runtime_command',
        ok: false,
        detail: '未配置 SKYGUARD_ASCEND_CMD（昇腾推理程序入口）',
      };
    }
    return { name: 'runtime_command', ok: true, detail: `已配置推理命令：${cmd}` };
  }

  private checkModel(): ProviderCheck {
    const model = process.env.SKYGUARD_ASCEND_MODEL;
    if (!model) {
      return { name: 'model', ok: false, detail: '未配置 SKYGUARD_ASCEND_MODEL（.om 模型路径）' };
    }
    if (!fs.existsSync(model)) {
      return { name: 'model', ok: false, detail: `模型文件不存在：${model}` };
    }
    return { name: 'model', ok: true, detail: `模型文件 ${model}` };
  }

  async probe(): Promise<{ checks: ProviderCheck[]; available: boolean }> {
    const checks: ProviderCheck[] = [
      this.checkAscendToolkit(),
      await this.checkNpuSmi(),
      this.checkRuntimeCommand(),
      this.checkModel(),
    ];
    return { checks, available: checks.every(check => check.ok) };
  }

  async status(): Promise<ProviderStatus> {
    const { checks, available } = await this.probe();
    return {
      id: this.id,
      kind: 'ascend',
      source: 'recorded_video',
      available,
      verified_on_this_host: false,
      model_version: process.env.SKYGUARD_ASCEND_MODEL_VERSION ?? 'unverified',
      checks,
      notes: [
        '本仓库开发环境未提供昇腾设备，硬件推理未经实测。',
        '该 provider 只实现环境探针与外部推理契约，不伪造设备与性能数据。',
        '启用条件：CANN + 昇腾推理运行时 + 已导出 .om 模型 + SKYGUARD_ASCEND_CMD/SKYGUARD_ASCEND_MODEL。',
        '未启用时请使用 CPU 视频路径 (recorded_video) 或明确标记的模拟数据。',
      ],
    };
  }

  async infer(request: CrowdInferenceRequest): Promise<CrowdInferenceResult> {
    const { checks, available } = await this.probe();
    if (!available) {
      throw new ProviderUnavailableError(
        this.id,
        '昇腾推理环境未就绪，拒绝产出未经验证的推理结果',
        checks,
      );
    }

    const cmd = process.env.SKYGUARD_ASCEND_CMD!;
    const model = process.env.SKYGUARD_ASCEND_MODEL!;
    const payload = {
      region_id: request.region.id,
      camera_id: request.region.camera.camera_id,
      roi: request.region.camera.roi ?? null,
      video_path: request.videoPath ?? null,
      model_path: model,
      max_frames: request.maxFrames ?? 90,
    };

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        cmd,
        [],
        { timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, out, errOut) => {
          if (error) {
            reject(
              new ProviderUnavailableError(this.id, `昇腾推理程序执行失败：${error.message}`, [
                { name: 'runtime_command', ok: false, detail: errOut.slice(0, 400) },
              ]),
            );
            return;
          }
          resolve(out);
        },
      );
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    });

    let parsed: z.infer<typeof ResponseSchema>;
    try {
      parsed = ResponseSchema.parse(JSON.parse(stdout));
    } catch (error) {
      throw new ProviderUnavailableError(this.id, `昇腾推理程序输出不符合契约：${(error as Error).message}`, [
        { name: 'runtime_command', ok: false, detail: stdout.slice(0, 400) },
      ]);
    }

    if (!parsed.ok || parsed.count === undefined || parsed.confidence === undefined) {
      throw new ProviderUnavailableError(this.id, parsed.message ?? '昇腾推理返回失败', [
        { name: 'runtime_command', ok: false, detail: parsed.message ?? 'unknown' },
      ]);
    }

    return {
      count: Math.round(parsed.count),
      confidence: parsed.confidence,
      provider: this.id,
      modelVersion: parsed.model_version ?? 'ascend/unverified',
      calibrationVersion: request.region.camera.calibration_version,
      evidence: {
        simulated: false,
        device: parsed.device ?? 'unknown',
        model_path: model,
      },
      warnings: [],
    };
  }
}
