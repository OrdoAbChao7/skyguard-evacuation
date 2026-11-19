/**
 * 昇腾推理写观测 API 测试。
 *
 * 本机没有 NPU：成功路径用 provider 级替身验证 HTTP 接线与写入链路，
 * 不可用路径验证 fail-closed。真实设备路径仍由 AscendCrowdProvider
 * 的环境探针与契约测试约束。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { jsonBody, startTestServer, type TestServer } from '../helpers/api-fixtures';
import { getProviders, resetSafetyServiceForTests } from '../../src/services/safety';
import { ProviderUnavailableError } from '../../src/services/safety/providers/types';
import { SECRET } from '../../src/api/v1/auth';
import { REPO_SCENARIO_PATH } from './fixtures';

function tokenFor(role: string): string {
  return jwt.sign({ username: `test-${role}`, role }, SECRET, { expiresIn: '1h' });
}

function headersFor(role: string): Record<string, string> {
  return {
    Authorization: `Bearer ${tokenFor(role)}`,
    'Content-Type': 'application/json',
  };
}

async function startServer(): Promise<TestServer> {
  resetSafetyServiceForTests();
  const server = await startTestServer();
  const scenarioDir = path.join(server.dataRoot, 'scenarios');
  fs.mkdirSync(scenarioDir, { recursive: true });
  const scenarioFile = path.join(scenarioDir, 'venue-default.json');
  fs.copyFileSync(REPO_SCENARIO_PATH, scenarioFile);
  process.env.SAFETY_SCENARIO_FILE = scenarioFile;
  return server;
}

test('昇腾推理成功后写入观测并触发重算', async () => {
  const server = await startServer();
  const ascend = getProviders().ascend as unknown as {
    infer: (request: unknown) => Promise<unknown>;
  };
  const original = ascend.infer;
  ascend.infer = async () => ({
    count: 321,
    confidence: 0.82,
    provider: 'ascend-npu-v1',
    modelVersion: 'test-ascend-1.0',
    calibrationVersion: 'test-calibration',
    evidence: { simulated: false, device: 'Ascend310P3-test', model_path: '/opt/models/test.om' },
    warnings: [],
  });
  try {
    const response = await server.request('/api/v1/safety/observations/ascend', {
      ...jsonBody({ region_id: 'R_MAIN', video_path: '/tmp/crowd.mp4', max_frames: 30, recompute: true }),
      headers: headersFor('admin'),
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.observation.region_id, 'R_MAIN');
    assert.equal(response.body.observation.estimated_count, 321);
    assert.equal(response.body.observation.source, 'recorded_video');
    assert.equal(response.body.observation.provider, 'ascend-npu-v1');
    assert.equal(response.body.observation.model_version, 'test-ascend-1.0');
    assert.equal(response.body.inference.provider, 'ascend-npu-v1');
    assert.equal(response.body.inference.evidence.device, 'Ascend310P3-test');
    assert.ok(['NORMAL', 'REROUTE', 'DEGRADED', 'REJECT'].includes(response.body.state));
    // 只观测一个区域时其余区域仍不可信，fail-closed 不产生可发布校验结果。
    assert.equal(response.body.validation_valid, undefined);
  } finally {
    ascend.infer = original;
    await server.close();
  }
});

test('昇腾不可用时返回 503 且不写入观测', async () => {
  const server = await startServer();
  const ascend = getProviders().ascend as unknown as {
    infer: (request: unknown) => Promise<unknown>;
  };
  const original = ascend.infer;
  ascend.infer = async () => {
    throw new ProviderUnavailableError('ascend-npu-v1', '昇腾推理环境未就绪', [
      { name: 'npu_smi', ok: false, detail: 'npu-smi 不可用' },
    ]);
  };
  try {
    const response = await server.request('/api/v1/safety/observations/ascend', {
      ...jsonBody({ region_id: 'R_MAIN', video_path: '/tmp/crowd.mp4' }),
      headers: headersFor('admin'),
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.ok(Array.isArray(response.body.error.detail));
    assert.equal(response.body.error.detail[0].name, 'npu_smi');

    const observations = await server.request('/api/v1/safety/observations');
    assert.equal(observations.status, 200);
    assert.equal(observations.body.observations.length, 0, '失败时不得写入任何观测');
  } finally {
    ascend.infer = original;
    await server.close();
  }
});

test('昇腾观测接口校验权限、区域与参数', async () => {
  const server = await startServer();
  try {
    const viewer = await server.request('/api/v1/safety/observations/ascend', {
      ...jsonBody({ region_id: 'R_MAIN', video_path: '/tmp/crowd.mp4' }),
      headers: headersFor('viewer'),
    });
    assert.equal(viewer.status, 403);

    const unknown = await server.request('/api/v1/safety/observations/ascend', {
      ...jsonBody({ region_id: 'R_NOT_EXIST', video_path: '/tmp/crowd.mp4' }),
      headers: headersFor('admin'),
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'UNKNOWN_REGION');

    const invalid = await server.request('/api/v1/safety/observations/ascend', {
      ...jsonBody({ region_id: 'R_MAIN', video_path: '', max_frames: 0 }),
      headers: headersFor('admin'),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_INPUT');
  } finally {
    await server.close();
  }
});
