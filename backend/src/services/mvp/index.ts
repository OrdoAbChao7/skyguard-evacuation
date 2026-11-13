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
import { PersistentStateStore, StateStoreError, type LoadedState } from '../state/persistent-store';
import type { PersistedAppState } from '../state/app-state';
import { buildDashboard, type MvpDashboard } from './dashboard';
import { analyzeMultiRegion } from './multi-region';
import { runUiDemo } from './demo';
import { runWithAgentArts } from './agentarts-run';
import { readExperimentSummary } from './experiment-summary';

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
export * from './budget';
export * from './availability';

export interface MvpServiceOptions {
  scenario?: SafetyScenario;
  safety?: SafetyDecisionService;
  audit?: AuditLog;
}

let singleton: MvpService | null = null;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

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
  private readonly runsFile: string | null;
  private readonly stateStore: PersistentStateStore<PersistedAppState> | null;
  private stateRevision = 0;
  private stateWritable = true;
  private restoring = true;
  private persisting = false;
  private transactionDepth = 0;
  private stateDirty = false;
  private transactionSnapshot: {
    safety: ReturnType<SafetyDecisionService['exportState']>;
    ops: ReturnType<OpsService['exportState']>;
  } | null = null;

  constructor(options: MvpServiceOptions = {}) {
    this.scenario = options.scenario ?? loadSafetyScenario();
    this.audit = options.audit ?? options.safety?.getAuditLog() ?? new AuditLog();
    const stateFile = process.env.MVP_STATE_FILE?.trim() || null;
    this.stateStore = stateFile ? new PersistentStateStore<PersistedAppState>(stateFile, 1) : null;
    // 先加载并校验；损坏或版本不兼容时在构造阶段 fail closed。
    const restoredState = this.stateStore?.load() ?? null;

    this.safety = options.safety ?? new SafetyDecisionService({ scenario: this.scenario, auditLog: this.audit });
    this.safety.setStateChangeHook(() => this.handleStateChange());
    this.safety.setWritableGuard(() => this.assertStateWritable());
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
      this.stateStore ? undefined : (process.env.OPS_PERSIST_FILE?.trim() || undefined),
      () => this.handleStateChange(),
      fn => this.withTransaction(fn),
      () => this.assertStateWritable(),
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
    this.runsFile = this.stateStore ? null : (process.env.MVP_RUNS_FILE?.trim() || null);
    this.restoreRuns();
    if (restoredState) this.applyRestoredState(restoredState);
    this.restoring = false;
    // 首次启动且已配置统一状态文件：立即建立 revision=1 的可校验快照。
    if (this.stateStore && !restoredState) this.persistState();
  }

  private applyRestoredState(loaded: LoadedState<PersistedAppState>): void {
    const state = loaded.payload;
    if (!state || state.schema_version !== 1) {
      throw new StateStoreError('STATE_RESTORE_FAILED', '统一状态 schema_version 不受支持');
    }
    if (state.scenario?.id !== this.scenario.scenario_id || state.scenario?.version !== this.scenario.version) {
      throw new StateStoreError(
        'STATE_SCENARIO_MISMATCH',
        `状态文件场景 ${state.scenario?.id ?? 'unknown'}@${state.scenario?.version ?? 'unknown'} 与当前场景 `
        + `${this.scenario.scenario_id}@${this.scenario.version} 不一致；拒绝恢复`,
      );
    }
    try {
      this.safety.restoreState(state.safety);
      this.audit.restoreState(state.audit);
      this.ops.applyPersistedState(state.ops);
      this.runs.clear();
      for (const run of Array.isArray(state.runs) ? state.runs : []) {
        if (run && typeof run.run_id === 'string') this.runs.set(run.run_id, run);
      }
      this.runOrder = (Array.isArray(state.run_order) ? state.run_order : Array.from(this.runs.keys()))
        .filter(id => this.runs.has(id))
        .slice(-100);
      this.stateRevision = loaded.revision;
      this.audit.record({
        actor: 'system',
        role: 'system',
        action: 'system.state_restored',
        entity_type: 'state_store',
        summary: `从 ${loaded.source} 恢复统一状态 revision=${loaded.revision}`,
        result: 'success',
        after: {
          source: loaded.source,
          revision: loaded.revision,
          saved_at: loaded.saved_at,
          work_orders: this.ops.listWorkOrders({}).length,
          runs: this.runOrder.length,
        },
      });
    } catch (error) {
      throw new StateStoreError('STATE_RESTORE_FAILED', `统一状态恢复失败：${(error as Error).message}`);
    }
  }

  /** 状态写入失败后进入只读；后续写操作直接失败，等待人工重启/修复。 */
  private handleStateChange(): void {
    if (this.restoring) return;
    if (this.transactionDepth > 0) {
      this.stateDirty = true;
      return;
    }
    this.persistState();
  }

  /** 把跨安全域/工单/反馈的多步变更合并为一次统一状态提交；失败时回滚内存状态。 */
  private withTransaction<T>(fn: () => T): T {
    this.assertStateWritable();
    if (this.transactionDepth === 0) {
      this.transactionSnapshot = {
        safety: cloneJson(this.safety.exportState()),
        ops: cloneJson(this.ops.exportState()),
      };
    }
    this.transactionDepth += 1;
    let result!: T;
    let failed = false;
    let failure: unknown;
    try {
      result = fn();
    } catch (error) {
      failed = true;
      failure = error;
    }
    this.transactionDepth -= 1;
    if (this.transactionDepth === 0) {
      if (failed) {
        this.rollbackTransaction(failure);
        throw failure;
      }
      if (this.stateDirty && !this.restoring) {
        this.stateDirty = false;
        try {
          this.persistState();
        } catch (error) {
          this.rollbackTransaction(error);
          throw error;
        }
      }
      this.transactionSnapshot = null;
    }
    return result;
  }

  private rollbackTransaction(failure?: unknown): void {
    const snapshot = this.transactionSnapshot;
    this.transactionSnapshot = null;
    this.stateDirty = false;
    if (!snapshot) return;
    const previousRestoring = this.restoring;
    this.restoring = true;
    try {
      this.safety.restoreState(cloneJson(snapshot.safety));
      this.ops.applyPersistedState(cloneJson(snapshot.ops));
      try {
        this.audit.record({
          actor: 'system',
          role: 'system',
          action: 'system.transaction_rolled_back',
          entity_type: 'state_store',
          summary: '事务失败，工单/预算/安全内存状态已回滚；失败操作不应视为完成',
          result: 'failure',
          reason: failure instanceof Error ? failure.message : String(failure ?? 'unknown'),
        });
      } catch {
        // 审计失败不改变回滚结果。
      }
    } catch (error) {
      this.stateWritable = false;
      try {
        this.audit.record({
          actor: 'system',
          role: 'system',
          action: 'system.state_rollback_failed',
          entity_type: 'state_store',
          summary: '事务失败后回滚内存状态失败；服务进入只读',
          result: 'failure',
          reason: (error as Error).message,
        });
      } catch {
        // 审计失败不得掩盖回滚错误。
      }
    } finally {
      this.restoring = previousRestoring;
    }
  }

  private assertStateWritable(): void {
    if (this.stateStore && !this.stateWritable) {
      throw new StateStoreError('STATE_READ_ONLY', '统一状态存储不可写；请检查磁盘并重启服务');
    }
  }

  private persistState(): void {
    if (!this.stateStore || this.restoring) return;
    if (!this.stateWritable) {
      throw new StateStoreError('STATE_READ_ONLY', '统一状态存储不可写；请检查磁盘并重启服务');
    }
    if (this.persisting) return;
    this.persisting = true;
    try {
      const payload: PersistedAppState = {
        schema_version: 1,
        saved_at: new Date().toISOString(),
        scenario: { id: this.scenario.scenario_id, version: this.scenario.version },
        safety: this.safety.exportState(),
        ops: this.ops.exportState(),
        runs: this.runOrder.map(id => this.runs.get(id)!).filter(Boolean),
        run_order: [...this.runOrder],
        audit: this.audit.exportState(),
      };
      this.stateRevision = this.stateStore.save(payload, this.stateRevision);
    } catch (error) {
      this.stateWritable = false;
      const wrapped = error instanceof StateStoreError
        ? error
        : new StateStoreError('STATE_WRITE_FAILED', `统一状态写入失败：${(error as Error).message}`);
      try {
        this.audit.record({
          actor: 'system',
          role: 'system',
          action: 'system.state_persist_failed',
          entity_type: 'state_store',
          summary: '统一状态写入失败，服务进入只读状态',
          result: 'failure',
          reason: wrapped.message,
        });
      } catch {
        // 审计失败不掩盖原始存储错误。
      }
      throw wrapped;
    } finally {
      this.persisting = false;
    }
  }

  getStateStoreHealth(): {
    enabled: boolean;
    writable: boolean;
    revision: number;
    path: string | null;
  } {
    return {
      enabled: Boolean(this.stateStore),
      writable: this.stateWritable,
      revision: this.stateRevision,
      path: this.stateStore?.path ?? null,
    };
  }

  /** 可选持久化：MVP_RUNS_FILE 指向 JSON 快照；未配置时保持纯内存。 */
  private restoreRuns(): void {
    if (this.stateStore) return;
    if (!this.runsFile || !fs.existsSync(this.runsFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.runsFile, 'utf8')) as { runs?: AgentRun[]; order?: string[] };
      const restored = Array.isArray(raw.runs)
        ? raw.runs.filter(run => run && typeof run.run_id === 'string')
        : [];
      for (const run of restored) this.runs.set(run.run_id, run);
      this.runOrder = (Array.isArray(raw.order) ? raw.order : restored.map(run => run.run_id))
        .filter(id => this.runs.has(id))
        .slice(-100);
      this.audit.record({
        actor: 'system',
        role: 'system',
        action: 'agent_runs.persistence_restored',
        entity_type: 'agent_run_state',
        summary: `已恢复 ${this.runOrder.length} 条 Agent 运行记录`,
        result: 'success',
      });
    } catch (error) {
      this.audit.record({
        actor: 'system',
        role: 'system',
        action: 'agent_runs.persistence_restore_failed',
        entity_type: 'agent_run_state',
        summary: 'Agent 运行快照恢复失败，已忽略',
        result: 'failure',
        reason: (error as Error).message,
      });
    }
  }

  private persistRuns(): void {
    if (this.stateStore) return;
    if (!this.runsFile) return;
    try {
      fs.mkdirSync(path.dirname(this.runsFile), { recursive: true });
      const payload = JSON.stringify({
        version: 1,
        saved_at: new Date().toISOString(),
        order: this.runOrder,
        runs: this.runOrder.map(id => this.runs.get(id)!).filter(Boolean),
      }, null, 2);
      const temp = `${this.runsFile}.tmp`;
      fs.writeFileSync(temp, payload);
      fs.renameSync(temp, this.runsFile);
    } catch (error) {
      this.audit.record({
        actor: 'system',
        role: 'system',
        action: 'agent_runs.persistence_failed',
        entity_type: 'agent_run_state',
        summary: 'Agent 运行快照写入失败',
        result: 'failure',
        reason: (error as Error).message,
      });
    }
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
    return buildDashboard({
      scenario: this.scenario,
      safety: this.safety,
      prediction: this.prediction,
      ops: this.ops,
      replay: this.replay,
      audit: this.audit,
      cameraHealth: regionId => this.cameraHealth(regionId),
      listAgentRuns: limit => this.listAgentRuns(limit),
      getAgentArtsStatusCached: () => this.getAgentArtsStatusCached(),
      getStateStoreHealth: () => this.getStateStoreHealth(),
    });
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
    return runWithAgentArts(this, options);
  }

  /**
   * 人工反馈后的续接入口：仅在显式开启时自动调用平台。
   * 平台故障或超时不改写工单状态；本地业务闭环仍可继续。
   */
  async continueAgentRun(runId: string, actor?: OpsActor): Promise<AgentRun | null> {
    const previous = this.runs.get(runId);
    if (!previous || !['awaiting_approval', 'awaiting_evidence'].includes(previous.status)) return null;
    if (this.agentArts.getConfig().runtime !== 'agentarts') return null;
    const run = await this.runWithAgentArts({
      regionId: previous.region_id,
      trigger: `continuation:${runId}`,
      actor,
    });
    this.storeRun(run);
    this.audit.record({
      actor: 'agentarts',
      role: 'agent',
      action: 'agent.continue',
      entity_type: 'agent_run',
      entity_id: run.run_id,
      trace_id: run.trace_id,
      summary: `AgentArts 续接 ${runId}：${run.status}`,
      result: run.status === 'failed' ? 'failure' : 'success',
      after: { previous_run_id: runId, status: run.status, tools: run.trace.map(item => item.tool) },
    });
    return run;
  }

  /** 工单完成/失败后，按需续接等待中的平台运行。 */
  private maybeContinueRunsForOrder(orderId: string): void {
    if (process.env.AGENTARTS_AUTO_CONTINUE !== 'true') return;
    if (this.agentArts.getConfig().runtime !== 'agentarts') return;
    for (const run of this.listAgentRuns(100)) {
      if (!run.investigation.pending_work_order_ids.includes(orderId)) continue;
      if (!['awaiting_approval', 'awaiting_evidence'].includes(run.status)) continue;
      void this.continueAgentRun(run.run_id).catch(error => {
        this.audit.record({
          actor: 'system',
          role: 'system',
          action: 'agent.continue_failed',
          entity_type: 'agent_run',
          entity_id: run.run_id,
          summary: `AgentArts 续接失败：${(error as Error).message}`,
          result: 'failure',
          reason: (error as Error).message,
        });
      });
    }
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
    if (this.stateStore) this.persistState();
    else this.persistRuns();
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
    return this.agentArtsCache?.status ?? this.agentArts.status();
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
    this.maybeContinueRunsForOrder(order.id);
  }

  // ---------------------------------------------------------------- 多区域协同
  getMultiRegionAnalysis(regionId?: string): Record<string, unknown> {
    return analyzeMultiRegion(this, regionId);
  }

  // ---------------------------------------------------------------- 一键推演
  async runDemoScenario(kind: 'A_normal' | 'B_surge' | 'C_untrusted', actor: OpsActor): Promise<Record<string, unknown>> {
    this.resetAll(actor);
    return runUiDemo(this, kind, actor);
  }

  /** 读取已生成的竞赛基准摘要（若文件不存在则返回 available=false）。 */
  getExperimentSummary(): Record<string, unknown> {
    return readExperimentSummary();
  }

  // ---------------------------------------------------------------- 重置
  resetAll(actor: OpsActor = { username: 'system', role: 'admin' }): void {
    const previousRestoring = this.restoring;
    this.restoring = true;
    try {
      this.safety.reset(actor);
      this.ops.reset();
      this.replay.reset();
      this.runs.clear();
      this.runOrder = [];
      this.agentArtsCache = null;
    } finally {
      this.restoring = previousRestoring;
    }
    if (this.stateStore) this.persistState();
    else this.persistRuns();
  }
}
