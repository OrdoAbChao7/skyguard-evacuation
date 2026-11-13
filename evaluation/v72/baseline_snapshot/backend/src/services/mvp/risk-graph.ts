/**
 * 区域—通道—出口图上的风险传播（确定性、可解释）。
 *
 * 目的：评估一个区域的局部风险如何沿通道影响相邻区域，为多区域联合调查排序。
 * 注意：这是运维启发式模型，不是人群动力学仿真；参数来自场景容量/通行时间，
 * 不代表真实人群迁移规律。
 */
import type { SafetyScenario } from '../safety/types';
import type { RegionRisk } from '../safety/risk';

export interface GraphEdge {
  corridorId: string;
  to: string;
  traversalSeconds: number;
  capacityPerMin: number;
  weight: number;
}

export interface RegionGraph {
  adjacency: Map<string, GraphEdge[]>;
  regionIds: string[];
}

export interface PropagatedRisk {
  regionId: string;
  localRisk: number;
  inboundInfluence: number;
  propagatedRisk: number;
  contributors: Array<{ regionId: string; weight: number; risk: number }>;
}

const RISK_VALUE: Record<string, number> = {
  normal: 0,
  watch: 0.25,
  high: 0.6,
  critical: 1,
  unknown: 0.35,
};

export function riskValue(level: string): number {
  return RISK_VALUE[level] ?? 0.35;
}

export function buildRegionGraph(scenario: SafetyScenario): RegionGraph {
  const adjacency = new Map<string, GraphEdge[]>();
  for (const region of scenario.regions) adjacency.set(region.id, []);
  for (const corridor of scenario.corridors) {
    if (corridor.status !== 'open' || corridor.capacity_per_min === null || corridor.capacity_per_min <= 0) continue;
    const capacityFactor = corridor.capacity_per_min / (corridor.capacity_per_min + 100);
    const distanceFactor = 1 / (1 + corridor.traversal_seconds / 60);
    const weight = Number((0.5 * capacityFactor * distanceFactor).toFixed(6));
    const forward = adjacency.get(corridor.from_region_id);
    const reverse = adjacency.get(corridor.to_region_id);
    if (forward && (corridor.direction === 'both' || corridor.direction === 'forward')) {
      forward.push({ corridorId: corridor.id, to: corridor.to_region_id, traversalSeconds: corridor.traversal_seconds, capacityPerMin: corridor.capacity_per_min, weight });
    }
    if (reverse && (corridor.direction === 'both' || corridor.direction === 'reverse')) {
      reverse.push({ corridorId: corridor.id, to: corridor.from_region_id, traversalSeconds: corridor.traversal_seconds, capacityPerMin: corridor.capacity_per_min, weight });
    }
  }
  return { adjacency, regionIds: scenario.regions.map(region => region.id) };
}

export function neighborsOf(graph: RegionGraph, regionId: string): string[] {
  return (graph.adjacency.get(regionId) ?? []).map(edge => edge.to);
}

/** 多步风险传播：propagated = min(1, local + damping × Σ neighbor risk × edgeWeight)。 */
export function propagateRisk(
  scenario: SafetyScenario,
  risks: RegionRisk[],
  options: { damping?: number; steps?: number; edgeWeightScale?: number } = {},
): PropagatedRisk[] {
  const graph = buildRegionGraph(scenario);
  const damping = options.damping ?? 0.6;
  const steps = options.steps ?? 3;
  const edgeWeightScale = options.edgeWeightScale ?? 1;
  const local = new Map<string, number>();
  for (const region of scenario.regions) {
    const risk = risks.find(item => item.regionId === region.id);
    local.set(region.id, risk ? riskValue(risk.level) : 0.35);
  }
  const current = new Map(local);
  for (let step = 0; step < steps; step += 1) {
    const next = new Map(current);
    for (const regionId of graph.regionIds) {
      let influence = 0;
      for (const edge of graph.adjacency.get(regionId) ?? []) {
        influence += (current.get(edge.to) ?? 0) * edge.weight * edgeWeightScale;
      }
      next.set(regionId, Math.min(1, (local.get(regionId) ?? 0) + damping * influence));
    }
    for (const [key, value] of next) current.set(key, value);
  }

  return graph.regionIds.map(regionId => {
    const contributors = (graph.adjacency.get(regionId) ?? [])
      .map(edge => ({ regionId: edge.to, weight: edge.weight, risk: current.get(edge.to) ?? 0 }))
      .sort((a, b) => b.risk * b.weight - a.risk * a.weight);
    const inbound = contributors.reduce((sum, item) => sum + item.risk * item.weight, 0);
    return {
      regionId,
      localRisk: Number((local.get(regionId) ?? 0).toFixed(4)),
      inboundInfluence: Number((damping * inbound).toFixed(4)),
      propagatedRisk: Number((current.get(regionId) ?? 0).toFixed(4)),
      contributors: contributors.slice(0, 4).map(item => ({ ...item, weight: Number(item.weight.toFixed(4)), risk: Number(item.risk.toFixed(4)) })),
    };
  }).sort((a, b) => b.propagatedRisk - a.propagatedRisk);
}

export interface InvestigationPriority {
  regionId: string;
  propagatedRisk: number;
  uncertainty: number;
  centrality: number;
  priority: number;
  reason: string;
}

/**
 * 调查优先级 = 传播风险 × 不确定性 × 图中心性。
 * 不确定性：观测不可信为 1，可信为 0.2；无观测为 1。
 */
export function rankInvestigationPriorities(
  scenario: SafetyScenario,
  risks: RegionRisk[],
  propagated: PropagatedRisk[],
): InvestigationPriority[] {
  const graph = buildRegionGraph(scenario);
  return propagated.map(item => {
    const risk = risks.find(entry => entry.regionId === item.regionId);
    const uncertainty = !risk || !risk.trusted ? 1 : 0.2;
    const degree = graph.adjacency.get(item.regionId)?.length ?? 0;
    const centrality = degree / Math.max(1, graph.regionIds.length - 1);
    const priority = item.propagatedRisk * (0.5 + uncertainty) * (0.5 + centrality);
    return {
      regionId: item.regionId,
      propagatedRisk: item.propagatedRisk,
      uncertainty,
      centrality: Number(centrality.toFixed(4)),
      priority: Number(priority.toFixed(4)),
      reason: `传播风险 ${item.propagatedRisk.toFixed(3)} × 不确定性 ${uncertainty} × 中心性 ${centrality.toFixed(2)}`,
    };
  }).sort((a, b) => b.priority - a.priority);
}
