/**
 * 最小费用最大流（Successive Shortest Path + SPFA 标号）。
 *
 * 选择理由：
 *  - 疏散问题的核心是「有容量上限的多路径分配」，最小费用最大流可以直接给出
 *    最大可疏散人数，并在同等疏散量下最小化总行程时间；
 *  - SPFA 版本对负费用边稳健（本模型费用非负，但保留通用性）；
 *  - 网络规模为 O(区域数 × 时间步数)，原型场景下每次求解在毫秒级。
 *
 * 复杂度：每次增广 O(V·E)，增广次数不超过 O(F)（F 为流量，整数），
 * 本场景 V ≈ 区域数 × 时间步，E ≈ 通道数 × 时间步，可实时求解。
 */

export interface FlowEdgeMeta {
  kind: 'source' | 'hold' | 'corridor' | 'exit';
  regionId?: string;
  corridorId?: string;
  exitId?: string;
  fromRegionId?: string;
  toRegionId?: string;
  departMinute?: number;
  arriveMinute?: number;
}

export interface FlowNodeMeta {
  kind: 'source' | 'region' | 'sink';
  regionId?: string;
  minute?: number;
}

interface InternalEdge {
  to: number;
  rev: number;
  cap: number;
  cost: number;
  meta?: FlowEdgeMeta;
}

export interface DecomposedPath {
  /** 起点区域。 */
  regionId: string;
  /** 终止出口。 */
  exitId: string;
  persons: number;
  /** 离开起点区域的分钟（等待后出发时刻）。 */
  departMinute: number;
  /** 到达出口的分钟。 */
  arriveMinute: number;
  steps: Array<{
    corridorId: string;
    fromRegionId: string;
    toRegionId: string;
    departMinute: number;
    arriveMinute: number;
  }>;
}

export class MinCostFlowNetwork {
  private graph: InternalEdge[][];
  private edgeCounter = 0;
  readonly nodeMeta: FlowNodeMeta[] = [];

  constructor(nodeCount: number) {
    this.graph = Array.from({ length: nodeCount }, () => [] as InternalEdge[]);
    for (let i = 0; i < nodeCount; i += 1) this.nodeMeta.push({ kind: 'region' });
  }

  setNodeMeta(index: number, meta: FlowNodeMeta): void {
    this.nodeMeta[index] = meta;
  }

  /** 添加一条有向边，返回边 ID（用于提取最终流量）。 */
  addEdge(from: number, to: number, cap: number, cost: number, meta?: FlowEdgeMeta): number {
    const id = this.edgeCounter;
    this.edgeCounter += 2;
    this.graph[from].push({ to, rev: this.graph[to].length, cap, cost, meta });
    this.graph[to].push({ to: from, rev: this.graph[from].length - 1, cap: 0, cost: -cost });
    return id;
  }

  /**
   * 计算最小费用最大流。返回总流量、总费用。
   * 若图中存在从未饱和的源边，调用方据此判断「需求未被完全满足」。
   */
  minCostMaxFlow(source: number, sink: number, maxIterations = 200000): { flow: number; cost: number; iterations: number } {
    let totalFlow = 0;
    let totalCost = 0;
    let iterations = 0;
    const n = this.graph.length;

    while (iterations < maxIterations) {
      const dist = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
      const inQueue = new Array<boolean>(n).fill(false);
      const prevNode = new Array<number>(n).fill(-1);
      const prevEdge = new Array<number>(n).fill(-1);

      dist[source] = 0;
      const queue: number[] = [source];
      inQueue[source] = true;
      let head = 0;

      while (head < queue.length) {
        const u = queue[head];
        head += 1;
        inQueue[u] = false;
        const edges = this.graph[u];
        for (let i = 0; i < edges.length; i += 1) {
          const edge = edges[i];
          if (edge.cap <= 0) continue;
          const next = dist[u] + edge.cost;
          if (next < dist[edge.to]) {
            dist[edge.to] = next;
            prevNode[edge.to] = u;
            prevEdge[edge.to] = i;
            if (!inQueue[edge.to]) {
              inQueue[edge.to] = true;
              queue.push(edge.to);
            }
          }
        }
      }

      if (dist[sink] === Number.POSITIVE_INFINITY) break;

      let bottleneck = Number.POSITIVE_INFINITY;
      let cursor = sink;
      while (cursor !== source) {
        const u = prevNode[cursor];
        const e = this.graph[u][prevEdge[cursor]];
        bottleneck = Math.min(bottleneck, e.cap);
        cursor = u;
      }
      if (!Number.isFinite(bottleneck) || bottleneck <= 0) break;

      cursor = sink;
      while (cursor !== source) {
        const u = prevNode[cursor];
        const e = this.graph[u][prevEdge[cursor]];
        e.cap -= bottleneck;
        this.graph[cursor][e.rev].cap += bottleneck;
        cursor = u;
      }

      totalFlow += bottleneck;
      totalCost += bottleneck * dist[sink];
      iterations += 1;
    }

    return { flow: totalFlow, cost: totalCost, iterations };
  }

