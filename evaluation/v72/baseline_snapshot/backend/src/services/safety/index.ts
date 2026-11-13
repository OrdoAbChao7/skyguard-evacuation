/**
 * 安全域模块出口。
 *
 * 服务实例按进程惰性创建：场景文件在首次访问时从 `DATA_ROOT`（或默认 data/）读取，
 * 因此测试可以在不同的 DATA_ROOT 下隔离运行，互不干扰。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadSafetyScenario } from './scenario';
import { SafetyDecisionService } from './decision-service';
import { RecordedVideoCrowdProvider } from './providers/video';
import { AscendCrowdProvider } from './providers/ascend';

export * from './types';
export { SafetyDecisionService } from './decision-service';
export { loadSafetyScenario, DEFAULT_SCENARIO_FILE, scenarioPath } from './scenario';
export { validateSafetyPlan } from './validator';
export { decideSafetyState } from './state-machine';
export { planEvacuation } from './planning/evacuation-planner';
export { parseIncidentText } from './nl-incident';
export { RecordedVideoCrowdProvider } from './providers/video';
export { AscendCrowdProvider } from './providers/ascend';
export { SimulationCrowdProvider } from './providers/simulation';

const videoProvider = new RecordedVideoCrowdProvider();
const ascendProvider = new AscendCrowdProvider();

let instance: SafetyDecisionService | null = null;

/**
 * 获取（或创建）进程内的安全决策服务。
 * 若当前 DATA_ROOT 下没有场景文件但仓库默认数据目录有，则回退到仓库默认场景，
 * 并在服务实例上记录实际来源，避免"以为在自己数据目录里跑"的误判。
 */
export function getSafetyService(): SafetyDecisionService {
  if (instance) return instance;
  const scenario = loadSafetyScenarioWithFallback();
  instance = new SafetyDecisionService({ scenario });
  return instance;
}

function loadSafetyScenarioWithFallback() {
  const configured = process.env.SAFETY_SCENARIO_FILE?.trim();
  try {
    return loadSafetyScenario();
  } catch (error) {
    // 显式配置的场景不存在时必须失败，不能静默换回默认场馆。
    if (configured && configured !== 'undefined') throw error;
    const fallback = path.resolve(__dirname, '../../../../data/scenarios/stadium-evacuation.json');
    if (fs.existsSync(fallback)) {
      console.warn(
        `[safety] 当前 DATA_ROOT 下未找到场景文件，回退到仓库默认场景：${fallback}`,
      );
      return loadSafetyScenario(fallback);
    }
    throw error;
  }
}

/** 测试用：丢弃进程内实例，使下一次访问重新读取场景。 */
export function resetSafetyServiceForTests(): void {
  instance = null;
}

export function getProviders() {
  return { video: videoProvider, ascend: ascendProvider };
}
