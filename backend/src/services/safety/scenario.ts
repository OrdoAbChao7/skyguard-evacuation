/**
 * 安全场景加载与静态一致性校验。
 *
 * 场景是**可替换输入**：`data/scenarios/*.json`。默认文件为 `stadium-evacuation.json`（体育场散场场景），
 * 可通过环境变量 `SAFETY_SCENARIO_FILE` 指定其它文件名（相对 scenarios 目录）
 * 或绝对路径。加载时做结构校验和引用完整性检查，任何悬空引用都会直接抛错，
 * 避免把坏数据带入规划器。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from '../../config/paths';
import { SafetyScenarioSchema, type SafetyScenario } from './types';

export const SCENARIO_DIR = 'scenarios';
export const DEFAULT_SCENARIO_FILE = 'stadium-evacuation.json';

/** 当前生效的场景文件名（环境变量优先）。 */
export function getScenarioFileName(): string {
  const configured = process.env.SAFETY_SCENARIO_FILE?.trim();
  return configured && configured !== 'undefined' ? configured : DEFAULT_SCENARIO_FILE;
}

export function scenarioDir(): string {
  return resolveDataPath(SCENARIO_DIR);
}

export function validateScenarioReferences(scenario: SafetyScenario): string[] {
  const errors: string[] = [];
  const regionIds = new Set<string>();
  for (const region of scenario.regions) {
    if (regionIds.has(region.id)) errors.push(`duplicate region id: ${region.id}`);
    regionIds.add(region.id);
  }

  const corridorIds = new Set<string>();
  for (const corridor of scenario.corridors) {
    if (corridorIds.has(corridor.id)) errors.push(`duplicate corridor id: ${corridor.id}`);
    corridorIds.add(corridor.id);
    if (!regionIds.has(corridor.from_region_id)) {
      errors.push(`corridor ${corridor.id} from_region_id unknown: ${corridor.from_region_id}`);
    }
    if (!regionIds.has(corridor.to_region_id)) {
      errors.push(`corridor ${corridor.id} to_region_id unknown: ${corridor.to_region_id}`);
    }
    if (corridor.from_region_id === corridor.to_region_id) {
      errors.push(`corridor ${corridor.id} connects a region to itself`);
    }
  }

  const exitIds = new Set<string>();
  for (const exit of scenario.exits) {
    if (exitIds.has(exit.id)) errors.push(`duplicate exit id: ${exit.id}`);
    exitIds.add(exit.id);
    if (!regionIds.has(exit.region_id)) {
      errors.push(`exit ${exit.id} region_id unknown: ${exit.region_id}`);
    }
  }

  const thresholds = scenario.config.default_thresholds;
  if (!(thresholds.watch_density < thresholds.high_density && thresholds.high_density < thresholds.critical_density)) {
    errors.push('default thresholds must satisfy watch < high < critical');
  }

  for (const region of scenario.regions) {
    if (region.thresholds) {
      const t = region.thresholds;
      if (!(t.watch_density < t.high_density && t.high_density < t.critical_density)) {
        errors.push(`region ${region.id} thresholds must satisfy watch < high < critical`);
      }
    }
  }

  const staffIds = new Set<string>();
  for (const member of scenario.staff) {
    if (staffIds.has(member.id)) errors.push(`duplicate staff id: ${member.id}`);
    staffIds.add(member.id);
    if (!regionIds.has(member.region_id)) {
      errors.push(`staff ${member.id} region_id unknown: ${member.region_id}`);
    }
  }

  const ruleIds = new Set<string>();
  for (const rule of scenario.venue?.rules ?? []) {
    if (ruleIds.has(rule.id)) errors.push(`duplicate venue rule id: ${rule.id}`);
    ruleIds.add(rule.id);
  }

  const uavIds = new Set<string>();
  for (const unit of scenario.venue?.uav_units ?? []) {
    if (uavIds.has(unit.id)) errors.push(`duplicate uav unit id: ${unit.id}`);
    uavIds.add(unit.id);
  }

  if (scenario.investigation) {
    const policy = scenario.investigation;
    const hypothesisIds = new Set<string>();
    let priorSum = 0;
    for (const hypothesis of policy.hypotheses) {
      if (hypothesisIds.has(hypothesis.id)) errors.push(`duplicate hypothesis id: ${hypothesis.id}`);
      hypothesisIds.add(hypothesis.id);
      priorSum += hypothesis.prior;
    }
    if (Math.abs(priorSum - 1) > 1e-6) {
      errors.push(`investigation priors must sum to 1 (got ${priorSum.toFixed(6)})`);
    }
    for (const hypothesis of policy.hypotheses) {
      const losses = policy.loss_matrix[hypothesis.id];
      if (!losses) {
        errors.push(`loss_matrix missing hypothesis: ${hypothesis.id}`);
        continue;
      }
      for (const decision of policy.decisions) {
        if (typeof losses[decision] !== 'number') {
          errors.push(`loss_matrix ${hypothesis.id} missing decision: ${decision}`);
        }
      }
    }
    const actionIds = new Set<string>();
    for (const action of policy.actions) {
      if (actionIds.has(action.id)) errors.push(`duplicate investigation action id: ${action.id}`);
      actionIds.add(action.id);
      const byKind = policy.likelihoods[action.kind];
      if (!byKind) {
        errors.push(`likelihoods missing action kind: ${action.kind}`);
        continue;
      }
      for (const hypothesis of policy.hypotheses) {
        const row = byKind[hypothesis.id];
        if (!row) {
          errors.push(`likelihoods ${action.kind} missing hypothesis: ${hypothesis.id}`);
          continue;
        }
        let sum = 0;
        for (const outcome of policy.outcomes) {
          const value = row[outcome];
          if (typeof value !== 'number') {
            errors.push(`likelihoods ${action.kind}/${hypothesis.id} missing outcome: ${outcome}`);
            continue;
          }
          sum += value;
        }
        if (Math.abs(sum - 1) > 1e-6) {
          errors.push(`likelihoods ${action.kind}/${hypothesis.id} must sum to 1 (got ${sum.toFixed(6)})`);
        }
      }
    }
  }

  for (const [regionId, baseline] of Object.entries(scenario.simulation_baseline ?? {})) {
    if (!regionIds.has(regionId)) errors.push(`simulation_baseline references unknown region: ${regionId}`);
    if (baseline.count > 0 && baseline.confidence <= 0) {
      errors.push(`simulation_baseline ${regionId} has positive count but non-positive confidence`);
    }
  }

  for (const demo of scenario.demo_scenarios) {
    for (const step of demo.steps) {
      if (step.action === 'observe') {
        for (const regionId of Object.keys(step.observations)) {
          if (!regionIds.has(regionId)) errors.push(`demo ${demo.id} observes unknown region: ${regionId}`);
        }
      }
      if (step.action === 'incident.create') {
        for (const id of step.affected.region_ids) {
          if (!regionIds.has(id)) errors.push(`demo ${demo.id} incident references unknown region: ${id}`);
        }
        for (const id of step.affected.corridor_ids) {
          if (!corridorIds.has(id)) errors.push(`demo ${demo.id} incident references unknown corridor: ${id}`);
        }
        for (const id of step.affected.exit_ids) {
          if (!exitIds.has(id)) errors.push(`demo ${demo.id} incident references unknown exit: ${id}`);
        }
      }
    }
  }

  return errors;
}

