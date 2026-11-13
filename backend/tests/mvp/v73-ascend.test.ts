import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOmTemplate, validateOmMetadata, type OmMetadata } from '../../src/services/safety/deployment/om-metadata';

const base: OmMetadata = {
  model_name: 'forecast_linear',
  soc_version: 'Ascend910B3',
  cann_version: '8.0.RC1',
  atc_command: 'atc --model=forecast_linear.onnx --framework=5 --output=forecast_linear --soc_version=Ascend910B3',
  om_sha256: 'a'.repeat(64),
  onnx_sha256: 'b'.repeat(64),
  input_shape: [1, 12],
  output_shape: [1, 5],
  device_evidence: { npu_smi_available: true, device_model: 'Ascend910B3', driver_version: '24.1', cann_version: '8.0.RC1' },
  benchmark: { executed_on: 'npu', p50_ms: 0.8, p95_ms: 1.2, memory_mb: 128 },
  numerical_consistency: { max_abs_diff: 0.0001, tolerance: 0.001, passed: true },
  generated_at: '2026-11-10T01:00:00Z',
  notes: [],
};

test('完整 NPU 元数据可标记 npu_verified', () => {
  const result = validateOmMetadata(base);
  assert.equal(result.valid, true);
  assert.equal(result.status, 'npu_verified');
});

test('声称 NPU 但缺少 npu-smi/设备信息时失败', () => {
  const result = validateOmMetadata({ ...base, device_evidence: { npu_smi_available: false } });
  assert.equal(result.valid, false);
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.some(item => item.includes('npu_smi_available')));
});

test('CPU 元数据有效但不得标记 NPU 验证', () => {
  const result = validateOmMetadata({
    ...base,
    device_evidence: { npu_smi_available: false },
    benchmark: { executed_on: 'cpu', p50_ms: 0.015, p95_ms: 0.03 },
  });
  assert.equal(result.valid, true);
  assert.equal(result.status, 'valid_metadata_not_npu_verified');
});

test('数值一致性失败或哈希非法时拒绝', () => {
  const badConsistency = validateOmMetadata({ ...base, numerical_consistency: { max_abs_diff: 0.1, tolerance: 0.001, passed: false } });
  assert.equal(badConsistency.valid, false);
  const badHash = validateOmMetadata({ ...base, om_sha256: 'not-a-hash' });
  assert.equal(badHash.valid, false);
});

test('OM 模板明确标记未执行 ATC/NPU', () => {
  const template = buildOmTemplate({
    modelName: 'forecast_linear',
    socVersion: 'Ascend910B3',
    cannVersion: '8.0.RC1',
    omSha256: 'c'.repeat(64),
    onnxSha256: 'd'.repeat(64),
    inputShape: [1, 12],
    outputShape: [1, 5],
  });
  const result = validateOmMetadata(template);
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.some(item => item.includes('numerical_consistency')));
  assert.equal(template.benchmark.executed_on, 'none');
});
