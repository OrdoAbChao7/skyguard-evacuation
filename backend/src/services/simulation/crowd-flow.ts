/**
 * 场景驱动的算法人群仿真（合成数据）。
 *
 * 目的：在没有真实人群数据的情况下，用**可解释、可复现**的离散流模型生成
 * 整个场景的分钟级人数序列，供观测、预测、VoI 与安全内核联调/演示使用。
 *
 * 模型（不是经验证的人群动力学）：
 *  - 1 分钟离散；区域是人数水库，通道按「人/分钟」服务，出口按「人/分钟」放行；
 *  - 每人只沿当前最短路走向一个开放出口；路径按「通行时间 + 下游占用惩罚」选择；
 *  - 通道容量、出口容量、区域在留容量都是硬约束，超出部分留在原区域排队；
 *  - 高密度时按阈值比例降低流出意愿（启发式拥堵反馈），不建模个体行为；
 *  - 人数取整、移动即守恒；同一 seed 的输出完全可复现。
 *
 * 明确边界：
 *  - 所有输出标记为 `simulation`，不是实测、不是视频推理结果；
 *  - 场景面积、容量、阈值均未现场标定，不能据此声称真实精度；
 *  - 未建模恐慌、逆行、跌倒、天气、出口外空间与二次事故；
 *  - 该模块不参与安全判定，也不修改安全内核；安全结论仍由独立校验器与状态机给出。
 */
import type { Corridor, SafetyExit, SafetyScenario } from '../safety/types';
import { corridorDirections, traversalMinutes } from '../safety/network';

export type CrowdFlowPreset = 'normal' | 'gate_closure' | 'surge';

export type CrowdFlowEvent =
  | { minute: number; kind: 'exit_close'; exit_id: string; reason?: string }
  | { minute: number; kind: 'exit_open'; exit_id: string; reason?: string }
  | { minute: number; kind: 'corridor_close'; corridor_id: string; reason?: string }
  | { minute: number; kind: 'corridor_open'; corridor_id: string; reason?: string }
  | { minute: number; kind: 'surge'; region_id: string; persons: number; reason?: string }
  | { minute: number; kind: 'confidence_drop'; region_id: string; confidence: number; reason?: string };

export interface CrowdFlowOptions {
  /** 仿真分钟数；默认场景 horizon。 */
  minutes?: number;
  /** 随机种子；只影响置信度噪声，人数轨迹是确定性的。 */
  seed?: number;
  /** 预设事件；默认 normal（只疏散，不注入事件）。 */
  preset?: CrowdFlowPreset;
  /** 第一个样本的时间；默认 now - minutes，最后一个样本落在当前时刻。 */
  start_at?: Date;
  /** 覆盖初始人数；缺省使用场景 simulation_baseline。 */
  initial_counts?: Record<string, number>;
  /** 每分钟注入区域的外部到达人数（可选，例如持续入场）。 */
  arrivals_per_minute?: Record<string, number>;
  /** 追加事件；与 preset 事件合并。 */
  events?: CrowdFlowEvent[];
  /** 自由流出比例（每分钟最多离开当前区域的比例），默认 0.35。 */
  outflow_per_minute?: number;
  /** 拥堵反馈参数。 */
  congestion?: {
    exponent?: number;
    min_fraction?: number;
  };
  /** 置信度模型参数。 */
  confidence?: {
    base?: number;
    density_penalty?: number;
    noise?: number;
  };
}

export interface CrowdFlowRegionSample {
  region_id: string;
  region_name: string;
  count: number;
  density: number;
  confidence: number;
  inflow: number;
  outflow: number;
  /** 区域有人但当前没有任何可用路径。 */
  stranded: boolean;
  /** 有人想离开但被通道/出口容量或下游空间限制。 */
  capacity_limited: boolean;
}

export interface CrowdFlowExitSample {
  exit_id: string;
  discharged: number;
  capacity_per_min: number;
}

