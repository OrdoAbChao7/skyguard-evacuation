/**
 * MVP 业务编排：把安全内核、预测、VoI/Agent、工具、人员与工单、回放和外部运行时接在一起。
 * 该服务是 HTTP API、MCP Server 与演示脚本共用的单例入口。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AuditLog } from '../safety/audit';
import { SafetyDecisionService } from '../safety/decision-service';
import type { SafetyScenario } from '../safety/types';
import { loadSafetyScenario } from '../safety/scenario';
import { getSafetyService } from '../safety';
import { PredictionService, type PredictionResult } from './prediction';
import { OpsService, WorkOrderCreateSchema, type OpsActor } from './ops';
import { ReplayService, allCameraHealth, replayObservationInputs, type ReplayStatus } from './ingest';
import { createToolDefinitions, ToolRegistry, type ToolContext } from './tools';
import { AgentService, type AgentRun } from './agent';
import { AgentArtsClient, loadAgentArtsConfig, type AgentArtsStatus } from './agentarts';
import { buildRegionGraph, propagateRisk, rankInvestigationPriorities } from './risk-graph';
import { decideMultiRegionInvestigation, priorBeliefsForRegions } from './multi-voi';

export * from './prediction';
export * from './voi';
export * from './ops';
export * from './ingest';
export * from './tools';
export * from './agent';
export * from './agentarts';
export * from './risk-graph';
export * from './multi-voi';
export * from './investigation-session';

export interface MvpServiceOptions {
  scenario?: SafetyScenario;
  safety?: SafetyDecisionService;
  audit?: AuditLog;
}

export interface MvpDashboard {
  scenario: {
    id: string;
    name: string;
    version: string;
    notice: string;
    venue: SafetyScenario['venue'] | null;
    horizon_minutes: number;
    regions: number;
    exits: number;
  };
  safety: ReturnType<SafetyDecisionService['getStatus']>;
  cameras: ReturnType<typeof allCameraHealth>;
  predictions: PredictionResult[];
  staff: ReturnType<OpsService['listStaff']>;
  work_orders: ReturnType<OpsService['listWorkOrders']>;
  agent_runs: AgentRun[];
  agentarts: AgentArtsStatus;
  replay: ReplayStatus;
  audit: Array<Record<string, unknown>>;
  generated_at: string;
}

let singleton: MvpService | null = null;

/** 进程内单例：HTTP API、MCP Server 与演示脚本共用。 */
export function getMvpService(): MvpService {
  if (!singleton) {
    // 与 /api/v1/safety/* 共用同一个安全服务实例，避免两套观测/状态分裂。
    const safety = getSafetyService();
    singleton = new MvpService({ scenario: safety.getScenario(), safety, audit: safety.getAuditLog() });
  }
  return singleton;
}

/** 测试用：丢弃单例，下一次访问重新读取场景。 */
export function resetMvpServiceForTests(): void {
  singleton = null;
}

export class MvpService {
  readonly scenario: SafetyScenario;
  readonly safety: SafetyDecisionService;
  readonly audit: AuditLog;
  readonly prediction: PredictionService;
  readonly ops: OpsService;
  readonly replay: ReplayService;
  readonly registry: ToolRegistry;
  readonly agent: AgentService;
  readonly agentArts: AgentArtsClient;

  private runs = new Map<string, AgentRun>();
  private runOrder: string[] = [];
  private agentArtsCache: { status: AgentArtsStatus; at: number } | null = null;

