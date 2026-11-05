/** MVP 测试夹具：体育场场景 + 临时审计目录 + 隔离的 MvpService。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../../src/services/safety/audit';
import { SafetyDecisionService } from '../../src/services/safety/decision-service';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import type { SafetyScenario } from '../../src/services/safety/types';
import { MvpService } from '../../src/services/mvp';

export const STADIUM_SCENARIO_PATH = path.resolve(__dirname, '../../../data/scenarios/stadium-evacuation.json');

export interface MvpFixture {
  scenario: SafetyScenario;
  audit: AuditLog;
  safety: SafetyDecisionService;
  mvp: MvpService;
  dataRoot: string;
  cleanup: () => void;
}

export function makeMvpFixture(options: { scenarioPath?: string } = {}): MvpFixture {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-mvp-test-'));
  const scenario = loadSafetyScenario(options.scenarioPath ?? STADIUM_SCENARIO_PATH);
  const audit = new AuditLog(path.join(dataRoot, 'audit'));
  const safety = new SafetyDecisionService({ scenario, auditLog: audit });
  const mvp = new MvpService({ scenario, safety, audit });
  return {
    scenario,
    audit,
    safety,
    mvp,
    dataRoot,
    cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }),
  };
}

export const ADMIN = { username: 'test-admin', role: 'admin' } as const;

export function staffActor(fixture: MvpFixture, staffId: string) {
  const member = fixture.mvp.ops.getStaff(staffId);
  if (!member) throw new Error(`missing staff ${staffId}`);
  return { username: member.name, role: 'staff', staff_id: member.id };
}

export function ingestObservation(
  fixture: MvpFixture,
  regionId: string,
  count: number,
  confidence: number,
  extra: { valid?: boolean; reason?: string; source?: 'simulation' | 'field_report' | 'uav_observation' } = {},
) {
  return fixture.safety.ingestObservation({
    regionId,
    count,
    confidence,
    source: extra.source ?? 'simulation',
    provider: 'test-harness',
    modelVersion: 'test/1.0.0',
    observedAt: new Date(),
    valid: extra.valid ?? true,
    invalidReason: extra.reason,
  }, ADMIN);
}
