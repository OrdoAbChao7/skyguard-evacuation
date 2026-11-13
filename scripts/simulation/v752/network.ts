/**
 * Directed corridor graph and least-cost route computation.
 *
 * The graph is rebuilt from the *observed* snapshot at every control tick.
 * A corridor with `unknown` status or unknown capacity is excluded, matching
 * the project's "unknown is unavailable" invariant.  Both-direction corridors
 * share their nominal capacity between the two directions (the data field is
 * per corridor, not per direction).
 */
import type {
  CorridorDef,
  ObservedSnapshot,
  RouteChoice,
  RouteComputation,
  SimScenario,
} from './types';

export interface DirectedEdge {
  corridor_id: string;
  from: string;
  to: string;
  capacity_per_min: number;
  traversal_minutes: number;
  direction_share: number;
}

export interface Graph {
  adjacency: Map<string, DirectedEdge[]>;
  edges: DirectedEdge[];
  edgeByKey: Map<string, DirectedEdge>;
}

export function buildGraph(scenario: SimScenario, snapshot: ObservedSnapshot): Graph {
  const adjacency = new Map<string, DirectedEdge[]>();
  for (const region of scenario.regions) adjacency.set(region.id, []);
  const edges: DirectedEdge[] = [];
  const edgeByKey = new Map<string, DirectedEdge>();

  for (const corridor of scenario.corridors) {
    const status = snapshot.corridor_status.get(corridor.id) ?? corridor.status;
    if (status !== 'open') continue;
    if (corridor.capacity_per_min === null || corridor.capacity_per_min <= 0) continue;
    const share = corridor.direction === 'both' ? 0.5 : 1;
    const capacity = corridor.capacity_per_min * share * scenario.corridor_capacity_factor;
    const traversal = Math.max(1 / 60, corridor.traversal_seconds / 60);
    const directions: Array<{ from: string; to: string }> = [];
    if (corridor.direction === 'forward' || corridor.direction === 'both') {
      directions.push({ from: corridor.from_region_id, to: corridor.to_region_id });
    }
    if (corridor.direction === 'reverse' || corridor.direction === 'both') {
      directions.push({ from: corridor.to_region_id, to: corridor.from_region_id });
    }
    for (const direction of directions) {
      if (!adjacency.has(direction.from) || !adjacency.has(direction.to)) continue;
      const edge: DirectedEdge = {
        corridor_id: corridor.id,
        from: direction.from,
        to: direction.to,
        capacity_per_min: capacity,
        traversal_minutes: traversal,
        direction_share: share,
      };
      adjacency.get(direction.from)!.push(edge);
      edges.push(edge);
      edgeByKey.set(`${direction.from}->${direction.to}|${corridor.id}`, edge);
    }
  }
  return { adjacency, edges, edgeByKey };
}

export function regionDensity(scenario: SimScenario, snapshot: ObservedSnapshot, regionId: string): number {
  const region = scenario.regionById.get(regionId);
  if (!region || region.area_m2 <= 0) return 0;
  const observed = snapshot.regions.get(regionId);
  return Math.max(0, observed?.count ?? 0) / region.area_m2;
}

export function edgeCost(scenario: SimScenario, snapshot: ObservedSnapshot, edge: DirectedEdge): number {
  const destination = scenario.regionById.get(edge.to);
  const destinationObservation = snapshot.regions.get(edge.to);
  const density = regionDensity(scenario, snapshot, edge.to);
  const densityRatio = density / Math.max(0.01, scenario.rhoCrit);
  const capacityPenalty = destinationObservation && destinationObservation.count !== null
    ? Math.min(2, destinationObservation.count / Math.max(1, destination?.holding_capacity_persons ?? 1))
    : 0;
  const unknownPenalty = !destinationObservation || !destinationObservation.valid || destinationObservation.conflict
    ? 25
    : 0;
  return edge.traversal_minutes
    + 2.5 * densityRatio * densityRatio
    + 0.5 * capacityPenalty
    + unknownPenalty;
}

function exitCost(scenario: SimScenario, snapshot: ObservedSnapshot, regionId: string): number | null {
  const exits = scenario.exitsByRegion.get(regionId) ?? [];
  let best: number | null = null;
  for (const exit of exits) {
    const status = snapshot.exit_status.get(exit.id) ?? exit.status;
    if (status !== 'open') continue;
    if (exit.capacity_per_min === null || exit.capacity_per_min <= 0) continue;
    const observed = snapshot.regions.get(regionId);
    const queue = Math.max(0, observed?.count ?? 0);
    const density = regionDensity(scenario, snapshot, regionId);
    const cost = 0.5 + queue / Math.max(1, exit.capacity_per_min * scenario.exit_capacity_factor)
      + 3 * (density / Math.max(0.01, scenario.rhoCrit));
    if (best === null || cost < best) best = cost;
  }
  return best;
}

interface DijkstraResult {
  dist: Map<string, number>;
  previous: Map<string, string>;
  previousEdge: Map<string, DirectedEdge>;
}