export function loadSafetyScenario(fileName: string = getScenarioFileName()): SafetyScenario {
  const filePath = path.isAbsolute(fileName)
    ? fileName
    : resolveDataPath(SCENARIO_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Safety scenario not found: ${filePath}`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const scenario = SafetyScenarioSchema.parse(raw);
  const errors = validateScenarioReferences(scenario);
  if (errors.length > 0) {
    throw new Error(`Invalid safety scenario: ${errors.join('; ')}`);
  }
  return scenario;
}

/** 场景文件路径（用于状态接口展示实际输入来源）。 */
export function scenarioPath(fileName: string = getScenarioFileName()): string {
  return path.isAbsolute(fileName) ? fileName : resolveDataPath(SCENARIO_DIR, fileName);
}

export interface ScenarioFileListing {
  file: string;
  scenario_id: string;
  name: string;
  version: string;
  regions: number;
  exits: number;
  is_default: boolean;
  valid: boolean;
  error?: string;
}

/** 列出 data/scenarios 下全部候选场景（只读，便于换场景时对照）。 */
export function listScenarioFiles(): ScenarioFileListing[] {
  const dir = scenarioDir();
  if (!fs.existsSync(dir)) return [];
  const defaultFile = path.basename(getScenarioFileName());
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(file => {
      const full = path.join(dir, file);
      try {
        const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
        const scenario = SafetyScenarioSchema.parse(raw);
        const errors = validateScenarioReferences(scenario);
        return {
          file,
          scenario_id: scenario.scenario_id,
          name: scenario.name,
          version: scenario.version,
          regions: scenario.regions.length,
          exits: scenario.exits.length,
          is_default: file === defaultFile,
          valid: errors.length === 0,
          ...(errors.length ? { error: errors.join('; ') } : {}),
        };
      } catch (error) {
        return {
          file,
          scenario_id: '',
          name: '',
          version: '',
          regions: 0,
          exits: 0,
          is_default: file === defaultFile,
          valid: false,
          error: (error as Error).message,
        };
      }
    });
}