export interface CrowdFlowCorridorSample {
  corridor_id: string;
  moved: number;
}

export interface CrowdFlowSample {
  /** 第几分钟（从 1 开始，表示该分钟结束后的状态）。 */
  minute: number;
  at: string;
  regions: CrowdFlowRegionSample[];
  exits: CrowdFlowExitSample[];
  corridors: CrowdFlowCorridorSample[];
  totals: {
    inside: number;
    in_transit: number;
    evacuated: number;
    stranded: number;
    arrivals: number;
  };
  events: string[];
}

export interface CrowdFlowSummary {
  algorithm: 'crowd-flow-v1';
  scenario_id: string;
  scenario_version: string;
  preset: CrowdFlowPreset;
  seed: number;
  minutes: number;
  step_seconds: 60;
  initial_total: number;
  arrivals_total: number;
  evacuated: number;
  remaining_inside: number;
  in_transit: number;
  stranded: number;
  conservation_ok: boolean;
  peak_density: {
    region_id: string;
    region_name: string;
    density: number;
    count: number;
    at: string;
  } | null;
  peak_region_count: {
    region_id: string;
    region_name: string;
    count: number;
    at: string;
  } | null;
  peak_in_transit: number;
  congested_samples: number;
  exit_totals: Record<string, number>;
  unresolved_regions: Array<{ region_id: string; count: number; reason: string }>;
  events: string[];
  assumptions: string[];
}

export interface CrowdFlowReplayRow {
  timestamp: string;
  region_id: string;
  count: number;
  confidence: number;
  source: 'simulation';
}

export interface CrowdFlowResult {
  summary: CrowdFlowSummary;
  samples: CrowdFlowSample[];
  replay_rows: CrowdFlowReplayRow[];
}

interface DirectedEdge {
  corridor: Corridor;
  from: string;
  to: string;
}

interface TransitEntry {
  arriveMinute: number;
  to: string;
  persons: number;
}

interface RoutePlan {
  distance: Map<string, number>;
  nextHop: Map<string, { corridorId: string; to: string }>;
}

const INF = Number.POSITIVE_INFINITY;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function presetEvents(preset: CrowdFlowPreset, scenario: SafetyScenario): CrowdFlowEvent[] {
  if (preset === 'gate_closure') {
    const events: CrowdFlowEvent[] = [
      {
        minute: 2,
        kind: 'exit_close',
        exit_id: 'GATE_03_G03',
        reason: '算法仿真预设：3 号闸口临时关闭',
      },
      {
        minute: 2,
        kind: 'exit_close',
        exit_id: 'GATE_04_G04',
        reason: '算法仿真预设：4 号闸口临时关闭',
      },
    ];
    return events.filter(event => (
      event.kind === 'exit_close' && scenario.exits.some(exit => exit.id === event.exit_id)
    ));
  }
  if (preset === 'surge') {
    const events: CrowdFlowEvent[] = [
      {
        minute: 2,
        kind: 'surge',
        region_id: 'R_GATE_04_PLAZA',
        persons: 3300,
        reason: '算法仿真预设：4 号门广场短时人群激增',
      },
      {
        minute: 2,
        kind: 'confidence_drop',
        region_id: 'R_GATE_04_PLAZA',
        confidence: 0.35,
        reason: '算法仿真预设：激增区域感知置信度下降',
      },
    ];
    return events.filter(event => (
      (event.kind === 'surge' || event.kind === 'confidence_drop')
      && scenario.regions.some(region => region.id === event.region_id)
    ));
  }
  return [];
}