  constructor(options: MvpServiceOptions = {}) {
    this.scenario = options.scenario ?? loadSafetyScenario();
    this.audit = options.audit ?? options.safety?.getAuditLog() ?? new AuditLog();
    this.safety = options.safety ?? new SafetyDecisionService({ scenario: this.scenario, auditLog: this.audit });
    this.prediction = new PredictionService(this.scenario, this.safety.getObservationStore());
    this.replay = new ReplayService(this.scenario);
    this.ops = new OpsService(
      this.scenario,
      this.audit,
      order => this.handleFeedback(order.id),
      () => {
        const version = this.safety.getVersions();
        return { observation: version.observation, constraint: version.constraint, scenario: version.scenario };
      },
      process.env.OPS_PERSIST_FILE?.trim() || undefined,
    );

    const context: ToolContext = {
      scenario: this.scenario,
      safety: this.safety,
      prediction: this.prediction,
      ops: this.ops,
      replay: this.replay,
      cameras: regionId => regionId
        ? allCameraHealth(this.scenario, this.safety.getObservationStore()).filter(item => item.region_id === regionId)
        : allCameraHealth(this.scenario, this.safety.getObservationStore()),
      now: () => new Date(),
      recordAudit: entry => {
        this.audit.record({
          actor: entry.actor.username,
          role: entry.actor.role,
          action: `tool.${entry.tool}`,
          entity_type: 'tool_call',
          entity_id: entry.tool,
          summary: `工具 ${entry.tool} ${entry.result === 'success' ? '成功' : '失败'}${entry.error ? `：${entry.error}` : ''}`,
          result: entry.result === 'success' ? 'success' : 'failure',
          reason: entry.error,
          after: {
            args: entry.args as Record<string, unknown>,
            source: entry.source,
            duration_ms: entry.duration_ms,
          },
        });
      },
    };

    const enabledTools = this.scenario.venue?.enabled_tools;
    const definitions = createToolDefinitions(context).filter(definition =>
      !enabledTools || enabledTools.length === 0 || enabledTools.includes(definition.name),
    );
    this.registry = new ToolRegistry(definitions, context.recordAudit, {
      username: 'skyguard-agent',
      role: 'agent',
      kind: 'agent',
    });
    this.agent = new AgentService(this.scenario, this.registry);
    this.agentArts = new AgentArtsClient(loadAgentArtsConfig());
  }

  // ---------------------------------------------------------------- 场景与态势
  getScenario(): SafetyScenario {
    return this.scenario;
  }

  cameraHealth(regionId?: string): ReturnType<typeof allCameraHealth> {
    const all = allCameraHealth(this.scenario, this.safety.getObservationStore());
    return regionId ? all.filter(item => item.region_id === regionId) : all;
  }

  predict(regionId: string, horizonMinutes?: number): PredictionResult {
    return this.prediction.predict(regionId, { horizonMinutes });
  }

