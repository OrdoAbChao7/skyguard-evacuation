/**
 * 安全决策编排服务。
 *
 * 把所有安全域组件串成一条可审计的闭环：
 *   观测 → 风险评估 → 容量约束规划 → 独立校验 → 四态状态机 → 发布/拒绝
 *
 * 关键不变量：
 *  1. 未通过独立校验的方案永远不会被标记为"已验证安全方案"；
 *  2. 感知不可信时不基于该数据生成新的安全路线；
 *  3. 约束版本变化会使既有方案立即失效；
 *  4. 所有写操作都会落到审计日志。
 */
import { randomUUID } from 'node:crypto';
import type {
  DensityObservation,
  EvacuationPlan,
  Incident,
  ObservationSource,
  SafetyScenario,
  SafetyState,
  SafetyValidationResult,
} from './types';
import { assessObservation, buildObservation, ObservationStore, type ObservationAssessment } from './observations';
import { assessRegionRisk, riskSummary, type RegionRisk } from './risk';
import { resolveEffectiveNetwork, type EffectiveNetwork } from './network';
import { IncidentStore, IncidentTransitionError, type CreateIncidentInput } from './incidents';
import { AuditLog, type AuditActor, type DecisionTrace } from './audit';
import { decideSafetyState, type SafetyStateSnapshot } from './state-machine';
import { validateSafetyPlan } from './validator';
import {
  computeEgressReachability,
  planEvacuation,
  type PlanInput,
  type PlanOutput,
} from './planning/evacuation-planner';
import { SimulationCrowdProvider } from './providers/simulation';

export interface SafetyDecisionOptions {
  scenario: SafetyScenario;
  auditLog?: AuditLog;
  observationStore?: ObservationStore;
  incidentStore?: IncidentStore;
  simulationProvider?: SimulationCrowdProvider;
  /** 测试/诊断注入点：替换规划器实现。 */
  planBuilder?: (input: PlanInput) => PlanOutput;
  now?: () => Date;
}

export interface RecomputeResult {
  trace: DecisionTrace;
  plan?: EvacuationPlan;
  validation?: SafetyValidationResult;
  snapshot: SafetyStateSnapshot;
  exclusions: Array<{ kind: string; id: string; reason: string }>;
}

export interface IngestObservationInput {
  regionId: string;
  count: number;
  confidence: number;
  source: ObservationSource;
  provider: string;
  modelVersion: string;
  calibrationVersion?: string;
  observedAt?: Date;
  valid?: boolean;
  invalidReason?: string;
  evidence?: Record<string, unknown>;
}

export interface SafetyStatus {
  state: SafetyStateSnapshot;
  state_entered_at: string;
  versions: { scenario: string; constraint: number; observation: number };
  plan: EvacuationPlan | null;
  candidate_plan: EvacuationPlan | null;
  validation: SafetyValidationResult | null;
  last_valid_plan: { plan_id: string; created_at: string; state: SafetyState } | null;
  risks: RegionRisk[];
  risk_summary: { highest: string; counts: Record<string, number> };
  incidents: Incident[];
  observations: DensityObservation[];
  regions: SafetyScenario['regions'];
  corridors: Array<{
    id: string;
    name: string;
    from_region_id: string;
    to_region_id: string;
    direction: string;
    base_status: string;
    effective_status: string;
    capacity_per_min: number | null;
    capacity_provenance: string;
    traversal_seconds: number;
    usable: boolean;
    status_reason: string;
    blocked_by_incident_id?: string;
  }>;
  exits: Array<{
    id: string;
    name: string;
    region_id: string;
    base_status: string;
    effective_status: string;
    capacity_per_min: number | null;
    capacity_provenance: string;
    usable: boolean;
    status_reason: string;
    blocked_by_incident_id?: string;
  }>;
  scenario: { id: string; name: string; version: string; notice: string; horizon_minutes: number };
  inference_health: { healthy: boolean; reason?: string };
  last_valid_observation_at: string | null;
}