function shortestPaths(
  graph: Graph,
  start: string,
  costOf: (edge: DirectedEdge) => number,
): DijkstraResult {
  const dist = new Map<string, number>();
  const previous = new Map<string, string>();
  const previousEdge = new Map<string, DirectedEdge>();
  const visited = new Set<string>();
  for (const node of graph.adjacency.keys()) dist.set(node, Number.POSITIVE_INFINITY);
  dist.set(start, 0);

  // 44 nodes: a simple sorted scan is deterministic and fast enough.
  while (true) {
    let current: string | null = null;
    let currentDist = Number.POSITIVE_INFINITY;
    for (const [node, value] of dist) {
      if (visited.has(node)) continue;
      if (value < currentDist || (value === currentDist && current !== null && node < current)) {
        current = node;
        currentDist = value;
      }
    }
    if (current === null || !Number.isFinite(currentDist)) break;
    visited.add(current);
    for (const edge of graph.adjacency.get(current) ?? []) {
      const candidate = currentDist + costOf(edge);
      const existing = dist.get(edge.to) ?? Number.POSITIVE_INFINITY;
      if (candidate < existing) {
        dist.set(edge.to, candidate);
        previous.set(edge.to, current);
        previousEdge.set(edge.to, edge);
      }
    }
  }
  return { dist, previous, previousEdge };
}

function reconstruct(
  start: string,
  exitRegion: string,
  previous: Map<string, string>,
  previousEdge: Map<string, DirectedEdge>,
): { pathRegions: string[]; pathCorridors: string[] } {
  const pathRegions = [exitRegion];
  const pathCorridors: string[] = [];
  let cursor = exitRegion;
  while (cursor !== start) {
    const edge = previousEdge.get(cursor);
    const parent = previous.get(cursor);
    if (!edge || !parent) return { pathRegions: [], pathCorridors: [] };
    pathCorridors.unshift(edge.corridor_id);
    pathRegions.unshift(parent);
    cursor = parent;
  }
  return { pathRegions, pathCorridors };
}

function pathTraversalMinutes(scenario: SimScenario, pathCorridors: string[]): number {
  return pathCorridors.reduce((sum, corridorId) => {
    const corridor = scenario.corridorById.get(corridorId);
    return sum + (corridor ? corridor.traversal_seconds / 60 : 0);
  }, 0);
}

export function computeLeastCostRoute(
  scenario: SimScenario,
  snapshot: ObservedSnapshot,
  graph: Graph,
  startRegionId: string,
): RouteChoice | null {
  const dijkstra = shortestPaths(graph, startRegionId, edge => edgeCost(scenario, snapshot, edge));
  let best: RouteChoice | null = null;
  for (const region of scenario.regions) {
    const exitCostValue = exitCost(scenario, snapshot, region.id);
    if (exitCostValue === null) continue;
    const travel = dijkstra.dist.get(region.id) ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(travel)) continue;
    const total = travel + exitCostValue;
    const { pathRegions, pathCorridors } = reconstruct(startRegionId, region.id, dijkstra.previous, dijkstra.previousEdge);
    if (pathRegions.length === 0 && region.id !== startRegionId) continue;
    const firstExit = (scenario.exitsByRegion.get(region.id) ?? []).find(exit => {
      const status = snapshot.exit_status.get(exit.id) ?? exit.status;
      return status === 'open' && exit.capacity_per_min !== null && exit.capacity_per_min > 0;
    });
    if (!firstExit) continue;
    const candidate: RouteChoice = {
      region_id: startRegionId,
      exit_id: firstExit.id,
      next_hop_region_id: pathRegions.length > 1 ? pathRegions[1] : null,
      path_regions: pathRegions,
      path_corridors: pathCorridors,
      eta_minutes: Number(pathTraversalMinutes(scenario, pathCorridors).toFixed(4)),
      cost: Number(total.toFixed(6)),
    };
    if (best === null || candidate.cost < best.cost
      || (candidate.cost === best.cost && candidate.exit_id < best.exit_id)) {
      best = candidate;
    }
  }
  return best;
}

export function evaluateRoute(
  scenario: SimScenario,
  snapshot: ObservedSnapshot,
  route: RouteChoice,
): number {
  let cost = 0;
  for (let index = 0; index < route.path_corridors.length; index += 1) {
    const corridorId = route.path_corridors[index];
    const from = route.path_regions[index];
    const to = route.path_regions[index + 1];
    const corridor = scenario.corridorById.get(corridorId);
    if (!corridor) return Number.POSITIVE_INFINITY;
    const status = snapshot.corridor_status.get(corridor.id) ?? corridor.status;
    if (status !== 'open' || corridor.capacity_per_min === null || corridor.capacity_per_min <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    const share = corridor.direction === 'both' ? 0.5 : 1;
    cost += edgeCost(scenario, snapshot, {
      corridor_id: corridor.id,
      from,
      to,
      capacity_per_min: corridor.capacity_per_min * share,
      traversal_minutes: Math.max(1 / 60, corridor.traversal_seconds / 60),
      direction_share: share,
    });
  }
  const exitCostValue = exitCost(scenario, snapshot, route.path_regions[route.path_regions.length - 1]);
  if (exitCostValue === null) return Number.POSITIVE_INFINITY;
  return cost + exitCostValue;
}

export function computeAllRoutes(
  scenario: SimScenario,
  snapshot: ObservedSnapshot,
): RouteComputation {
  const started = performance.now();
  const graph = buildGraph(scenario, snapshot);
  const routes = new Map<string, RouteChoice | null>();
  for (const region of scenario.regions) {
    routes.set(region.id, computeLeastCostRoute(scenario, snapshot, graph, region.id));
  }
  return {
    routes,
    solve_ms: performance.now() - started,
    graph_nodes: graph.adjacency.size,
    graph_edges: graph.edges.length,
  };
}
