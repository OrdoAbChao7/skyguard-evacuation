/**
 * 独立安全校验器（SafetyPlanValidator）。
 *
 * 该模块与规划器完全解耦：只吃「候选方案 + 当前约束 + 当前观测」，不采信规划器自报的
 * status / feasible 字段。规划器报告成功但校验失败时，方案必须被拒绝。
 *
 * 同时它是**纯函数**：不读写外部状态，便于在 API、测试和离线审计中复用。
 */
import type {
  DensityObservation,
  EvacuationPlan,
  SafetyConfig,
  SafetyScenario,
  SafetyValidationResult,
  SafetyViolation,
} from './types';
import { assessObservation } from './observations';
import {
  corridorDirections,
  traversalMinutes,
  type EffectiveNetwork,
} from './network';

export interface ValidateSafetyPlanInput {
  plan: EvacuationPlan;
  scenario: SafetyScenario;
  network: EffectiveNetwork;
  /** 各区域最新观测（可为空）。 */
  latestObservations: Map<string, DensityObservation>;
  config: SafetyConfig;
  constraintVersion: number;
  observationVersion: number;
  now?: Date;
}

const CHECK_NAMES = [
  'version_match',
  'reference_integrity',
  'corridor_direction',
  'path_chain',
  'corridor_status',
  'corridor_capacity',
  'exit_status',
  'exit_capacity',
  'flow_conservation',
  'demand_completeness',
  'demand_matches_observations',
  'observation_trust',
  'horizon_bounds',
  'totals_consistency',
] as const;

