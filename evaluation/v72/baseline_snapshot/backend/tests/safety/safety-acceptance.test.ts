/**
 * SkyGuard 安全闭环验收测试（T01–T13、T15）。
 *
 * 每个用例对应需求文档「10.1 安全场景测试」中的一条，断言针对真实计算结果的
 * 状态、方案与校验违规码，不使用任何固定返回值桩。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planEvacuation } from '../../src/services/safety/planning/evacuation-planner';
import { resolveEffectiveNetwork } from '../../src/services/safety/network';
import { validateSafetyPlan } from '../../src/services/safety/validator';
import { AuditLog } from '../../src/services/safety/audit';
import { SafetyDecisionService } from '../../src/services/safety/decision-service';
import type { EvacuationPlan, Incident, SafetyScenario } from '../../src/services/safety/types';
import {
  BASELINE_COUNTS,
  OPERATOR,
  buildObservationFor,
  loadScenario,
  makeService,
  seedObservations,
} from './fixtures';

function nowIso(): string {
  return new Date().toISOString();
}

function confirmedIncident(
  id: string,
  affected: { region_ids?: string[]; corridor_ids?: string[]; exit_ids?: string[] },
): Incident {
  return {
    id,
    type: 'fire',
    description: '测试用已确认事件',
    status: 'confirmed',
    severity: 'critical',
    affected: {
      region_ids: affected.region_ids ?? [],
      corridor_ids: affected.corridor_ids ?? [],
      exit_ids: affected.exit_ids ?? [],
    },
    source: 'operator',
    reported_by: 'test',
    reported_at: nowIso(),
    confirmed_by: 'test',
    confirmed_at: nowIso(),
  };
}

function emptyPlan(overrides: Partial<EvacuationPlan>): EvacuationPlan {
  return {
    plan_id: 'PLAN-CANDIDATE',
    created_at: nowIso(),
    scenario_version: '1.0.0',
    constraint_version: 0,
    observation_version: 0,
    horizon_minutes: 8,
    status: 'feasible',
    routes: [],
    unresolved: [],
    exit_totals: [],
    corridor_totals: [],
    demand_by_region: [],
    total_persons: 0,
    evacuated_persons: 0,
    unresolved_persons: 0,
    planner: { algorithm: 'test', model: 'test', notes: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T01 正常场景
// ---------------------------------------------------------------------------
test('T01 正常场景：生成可行方案并通过独立校验，进入 NORMAL', () => {
  const { service } = makeService();
  seedObservations(service);
  const result = service.recompute(OPERATOR, 'test');

  assert.equal(result.snapshot.state, 'NORMAL');
  assert.equal(result.snapshot.publishable, true);
  assert.ok(result.plan, '应产出方案');
  assert.equal(result.plan!.status, 'feasible');
  assert.equal(result.plan!.evacuated_persons, result.plan!.total_persons);
  assert.equal(result.validation!.valid, true);
  assert.deepEqual(result.validation!.violations, []);
  assert.equal(result.plan!.total_persons, 1000);
  assert.equal(service.getPlan()?.plan_id, result.plan!.plan_id, '通过校验的方案应被发布');
});

// ---------------------------------------------------------------------------
// T02 密度上升
// ---------------------------------------------------------------------------
test('T02 区域密度快速上升触发风险评估', () => {
  const { service } = makeService();
  const earlier = new Date(Date.now() - 120_000);
  service.ingestObservation(
    { regionId: 'R_MAIN', count: 240, confidence: 0.9, source: 'simulation', provider: 't', modelVersion: 't', observedAt: earlier },
    OPERATOR,
  );
  service.ingestObservation(
    { regionId: 'R_MAIN', count: 900, confidence: 0.9, source: 'simulation', provider: 't', modelVersion: 't', observedAt: new Date() },
    OPERATOR,
  );

  const risk = service.getStatus().risks.find(item => item.regionId === 'R_MAIN');
  assert.ok(risk);
  assert.ok(
    risk!.signals.some(signal => signal.code === 'density_rising_fast'),
    `应记录密度上升信号，实际：${risk!.signals.map(s => s.code).join(',')}`,
  );
  assert.ok(risk!.level === 'high' || risk!.level === 'critical', `风险等级应提升，实际 ${risk!.level}`);
  assert.equal(risk!.density, 1.5);
});

// ---------------------------------------------------------------------------
// T03 / T04 出口关闭与容量不足
// ---------------------------------------------------------------------------
test('T03 B 出口关闭：自动重规划并通过校验，进入 REROUTE', () => {
  const { service } = makeService();
  seedObservations(service);
  const normal = service.recompute(OPERATOR, 'test');
  assert.equal(normal.snapshot.state, 'NORMAL');

  const incident = service.createIncident({
    type: 'fire',
    description: '东侧主出口火情',
    severity: 'critical',
    affected: { exit_ids: ['E_B'] },
    source: 'operator',
    actor: OPERATOR.username,
  });
  service.confirmIncident(incident.id, OPERATOR);
  const reroute = service.recompute(OPERATOR, 'test');

  assert.equal(reroute.snapshot.state, 'REROUTE');
  assert.equal(reroute.validation!.valid, true);
  assert.equal(reroute.plan!.status, 'feasible');
  assert.ok(
    !reroute.plan!.routes.some(route => route.exit_id === 'E_B'),
    '不得再使用已关闭的 E_B',
  );
  assert.ok(reroute.plan!.exit_totals.some(item => item.exit_id === 'E_A'));
  assert.notEqual(reroute.plan!.plan_id, normal.plan!.plan_id);
});

test('T04 B 出口关闭且剩余容量不足：进入 REJECT 并给出未解决需求', () => {
  const { service } = makeService();
  seedObservations(service, { R_MAIN: 620, R_ATRIUM: 200, R_EAST: 620, R_NORTH: 150, R_SOUTH: 120, R_WEST: 90 });
  const incident = service.createIncident({
    type: 'fire',
    description: '东侧主出口长期关闭',
    severity: 'critical',
    affected: { exit_ids: ['E_B'] },
    source: 'operator',
    actor: OPERATOR.username,
  });
  service.confirmIncident(incident.id, OPERATOR);
  const result = service.recompute(OPERATOR, 'test');

  assert.equal(result.snapshot.state, 'REJECT');
  assert.equal(result.snapshot.publishable, false);
  assert.equal(service.getPlan(), undefined, 'REJECT 状态下不得发布方案');
  assert.ok(result.plan, '仍应保留候选方案用于展示');
  assert.equal(result.plan!.status, 'partial');
  assert.ok(result.plan!.unresolved_persons > 0);
  assert.ok(result.validation!.violations.some(violation => violation.code === 'unresolved_demand'));
});

// ---------------------------------------------------------------------------
// T05 / T06 / T10 / T12 独立校验器对抗性用例
// ---------------------------------------------------------------------------
test('T05 候选路线使用已关闭通道必须被拒绝', () => {
  const scenario = loadScenario();
  const network = resolveEffectiveNetwork(scenario, [confirmedIncident('INC-C05', { corridor_ids: ['C05'] })]);

  const plan = emptyPlan({
    scenario_version: scenario.version,
    constraint_version: 1,
    observation_version: 1,
    routes: [
      {
        route_id: 'RT-1',
        from_region_id: 'R_SOUTH',
        exit_id: 'E_A',
        persons: 50,
        depart_minute: 0,
        arrive_minute: 1,
        steps: [
          { corridor_id: 'C05', from_region_id: 'R_SOUTH', to_region_id: 'R_MAIN', depart_minute: 0, arrive_minute: 1, persons: 50 },
        ],
      },
    ],
    exit_totals: [{ exit_id: 'E_A', persons: 50 }],
    corridor_totals: [{ corridor_id: 'C05', persons: 50 }],
    demand_by_region: [{ region_id: 'R_SOUTH', persons: 50 }],
    total_persons: 50,
    evacuated_persons: 50,
  });

  const validation = validateSafetyPlan({
    plan,
    scenario,
    network,
    latestObservations: new Map([['R_SOUTH', buildObservationFor(scenario, 'R_SOUTH', 50)]]),
    config: scenario.config,
    constraintVersion: 1,
    observationVersion: 1,
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.violations.some(violation => violation.code === 'closed_corridor_used'));
});

test('T06 容量未知的通道不得当作无限容量', () => {
  const scenario = loadScenario();
  const network = resolveEffectiveNetwork(scenario, []);

  // 规划器必须排除 C11（容量/状态均未知）
  const planned = planEvacuation({
    scenario,
    network,
    demandByRegion: new Map([['R_NORTH', 40]]),
    scenarioVersion: scenario.version,
    constraintVersion: 0,
    observationVersion: 0,
  });
  assert.ok(!planned.plan.routes.some(route => route.steps.some(step => step.corridor_id === 'C11')));
  assert.ok(planned.exclusions.some(entry => entry.id === 'C11'));

  const plan = emptyPlan({
    scenario_version: scenario.version,
    routes: [
      {
        route_id: 'RT-1',
        from_region_id: 'R_NORTH',
        exit_id: 'E_D',
        persons: 40,
        depart_minute: 0,
        arrive_minute: 2,
        steps: [
          { corridor_id: 'C11', from_region_id: 'R_NORTH', to_region_id: 'R_WEST', depart_minute: 0, arrive_minute: 2, persons: 40 },
        ],
      },
    ],
    demand_by_region: [{ region_id: 'R_NORTH', persons: 40 }],
    total_persons: 40,
    evacuated_persons: 40,
    exit_totals: [{ exit_id: 'E_D', persons: 40 }],
  });

  const validation = validateSafetyPlan({
    plan,
    scenario,
    network,
    latestObservations: new Map([['R_NORTH', buildObservationFor(scenario, 'R_NORTH', 40)]]),
    config: scenario.config,
    constraintVersion: 0,
    observationVersion: 0,
  });

  assert.equal(validation.valid, false);
  const codes = validation.violations.map(violation => violation.code);
  assert.ok(codes.includes('corridor_capacity_unknown'), `实际违规：${codes.join(',')}`);
  assert.ok(codes.includes('unknown_corridor_used'), `实际违规：${codes.join(',')}`);
});

test('T10 出口接收流量超过容量必须被拒绝', () => {
  const scenario = loadScenario();
  const network = resolveEffectiveNetwork(scenario, []);
  const plan = emptyPlan({
    scenario_version: scenario.version,
    routes: [
      {
        route_id: 'RT-1',
        from_region_id: 'R_MAIN',
        exit_id: 'E_A',
        persons: 200,
        depart_minute: 0,
        arrive_minute: 0,
        steps: [],
      },
    ],
    demand_by_region: [{ region_id: 'R_MAIN', persons: 200 }],
    total_persons: 200,
    evacuated_persons: 200,
    exit_totals: [{ exit_id: 'E_A', persons: 200 }],
  });

  const validation = validateSafetyPlan({
    plan,
    scenario,
    network,
    latestObservations: new Map([['R_MAIN', buildObservationFor(scenario, 'R_MAIN', 200)]]),
    config: scenario.config,
    constraintVersion: 0,
    observationVersion: 0,
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.violations.some(violation => violation.code === 'exit_capacity_exceeded'));
});

test('T12 LLM 生成的违规方案被独立校验器拒绝且不会成为已发布方案', () => {
  const { service } = makeService();
  seedObservations(service);
  service.recompute(OPERATOR, 'test');
  const published = service.getPlan();
  assert.ok(published);

  // 模拟"大模型返回的路线"：把 R_MAIN 的人全部写到一个不存在连通关系的出口
  const fabricated = emptyPlan({
    plan_id: 'PLAN-LLM-FABRICATED',
    scenario_version: service.getScenario().version,
    constraint_version: service.getVersions().constraint,
    observation_version: service.getVersions().observation,
    routes: [
      {
        route_id: 'RT-LLM',
        from_region_id: 'R_MAIN',
        exit_id: 'E_B',
        persons: 380,
        depart_minute: 0,
        arrive_minute: 0,
        steps: [],
      },
    ],
    demand_by_region: [{ region_id: 'R_MAIN', persons: 380 }],
    total_persons: 380,
    evacuated_persons: 380,
    exit_totals: [{ exit_id: 'E_B', persons: 380 }],
  });

  const validation = service.validateCandidate(fabricated, OPERATOR);
  assert.equal(validation.valid, false);
  const codes = validation.violations.map(violation => violation.code);
  assert.ok(codes.includes('path_does_not_reach_exit'), `实际违规：${codes.join(',')}`);
  assert.equal(
    service.getPlan()?.plan_id,
    published!.plan_id,
    '校验失败的候选方案不得替换已发布方案',
  );
});

// ---------------------------------------------------------------------------
// T07 / T08 / T13 感知降级
// ---------------------------------------------------------------------------
test('T07 观测过期：进入 DEGRADED 且不发布新路线', () => {
  const { service } = makeService();
  const stale = new Date(Date.now() - 10 * 60 * 1000);
  seedObservations(service, BASELINE_COUNTS, { observedAt: stale });
  const result = service.recompute(OPERATOR, 'test');

  assert.equal(result.snapshot.state, 'DEGRADED');
  assert.equal(result.snapshot.publishable, false);
  assert.equal(result.snapshot.validated_route_display_allowed, false);
  assert.equal(service.getPlan(), undefined);
  assert.ok(result.snapshot.reasons.some(reason => reason.code === 'untrusted_observation'));
});

test('T08 观测置信度不足：按规则降级', () => {
  const { service } = makeService();
  seedObservations(service, BASELINE_COUNTS, { confidence: 0.2 });
  const result = service.recompute(OPERATOR, 'test');

  assert.equal(result.snapshot.state, 'DEGRADED');
  assert.equal(service.getPlan(), undefined);
  const joined = result.snapshot.reasons.map(reason => reason.message).join(' | ');
  assert.match(joined, /low_confidence/);
});

test('T13 推理服务异常：记录故障并执行降级策略', () => {
  const { service } = makeService();
  seedObservations(service);
  service.recompute(OPERATOR, 'test');
  assert.equal(service.getStatus().state.state, 'NORMAL');

  service.setInferenceHealth(false, '感知推理进程崩溃');
  const status = service.getStatus();
  assert.equal(status.state.state, 'DEGRADED');
  assert.equal(status.state.publishable, false);
  assert.equal(status.state.validated_route_display_allowed, false);

  const healthEntries = service.getAuditLog().list(50).filter(entry => entry.action === 'inference.health');
  assert.equal(healthEntries.length, 1);
  assert.equal(healthEntries[0].result, 'failure');
  assert.match(healthEntries[0].summary, /感知推理进程崩溃/);
});

// ---------------------------------------------------------------------------
// T09 路网断开
// ---------------------------------------------------------------------------
test('T09 路网断开且无可行方案：不得生成虚假的完整疏散方案', () => {
  const { service } = makeService();
  seedObservations(service);
  const incident = service.createIncident({
    type: 'corridor_closure',
    description: '东侧展区所有通道封闭',
    severity: 'critical',
    affected: { corridor_ids: ['C02', 'C08', 'C09'], exit_ids: ['E_B'] },
    source: 'operator',
    actor: OPERATOR.username,
  });
  service.confirmIncident(incident.id, OPERATOR);
  const result = service.recompute(OPERATOR, 'test');

  assert.equal(result.snapshot.state, 'REJECT');
  assert.equal(service.getPlan(), undefined);
  assert.ok(result.plan);
  assert.notEqual(result.plan!.status, 'feasible', '不得声称存在完整可行方案');
  const unresolvedEast = result.plan!.unresolved.find(item => item.region_id === 'R_EAST');
  assert.ok(unresolvedEast, 'R_EAST 的未解决需求必须被明确记录');
  assert.equal(unresolvedEast!.persons, 220);
  assert.match(unresolvedEast!.reason, /无可达且可用的出口/);
});

// ---------------------------------------------------------------------------
// T11 规划期间版本漂移
// ---------------------------------------------------------------------------
test('T11 规划过程中约束版本变化：旧规划结果不得直接发布', () => {
  const scenario: SafetyScenario = loadScenario();
  const auditDir = makeTempDir();
  let triggered = false;
  let service!: SafetyDecisionService;

  service = new SafetyDecisionService({
    scenario,
    auditLog: new AuditLog(auditDir),
    planBuilder: input => {
      const output = planEvacuation(input);
      if (!triggered) {
        triggered = true;
        const incident = service.createIncident({
          type: 'fire',
          description: '规划期间确认的火情',
          severity: 'critical',
          affected: { exit_ids: ['E_B'] },
          source: 'operator',
          actor: OPERATOR.username,
        });
        service.confirmIncident(incident.id, OPERATOR);
      }
      return output;
    },
  });

  seedObservations(service);
  const result = service.recompute(OPERATOR, 'test');

  assert.equal(triggered, true);
  assert.equal(result.snapshot.state, 'REROUTE');
  assert.equal(service.getPlan(), undefined, '版本漂移的方案不得发布');
  assert.ok(service.getCandidatePlan(), '应保留为候选方案');
  assert.ok(
    service.getValidation()!.violations.some(violation => violation.code === 'version_changed_during_planning'),
  );
  assert.equal(result.snapshot.publishable, false);
});

// ---------------------------------------------------------------------------
// T15 事件解除
// ---------------------------------------------------------------------------
test('T15 事件解除后旧路线不得自动恢复，必须重新规划并通过校验', () => {
  const { service } = makeService();
  seedObservations(service);
  service.recompute(OPERATOR, 'test');

  const incident = service.createIncident({
    type: 'fire',
    description: '东侧主出口火情',
    severity: 'critical',
    affected: { exit_ids: ['E_B'] },
    source: 'operator',
    actor: OPERATOR.username,
  });
  service.confirmIncident(incident.id, OPERATOR);
  const detour = service.recompute(OPERATOR, 'test');
  assert.equal(detour.snapshot.state, 'REROUTE');

  // 解除事件但不重新规划：原方案必须立即失效
  service.resolveIncident(incident.id, OPERATOR, '火情已扑灭');
  const afterResolve = service.getStatus();
  assert.equal(afterResolve.state.state, 'REROUTE');
  assert.equal(afterResolve.state.publishable, false, '解除事件不得让旧方案自动恢复为可发布');
  assert.ok(afterResolve.state.reasons.some(reason => reason.code === 'plan_invalidated'));

  // 重新规划后才恢复
  const replanned = service.recompute(OPERATOR, 'test');
  assert.equal(replanned.snapshot.state, 'NORMAL');
  assert.equal(replanned.validation!.valid, true);
  assert.notEqual(replanned.plan!.plan_id, detour.plan!.plan_id);
  assert.ok(replanned.plan!.exit_totals.some(item => item.exit_id === 'E_B'), '重规划应重新使用已恢复的出口');
});

function makeTempDir(): string {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-audit-'));
}
