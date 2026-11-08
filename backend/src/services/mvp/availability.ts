/**
 * 调查动作可用性：按动作 **kind** 映射运行时事实，而不是按硬编码动作 ID。
 *
 * 场景可以重命名/增删动作（例如 A_CAMERA 改成 CAM_1），只要 kind 仍是
 * camera_query，就应得到同一份可用性判定。旧实现把 `A_CAMERA` 等 ID 写死，
 * 换场景后可用性会全部失真（G09）。
 */
import type { InvestigationPolicy } from '../safety/types';
import type { AvailabilityMap } from './voi';

export interface InvestigationAvailabilityFacts {
  cameraOnline: boolean;
  cameraReason?: string;
  staffAvailable: boolean;
  staffReason?: string;
  uavAvailable: boolean;
  uavReason?: string;
  historyPoints: number;
  predictionAvailable?: boolean;
}

export function buildInvestigationAvailability(
  policy: InvestigationPolicy,
  facts: InvestigationAvailabilityFacts,
): AvailabilityMap {
  const availability: AvailabilityMap = {};
  for (const action of policy.actions) {
    switch (action.kind) {
      case 'camera_query':
        availability[action.id] = facts.cameraOnline
          ? { available: true }
          : { available: false, reason: facts.cameraReason ?? '摄像头离线' };
        break;
      case 'staff_check':
        availability[action.id] = facts.staffAvailable
          ? { available: true }
          : { available: false, reason: facts.staffReason ?? '没有可用工作人员' };
        break;
      case 'uav_request':
        availability[action.id] = facts.uavAvailable
          ? { available: true }
          : { available: false, reason: facts.uavReason ?? '没有可用无人机' };
        break;
      case 'history_query':
        availability[action.id] = facts.historyPoints >= 2
          ? { available: true }
          : { available: false, reason: '历史观测不足' };
        break;
      case 'prediction':
        availability[action.id] = facts.predictionAvailable === false
          ? { available: false, reason: '预测服务不可用' }
          : { available: true };
        break;
      default:
        // 未知 kind 保持场景声明；不默认放行。
        availability[action.id] = {
          available: action.base_availability === 'available',
          reason: action.base_availability === 'available' ? undefined : '未知调查类型且场景标记不可用',
        };
    }
  }
  return availability;
}
