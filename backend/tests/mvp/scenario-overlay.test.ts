import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readScenarioJson } from '../../src/services/safety/scenario-overlay';
import { SafetyScenarioSchema } from '../../src/services/safety/types';

const scenariosDir = path.resolve(__dirname, '../../../data/scenarios');

function writeTempJson(dir: string, name: string, value: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}

test('MVP overlay 派生自冻结基础场景，几何与容量未被改写', () => {
  const overlay = readScenarioJson(path.join(scenariosDir, 'hankou-mvp.json')) as Record<string, unknown>;
  const base = readScenarioJson(path.join(scenariosDir, 'hankou-marshland-v752-base.json')) as Record<string, unknown>;
  const scenario = SafetyScenarioSchema.parse(overlay);

  assert.equal(scenario.version, '7.6.0');
  assert.notEqual(scenario.scenario_id, (base as Record<string, unknown>).scenario_id);
  assert.deepEqual(overlay.regions, base.regions);
  assert.deepEqual(overlay.corridors, base.corridors);
  assert.deepEqual(overlay.exits, base.exits);
  assert.equal(scenario.regions.length, 44);
  assert.equal(scenario.corridors.length, 78);
});

test('staff 覆盖按 id 深合并，保留基础场景未声明的字段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-overlay-'));
  try {
    const basePath = writeTempJson(dir, 'base.json', {
      scenario_id: 'base',
      staff: [
        { id: 'S1', name: '张三', region_id: 'R1', status: 'on_duty', skills: ['gate_control'] },
        { id: 'S2', name: '李四', region_id: 'R2', status: 'on_duty', skills: [] },
      ],
    });
    const overlayPath = writeTempJson(dir, 'overlay.json', {
      extends: 'base.json',
      overrides: { staff: [{ id: 'S1', status: 'busy', skills: ['crowd_check'] }] },
    });

    const merged = readScenarioJson(overlayPath) as { scenario_id: string; staff: Array<Record<string, unknown>> };
    assert.equal(merged.scenario_id, 'base');
    assert.deepEqual(merged.staff, [
      { id: 'S1', name: '张三', region_id: 'R1', status: 'busy', skills: ['crowd_check'] },
      { id: 'S2', name: '李四', region_id: 'R2', status: 'on_duty', skills: [] },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay 拒绝未知 staff id、未知顶层键与循环引用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-overlay-'));
  try {
    writeTempJson(dir, 'base.json', {
      scenario_id: 'base',
      staff: [{ id: 'S1', status: 'on_duty' }],
    });

    const unknownStaff = writeTempJson(dir, 'unknown-staff.json', {
      extends: 'base.json',
      overrides: { staff: [{ id: 'S9', status: 'busy' }] },
    });
    assert.throws(() => readScenarioJson(unknownStaff), /unknown staff id S9/);

    const extraKey = writeTempJson(dir, 'extra-key.json', {
      extends: 'base.json',
      regions: [],
    });
    assert.throws(() => readScenarioJson(extraKey), /unsupported top-level key regions/);

    writeTempJson(dir, 'cycle-a.json', { extends: 'cycle-b.json', overrides: {} });
    writeTempJson(dir, 'cycle-b.json', { extends: 'cycle-a.json', overrides: {} });
    assert.throws(() => readScenarioJson(path.join(dir, 'cycle-a.json')), /scenario overlay cycle/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
