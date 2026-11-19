/**
 * 人群感知统一接口。
 *
 * 业务层只依赖 CrowdInferenceProvider，不关心推理在 CPU、昇腾 NPU 还是模拟器中完成。
 * 任何 provider 都必须如实声明：数据来源、模型版本、标定版本，以及是否在本机实际执行。
 */
import type { ObservationSource, Region } from '../types';

export interface ProviderCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProviderStatus {
  id: string;
  kind: 'simulation' | 'recorded_video' | 'live_video' | 'ascend';
  /** 该 provider 产出的观测在系统中的来源标签。 */
  source: ObservationSource;
  available: boolean;
  /** 是否在本机真实跑通过（模拟器为 true，因为它确实在本机执行）。 */
  verified_on_this_host: boolean;
  model_version: string;
  checks: ProviderCheck[];
  notes: string[];
}

export interface NormalizedRoi {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CrowdInferenceRequest {
  region: Region;
  videoPath?: string;
  /** 实时流模式下由服务端注册表解析，调用方不能直接传 URL 到 HTTP API。 */
  streamId?: string;
  streamUrl?: string;
  roi?: NormalizedRoi;
  maxFrames?: number;
  sampleEvery?: number;
  maxSeconds?: number;
  openTimeoutMs?: number;
  readTimeoutMs?: number;
  reconnectAttempts?: number;
  observedAt?: Date;
}

export interface CrowdInferenceResult {
  count: number;
  confidence: number;
  provider: string;
  modelVersion: string;
  calibrationVersion: string;
  evidence?: Record<string, unknown>;
  warnings: string[];
}

export interface CrowdInferenceProvider {
  readonly id: string;
  status(): Promise<ProviderStatus>;
  infer(request: CrowdInferenceRequest): Promise<CrowdInferenceResult>;
}

export class ProviderUnavailableError extends Error {
  readonly providerId: string;
  readonly checks: ProviderCheck[];
  constructor(providerId: string, message: string, checks: ProviderCheck[] = []) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.providerId = providerId;
    this.checks = checks;
  }
}
