import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getSafetyService, resetSafetyServiceForTests } from '../../src/services/safety';

test('显式配置的场景文件不存在时失败，不静默回退默认场馆', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-scenario-missing-'));
  const previousRoot = process.env.DATA_ROOT;
  const previousScenario = process.env.SAFETY_SCENARIO_FILE;
  process.env.DATA_ROOT = dataRoot;
  process.env.SAFETY_SCENARIO_FILE = 'does-not-exist.json';
  resetSafetyServiceForTests();
  try {
    assert.throws(() => getSafetyService(), /Safety scenario not found/);
  } finally {
    resetSafetyServiceForTests();
    if (previousRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = previousRoot;
    if (previousScenario === undefined) delete process.env.SAFETY_SCENARIO_FILE; else process.env.SAFETY_SCENARIO_FILE = previousScenario;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('未显式配置场景且 DATA_ROOT 无文件时回退仓库默认场景', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-scenario-fallback-'));
  const previousRoot = process.env.DATA_ROOT;
  const previousScenario = process.env.SAFETY_SCENARIO_FILE;
  process.env.DATA_ROOT = dataRoot;
  delete process.env.SAFETY_SCENARIO_FILE;
  resetSafetyServiceForTests();
  try {
    const service = getSafetyService();
    assert.equal(service.getScenario().scenario_id, 'stadium-evacuation-v1');
  } finally {
    resetSafetyServiceForTests();
    if (previousRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = previousRoot;
    if (previousScenario === undefined) delete process.env.SAFETY_SCENARIO_FILE; else process.env.SAFETY_SCENARIO_FILE = previousScenario;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
