/**
 * V7.3 Ascend OM 元数据校验（TypeScript 侧）。
 *
 * 目的：让部署证据可机器校验，并禁止把 CPU/模拟结果标成 NPU 实机。
 * 不执行 ATC、不加载 OM、不接触设备；只校验元数据与声明一致性。
 */
import { z } from 'zod';

export const OmMetadataSchema = z.object({
  model_name: z.string().min(1),
  soc_version: z.string().min(1),
  cann_version: z.string().min(1),
  atc_command: z.string().min(1),
  om_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  onnx_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  input_shape: z.array(z.number().int().positive()).min(1),
  output_shape: z.array(z.number().int().positive()).min(1),
  device_evidence: z.object({
    npu_smi_available: z.boolean(),
    device_model: z.string().optional(),
    driver_version: z.string().optional(),
    cann_version: z.string().optional(),
  }),
  benchmark: z.object({
    executed_on: z.enum(['npu', 'cpu', 'none']),
    p50_ms: z.number().nonnegative().optional(),
    p95_ms: z.number().nonnegative().optional(),
    memory_mb: z.number().nonnegative().optional(),
    throughput_per_second: z.number().nonnegative().optional(),
  }),
  numerical_consistency: z.object({
    max_abs_diff: z.number().nonnegative(),
    tolerance: z.number().positive(),
    passed: z.boolean(),
  }),
  generated_at: z.string().datetime({ offset: true }),
  notes: z.array(z.string()).default([]),
});
export type OmMetadata = z.infer<typeof OmMetadataSchema>;

export interface OmValidation {
  valid: boolean;
  status: 'npu_verified' | 'valid_metadata_not_npu_verified' | 'invalid';
  errors: string[];
  warnings: string[];
}

export function validateOmMetadata(input: unknown): OmValidation {
  const parsed = OmMetadataSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      status: 'invalid',
      errors: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`),
      warnings: [],
    };
  }
  const data = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (data.numerical_consistency.max_abs_diff > data.numerical_consistency.tolerance) {
    errors.push('numerical_consistency.max_abs_diff exceeds tolerance');
  }
  if (!data.numerical_consistency.passed) {
    errors.push('numerical_consistency.passed is false');
  }
  const claimsNpu = data.benchmark.executed_on === 'npu';
  if (claimsNpu) {
    if (!data.device_evidence.npu_smi_available) {
      errors.push('benchmark claims npu but npu_smi_available is false');
    }
    for (const field of ['device_model', 'driver_version', 'cann_version'] as const) {
      if (!data.device_evidence[field]) errors.push(`benchmark claims npu but device_evidence.${field} is missing`);
    }
    if (!data.benchmark.p50_ms || !data.benchmark.p95_ms) {
      warnings.push('NPU benchmark missing p50/p95 latency');
    }
  } else {
    warnings.push('benchmark.executed_on is not npu; not NPU-verified');
  }
  if (errors.length > 0) return { valid: false, status: 'invalid', errors, warnings };
  return {
    valid: true,
    status: claimsNpu ? 'npu_verified' : 'valid_metadata_not_npu_verified',
    errors,
    warnings,
  };
}

export function buildOmTemplate(input: {
  modelName: string;
  socVersion: string;
  cannVersion: string;
  omSha256: string;
  onnxSha256: string;
  inputShape: number[];
  outputShape: number[];
}): OmMetadata {
  return {
    model_name: input.modelName,
    soc_version: input.socVersion,
    cann_version: input.cannVersion,
    atc_command: `atc --model=${input.modelName}.onnx --framework=5 --output=${input.modelName} --soc_version=${input.socVersion} --input_shape="history:${input.inputShape.join(',')}" --log=error`,
    om_sha256: input.omSha256,
    onnx_sha256: input.onnxSha256,
    input_shape: input.inputShape,
    output_shape: input.outputShape,
    device_evidence: { npu_smi_available: false },
    benchmark: { executed_on: 'none' },
    numerical_consistency: { max_abs_diff: 0, tolerance: 1e-3, passed: false },
    generated_at: new Date().toISOString(),
    notes: ['模板：尚未执行 ATC/NPU；不得作为昇腾实机证据。'],
  };
}
