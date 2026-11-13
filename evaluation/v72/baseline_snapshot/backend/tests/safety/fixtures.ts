/**
 * SkyGuard 测试夹具。
 *
 * 复用仓库真实的默认安全场景；所有测试都在临时目录写审计日志，不污染 data/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { SafetyDecisionService } from '../../src/services/safety/decision-service';
import { AuditLog } from '../../src/services/safety/audit';
import type { DensityObservation, SafetyScenario } from '../../src/services/safety/types';

export const REPO_SCENARIO_PATH = path.resolve(__dirname, '../../../data/scenarios/venue-default.json');

export const OPERATOR = { username: 'test-operator', role: 'safety_operator' };
export const ADMIN = { username: 'test-admin', role: 'admin' };

export function loadScenario(): SafetyScenario {
  return loadSafetyScenario(REPO_SCENARIO_PATH);
}

export function makeService(options: { scenario?: SafetyScenario } = {}): {
  service: SafetyDecisionService;
  auditDir: string;
} {
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-audit-'));
  const service = new SafetyDecisionService({
    scenario: options.scenario ?? loadScenario(),
    auditLog: new AuditLog(auditDir),
  });
  return { service, auditDir };
}

/** 场景 A 的基线人群分布（与 demo 脚本一致）。 */
export const BASELINE_COUNTS: Record<string, number> = {
  R_MAIN: 380,
  R_ATRIUM: 140,
  R_EAST: 220,
  R_NORTH: 110,
  R_SOUTH: 80,
  R_WEST: 70,
};

export function seedObservations(
  service: SafetyDecisionService,
  counts: Record<string, number> = BASELINE_COUNTS,
  options: { confidence?: number; observedAt?: Date } = {},
): void {
  for (const [regionId, count] of Object.entries(counts)) {
    service.ingestObservation(
      {
        regionId,
        count,
        confidence: options.confidence ?? 0.9,
        source: 'simulation',
        provider: 'test-harness',
        modelVersion: 'test/1.0.0',
        observedAt: options.observedAt,
      },
      OPERATOR,
    );
  }
}

export function buildObservationFor(
  scenario: SafetyScenario,
  regionId: string,
  count: number,
  overrides: Partial<DensityObservation> = {},
): DensityObservation {
  const region = scenario.regions.find(item => item.id === regionId);
  if (!region) throw new Error(`unknown region ${regionId}`);
  return {
    id: `OBS-TEST-${regionId}-${Math.random().toString(36).slice(2, 8)}`,
    region_id: regionId,
    observed_at: new Date().toISOString(),
    received_at: new Date().toISOString(),
    estimated_count: count,
    estimated_density: Number((count / region.area_m2).toFixed(4)),
    confidence: 0.9,
    source: 'simulation',
    provider: 'test-harness',
    model_version: 'test/1.0.0',
    calibration_version: region.camera.calibration_version,
    valid: true,
    ...overrides,
  };
}