  dashboard(): MvpDashboard {
    return {
      scenario: {
        id: this.scenario.scenario_id,
        name: this.scenario.name,
        version: this.scenario.version,
        notice: this.scenario.notice,
        venue: this.scenario.venue ?? null,
        horizon_minutes: this.scenario.config.horizon_minutes,
        regions: this.scenario.regions.length,
        exits: this.scenario.exits.length,
      },
      safety: this.safety.getStatus(),
      cameras: this.cameraHealth(),
      predictions: this.scenario.regions.map(region => this.prediction.predict(region.id)),
      staff: this.ops.listStaff(),
      work_orders: this.ops.listWorkOrders(),
      agent_runs: this.listAgentRuns(10),
      agentarts: this.getAgentArtsStatusCached(),
      replay: this.replay.status(),
      audit: this.audit.list(20) as unknown as Array<Record<string, unknown>>,
      generated_at: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------- 回放
  loadReplay(params: { file: string; format?: 'json' | 'csv' }): ReplayStatus {
    const format = params.format ?? (params.file.toLowerCase().endsWith('.csv') ? 'csv' : 'json');
    return format === 'csv'
      ? this.replay.loadCsvFile(params.file)
      : this.replay.loadJsonFile(params.file);
  }

  stepReplay(params: { count?: number; actor?: OpsActor } = {}): {
    status: ReplayStatus;
    ingested: number;
    observations: Array<Record<string, unknown>>;
  } {
    const count = params.count ?? 1;
    const rows = this.replay.next(count);
    const inputs = replayObservationInputs(rows, this.scenario);
    const actor = params.actor ?? { username: 'replay-engine', role: 'agent' };
    const observations = inputs.map(input => {
      const observation = this.safety.ingestObservation({
        regionId: input.regionId,
        count: input.count,
        confidence: input.confidence,
        source: input.source,
        provider: input.provider,
        modelVersion: 'replay-v1',
        observedAt: input.observedAt,
        evidence: { replay: true },
      }, actor);
      return {
        id: observation.id,
        region_id: observation.region_id,
        count: observation.estimated_count,
        density: observation.estimated_density,
        confidence: observation.confidence,
        source: observation.source,
        observed_at: observation.observed_at,
      };
    });
    if (observations.length > 0) {
      this.safety.recompute(actor, 'replay_step');
    }
    return { status: this.replay.status(), ingested: observations.length, observations };
  }

  // ---------------------------------------------------------------- Agent
  async runAgent(options: {
    regionId: string;
    trigger: string;
    actor?: OpsActor;
    runtime?: 'local' | 'agentarts';
  }): Promise<AgentRun> {
    const requested = options.runtime ?? this.agentArts.getConfig().runtime;
    let run: AgentRun;
    if (requested === 'agentarts') {
      const status = await this.agentArts.healthCheck();
      this.agentArtsCache = { status, at: Date.now() };
      if (status.mode !== 'AGENTARTS_CONNECTED') {
        run = this.failedRemoteRun(options, status);
      } else {
        run = await this.runWithAgentArts(options);
      }
    } else {
      run = await this.agent.run({
        regionId: options.regionId,
        trigger: options.trigger,
        actor: options.actor,
      });
    }
    this.storeRun(run);
    this.audit.record({
      actor: run.mode === 'AGENTARTS_CONNECTED' ? 'agentarts' : 'skyguard-agent',
      role: 'agent',
      action: 'agent.run',
      entity_type: 'agent_run',
      entity_id: run.run_id,
      trace_id: run.trace_id,
      summary: `Agent 运行 ${run.run_id}：${run.status}（${run.mode}）`,
      result: run.status === 'failed' ? 'failure' : 'success',
      after: {
        mode: run.mode,
        status: run.status,
        region_id: run.region_id,
        tool_calls: run.trace.length,
        work_orders: run.work_orders.map(order => order.id),
      },
    });
    return run;
  }

  private async runWithAgentArts(options: {
    regionId: string;
    trigger: string;
    actor?: OpsActor;
  }): Promise<AgentRun> {
    const actor: OpsActor = options.actor ?? { username: 'skyguard-agent', role: 'agent', kind: 'agent' };
    const status = this.safety.getStatus();
    const camera = this.cameraHealth(options.regionId)[0] ?? null;
    const prediction = this.prediction.predict(options.regionId);
    const traceId = `RUN-${randomUUID().slice(0, 8)}`;
    const decision = await this.agentArts.select({
      regionId: options.regionId,
      trigger: options.trigger,
      traceId,
      context: {
        safety_state: status.state,
        region: status.regions.find(region => region.id === options.regionId) ?? null,
        risk: status.risks.find(risk => risk.regionId === options.regionId) ?? null,
        camera,
        prediction,
        venue: this.scenario.venue ?? null,
      },
      tools: this.registry.list().map(tool => ({ name: tool.name, description: tool.description, roles: tool.roles })),
    });
    const toolResult = await this.registry.invoke(decision.tool, decision.arguments, actor);
    const trace = [{
      seq: 1,
      tool: decision.tool,
      args: decision.arguments,
      ok: toolResult.ok,
      status: toolResult.ok ? 'ok' as const : 'error' as const,
      result_summary: toolResult.ok ? 'AgentArts 选择的工具执行成功' : (toolResult.error ?? 'failed'),
      source: toolResult.source,
      confidence: toolResult.confidence,
      duration_ms: toolResult.duration_ms ?? 0,
    }];
    return {
      run_id: traceId,
      trace_id: traceId,
      mode: 'AGENTARTS_CONNECTED',
      runtime_detail: '华为云 AgentArts：连接探测成功，由平台返回工具决策，本地执行并做权限校验。',
      scenario_id: this.scenario.scenario_id,
      trigger: options.trigger,
      region_id: options.regionId,
      status: toolResult.ok ? 'completed' : 'failed',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      state: status.state,
      belief_before: [],
      belief_after: [],
      entropy_before_bits: null,
      entropy_after_bits: null,
      risk_before: null,
      risk_after: null,
      investigation: {
        required: true,
        reason: '由 AgentArts 平台决策',
        rounds: [],
        pending_work_order_ids: [],
        stopped_reason: decision.reasoning || null,
      },
      prediction,
      camera: camera as unknown as Record<string, unknown> | null,
      risk: (status.risks.find(risk => risk.regionId === options.regionId) ?? null) as unknown as Record<string, unknown> | null,
      staff_recommendation: null,
      work_orders: [],
      recommendations: [decision.reasoning || '由 AgentArts 返回决策。'],
      trace,
      summary: `AgentArts 决策：调用 ${decision.tool}。${decision.reasoning}`,
      limitations: ['AgentArts 路径未经真实租户实机验证；工具执行仍受本地权限与安全校验约束。'],
    };
  }

  private failedRemoteRun(options: { regionId: string; trigger: string }, status: AgentArtsStatus): AgentRun {
    const safety = this.safety.getStatus();
    return {
      run_id: `RUN-${randomUUID().slice(0, 8)}`,
      trace_id: `RUN-${randomUUID().slice(0, 8)}`,
      mode: 'AGENTARTS_UNAVAILABLE',
      runtime_detail: status.detail,
      scenario_id: this.scenario.scenario_id,
      trigger: options.trigger,
      region_id: options.regionId,
      status: 'failed',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      state: safety.state,
      belief_before: [],
      belief_after: [],
      entropy_before_bits: null,
      entropy_after_bits: null,
      risk_before: null,
      risk_after: null,
      investigation: { required: false, reason: 'AgentArts 不可用', rounds: [], pending_work_order_ids: [], stopped_reason: status.detail },
      prediction: null,
      camera: null,
      risk: null,
      staff_recommendation: null,
      work_orders: [],
      recommendations: ['请检查 AGENTARTS_* 配置并完成健康探测；可切换 AGENT_RUNTIME=local 使用本地演示。'],
      trace: [],
      summary: `AgentArts 不可用：${status.detail}`,
      limitations: ['未完成 AgentArts 实机验证，系统不会回退并伪装为已连接。'],
    };
  }

  private storeRun(run: AgentRun): void {
    this.runs.set(run.run_id, run);
    this.runOrder.push(run.run_id);
    if (this.runOrder.length > 100) {
      const evicted = this.runOrder.shift();
      if (evicted) this.runs.delete(evicted);
    }
  }

  listAgentRuns(limit = 20): AgentRun[] {
    return this.runOrder.slice(-limit).reverse().map(id => this.runs.get(id)!).filter(Boolean);
  }

  getAgentRun(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  // ---------------------------------------------------------------- AgentArts
  async agentRuntimeStatus(force = false): Promise<AgentArtsStatus> {
    const now = Date.now();
    if (!force && this.agentArtsCache && now - this.agentArtsCache.at < 30_000) {
      return this.agentArtsCache.status;
    }
    const status = await this.agentArts.healthCheck();
    this.agentArtsCache = { status, at: now };
    return status;
  }

  private getAgentArtsStatusCached(): AgentArtsStatus {
    return this.agentArtsCache?.status ?? this.agentArts.staticStatus();
  }

  // ---------------------------------------------------------------- 人员与工单
  createWorkOrder(actor: OpsActor, input: unknown) {
    return this.ops.createWorkOrder(actor, WorkOrderCreateSchema.parse(input));
  }

  // ---------------------------------------------------------------- 反馈闭环
  private handleFeedback(orderId: string): void {
    const order = this.ops.getWorkOrder(orderId);
    if (!order?.feedback?.observation || !order.region_id) return;
    const region = this.scenario.regions.find(item => item.id === order.region_id);
    if (!region) return;
    const observation = order.feedback.observation;
    const actor: OpsActor = {
      username: order.feedback.staff_id,
      role: 'staff',
      staff_id: order.feedback.staff_id,
    };
    this.safety.ingestObservation({
      regionId: order.region_id,
      count: observation.count,
      confidence: observation.confidence,
      source: 'field_report',
      provider: `staff:${order.feedback.staff_id}`,
      modelVersion: 'field-report-v1',
      observedAt: new Date(order.feedback.at),
      valid: observation.valid,
      invalidReason: observation.reason,
      evidence: { work_order_id: order.id, feedback_note: order.feedback.note },
    }, actor);
    this.safety.recompute(actor, `staff_feedback:${order.id}`);
  }

  // ---------------------------------------------------------------- 多区域协同
  getMultiRegionAnalysis(regionId?: string): Record<string, unknown> {
    const policy = this.scenario.investigation;
    if (!policy) {
      return { available: false, reason: '场景未配置 investigation 策略' };
    }
    const status = this.safety.getStatus();
    const graph = buildRegionGraph(this.scenario);
    const propagated = propagateRisk(this.scenario, status.risks);
    const priorities = rankInvestigationPriorities(this.scenario, status.risks, propagated);
    const target = regionId ?? priorities[0]?.regionId ?? this.scenario.regions[0]?.id;
    if (!target) return { available: false, reason: '场景没有区域' };
    const beliefs = priorBeliefsForRegions(policy, status.risks);
    const cameras = this.cameraHealth(target);
    const camera = cameras[0] ?? null;
    const staff = this.ops.recommendStaff({ region_id: target, required_skills: ['crowd_check'] });
    const uavAvailable = (this.scenario.venue?.uav_units ?? []).some(unit => unit.status === 'available');
    const historyPoints = this.safety.getObservationStore().window(
      target,
      new Date(Date.now() - this.scenario.config.trend_window_seconds * 1000),
      new Date(),
    ).filter(item => item.valid).length;
    const availability = {
      A_CAMERA: camera && camera.state !== 'offline' ? { available: true } : { available: false, reason: '摄像头离线' },
      A_STAFF: staff.recommended ? { available: true } : { available: false, reason: '没有可用工作人员' },
      A_UAV: uavAvailable ? { available: true } : { available: false, reason: '没有可用无人机' },
      A_HISTORY: historyPoints >= 2 ? { available: true } : { available: false, reason: '历史观测不足' },
      A_PREDICTION: { available: true },
    };
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

  // ---------------------------------------------------------------- 一键推演
  async runDemoScenario(kind: 'A_normal' | 'B_surge' | 'C_untrusted', actor: OpsActor): Promise<Record<string, unknown>> {
    this.resetAll(actor);
    const now = Date.now();
    const step = (index: number, total: number) => new Date(now - (total - 1 - index) * 60_000).toISOString();

    if (kind === 'A_normal') {
      const series: Record<string, number[]> = {
        R_NORTH_STAND: [360, 345, 330, 315, 300, 290],
        R_SOUTH_STAND: [310, 300, 290, 280, 270, 260],
        R_WEST_STAND: [290, 280, 270, 260, 250, 240],
        R_EAST_STAND: [300, 320, 345, 370, 395, 420],
        R_NORTH_CONCOURSE: [120, 125, 130, 135, 140, 145],
        R_SOUTH_CONCOURSE: [110, 112, 114, 116, 118, 120],
        R_EAST_PLAZA: [60, 62, 64, 66, 68, 70],
        R_WEST_PLAZA: [55, 56, 57, 58, 59, 60],
      };
      const rows = Object.entries(series).flatMap(([regionId, counts]) => counts.map((count, index) => ({
        timestamp: step(index, counts.length),
        region_id: regionId,
        count,
        confidence: 0.9,
        source: 'csv_replay' as const,
      })));
      this.replay.loadRows(rows, { name: 'ui-demo-normal', provenance: '合成回放数据（控制台一键推演）' });
      this.stepReplay({ count: rows.length, actor });
      const run = await this.runAgent({ regionId: 'R_NORTH_STAND', trigger: 'ui_demo_normal', actor });
      return { scenario: kind, state: this.safety.getStatus().state, run, dashboard: this.dashboard() };
    }

    if (kind === 'B_surge') {
      const baseline: Record<string, number[]> = {
        R_NORTH_STAND: [300, 305, 310],
        R_SOUTH_STAND: [280, 285, 290],
        R_WEST_STAND: [260, 265, 270],
        R_NORTH_CONCOURSE: [110, 115, 120],
        R_SOUTH_CONCOURSE: [105, 108, 112],
        R_EAST_PLAZA: [55, 60, 65],
        R_WEST_PLAZA: [50, 52, 55],
      };
      const rows = Object.entries(baseline).flatMap(([regionId, counts]) => counts.map((count, index) => ({
        timestamp: step(index, counts.length),
        region_id: regionId,
        count,
        confidence: 0.9,
        source: 'csv_replay' as const,
      })));
      this.replay.loadRows(rows, { name: 'ui-demo-surge', provenance: '合成回放数据（控制台一键推演）' });
      this.stepReplay({ count: rows.length, actor });
      this.safety.ingestObservation({
        regionId: 'R_EAST_STAND', count: 900, confidence: 0.35,
        source: 'simulation', provider: 'ui-demo-degraded', modelVersion: 'demo/1.0.0',
        observedAt: new Date(), valid: true,
      }, actor);
      this.safety.recompute(actor, 'ui_demo_surge');
      const run = await this.runAgent({ regionId: 'R_EAST_STAND', trigger: 'ui_demo_surge', actor });
      return { scenario: kind, state: this.safety.getStatus().state, run, dashboard: this.dashboard() };
    }

    for (const region of this.scenario.regions) {
      this.safety.ingestObservation({
        regionId: region.id, count: 800, confidence: 0.9,
        source: 'simulation', provider: 'ui-demo-offline', modelVersion: 'demo/1.0.0',
        observedAt: new Date(), valid: false, invalidReason: '摄像头离线（演示构造）',
      }, actor);
    }
    this.safety.recompute(actor, 'ui_demo_untrusted');
    for (const region of this.scenario.regions) {
      const count = region.id.includes('STAND') ? 1300 : region.id.includes('CONCOURSE') ? 700 : 400;
      this.safety.ingestObservation({
        regionId: region.id, count, confidence: 0.95,
        source: 'simulation', provider: 'ui-demo-capacity', modelVersion: 'demo/1.0.0',
        observedAt: new Date(),
      }, actor);
    }
    const incident = this.safety.createIncident({
      type: 'corridor_closure',
      description: '东西主出口临时关闭（控制台演示）',
      severity: 'critical',
      affected: { region_ids: [], corridor_ids: [], exit_ids: ['E_EAST', 'E_WEST'] },
      source: 'operator',
      actor: actor.username,
    });
    this.safety.confirmIncident(incident.id, actor);
    this.safety.recompute(actor, 'ui_demo_reject');
    const run = await this.runAgent({ regionId: 'R_EAST_STAND', trigger: 'ui_demo_reject', actor });
    return { scenario: kind, state: this.safety.getStatus().state, run, dashboard: this.dashboard() };
  }

  /** 读取已生成的竞赛基准摘要（若文件不存在则返回 available=false）。 */
  getExperimentSummary(): Record<string, unknown> {
    const dir = path.resolve(__dirname, '../../../../evaluation/competition');
    const files: Record<string, string> = {
      voi: 'experiment_a_voi.json',
      prediction: 'experiment_b_prediction.json',
      planning: 'experiment_c_planning_robustness.json',
      safety: 'experiment_d_safety_faults.json',
      business: 'experiment_e_business_loop.json',
      latency: 'experiment_f_latency.json',
    };
    const experiments: Record<string, unknown> = {};
    for (const [key, file] of Object.entries(files)) {
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        experiments[key] = parsed.summary ?? parsed.results ?? null;
      } catch { /* ignore corrupt file */ }
    }
    return {
      available: Object.keys(experiments).length > 0,
      generated_at: fs.existsSync(path.join(dir, 'run_metadata.json'))
        ? JSON.parse(fs.readFileSync(path.join(dir, 'run_metadata.json'), 'utf8')).generated_at
        : null,
      experiments,
      report_path: 'evaluation/COMPETITION_REPORT.md',
      note: '全部为合成数据基准；不代表真实场地或平台效果。',
    };
  }

  // ---------------------------------------------------------------- 重置
  resetAll(actor: OpsActor = { username: 'system', role: 'admin' }): void {
    this.safety.reset(actor);
    this.ops.reset();
    this.replay.reset();
    this.runs.clear();
    this.runOrder = [];
    this.agentArtsCache = null;
  }
}