export function simulateCrowdFlow(
  scenario: SafetyScenario,
  options: CrowdFlowOptions = {},
): CrowdFlowResult {
  const minutes = options.minutes ?? scenario.config.horizon_minutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
    throw new Error('仿真分钟数必须是 1~240 的整数');
  }
  const seed = options.seed ?? 42;
  if (!Number.isInteger(seed) || seed < 0) throw new Error('seed 必须是非负整数');
  const preset = options.preset ?? 'normal';
  const outflowRate = options.outflow_per_minute ?? 0.35;
  if (!(outflowRate > 0 && outflowRate <= 1)) throw new Error('outflow_per_minute 必须在 (0, 1] 内');
  const exponent = Math.max(0.5, options.congestion?.exponent ?? 2);
  const minFraction = clamp(options.congestion?.min_fraction ?? 0.35, 0.05, 1);
  const confidenceBase = clamp(options.confidence?.base ?? 0.92, 0.1, 0.99);
  const densityPenalty = Math.max(0, options.confidence?.density_penalty ?? 0.12);
  const noiseAmplitude = Math.max(0, options.confidence?.noise ?? 0.015);
  const startAt = options.start_at ?? new Date(Date.now() - minutes * 60_000);
  if (Number.isNaN(startAt.getTime())) throw new Error('start_at 不是有效时间');

  const enabledRegions = scenario.regions.filter(region => region.enabled);
  if (enabledRegions.length === 0) throw new Error('场景没有启用区域，无法仿真');
  const regionById = new Map(enabledRegions.map(region => [region.id, region]));
  const holding = new Map(enabledRegions.map(region => [region.id, region.holding_capacity_persons]));
  const area = new Map(enabledRegions.map(region => [region.id, region.area_m2]));
  const criticalDensity = new Map(enabledRegions.map(region => [
    region.id,
    region.thresholds?.critical_density ?? scenario.config.default_thresholds.critical_density,
  ]));

  const baseline = scenario.simulation_baseline ?? {};
  const initial = options.initial_counts ?? Object.fromEntries(
    Object.entries(baseline).map(([regionId, sample]) => [regionId, sample.count]),
  );
  const persons = new Map<string, number>();
  let initialTotal = 0;
  for (const region of enabledRegions) {
    const raw = initial[region.id] ?? 0;
    if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
      throw new Error(`初始人数必须是非负整数：${region.id}=${raw}`);
    }
    persons.set(region.id, raw);
    initialTotal += raw;
  }
  for (const regionId of Object.keys(initial)) {
    if (!regionById.has(regionId)) throw new Error(`初始人数引用未知区域：${regionId}`);
  }

  const arrivalsPerMinute = options.arrivals_per_minute ?? {};
  for (const [regionId, value] of Object.entries(arrivalsPerMinute)) {
    if (!regionById.has(regionId)) throw new Error(`外部到达引用未知区域：${regionId}`);
    if (!Number.isFinite(value) || value < 0) throw new Error(`外部到达必须是非负数：${regionId}=${value}`);
  }

  const corridorById = new Map(scenario.corridors.map(corridor => [corridor.id, corridor]));
  const exitById = new Map(scenario.exits.map(exit => [exit.id, exit]));
  const exitsByRegion = new Map<string, SafetyExit[]>();
  for (const exit of scenario.exits) {
    if (!regionById.has(exit.region_id)) continue;
    const list = exitsByRegion.get(exit.region_id) ?? [];
    list.push(exit);
    exitsByRegion.set(exit.region_id, list);
  }

  const closedExitIds = new Set<string>();
  const closedCorridorIds = new Set<string>();
  const confidenceOverrides = new Map<string, number>();
  const allEvents: string[] = [];
  const eventsByMinute = new Map<number, CrowdFlowEvent[]>();
  for (const event of [...presetEvents(preset, scenario), ...(options.events ?? [])]) {
    if (!Number.isInteger(event.minute) || event.minute < 0 || event.minute >= minutes) {
      throw new Error(`事件分钟数超出范围：${event.minute}`);
    }
    if (event.kind === 'exit_close' || event.kind === 'exit_open') {
      if (!exitById.has(event.exit_id)) throw new Error(`事件引用未知出口：${event.exit_id}`);
    } else if (event.kind === 'corridor_close' || event.kind === 'corridor_open') {
      if (!corridorById.has(event.corridor_id)) throw new Error(`事件引用未知通道：${event.corridor_id}`);
    } else if (event.kind === 'surge') {
      if (!regionById.has(event.region_id)) throw new Error(`事件引用未知区域：${event.region_id}`);
      if (!Number.isInteger(event.persons) || event.persons < 0) throw new Error('激增人数必须是非负整数');
    } else if (event.kind === 'confidence_drop') {
      if (!regionById.has(event.region_id)) throw new Error(`事件引用未知区域：${event.region_id}`);
      if (!(event.confidence >= 0 && event.confidence <= 1)) throw new Error('置信度必须在 0~1 内');
    }
    const list = eventsByMinute.get(event.minute) ?? [];
    list.push(event);
    eventsByMinute.set(event.minute, list);
  }

  const transit: TransitEntry[] = [];
  const exitTotals: Record<string, number> = {};
  let evacuated = 0;
  let arrivalsTotal = 0;
  let peakInTransit = 0;
  let congestedSamples = 0;
  let peakDensity: CrowdFlowSummary['peak_density'] = null;
  let peakRegionCount: CrowdFlowSummary['peak_region_count'] = null;
  const samples: CrowdFlowSample[] = [];
  const rng = mulberry32(seed);

  const usableExitsFor = (regionId: string): SafetyExit[] => (exitsByRegion.get(regionId) ?? [])
    .filter(exit => exit.status === 'open' && (exit.capacity_per_min ?? 0) > 0 && !closedExitIds.has(exit.id));

  const usableCorridors = (): Corridor[] => scenario.corridors.filter(corridor => (
    corridor.status === 'open'
    && (corridor.capacity_per_min ?? 0) > 0
    && !closedCorridorIds.has(corridor.id)
    && regionById.has(corridor.from_region_id)
    && regionById.has(corridor.to_region_id)
  ));

  const queuePenalty = (regionId: string): number => {
    const count = persons.get(regionId) ?? 0;
    const capacity = holding.get(regionId) ?? 1;
    return 1.5 * clamp(count / capacity, 0, 1);
  };

  const computeRoutes = (): RoutePlan => {
    const incoming = new Map<string, DirectedEdge[]>();
    for (const corridor of usableCorridors()) {
      for (const direction of corridorDirections(corridor)) {
        if (!regionById.has(direction.from) || !regionById.has(direction.to)) continue;
        const edge: DirectedEdge = { corridor, from: direction.from, to: direction.to };
        const list = incoming.get(direction.to) ?? [];
        list.push(edge);
        incoming.set(direction.to, list);
      }
    }

    const distance = new Map<string, number>();
    const nextHop = new Map<string, { corridorId: string; to: string }>();
    const unvisited = new Set(enabledRegions.map(region => region.id));
    for (const region of enabledRegions) {
      distance.set(region.id, usableExitsFor(region.id).length > 0 ? 0 : INF);
    }

    while (unvisited.size > 0) {
      let current: string | null = null;
      for (const regionId of unvisited) {
        if (current === null || (distance.get(regionId) ?? INF) < (distance.get(current) ?? INF)) {
          current = regionId;
        }
      }
      if (current === null || (distance.get(current) ?? INF) === INF) break;
      unvisited.delete(current);
      const base = distance.get(current) ?? INF;
      for (const edge of incoming.get(current) ?? []) {
        if (!unvisited.has(edge.from)) continue;
        const candidate = base + traversalMinutes(edge.corridor) + queuePenalty(current);
        if (candidate < (distance.get(edge.from) ?? INF)) {
          distance.set(edge.from, candidate);
          nextHop.set(edge.from, { corridorId: edge.corridor.id, to: current });
        }
      }
    }
    return { distance, nextHop };
  };

  const inTransitTo = (regionId: string): number => transit
    .filter(entry => entry.to === regionId)
    .reduce((sum, entry) => sum + entry.persons, 0);

  const eventText = (event: CrowdFlowEvent): string => {
    const reason = 'reason' in event && event.reason ? `（${event.reason}）` : '';
    switch (event.kind) {
      case 'exit_close':
        return `第 ${event.minute + 1} 分钟：关闭出口 ${event.exit_id}${reason}`;
      case 'exit_open':
        return `第 ${event.minute + 1} 分钟：开放出口 ${event.exit_id}${reason}`;
      case 'corridor_close':
        return `第 ${event.minute + 1} 分钟：关闭通道 ${event.corridor_id}${reason}`;
      case 'corridor_open':
        return `第 ${event.minute + 1} 分钟：开放通道 ${event.corridor_id}${reason}`;
      case 'surge':
        return `第 ${event.minute + 1} 分钟：区域 ${event.region_id} 新增 ${event.persons} 人${reason}`;
      case 'confidence_drop':
        return `第 ${event.minute + 1} 分钟：区域 ${event.region_id} 置信度降至 ${event.confidence}${reason}`;
    }
  };

  for (let minute = 0; minute < minutes; minute += 1) {
    const appliedEvents: string[] = [];

    for (const event of eventsByMinute.get(minute) ?? []) {
      switch (event.kind) {
        case 'exit_close':
          closedExitIds.add(event.exit_id);
          break;
        case 'exit_open':
          closedExitIds.delete(event.exit_id);
          break;
        case 'corridor_close':
          closedCorridorIds.add(event.corridor_id);
          break;
        case 'corridor_open':
          closedCorridorIds.delete(event.corridor_id);
          break;
        case 'surge': {
          const next = (persons.get(event.region_id) ?? 0) + event.persons;
          persons.set(event.region_id, next);
          arrivalsTotal += event.persons;
          break;
        }
        case 'confidence_drop':
          confidenceOverrides.set(event.region_id, event.confidence);
          break;
      }
      const text = eventText(event);
      appliedEvents.push(text);
      allEvents.push(text);
    }

    // 先处理上一分钟在通道上的到达，再处理持续外部到达。
    const arrivalsThisMinute = new Map<string, number>();
    for (let index = transit.length - 1; index >= 0; index -= 1) {
      const entry = transit[index];
      if (entry.arriveMinute > minute) continue;
      persons.set(entry.to, (persons.get(entry.to) ?? 0) + entry.persons);
      arrivalsThisMinute.set(entry.to, (arrivalsThisMinute.get(entry.to) ?? 0) + entry.persons);
      transit.splice(index, 1);
    }
    for (const [regionId, perMinute] of Object.entries(arrivalsPerMinute)) {
      const inflow = Math.floor(perMinute);
      if (inflow <= 0) continue;
      persons.set(regionId, (persons.get(regionId) ?? 0) + inflow);
      arrivalsTotal += inflow;
      arrivalsThisMinute.set(regionId, (arrivalsThisMinute.get(regionId) ?? 0) + inflow);
    }

    const routes = computeRoutes();
    const corridorUsed = new Map<string, number>();
    const exitUsed = new Map<string, number>();
    const outflow = new Map<string, number>();
    const capacityLimited = new Set<string>();
    const stranded = new Set<string>();
    const corridorMoved = new Map<string, number>();

    const order = [...enabledRegions].sort((a, b) => (
      (routes.distance.get(a.id) ?? INF) - (routes.distance.get(b.id) ?? INF)
      || a.id.localeCompare(b.id)
    ));

    for (const region of order) {
      let remaining = persons.get(region.id) ?? 0;
      if (remaining <= 0) continue;
      const density = remaining / (area.get(region.id) ?? 1);
      const critical = criticalDensity.get(region.id) ?? 1;
      const ratio = clamp(density / Math.max(critical, 0.0001), 0, 1);
      const congestionFactor = Math.max(minFraction, 1 - (1 - minFraction) * ratio ** exponent);
      let desired = Math.max(1, Math.floor(remaining * outflowRate * congestionFactor));
      const exits = usableExitsFor(region.id);

      if (exits.length > 0) {
        for (const exit of exits) {
          if (remaining <= 0 || desired <= 0) break;
          const capacity = exit.capacity_per_min ?? 0;
          const used = exitUsed.get(exit.id) ?? 0;
          const available = Math.max(0, capacity - used);
          const moved = Math.min(desired, remaining, available);
          if (moved > 0) {
            remaining -= moved;
            desired -= moved;
            evacuated += moved;
            exitUsed.set(exit.id, used + moved);
            exitTotals[exit.id] = (exitTotals[exit.id] ?? 0) + moved;
            outflow.set(region.id, (outflow.get(region.id) ?? 0) + moved);
          }
        }
        if (remaining > 0 && desired > 0) {
          // 出口容量已用尽，剩余人数留在区域。
          capacityLimited.add(region.id);
        }
      } else {
        const hop = routes.nextHop.get(region.id);
        if (!hop) {
          stranded.add(region.id);
        } else {
          const corridor = corridorById.get(hop.corridorId);
          const capacity = corridor?.capacity_per_min ?? 0;
          const used = corridorUsed.get(hop.corridorId) ?? 0;
          const corridorAvailable = Math.max(0, capacity - used);
          const destination = hop.to;
          const space = Math.max(0, (holding.get(destination) ?? 0) - (persons.get(destination) ?? 0) - inTransitTo(destination));
          const moved = Math.min(desired, remaining, corridorAvailable, space);
          if (moved > 0) {
            remaining -= moved;
            persons.set(region.id, remaining);
            corridorUsed.set(hop.corridorId, used + moved);
            corridorMoved.set(hop.corridorId, (corridorMoved.get(hop.corridorId) ?? 0) + moved);
            outflow.set(region.id, (outflow.get(region.id) ?? 0) + moved);
            const travel = corridor ? traversalMinutes(corridor) : 1;
            transit.push({ arriveMinute: minute + travel, to: destination, persons: moved });
          }
          if (remaining > 0 && desired > 0 && moved < desired) capacityLimited.add(region.id);
        }
      }
      persons.set(region.id, remaining);
    }

    const inside = enabledRegions.reduce((sum, region) => sum + (persons.get(region.id) ?? 0), 0);
    const inTransit = transit.reduce((sum, entry) => sum + entry.persons, 0);
    peakInTransit = Math.max(peakInTransit, inTransit);
    const strandedPersons = enabledRegions
      .filter(region => stranded.has(region.id))
      .reduce((sum, region) => sum + (persons.get(region.id) ?? 0), 0);
    if (capacityLimited.size > 0) congestedSamples += 1;

    const at = new Date(startAt.getTime() + (minute + 1) * 60_000).toISOString();
    const regionSamples: CrowdFlowRegionSample[] = enabledRegions.map(region => {
      const count = persons.get(region.id) ?? 0;
      const density = count / (area.get(region.id) ?? 1);
      const critical = criticalDensity.get(region.id) ?? 1;
      const ratio = clamp(density / Math.max(critical, 0.0001), 0, 1);
      let confidence = confidenceBase - densityPenalty * ratio + (rng() - 0.5) * 2 * noiseAmplitude;
      if (region.camera.status === 'offline') confidence = Math.min(confidence, 0.3);
      else if (region.camera.status === 'degraded') confidence = Math.min(confidence, 0.6);
      const override = confidenceOverrides.get(region.id);
      if (override !== undefined) confidence = override;
      confidence = clamp(Number(confidence.toFixed(3)), 0.05, 0.99);
      return {
        region_id: region.id,
        region_name: region.name,
        count,
        density: Number(density.toFixed(4)),
        confidence,
        inflow: arrivalsThisMinute.get(region.id) ?? 0,
        outflow: outflow.get(region.id) ?? 0,
        stranded: stranded.has(region.id) && count > 0,
        capacity_limited: capacityLimited.has(region.id),
      };
    });

    for (const sample of regionSamples) {
      if (sample.count > 0 && (peakRegionCount === null || sample.count > peakRegionCount.count)) {
        peakRegionCount = {
          region_id: sample.region_id,
          region_name: sample.region_name,
          count: sample.count,
          at,
        };
      }
      if (sample.density > 0 && (peakDensity === null || sample.density > peakDensity.density)) {
        peakDensity = {
          region_id: sample.region_id,
          region_name: sample.region_name,
          density: sample.density,
          count: sample.count,
          at,
        };
      }
    }

    samples.push({
      minute: minute + 1,
      at,
      regions: regionSamples,
      exits: [...exitById.values()]
        .filter(exit => regionById.has(exit.region_id))
        .map(exit => ({
          exit_id: exit.id,
          discharged: exitUsed.get(exit.id) ?? 0,
          capacity_per_min: exit.capacity_per_min ?? 0,
        })),
      corridors: [...corridorMoved.entries()]
        .map(([corridor_id, moved]) => ({ corridor_id, moved }))
        .sort((a, b) => a.corridor_id.localeCompare(b.corridor_id)),
      totals: {
        inside,
        in_transit: inTransit,
        evacuated,
        stranded: strandedPersons,
        arrivals: arrivalsTotal,
      },
      events: appliedEvents,
    });
  }

  const finalRoutes = computeRoutes();
  const unresolvedRegions = enabledRegions
    .filter(region => (persons.get(region.id) ?? 0) > 0)
    .filter(region => usableExitsFor(region.id).length === 0 && !finalRoutes.nextHop.has(region.id))
    .map(region => ({
      region_id: region.id,
      count: persons.get(region.id) ?? 0,
      reason: usableExitsFor(region.id).length === 0 ? '没有可用出口且无可用绕行路径' : '没有可用路径',
    }));

  const remainingInside = enabledRegions.reduce((sum, region) => sum + (persons.get(region.id) ?? 0), 0);
  const inTransit = transit.reduce((sum, entry) => sum + entry.persons, 0);
  const stranded = unresolvedRegions.reduce((sum, item) => sum + item.count, 0);

  const replayRows: CrowdFlowReplayRow[] = samples.flatMap(sample => sample.regions.map(region => ({
    timestamp: sample.at,
    region_id: region.region_id,
    count: region.count,
    confidence: region.confidence,
    source: 'simulation' as const,
  })));

  return {
    summary: {
      algorithm: 'crowd-flow-v1',
      scenario_id: scenario.scenario_id,
      scenario_version: scenario.version,
      preset,
      seed,
      minutes,
      step_seconds: 60,
      initial_total: initialTotal,
      arrivals_total: arrivalsTotal,
      evacuated,
      remaining_inside: remainingInside,
      in_transit: inTransit,
      stranded,
      conservation_ok: initialTotal + arrivalsTotal === remainingInside + inTransit + evacuated,
      peak_density: peakDensity,
      peak_region_count: peakRegionCount,
      peak_in_transit: peakInTransit,
      congested_samples: congestedSamples,
      exit_totals: exitTotals,
      unresolved_regions: unresolvedRegions,
      events: allEvents,
      assumptions: [
        '1 分钟离散、人数取整；通道与出口按人/分钟服务，超出部分在区域排队。',
        '路径选择为「通行时间 + 下游占用惩罚」的启发式最短路，不是个体行为模型。',
        '高密度时按阈值比例降低流出意愿，是未标定的拥堵反馈启发式。',
        '未建模恐慌、逆行、跌倒、天气、出口外空间与二次事故。',
        '场景面积、容量与阈值均未现场标定；所有输出为合成数据，不得当作实测。',
      ],
    },
    samples,
    replay_rows: replayRows,
  };
}
