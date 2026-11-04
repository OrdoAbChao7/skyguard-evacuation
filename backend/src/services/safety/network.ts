/**
 * 安全路网模型：把场景静态定义 + 当前已确认事件合成为「有效约束」。
 *
 * 关键安全语义：
 *  - 只有 `confirmed` 事件才会改变约束；`reported` 事件只是待确认情报。
 *  - `unknown` 状态永远不等于 `open`，未知通路与未知容量都不可用于规划。
 *  - 关闭原因必须可追溯到具体事件或基础配置。
 */
import type {
  Corridor,
  CorridorStatus,
  Incident,
  SafetyExit,
  SafetyScenario,
} from './types';

export interface EffectiveCorridor {
  corridor: Corridor;
  status: CorridorStatus;
  statusReason: string;
  blockedByIncidentId?: string;
  /** 可用于规划的通行能力；null 表示容量未知。 */
  usable: boolean;
  unusableReason?: string;
}

export interface EffectiveExit {
  exit: SafetyExit;
  status: CorridorStatus;
  statusReason: string;
  blockedByIncidentId?: string;
  usable: boolean;
  unusableReason?: string;
}

export interface EffectiveNetwork {
  corridors: Map<string, EffectiveCorridor>;
  exits: Map<string, EffectiveExit>;
  sensorFailedRegionIds: Set<string>;
  activeIncidentIds: string[];
}

export function traversalMinutes(corridor: Corridor): number {
  return Math.max(1, Math.ceil(corridor.traversal_seconds / 60));
}

/** 某通道允许的通行方向（可能两个方向都允许）。 */
export function corridorDirections(corridor: Corridor): Array<{ from: string; to: string }> {
  const directions: Array<{ from: string; to: string }> = [];
  if (corridor.direction === 'forward' || corridor.direction === 'both') {
    directions.push({ from: corridor.from_region_id, to: corridor.to_region_id });
  }
  if (corridor.direction === 'reverse' || corridor.direction === 'both') {
    directions.push({ from: corridor.to_region_id, to: corridor.from_region_id });
  }
  return directions;
}

export function activeIncidents(incidents: Incident[]): Incident[] {
  return incidents.filter(incident => incident.status === 'confirmed');
}

export function resolveEffectiveNetwork(
  scenario: SafetyScenario,
  incidents: Incident[],
): EffectiveNetwork {
  const active = activeIncidents(incidents);
  const corridorBlocks = new Map<string, Incident>();
  const exitBlocks = new Map<string, Incident>();
  const sensorFailed = new Set<string>();

  for (const incident of active) {
    if (incident.type === 'sensor_failure') {
      for (const regionId of incident.affected.region_ids) sensorFailed.add(regionId);
      continue;
    }
    if (incident.type === 'fire' || incident.type === 'corridor_closure' || incident.type === 'other' || incident.type === 'crowd_surge') {
      // 火灾/通道关闭类事件才会封锁物理通路；crowd_surge 不封锁通路（只提升风险）。
      if (incident.type === 'crowd_surge') continue;
      for (const corridorId of incident.affected.corridor_ids) {
        if (!corridorBlocks.has(corridorId)) corridorBlocks.set(corridorId, incident);
      }
      for (const exitId of incident.affected.exit_ids) {
        if (!exitBlocks.has(exitId)) exitBlocks.set(exitId, incident);
      }
    }
  }

  const corridors = new Map<string, EffectiveCorridor>();
  for (const corridor of scenario.corridors) {
    const blocker = corridorBlocks.get(corridor.id);
    let status: CorridorStatus = corridor.status;
    let statusReason = corridor.closure_reason ?? corridor.status_source;
    let blockedByIncidentId: string | undefined;

    if (blocker) {
      status = 'closed';
      statusReason = `事件 ${blocker.id}（${blocker.description}）强制关闭`;
      blockedByIncidentId = blocker.id;
    }

    let usable = true;
    let unusableReason: string | undefined;
    if (status === 'closed') {
      usable = false;
      unusableReason = statusReason;
    } else if (status === 'unknown') {
      usable = false;
      unusableReason = `通道通行状态未知：${corridor.status_source}`;
    } else if (corridor.capacity_per_min === null) {
      usable = false;
      unusableReason = '通道通行能力未知，不得按无限容量处理';
    } else if (corridor.capacity_per_min <= 0) {
      usable = false;
      unusableReason = '通道通行能力为 0';
    }

    corridors.set(corridor.id, {
      corridor,
      status,
      statusReason,
      blockedByIncidentId,
      usable,
      unusableReason,
    });
  }

  const exits = new Map<string, EffectiveExit>();
  for (const exit of scenario.exits) {
    const blocker = exitBlocks.get(exit.id);
    let status: CorridorStatus = exit.status;
    let statusReason = exit.closure_reason ?? exit.status_source;
    let blockedByIncidentId: string | undefined;

    if (blocker) {
      status = 'closed';
      statusReason = `事件 ${blocker.id}（${blocker.description}）强制关闭`;
      blockedByIncidentId = blocker.id;
    }

    let usable = true;
    let unusableReason: string | undefined;
    if (status === 'closed') {
      usable = false;
      unusableReason = statusReason;
    } else if (status === 'unknown') {
      usable = false;
      unusableReason = `出口状态未知：${exit.status_source}`;
    } else if (exit.capacity_per_min === null) {
      usable = false;
      unusableReason = '出口接收能力未知，不得按无限容量处理';
    } else if (exit.capacity_per_min <= 0) {
      usable = false;
      unusableReason = '出口接收能力为 0';
    }

    exits.set(exit.id, { exit, status, statusReason, blockedByIncidentId, usable, unusableReason });
  }

  return {
    corridors,
    exits,
    sensorFailedRegionIds: sensorFailed,
    activeIncidentIds: active.map(incident => incident.id),
  };
}

export function corridorsByRegion(scenario: SafetyScenario): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const region of scenario.regions) map.set(region.id, []);
  for (const corridor of scenario.corridors) {
    map.get(corridor.from_region_id)?.push(corridor.id);
    map.get(corridor.to_region_id)?.push(corridor.id);
  }
  return map;
}

export function exitsByRegion(scenario: SafetyScenario): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const region of scenario.regions) map.set(region.id, []);
  for (const exit of scenario.exits) map.get(exit.region_id)?.push(exit.id);
  return map;
}