  /** 调试/审计用：返回所有原始弧及其净流量。 */
  debugEdgeFlows(): Array<{ from: number; to: number; capacity: number; flow: number; meta?: FlowEdgeMeta }> {
    const out: Array<{ from: number; to: number; capacity: number; flow: number; meta?: FlowEdgeMeta }> = [];
    for (let u = 0; u < this.graph.length; u += 1) {
      for (const edge of this.graph[u]) {
        if (!edge.meta) continue;
        const reverse = this.graph[edge.to][edge.rev];
        out.push({ from: u, to: edge.to, capacity: reverse.cap + edge.cap, flow: reverse.cap, meta: edge.meta });
      }
    }
    return out;
  }

  /**
   * 按最大流算法的残余流量做路径分解，得到「起点区域 → 出口」的多条明确路线。
   * 分解只在原始弧（cap 已减少表示已有流量）上进行，不会凭空创造流量。
   */
  decompose(source: number, sink: number): DecomposedPath[] {
    // 记录每条原始有向边的初始容量，用初始容量与剩余容量差得到流量。
    const flows: Array<{ from: number; to: number; flow: number; meta?: FlowEdgeMeta }> = [];
    for (let u = 0; u < this.graph.length; u += 1) {
      for (const edge of this.graph[u]) {
        if (!edge.meta) continue; // 反向边没有 meta
        const reverse = this.graph[edge.to][edge.rev];
        const used = reverse.cap;
        if (used > 0) flows.push({ from: u, to: edge.to, flow: used, meta: edge.meta });
      }
    }

    // 邻接索引
    const outgoing = new Map<number, number[]>();
    flows.forEach((f, index) => {
      const list = outgoing.get(f.from) ?? [];
      list.push(index);
      outgoing.set(f.from, list);
    });

    const results: DecomposedPath[] = [];
    let guard = 0;
    const maxPaths = 100000;

    while (guard < maxPaths) {
      guard += 1;
      // DFS 找一条从 source 到 sink、所有边残余流量为正的路径
      const visited = new Set<number>();
      const pathEdges: number[] = [];
      const dfs = (node: number): boolean => {
        if (node === sink) return true;
        if (visited.has(node)) return false;
        visited.add(node);
        for (const edgeIndex of outgoing.get(node) ?? []) {
          if (flows[edgeIndex].flow <= 0) continue;
          pathEdges.push(edgeIndex);
          if (dfs(flows[edgeIndex].to)) return true;
          pathEdges.pop();
        }
        return false;
      };

      if (!dfs(source)) break;

      let bottleneck = Number.POSITIVE_INFINITY;
      for (const edgeIndex of pathEdges) {
        bottleneck = Math.min(bottleneck, flows[edgeIndex].flow);
      }
      if (!Number.isFinite(bottleneck) || bottleneck <= 0) break;
      for (const edgeIndex of pathEdges) flows[edgeIndex].flow -= bottleneck;

      const path = pathEdges.map(index => flows[index]);
      const regionId = path[0]?.meta?.regionId;
      const exitId = path.find(edge => edge.meta?.kind === 'exit')?.meta?.exitId;
      if (!regionId || !exitId) continue;

      const steps = path
        .filter(edge => edge.meta?.kind === 'corridor')
        .map(edge => ({
          corridorId: edge.meta!.corridorId!,
          fromRegionId: edge.meta!.fromRegionId!,
          toRegionId: edge.meta!.toRegionId!,
          departMinute: edge.meta!.departMinute!,
          arriveMinute: edge.meta!.arriveMinute!,
        }));

      const exitEdge = path.find(edge => edge.meta?.kind === 'exit')!;
      results.push({
        regionId,
        exitId,
        persons: bottleneck,
        departMinute: steps.length > 0 ? steps[0].departMinute : (exitEdge.meta?.departMinute ?? 0),
        arriveMinute: exitEdge.meta?.arriveMinute ?? (steps.length > 0 ? steps[steps.length - 1].arriveMinute : 0),
        steps,
      });
    }

    return results;
  }
}
