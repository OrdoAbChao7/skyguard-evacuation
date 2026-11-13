/**
 * 多区域风险传播与调查优先级分析。
 *
 * 只读聚合：风险传播、优先级与调查可用性均来自显式配置与当前安全状态。
 */
import type { SafetyDecisionService } from '../safety/decision-service';
import type { SafetyScenario } from '../safety/types';
import { buildInvestigationAvailability } from './availability';
import type { CameraHealth } from './ingest';
import { decideMultiRegionInvestigation, priorBeliefsForRegions } from './multi-voi';
import type { OpsService } from './ops';
import type { PredictionService } from './prediction';
import { buildRegionGraph, propagateRisk, rankInvestigationPriorities } from './risk-graph';

export interface MultiRegionSource {
  scenario: SafetyScenario;
  safety: SafetyDecisionService;
  prediction: PredictionService;
  ops: OpsService;
  cameraHealth(regionId?: string): CameraHealth[];
}

export function analyzeMultiRegion(
  source: MultiRegionSource,
  regionId?: string,
): Record<string, unknown> {
  const policy = source.scenario.investigation;
  if (!policy) {
    return { available: false, reason: '场景未配置 investigation 策略' };
  }
  const status = source.safety.getStatus();
  const graph = buildRegionGraph(source.scenario);
  const propagated = propagateRisk(source.scenario, status.risks);
  const priorities = rankInvestigationPriorities(source.scenario, status.risks, propagated);
  const target = regionId ?? priorities[0]?.regionId ?? source.scenario.regions[0]?.id;
  if (!target) return { available: false, reason: '场景没有区域' };
  const beliefs = priorBeliefsForRegions(policy, status.risks);
  const cameras = source.cameraHealth(target);
  const camera = cameras[0] ?? null;
  const staff = source.ops.recommendStaff({ region_id: target, required_skills: ['crowd_check'] });
  const uavAvailable = (source.scenario.venue?.uav_units ?? []).some(unit => unit.status === 'available');
  const historyPoints = source.safety.getObservationStore().window(
    target,
    new Date(Date.now() - source.scenario.config.trend_window_seconds * 1000),
    new Date(),
  ).filter(item => item.valid).length;
  const prediction = source.prediction.predict(target);
  const availability = buildInvestigationAvailability(policy, {
    cameraOnline: Boolean(camera && camera.state !== 'offline'),
    cameraReason: camera ? '摄像头离线' : '无可用摄像头',
    staffAvailable: Boolean(staff.recommended),
    staffReason: '没有可用工作人员',
    uavAvailable,
    uavReason: '没有可用无人机',
    historyPoints,
    predictionReliable: prediction.reliability?.status !== 'failed',
    predictionReason: `预测可靠性 ${prediction.reliability?.status ?? 'unknown'}：${(prediction.reliability?.reasons ?? []).join('、') || '区间过宽或数据不足'}`,
  });
  const decision = decideMultiRegionInvestigation(policy, target, beliefs, graph, availability);
  return {
    available: true,
    target_region_id: target,
    propagated_risks: propagated,
    priorities: priorities.slice(0, 8),
    decision,
    note: '风险传播与覆盖权重为配置化启发式，不是真实人群迁移模型。',
  };
}