export function validateSafetyPlan(input: ValidateSafetyPlanInput): SafetyValidationResult {
  const { plan, scenario, network, config } = input;
  const now = input.now ?? new Date();
  const violations: SafetyViolation[] = [];
  const push = (violation: SafetyViolation) => violations.push(violation);

  const regionIds = new Set(scenario.regions.map(region => region.id));
  const corridorById = new Map(scenario.corridors.map(corridor => [corridor.id, corridor]));
  const exitById = new Map(scenario.exits.map(exit => [exit.id, exit]));
  const horizon = plan.horizon_minutes;

  // --- 1. 版本一致性 -------------------------------------------------------
  if (plan.scenario_version !== scenario.version) {
    push({
      code: 'stale_scenario',
      severity: 'hard',
      message: `方案基于场景版本 ${plan.scenario_version}，当前为 ${scenario.version}`,
    });
  }
  if (plan.constraint_version !== input.constraintVersion) {
    push({
      code: 'stale_constraints',
      severity: 'hard',
      message: `方案约束版本 ${plan.constraint_version} 与当前 ${input.constraintVersion} 不一致，期间约束已变化`,
      detail: { plan_version: plan.constraint_version, current_version: input.constraintVersion },
    });
  }
  if (plan.observation_version !== input.observationVersion) {
    push({
      code: 'stale_observations',
      severity: 'hard',
      message: `方案观测版本 ${plan.observation_version} 与当前 ${input.observationVersion} 不一致，期间观测已更新`,
      detail: { plan_version: plan.observation_version, current_version: input.observationVersion },
    });
  }

  // --- 2. 引用完整性 + 方向 + 连通链 ---------------------------------------
  const seenRouteIds = new Set<string>();
  for (const route of plan.routes) {
    if (seenRouteIds.has(route.route_id)) {
      push({ code: 'duplicate_route_id', severity: 'hard', message: `重复的路线 ID ${route.route_id}` });
    }
    seenRouteIds.add(route.route_id);

    if (!regionIds.has(route.from_region_id)) {
      push({
        code: 'unknown_region',
        severity: 'hard',
        message: `路线 ${route.route_id} 引用了不存在的区域 ${route.from_region_id}`,
        region_id: route.from_region_id,
      });
    }
    const exit = exitById.get(route.exit_id);
    if (!exit) {
      push({
        code: 'unknown_exit',
        severity: 'hard',
        message: `路线 ${route.route_id} 引用了不存在的出口 ${route.exit_id}`,
        exit_id: route.exit_id,
      });
    }
    if (route.persons <= 0) {
      push({
        code: 'invalid_persons',
        severity: 'hard',
        message: `路线 ${route.route_id} 人数必须为正数，实际 ${route.persons}`,
        detail: { persons: route.persons },
      });
    }
    if (route.depart_minute > route.arrive_minute) {
      push({
        code: 'invalid_time_order',
        severity: 'hard',
        message: `路线 ${route.route_id} 出发时刻晚于到达时刻`,
      });
    }
    if (route.arrive_minute > horizon) {
      push({
        code: 'horizon_exceeded',
        severity: 'hard',
        message: `路线 ${route.route_id} 到达时刻 ${route.arrive_minute} 超过疏散时限 ${horizon} 分钟`,
        detail: { arrive_minute: route.arrive_minute, horizon },
      });
    }

    // 逐段检查方向与链路
    let cursorRegion = route.from_region_id;
    let cursorMinute = route.depart_minute;
    for (let i = 0; i < route.steps.length; i += 1) {
      const step = route.steps[i];
      const corridor = corridorById.get(step.corridor_id);
      if (!corridor) {
        push({
          code: 'unknown_corridor',
          severity: 'hard',
          message: `路线 ${route.route_id} 引用了不存在的通道 ${step.corridor_id}`,
          corridor_id: step.corridor_id,
        });
        continue;
      }

      if (step.from_region_id !== cursorRegion) {
        push({
          code: 'path_broken_chain',
          severity: 'hard',
          message: `路线 ${route.route_id} 第 ${i + 1} 段起点 ${step.from_region_id} 与上一段终点 ${cursorRegion} 不连续`,
          detail: { stepIndex: i, expected: cursorRegion, actual: step.from_region_id },
        });
      }

      const directions = corridorDirections(corridor);
      const allowed = directions.some(
        direction => direction.from === step.from_region_id && direction.to === step.to_region_id,
      );
      if (!allowed) {
        push({
          code: 'corridor_direction_violation',
          severity: 'hard',
          message: `路线 ${route.route_id} 第 ${i + 1} 段使用通道 ${corridor.id} 的方向 ${step.from_region_id}→${step.to_region_id} 不被允许`,
          corridor_id: corridor.id,
          detail: { direction: corridor.direction },
        });
      }

      // 允许在中间区域等待（depart > arrive），但不允许倒流（depart < arrive）
      if (step.depart_minute < cursorMinute) {
        push({
          code: 'step_time_inconsistent',
          severity: 'hard',
          message: `路线 ${route.route_id} 第 ${i + 1} 段出发时刻 ${step.depart_minute} 早于到达该区域的时刻 ${cursorMinute}`,
          corridor_id: corridor.id,
          detail: { depart_minute: step.depart_minute, arrived_at: cursorMinute },
        });
      }
      const expectedArrive = step.depart_minute + traversalMinutes(corridor);
      if (step.arrive_minute !== expectedArrive) {
        push({
          code: 'step_duration_mismatch',
          severity: 'hard',
          message: `路线 ${route.route_id} 第 ${i + 1} 段耗时与通道 ${corridor.id} 的行程时间不符`,
          corridor_id: corridor.id,
          detail: { expected: expectedArrive, actual: step.arrive_minute },
        });
      }

      cursorRegion = step.to_region_id;
      cursorMinute = step.arrive_minute;
    }

    if (exit && cursorRegion !== exit.region_id) {
      push({
        code: 'path_does_not_reach_exit',
        severity: 'hard',
        message: `路线 ${route.route_id} 终点区域 ${cursorRegion} 与出口 ${exit.id} 所属区域 ${exit.region_id} 不一致`,
        exit_id: exit.id,
      });
    }
    // 到达出口的时刻不得早于到达出口所在区域的时刻（允许在出口区域排队等待）
    if (route.steps.length > 0 && route.arrive_minute < cursorMinute) {
      push({
        code: 'route_arrival_mismatch',
        severity: 'hard',
        message: `路线 ${route.route_id} 通过出口时刻 ${route.arrive_minute} 早于抵达出口所属区域的时刻 ${cursorMinute}`,
      });
    }
  }

  // --- 3. 通道状态与容量 ---------------------------------------------------
  const corridorUsage = new Map<string, Map<number, number>>();
  for (const route of plan.routes) {
    for (const step of route.steps) {
      const corridor = corridorById.get(step.corridor_id);
      if (!corridor) continue;
      const effective = network.corridors.get(corridor.id);
      if (!effective) continue;

      if (effective.status === 'closed') {
        push({
          code: 'closed_corridor_used',
          severity: 'hard',
          message: `路线 ${route.route_id} 使用了已关闭的通道 ${corridor.id}（${effective.statusReason}）`,
          corridor_id: corridor.id,
          detail: { status_reason: effective.statusReason, blocked_by: effective.blockedByIncidentId },
        });
      } else if (effective.status === 'unknown') {
        push({
          code: 'unknown_corridor_used',
          severity: 'hard',
          message: `路线 ${route.route_id} 使用了通行状态未知的通道 ${corridor.id}`,
          corridor_id: corridor.id,
        });
      }

      if (corridor.capacity_per_min === null) {
        push({
          code: 'corridor_capacity_unknown',
          severity: 'hard',
          message: `路线 ${route.route_id} 使用了通行能力未知的通道 ${corridor.id}，不得按无限容量处理`,
          corridor_id: corridor.id,
        });
        continue;
      }

      const perMinute = corridorUsage.get(corridor.id) ?? new Map<number, number>();
      perMinute.set(step.depart_minute, (perMinute.get(step.depart_minute) ?? 0) + route.persons);
      corridorUsage.set(corridor.id, perMinute);
    }
  }

  for (const [corridorId, perMinute] of corridorUsage) {
    const corridor = corridorById.get(corridorId);
    if (!corridor || corridor.capacity_per_min === null) continue;
    for (const [minute, persons] of perMinute) {
      if (persons > corridor.capacity_per_min) {
        push({
          code: 'corridor_capacity_exceeded',
          severity: 'hard',
          message: `通道 ${corridorId} 在 t=${minute} 分钟通行 ${persons} 人，超过容量 ${corridor.capacity_per_min} 人/分钟`,
          corridor_id: corridorId,
          detail: { minute, persons, capacity: corridor.capacity_per_min },
        });
      }
    }
  }

  // --- 4. 出口状态与容量 ---------------------------------------------------
  const exitUsage = new Map<string, Map<number, number>>();
  for (const route of plan.routes) {
    const exit = exitById.get(route.exit_id);
    if (!exit) continue;
    const effective = network.exits.get(exit.id);
    if (!effective) continue;

    if (effective.status === 'closed') {
      push({
        code: 'closed_exit_used',
        severity: 'hard',
        message: `路线 ${route.route_id} 使用了已关闭的出口 ${exit.id}（${effective.statusReason}）`,
        exit_id: exit.id,
        detail: { blocked_by: effective.blockedByIncidentId },
      });
    } else if (effective.status === 'unknown') {
      push({
        code: 'unknown_exit_used',
        severity: 'hard',
        message: `路线 ${route.route_id} 使用了状态未知的出口 ${exit.id}`,
        exit_id: exit.id,
      });
    }

    if (exit.capacity_per_min === null) {
      push({
        code: 'exit_capacity_unknown',
        severity: 'hard',
        message: `路线 ${route.route_id} 使用了接收能力未知的出口 ${exit.id}`,
        exit_id: exit.id,
      });
      continue;
    }

    const perMinute = exitUsage.get(exit.id) ?? new Map<number, number>();
    perMinute.set(route.arrive_minute, (perMinute.get(route.arrive_minute) ?? 0) + route.persons);
    exitUsage.set(exit.id, perMinute);
  }

  for (const [exitId, perMinute] of exitUsage) {
    const exit = exitById.get(exitId);
    if (!exit || exit.capacity_per_min === null) continue;
    let total = 0;
    for (const [minute, persons] of perMinute) {
      total += persons;
      if (persons > exit.capacity_per_min) {
        push({
          code: 'exit_capacity_exceeded',
          severity: 'hard',
          message: `出口 ${exitId} 在 t=${minute} 分钟接收 ${persons} 人，超过容量 ${exit.capacity_per_min} 人/分钟`,
          exit_id: exitId,
          detail: { minute, persons, capacity: exit.capacity_per_min },
        });
      }
    }
    const totalCapacity = exit.capacity_per_min * (horizon + 1);
    if (total > totalCapacity) {
      push({
        code: 'exit_total_capacity_exceeded',
        severity: 'hard',
        message: `出口 ${exitId} 累计接收 ${total} 人，超过 ${horizon + 1} 分钟窗口容量 ${totalCapacity} 人`,
        exit_id: exitId,
        detail: { total, total_capacity: totalCapacity },
      });
    }
  }

  // --- 5. 流量守恒（逐区域逐分钟） ----------------------------------------
  const demandByRegion = new Map<string, number>();
  for (const entry of plan.demand_by_region) {
    demandByRegion.set(entry.region_id, entry.persons);
  }

  const departures = new Map<string, Map<number, number>>();
  const arrivals = new Map<string, Map<number, number>>();
  const exitByRegion = new Map<string, Map<number, number>>();
  const bump = (map: Map<string, Map<number, number>>, region: string, minute: number, persons: number) => {
    const perMinute = map.get(region) ?? new Map<number, number>();
    perMinute.set(minute, (perMinute.get(minute) ?? 0) + persons);
    map.set(region, perMinute);
  };

  for (const route of plan.routes) {
    if (route.steps.length === 0) {
      bump(exitByRegion, route.from_region_id, route.arrive_minute, route.persons);
      continue;
    }
    bump(departures, route.from_region_id, route.steps[0].depart_minute, route.persons);
    for (let i = 0; i < route.steps.length; i += 1) {
      const step = route.steps[i];
      bump(arrivals, step.to_region_id, step.arrive_minute, route.persons);
      if (i + 1 < route.steps.length) {
        bump(departures, step.to_region_id, route.steps[i + 1].depart_minute, route.persons);
      } else {
        bump(exitByRegion, step.to_region_id, route.arrive_minute, route.persons);
      }
    }
  }

  for (const regionId of new Set([...demandByRegion.keys(), ...departures.keys(), ...arrivals.keys(), ...exitByRegion.keys()])) {
    let occupancy = demandByRegion.get(regionId) ?? 0;
    for (let minute = 0; minute <= horizon; minute += 1) {
      const arrived = arrivals.get(regionId)?.get(minute) ?? 0;
      const available = occupancy + arrived;
      const leaving = (departures.get(regionId)?.get(minute) ?? 0) + (exitByRegion.get(regionId)?.get(minute) ?? 0);
      if (leaving > available) {
        push({
          code: 'flow_conservation_violation',
          severity: 'hard',
          message: `区域 ${regionId} 在 t=${minute} 分钟有 ${leaving} 人离开，但在场仅 ${available} 人`,
          region_id: regionId,
          detail: { minute, leaving, available },
        });
        break;
      }
      occupancy = available - leaving;
    }
  }

  // --- 6. 需求完整性 -------------------------------------------------------
  const routedPersons = plan.routes.reduce((sum, route) => sum + route.persons, 0);
  const totalDemand = [...demandByRegion.values()].reduce((sum, value) => sum + value, 0);

  if (plan.unresolved_persons > 0 || plan.unresolved.length > 0) {
    push({
      code: 'unresolved_demand',
      severity: 'hard',
      message: `仍有 ${plan.unresolved_persons} 人未被分配疏散路线：${plan.unresolved
        .map(item => `${item.region_id}×${item.persons}（${item.reason}）`)
        .join('；')}`,
      detail: {
        unresolved_persons: plan.unresolved_persons,
        regions: plan.unresolved,
      },
    });
  }

  if (routedPersons !== plan.evacuated_persons) {
    push({
      code: 'totals_inconsistent',
      severity: 'hard',
      message: `方案自报已疏散 ${plan.evacuated_persons} 人，但路线合计 ${routedPersons} 人`,
      detail: { reported: plan.evacuated_persons, actual: routedPersons },
    });
  }
  if (plan.evacuated_persons + plan.unresolved_persons !== plan.total_persons) {
    push({
      code: 'totals_inconsistent',
      severity: 'hard',
      message: `已疏散 ${plan.evacuated_persons} + 未解决 ${plan.unresolved_persons} ≠ 总人数 ${plan.total_persons}`,
    });
  }
  if (totalDemand !== plan.total_persons) {
    push({
      code: 'totals_inconsistent',
      severity: 'hard',
      message: `按区域需求合计 ${totalDemand} 人与方案总人数 ${plan.total_persons} 不一致`,
    });
  }

  // 区域需求必须与当前观测一致
  const allRegions = new Set<string>([...demandByRegion.keys(), ...input.latestObservations.keys()]);
  for (const regionId of allRegions) {
    if (!regionIds.has(regionId)) continue;
    const observed = input.latestObservations.get(regionId)?.estimated_count ?? 0;
    const planned = demandByRegion.get(regionId) ?? 0;
    if (observed !== planned) {
      push({
        code: 'demand_mismatch',
        severity: 'hard',
        message: `区域 ${regionId} 规划需求 ${planned} 人与当前观测 ${observed} 人不一致`,
        region_id: regionId,
        detail: { planned, observed },
      });
    }
  }

  // --- 7. 观测可信度 -------------------------------------------------------
  for (const regionId of demandByRegion.keys()) {
    const observation = input.latestObservations.get(regionId);
    if (!observation) {
      push({
        code: 'observation_missing',
        severity: 'hard',
        message: `区域 ${regionId} 需要疏散但没有任何有效观测`,
        region_id: regionId,
      });
      continue;
    }
    const assessment = assessObservation(observation, config, now);
    if (assessment.invalid) {
      push({
        code: 'observation_invalid',
        severity: 'hard',
        message: `区域 ${regionId} 的观测无效：${observation.invalid_reason ?? '未说明原因'}`,
        region_id: regionId,
      });
    }
    if (assessment.stale) {
      push({
        code: 'observation_stale',
        severity: 'hard',
        message: `区域 ${regionId} 的观测已过期 ${Math.round(assessment.ageSeconds)}s，超过 ${config.max_observation_age_seconds}s`,
        region_id: regionId,
        detail: { age_seconds: Math.round(assessment.ageSeconds) },
      });
    }
    if (assessment.lowConfidence) {
      push({
        code: 'observation_low_confidence',
        severity: 'hard',
        message: `区域 ${regionId} 的观测置信度 ${observation.confidence} 低于 ${config.min_confidence}`,
        region_id: regionId,
        detail: { confidence: observation.confidence },
      });
    }
  }

  const hasHard = violations.some(violation => violation.severity === 'hard');
  return {
    valid: !hasHard,
    checked_at: now.toISOString(),
    plan_id: plan.plan_id,
    violations,
    checks_run: [...CHECK_NAMES],
    versions: {
      scenario_version: scenario.version,
      constraint_version: input.constraintVersion,
      observation_version: input.observationVersion,
    },
  };
}