export class SafetyDecisionService {
  private scenario: SafetyScenario;
  private readonly audit: AuditLog;
  private readonly observations: ObservationStore;
  private readonly incidents: IncidentStore;
  readonly simulationProvider: SimulationCrowdProvider;
  private readonly planBuilder: (input: PlanInput) => PlanOutput;
  private readonly now: () => Date;

  private constraintVersion = 0;
  private publishedPlan?: EvacuationPlan;
  private candidatePlan?: EvacuationPlan;
  private lastValidation?: SafetyValidationResult;
  private lastValidPlanRef?: { plan_id: string; created_at: string; state: SafetyState };
  private stateSnapshot?: SafetyStateSnapshot;
  private stateEnteredAt = new Date().toISOString();
  private inferenceHealth: { healthy: boolean; reason?: string } = { healthy: true };
  private lastPlanExclusions: Array<{ kind: string; id: string; reason: string }> = [];

  constructor(options: SafetyDecisionOptions) {
    this.scenario = options.scenario;
    this.audit = options.auditLog ?? new AuditLog();
    this.observations = options.observationStore ?? new ObservationStore();
    this.incidents = options.incidentStore ?? new IncidentStore();
    this.simulationProvider = options.simulationProvider ?? new SimulationCrowdProvider();
    this.planBuilder = options.planBuilder ?? planEvacuation;
    this.now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  getScenario(): SafetyScenario {
    return this.scenario;
  }

  getAuditLog(): AuditLog {
    return this.audit;
  }

  getObservationStore(): ObservationStore {
    return this.observations;
  }

  getIncidentStore(): IncidentStore {
    return this.incidents;
  }

  getVersions(): { scenario: string; constraint: number; observation: number } {
    return {
      scenario: this.scenario.version,
      constraint: this.constraintVersion,
      observation: this.observations.getVersion(),
    };
  }

  getPlan(): EvacuationPlan | undefined {
    return this.publishedPlan;
  }

  getCandidatePlan(): EvacuationPlan | undefined {
    return this.candidatePlan;
  }

  getValidation(): SafetyValidationResult | undefined {
    return this.lastValidation;
  }

  getExclusions(): Array<{ kind: string; id: string; reason: string }> {
    return this.lastPlanExclusions;
  }

  // -------------------------------------------------------------------------
  // 评估
  // -------------------------------------------------------------------------

  private latestObservationMap(): Map<string, DensityObservation> {
    const map = new Map<string, DensityObservation>();
    for (const region of this.scenario.regions) {
      const latest = this.observations.latest(region.id);
      if (latest) map.set(region.id, latest);
    }
    return map;
  }

  private assessAll(network: EffectiveNetwork): {
    assessments: Map<string, ObservationAssessment>;
    untrustedRegions: Array<{ regionId: string; reasons: string[] }>;
    hasObservations: boolean;
    lastValidObservationAt: string | null;
  } {
    const now = this.now();
    const assessments = new Map<string, ObservationAssessment>();
    const untrustedRegions: Array<{ regionId: string; reasons: string[] }> = [];
    let hasObservations = false;
    let lastValidObservationAt: string | null = null;

    for (const region of this.scenario.regions) {
      if (!region.enabled) continue;
      const latest = this.observations.latest(region.id);
      if (!latest) {
        untrustedRegions.push({ regionId: region.id, reasons: ['no_observation'] });
        continue;
      }
      hasObservations = true;
      const assessment = assessObservation(latest, this.scenario.config, now);
      assessments.set(region.id, assessment);

      const reasons = [...assessment.untrustedReasons];
      if (network.sensorFailedRegionIds.has(region.id)) reasons.push('sensor_failure_incident');
      if (reasons.length > 0) untrustedRegions.push({ regionId: region.id, reasons });

      if (assessment.trusted && !network.sensorFailedRegionIds.has(region.id)) {
        if (!lastValidObservationAt || latest.observed_at > lastValidObservationAt) {
          lastValidObservationAt = latest.observed_at;
        }
      }
    }

    return { assessments, untrustedRegions, hasObservations, lastValidObservationAt };
  }

  private assessRisks(network: EffectiveNetwork, assessments: Map<string, ObservationAssessment>): RegionRisk[] {
    const reachable = computeEgressReachability(this.scenario, network);
    const confirmed = this.incidents.confirmed();
    const now = this.now();

    return this.scenario.regions
      .filter(region => region.enabled)
      .map(region => {
        const assessment = assessments.get(region.id);
        const previous = this.previousObservation(region.id);
        return assessRegionRisk({
          region,
          config: this.scenario.config,
          assessment,
          previousObservation: previous,
          hasUsableEgress: reachable.has(region.id),
          usableExitCount: this.scenario.exits.filter(
            exit => exit.region_id === region.id && network.exits.get(exit.id)?.usable,
          ).length,
          confirmedIncidents: confirmed,
          now,
        });
      });
  }

  private previousObservation(regionId: string): DensityObservation | undefined {
    const latest = this.observations.latest(regionId);
    if (!latest) return undefined;
    const windowStart = new Date(
      new Date(latest.observed_at).getTime() - this.scenario.config.trend_window_seconds * 1000,
    );
    const window = this.observations
      .window(regionId, windowStart, new Date(latest.observed_at))
      .filter(obs => obs.id !== latest.id);
    return window.length > 0 ? window[window.length - 1] : undefined;
  }

  private currentState(): SafetyStateSnapshot {
    const network = resolveEffectiveNetwork(this.scenario, this.incidents.list());
    const { untrustedRegions, hasObservations, lastValidObservationAt } = this.assessAll(network);
    const comparisons = this.planVersionComparison();
    const activeConstraintIncidents = this.incidents.confirmed().filter(
      incident => incident.type !== 'sensor_failure',
    );

    const snapshot = decideSafetyState({
      hasObservations,
      inferenceHealthy: this.inferenceHealth.healthy,
      inferenceFailureReason: this.inferenceHealth.reason,
      untrustedRegions,
      activeIncidentIds: activeConstraintIncidents.map(incident => incident.id),
      plan: this.publishedPlan ?? this.candidatePlan,
      validation: this.lastValidation,
      planInvalidated: comparisons.invalidated,
      lastValidObservationAt,
      now: this.now(),
    });

    if (!this.stateSnapshot || this.stateSnapshot.state !== snapshot.state) {
      this.stateEnteredAt = snapshot.decided_at;
    }
    this.stateSnapshot = snapshot;
    return snapshot;
  }

  private planVersionComparison(): { invalidated: boolean; reasons: string[] } {
    const plan = this.publishedPlan ?? this.candidatePlan;
    if (!plan) return { invalidated: false, reasons: [] };
    const reasons: string[] = [];
    if (plan.constraint_version !== this.constraintVersion) reasons.push('constraint_version_changed');
    if (plan.observation_version !== this.observations.getVersion()) reasons.push('observation_version_changed');
    if (plan.scenario_version !== this.scenario.version) reasons.push('scenario_version_changed');
    return { invalidated: reasons.length > 0, reasons };
  }

  // -------------------------------------------------------------------------
  // 观测写入
  // -------------------------------------------------------------------------

  ingestObservation(input: IngestObservationInput, actor: AuditActor): DensityObservation {
    const region = this.scenario.regions.find(item => item.id === input.regionId);
    if (!region) throw new Error(`区域不存在：${input.regionId}`);

    const observation = buildObservation({
      region,
      count: input.count,
      confidence: input.confidence,
      source: input.source,
      provider: input.provider,
      modelVersion: input.modelVersion,
      calibrationVersion: input.calibrationVersion,
      observedAt: input.observedAt ?? this.now(),
      receivedAt: this.now(),
      valid: input.valid,
      invalidReason: input.invalidReason,
      evidence: input.evidence,
    });

    this.observations.ingest(observation);
    this.audit.record({
      actor: actor.username,
      role: actor.role,
      action: 'observation.ingest',
      entity_type: 'region',
      entity_id: region.id,
      summary: `写入区域 ${region.name} 观测：${observation.estimated_count} 人（${observation.source}）`,
      result: 'success',
      after: {
        observation_id: observation.id,
        count: observation.estimated_count,
        density: observation.estimated_density,
        confidence: observation.confidence,
        source: observation.source,
        valid: observation.valid,
      },
    });
    return observation;
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  createIncident(input: CreateIncidentInput): Incident {
    const incident = this.incidents.create(input, this.now());
    this.audit.record({
      actor: input.actor,
      role: 'operator',
      action: 'incident.create',
      entity_type: 'incident',
      entity_id: incident.id,
      incident_id: incident.id,
      summary: `登记事件：${incident.type} — ${incident.description}`,
      result: 'success',
      after: { status: incident.status, affected: incident.affected, severity: incident.severity },
    });
    return incident;
  }

  confirmIncident(id: string, actor: AuditActor): Incident {
    const before = this.incidents.get(id);
    try {
      const confirmed = this.incidents.confirm(id, actor.username, this.now());
      this.constraintVersion += 1;
      this.audit.record({
        actor: actor.username,
        role: actor.role,
        action: 'incident.confirm',
        entity_type: 'incident',
        entity_id: confirmed.id,
        incident_id: confirmed.id,
        summary: `确认事件 ${confirmed.id}，约束版本升至 ${this.constraintVersion}`,
        result: 'success',
        before: before ? { status: before.status } : undefined,
        after: { status: confirmed.status, constraint_version: this.constraintVersion },
      });
      return confirmed;
    } catch (error) {
      this.audit.record({
        actor: actor.username,
        role: actor.role,
        action: 'incident.confirm',
        entity_type: 'incident',
        entity_id: id,
        incident_id: id,
        summary: `确认事件失败：${(error as Error).message}`,
        result: 'rejected',
        reason: (error as Error).message,
      });
      throw error;
    }
  }

  resolveIncident(id: string, actor: AuditActor, note?: string): Incident {
    const before = this.incidents.get(id);
    try {
      const resolved = this.incidents.resolve(id, actor.username, note, this.now());
      this.constraintVersion += 1;
      this.audit.record({
        actor: actor.username,
        role: actor.role,
        action: 'incident.resolve',
        entity_type: 'incident',
        entity_id: resolved.id,
        incident_id: resolved.id,
        summary: `解除事件 ${resolved.id}，约束版本升至 ${this.constraintVersion}；既有方案必须重新校验`,
        result: 'success',
        before: before ? { status: before.status } : undefined,
        after: { status: resolved.status, constraint_version: this.constraintVersion },
      });
      return resolved;
    } catch (error) {
      this.audit.record({
        actor: actor.username,
        role: actor.role,
        action: 'incident.resolve',
        entity_type: 'incident',
        entity_id: id,
        incident_id: id,
        summary: `解除事件失败：${(error as Error).message}`,
        result: 'rejected',
        reason: (error as Error).message,
      });
      throw error;
    }
  }

  dismissIncident(id: string, actor: AuditActor, note?: string): Incident {
    const dismissed = this.incidents.dismiss(id, actor.username, note, this.now());
    this.audit.record({
      actor: actor.username,
      role: actor.role,
      action: 'incident.dismiss',
      entity_type: 'incident',
      entity_id: dismissed.id,
      incident_id: dismissed.id,
      summary: `驳回误报事件 ${dismissed.id}`,
      result: 'success',
      after: { status: dismissed.status },
    });
    return dismissed;
  }

  // -------------------------------------------------------------------------
  // 重规划
  // -------------------------------------------------------------------------

  recompute(actor: AuditActor, trigger: string): RecomputeResult {
    const trace = this.audit.startTrace({
      actor: actor.username,
      trigger,
      constraintVersion: this.constraintVersion,
      observationVersion: this.observations.getVersion(),
    });

    const networkStarted = Date.now();
    const network = resolveEffectiveNetwork(this.scenario, this.incidents.list());
    this.audit.addStage(trace, 'effective_network', 'ok', Date.now() - networkStarted, {
      usable_corridors: [...network.corridors.values()].filter(item => item.usable).length,
      usable_exits: [...network.exits.values()].filter(item => item.usable).length,
      active_incidents: network.activeIncidentIds.length,
    });

    const assessStarted = Date.now();
    const assessment = this.assessAll(network);
    this.audit.addStage(
      trace,
      'observation_assessment',
      assessment.untrustedRegions.length > 0 ? 'warning' : 'ok',
      Date.now() - assessStarted,
      {
        has_observations: assessment.hasObservations,
        untrusted_regions: assessment.untrustedRegions.map(item => item.regionId),
      },
    );

    const risks = this.assessRisks(network, assessment.assessments);
    this.audit.addStage(trace, 'risk_assessment', 'ok', 0, {
      summary: riskSummary(risks),
    });

    // 感知不可信：不得基于该数据生成新的安全路线
    if (assessment.untrustedRegions.length > 0) {
      this.publishedPlan = undefined;
      this.candidatePlan = undefined;
      this.lastValidation = undefined;
      this.audit.addStage(trace, 'planning', 'skipped', 0, {
        reason: 'untrusted_observations',
        regions: assessment.untrustedRegions.map(item => item.regionId),
      });
      const snapshot = this.currentState();
      const auditEntry = this.audit.record({
        actor: actor.username,
        role: actor.role,
        action: 'plan.recompute',
        entity_type: 'system',
        summary: `跳过规划：${assessment.untrustedRegions.length} 个区域观测不可信，系统进入 ${snapshot.state}`,
        result: 'rejected',
        reason: 'untrusted_observations',
        trace_id: trace.trace_id,
      });
      this.audit.finishTrace(trace, {
        state: snapshot.state,
        violation_codes: ['untrusted_observations'],
      });
      this.audit.addStage(trace, 'audit', 'ok', 0, { audit_id: auditEntry.id });
      return { trace, snapshot, exclusions: [] };
    }

    const demand = new Map<string, number>();
    for (const region of this.scenario.regions) {
      if (!region.enabled) continue;
      const observation = this.observations.latest(region.id);
      demand.set(region.id, observation ? observation.estimated_count : 0);
    }

    const constraintVersionAtPlanningStart = this.constraintVersion;
    const observationVersionAtPlanningStart = this.observations.getVersion();

    const planStarted = Date.now();
    const built = this.planBuilder({
      scenario: this.scenario,
      network,
      demandByRegion: demand,
      scenarioVersion: this.scenario.version,
      constraintVersion: constraintVersionAtPlanningStart,
      observationVersion: observationVersionAtPlanningStart,
      now: this.now(),
    });
    this.audit.addStage(trace, 'planning', 'ok', Date.now() - planStarted, {
      plan_id: built.plan.plan_id,
      status: built.plan.status,
      evacuated: built.plan.evacuated_persons,
      unresolved: built.plan.unresolved_persons,
      solve_ms: built.solveMs,
    });
    this.lastPlanExclusions = built.exclusions;

    // 规划期间约束/观测是否发生变化（T11）
    const constraintDrift = this.constraintVersion !== constraintVersionAtPlanningStart;
    const observationDrift = this.observations.getVersion() !== observationVersionAtPlanningStart;

    if (constraintDrift || observationDrift) {
      this.audit.addStage(trace, 'validation', 'failed', 0, {
        reason: 'version_changed_during_planning',
        constraint_drift: constraintDrift,
        observation_drift: observationDrift,
      });
      this.publishedPlan = undefined;
      this.candidatePlan = built.plan;
      this.lastValidation = {
        valid: false,
        checked_at: this.now().toISOString(),
        plan_id: built.plan.plan_id,
        violations: [
          {
            code: 'version_changed_during_planning',
            severity: 'hard',
            message: '规划过程中约束或观测版本发生变化，本方案基于已过期的输入，不得发布',
            detail: {
              constraint_version_at_start: constraintVersionAtPlanningStart,
              constraint_version_now: this.constraintVersion,
              observation_version_at_start: observationVersionAtPlanningStart,
              observation_version_now: this.observations.getVersion(),
            },
          },
        ],
        checks_run: ['version_match'],
        versions: {
          scenario_version: this.scenario.version,
          constraint_version: this.constraintVersion,
          observation_version: this.observations.getVersion(),
        },
      };
      const snapshot = this.currentState();
      this.audit.finishTrace(trace, {
        state: snapshot.state,
        plan_id: built.plan.plan_id,
        validation_valid: false,
        violation_codes: ['version_changed_during_planning'],
      });
      return { trace, plan: built.plan, validation: this.lastValidation, snapshot, exclusions: built.exclusions };
    }

    const validationStarted = Date.now();
    const validation = validateSafetyPlan({
      plan: built.plan,
      scenario: this.scenario,
      network,
      latestObservations: this.latestObservationMap(),
      config: this.scenario.config,
      constraintVersion: this.constraintVersion,
      observationVersion: this.observations.getVersion(),
      now: this.now(),
    });
    this.audit.addStage(
      trace,
      'validation',
      validation.valid ? 'ok' : 'failed',
      Date.now() - validationStarted,
      {
        valid: validation.valid,
        violations: validation.violations.map(violation => violation.code),
      },
    );

    this.lastValidation = validation;
    if (validation.valid) {
      this.publishedPlan = built.plan;
      this.candidatePlan = undefined;
      const state = this.currentState();
      this.lastValidPlanRef = {
        plan_id: built.plan.plan_id,
        created_at: built.plan.created_at,
        state: state.state,
      };
    } else {
      // 校验失败：绝不能继续把旧方案当作当前方案
      this.publishedPlan = undefined;
      this.candidatePlan = built.plan;
    }

    const snapshot = this.currentState();
    const auditEntry = this.audit.record({
      actor: actor.username,
      role: actor.role,
      action: 'plan.recompute',
      entity_type: 'plan',
      entity_id: built.plan.plan_id,
      plan_id: built.plan.plan_id,
      summary: `重新规划：疏散 ${built.plan.evacuated_persons}/${built.plan.total_persons} 人，校验${validation.valid ? '通过' : '失败'}，状态 ${snapshot.state}`,
      result: validation.valid ? 'success' : 'rejected',
      reason: validation.valid ? undefined : validation.violations.map(violation => violation.code).join(','),
      after: {
        state: snapshot.state,
        plan_status: built.plan.status,
        evacuated: built.plan.evacuated_persons,
        unresolved: built.plan.unresolved_persons,
      },
      trace_id: trace.trace_id,
    });
    this.audit.addStage(trace, 'audit', 'ok', 0, { audit_id: auditEntry.id });
    this.audit.finishTrace(trace, {
      state: snapshot.state,
      plan_id: built.plan.plan_id,
      validation_valid: validation.valid,
      violation_codes: validation.violations.map(violation => violation.code),
    });

    return {
      trace,
      plan: built.plan,
      validation,
      snapshot,
      exclusions: built.exclusions,
    };
  }

  /** 对任意候选方案执行独立校验（不改变当前发布状态）。 */
  validateCandidate(plan: EvacuationPlan, actor: AuditActor): SafetyValidationResult {
    const network = resolveEffectiveNetwork(this.scenario, this.incidents.list());
    const validation = validateSafetyPlan({
      plan,
      scenario: this.scenario,
      network,
      latestObservations: this.latestObservationMap(),
      config: this.scenario.config,
      constraintVersion: this.constraintVersion,
      observationVersion: this.observations.getVersion(),
      now: this.now(),
    });
    this.audit.record({
      actor: actor.username,
      role: actor.role,
      action: 'plan.validate',
      entity_type: 'plan',
      entity_id: plan.plan_id,
      plan_id: plan.plan_id,
      summary: `独立校验候选方案：${validation.valid ? '通过' : '不通过'}`,
      result: validation.valid ? 'success' : 'rejected',
      reason: validation.valid ? undefined : validation.violations.map(violation => violation.code).join(','),
      after: { violations: validation.violations.map(violation => violation.code) },
    });
    return validation;
  }

  setInferenceHealth(healthy: boolean, reason?: string): void {
    if (this.inferenceHealth.healthy === healthy && this.inferenceHealth.reason === reason) return;
    this.inferenceHealth = { healthy, reason };
    this.audit.record({
      actor: 'system',
      role: 'system',
      action: 'inference.health',
      entity_type: 'system',
      summary: healthy ? '推理服务恢复' : `推理服务异常：${reason ?? '未知'}`,
      result: healthy ? 'success' : 'failure',
      reason,
    });
  }

  // -------------------------------------------------------------------------
  // 状态快照
  // -------------------------------------------------------------------------

  getStatus(): SafetyStatus {
    const snapshot = this.currentState();
    const network = resolveEffectiveNetwork(this.scenario, this.incidents.list());
    const { assessments, lastValidObservationAt } = this.assessAll(network);
    const risks = this.assessRisks(network, assessments);

    return {
      state: snapshot,
      state_entered_at: this.stateEnteredAt,
      versions: this.getVersions(),
      plan: this.publishedPlan ?? null,
      candidate_plan: this.candidatePlan ?? null,
      validation: this.lastValidation ?? null,
      last_valid_plan: this.lastValidPlanRef ?? null,
      risks,
      risk_summary: riskSummary(risks),
      incidents: this.incidents.list(),
      observations: this.observations.snapshot(),
      regions: this.scenario.regions,
      corridors: this.scenario.corridors.map(corridor => {
        const effective = network.corridors.get(corridor.id)!;
        return {
          id: corridor.id,
          name: corridor.name,
          from_region_id: corridor.from_region_id,
          to_region_id: corridor.to_region_id,
          direction: corridor.direction,
          base_status: corridor.status,
          effective_status: effective.status,
          capacity_per_min: corridor.capacity_per_min,
          capacity_provenance: corridor.capacity_provenance,
          traversal_seconds: corridor.traversal_seconds,
          usable: effective.usable,
          status_reason: effective.statusReason,
          blocked_by_incident_id: effective.blockedByIncidentId,
        };
      }),
      exits: this.scenario.exits.map(exit => {
        const effective = network.exits.get(exit.id)!;
        return {
          id: exit.id,
          name: exit.name,
          region_id: exit.region_id,
          base_status: exit.status,
          effective_status: effective.status,
          capacity_per_min: exit.capacity_per_min,
          capacity_provenance: exit.capacity_provenance,
          usable: effective.usable,
          status_reason: effective.statusReason,
          blocked_by_incident_id: effective.blockedByIncidentId,
        };
      }),
      scenario: {
        id: this.scenario.scenario_id,
        name: this.scenario.name,
        version: this.scenario.version,
        notice: this.scenario.notice,
        horizon_minutes: this.scenario.config.horizon_minutes,
      },
      inference_health: { ...this.inferenceHealth },
      last_valid_observation_at: lastValidObservationAt,
    };
  }

  // -------------------------------------------------------------------------
  // 演示
  // -------------------------------------------------------------------------

  async runDemo(demoId: string, actor: AuditActor): Promise<{
    demo_id: string;
    steps: Array<{ index: number; action: string; result: string; detail?: Record<string, unknown> }>;
    status: SafetyStatus;
    expected_state: SafetyState;
  }> {
    const demo = this.scenario.demo_scenarios.find(item => item.id === demoId);
    if (!demo) throw new Error(`演示场景不存在：${demoId}`);

    this.reset(actor);
    const refs = new Map<string, string>();
    const steps: Array<{ index: number; action: string; result: string; detail?: Record<string, unknown> }> = [];

    for (let index = 0; index < demo.steps.length; index += 1) {
      const step = demo.steps[index];
      switch (step.action) {
        case 'observe': {
          this.simulationProvider.updateSamples(step.observations);
          for (const [regionId, sample] of Object.entries(step.observations)) {
            const region = this.scenario.regions.find(item => item.id === regionId);
            if (!region) continue;
            const result = await this.simulationProvider.infer({ region });
            this.ingestObservation(
              {
                regionId,
                count: result.count,
                confidence: result.confidence,
                source: 'simulation',
                provider: result.provider,
                modelVersion: result.modelVersion,
                calibrationVersion: result.calibrationVersion,
                evidence: result.evidence,
              },
              actor,
            );
          }
          steps.push({ index, action: step.action, result: 'ok', detail: { regions: Object.keys(step.observations) } });
          break;
        }
        case 'sensor_fault': {
          for (const regionId of step.region_ids) {
            this.ingestObservation(
              {
                regionId,
                count: 0,
                confidence: 0,
                source: 'simulation',
                provider: 'simulation-v1',
                modelVersion: 'simulation/1.0.0',
                valid: false,
                invalidReason: step.reason,
              },
              actor,
            );
          }
          steps.push({ index, action: step.action, result: 'ok', detail: { regions: step.region_ids } });
          break;
        }
        case 'incident.create': {
          const incident = this.createIncident({
            type: step.type,
            description: step.description,
            severity: step.severity,
            affected: step.affected,
            source: 'simulation',
            actor: actor.username,
          });
          refs.set(step.ref, incident.id);
          steps.push({ index, action: step.action, result: 'ok', detail: { incident_id: incident.id } });
          break;
        }
        case 'incident.confirm': {
          const id = refs.get(step.ref) ?? step.ref;
          this.confirmIncident(id, actor);
          steps.push({ index, action: step.action, result: 'ok', detail: { incident_id: id } });
          break;
        }
        case 'incident.resolve': {
          const id = refs.get(step.ref) ?? step.ref;
          this.resolveIncident(id, actor, '演示解除');
          steps.push({ index, action: step.action, result: 'ok', detail: { incident_id: id } });
          break;
        }
        case 'recompute': {
          const result = this.recompute(actor, `demo:${demoId}`);
          steps.push({
            index,
            action: step.action,
            result: 'ok',
            detail: {
              state: result.snapshot.state,
              plan_id: result.plan?.plan_id,
              valid: result.validation?.valid,
            },
          });
          break;
        }
        default: {
          steps.push({ index, action: (step as { action: string }).action, result: 'unsupported' });
        }
      }
    }

    return {
      demo_id: demo.id,
      steps,
      status: this.getStatus(),
      expected_state: demo.expected_state,
    };
  }

  reset(actor: AuditActor): void {
    this.observations.reset();
    this.incidents.clear();
    this.publishedPlan = undefined;
    this.candidatePlan = undefined;
    this.lastValidation = undefined;
    this.lastValidPlanRef = undefined;
    this.stateSnapshot = undefined;
    this.stateEnteredAt = this.now().toISOString();
    this.constraintVersion = 0;
    this.lastPlanExclusions = [];
    this.inferenceHealth = { healthy: true };
    this.audit.record({
      actor: actor.username,
      role: actor.role,
      action: 'system.reset',
      entity_type: 'system',
      summary: '重置安全决策状态（观测、事件、方案与版本）',
      result: 'success',
    });
  }
}

export { IncidentTransitionError };
