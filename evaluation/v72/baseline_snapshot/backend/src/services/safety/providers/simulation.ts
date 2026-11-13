/**
 * 模拟人群感知 provider。
 *
 * 用途：自动化测试与确定性演示。产出**明确标记为 simulation** 的观测，
 * 前端与审计链路必须能区分模拟数据与真实视频推理。
 *
 * 它不模拟"推理过程"：人数由调用方显式给定（演示脚本），不做随机采样，
 * 因此同一脚本必然产生同一结果，可复现。
 */
import type { CrowdInferenceProvider, CrowdInferenceRequest, CrowdInferenceResult, ProviderStatus } from './types';
import { ProviderUnavailableError } from './types';

export interface SimulationSample {
  count: number;
  confidence: number;
}

export class SimulationCrowdProvider implements CrowdInferenceProvider {
  readonly id = 'simulation-v1';
  private samples: Map<string, SimulationSample>;

  constructor(samples: Record<string, SimulationSample> = {}) {
    this.samples = new Map(Object.entries(samples));
  }

  setSamples(samples: Record<string, SimulationSample>): void {
    this.samples = new Map(Object.entries(samples));
  }

  /** 仅更新部分区域（演示脚本逐步推送时使用）。 */
  updateSamples(samples: Record<string, SimulationSample>): void {
    for (const [regionId, sample] of Object.entries(samples)) {
      this.samples.set(regionId, sample);
    }
  }

  status(): Promise<ProviderStatus> {
    return Promise.resolve({
      id: this.id,
      kind: 'simulation',
      source: 'simulation',
      available: true,
      verified_on_this_host: true,
      model_version: 'simulation/1.0.0',
      checks: [
        { name: 'deterministic_input', ok: true, detail: '人数由演示脚本显式给定，不依赖随机数' },
      ],
      notes: [
        '产出数据标记为 simulation，不得当作视频推理结果。',
        '仅用于演示与自动化测试的可复现输入。',
      ],
    });
  }

  infer(request: CrowdInferenceRequest): Promise<CrowdInferenceResult> {
    const sample = this.samples.get(request.region.id);
    if (!sample) {
      return Promise.reject(
        new ProviderUnavailableError(this.id, `区域 ${request.region.id} 没有可用的模拟样本`),
      );
    }
    return Promise.resolve({
      count: sample.count,
      confidence: sample.confidence,
      provider: this.id,
      modelVersion: 'simulation/1.0.0',
      calibrationVersion: `simulation/${request.region.camera.calibration_version}`,
      evidence: {
        simulated: true,
        note: '该观测来自演示脚本的显式输入，不是视频推理结果',
      },
      warnings: ['simulated_data'],
    });
  }
}
