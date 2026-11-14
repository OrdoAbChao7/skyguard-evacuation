/**
 * 合成观测时间轴仿真。
 *
 * 按场景配置的剧本逐步写入观测、触发规划、登记事件并运行 Agent，让前端能
 * 看到一条数据从“进入系统”到“形成决策”的全过程。
 *
 * 边界（不可违背）：
 *  - 所有观测都标记 source=simulation / provider=sim-live，不是真实数据；
 *  - 仿真不是 Agent，也不代表人工：不审批、不派发、不控制任何现场资源；
 *  - 需要人工的步骤只暂停并提示，审批/派发仍由工单接口和真人执行；
 *  - 场景未配置 ui_demos.simulation 时明确不可用，不在代码里写死数据。
 */
import type { AgentRun } from './agent';
import type { OpsActor, WorkOrder } from './ops';
import type { OpsService } from './ops';
import { assessObservation } from '../safety/observations';
import type { SafetyDecisionService, RecomputeResult } from '../safety/decision-service';
import type {
  SafetyScenario,
  SafetyState,
  UiSimulation,
  UiSimulationStep,
} from '../safety/types';

export type SimulationEventKind =
  | 'system'
  | 'observation'
  | 'plan'
  | 'state'
  | 'incident'
  | 'agent'
  | 'work_order'
  | 'human';

export interface SimulationEvent {
  seq: number;
  at: string;
  step_id: string;
  phase: string;
  kind: SimulationEventKind;
  title: string;
  detail?: string;
  state: SafetyState | null;
}

export interface SimulationStatus {
  available: boolean;
  reason?: string;
  running: boolean;
  paused: boolean;
  awaiting_human: boolean;
  finished: boolean;
  name: string;
  notice: string;
  started_at: string | null;
  finished_at: string | null;
  sequence: number;
  step_index: number;
  step_total: number;
  progress: number;
  steps: Array<{ index: number; id: string; phase: string; title: string; action: string }>;
  current: {
    index: number;
    total: number;
    id: string;
    phase: string;
    title: string;
    narrative: string;
    action: string;
  } | null;
  state: SafetyState;
  headline: string;
  counts: {
    observations: number;
    untrusted_regions: number;
    pending_work_orders: number;
    work_orders: number;
    agent_runs: number;
  };
  next_actions: string[];
  events: SimulationEvent[];
}

export interface SimulationHost {
  readonly scenario: SafetyScenario;
  readonly safety: SafetyDecisionService;
  readonly ops: OpsService;
  resetAll(actor: OpsActor): void;
  runAgent(options: {
    regionId: string;
    trigger: string;
    actor?: OpsActor;
  }): Promise<AgentRun>;
  listAgentRuns(limit?: number): AgentRun[];
}

type RunState = 'idle' | 'running' | 'paused' | 'awaiting_human' | 'finished';

interface SimulationOptions {
  autoplay?: boolean;
}

function cloneActor(actor: OpsActor): OpsActor {
  return { ...actor };
}

export class SimulationService {
  private runState: RunState = 'idle';
  private cursor = 0;
  private events: SimulationEvent[] = [];
  private sequence = 0;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private actor: OpsActor = { username: 'system', role: 'admin' };
  private incidentIds: string[] = [];
  private lastRunId: string | null = null;
  private awaitingStep: UiSimulationStep | null = null;

  constructor(private readonly host: SimulationHost) {}

  private get config(): UiSimulation | undefined {
    return this.host.scenario.ui_demos?.simulation;
  }

  private now(): Date {
    return new Date();
  }

  private pushEvent(input: Omit<SimulationEvent, 'seq' | 'at'>): void {
    this.sequence += 1;
    this.events.push({
      seq: this.sequence,
      at: this.now().toISOString(),
      ...input,
    });
    if (this.events.length > 120) this.events.splice(0, this.events.length - 120);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    this.clearTimer();
    const config = this.config;
    if (!config || this.runState !== 'running') return;
    this.timer = setInterval(() => {
      void this.tick();
    }, config.tick_ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.runState !== 'running') return;
    this.ticking = true;
    try {
      await this.advance();
    } finally {
      this.ticking = false;
    }
  }

  private currentState(): { state: SafetyState; headline: string; untrusted: number } {
    const status = this.host.safety.getStatus();
    return {
      state: status.state.state,
      headline: status.state.headline,
      untrusted: status.state.reasons.filter(reason => reason.code === 'untrusted_observation').length,
    };
  }

  private pendingOrders(): WorkOrder[] {
    return this.host.ops.listWorkOrders({ status: 'PENDING_APPROVAL' });
  }

  private async execute(step: UiSimulationStep): Promise<void> {
    const actor = this.actor;
    const base = { step_id: step.id, phase: step.phase, state: null as SafetyState | null };
    const config = this.config;
    if (!config) return;

    switch (step.action) {
      case 'recompute': {
        const result = this.host.safety.recompute(actor, `simulation:${step.id}`);
        const current = this.currentState();
        this.pushEvent({
          ...base,
          kind: 'plan',
          title: step.title,
          detail: `${this.planSummary(result)}；不可信区域 ${current.untrusted} 个`,
        });
        break;
      }

      case 'baseline': {
        const normal = this.host.scenario.ui_demos?.normal;
        if (!normal) {
          this.pushEvent({ ...base, kind: 'system', title: '基线数据缺失', detail: '场景未配置 ui_demos.normal，仿真无法写入基线观测。' });
          return;
        }
        const confidence = step.confidence ?? config.baseline_confidence;
        let written = 0;
        const missing: string[] = [];
        for (const region of this.host.scenario.regions) {
          if (!region.enabled) continue;
          const series = normal.series[region.id];
          if (!series || series.length === 0) {
            missing.push(region.id);
            continue;
          }
          this.ingest(region.id, series[series.length - 1], confidence, step, true);
          written += 1;
        }
        if (step.recompute !== false) this.host.safety.recompute(actor, `simulation:${step.id}`);
        const current = this.currentState();
        this.pushEvent({
          ...base,
          kind: 'observation',
          title: `写入 ${written} 个区域基线观测（合成）`,
          detail: `置信度 ${confidence} · 来源 simulation · 状态 ${current.state}`
            + (missing.length > 0 ? ` · 缺少基线：${missing.join(', ')}` : ''),
        });
        break;
      }

      case 'observe': {
        const entries = Object.entries(step.regions ?? {});
        for (const [regionId, sample] of entries) {
          this.ingest(regionId, sample.count, sample.confidence, step, sample.valid, sample.reason);
        }
        if (step.recompute !== false) this.host.safety.recompute(actor, `simulation:${step.id}`);
        const current = this.currentState();
        this.pushEvent({
          ...base,
          kind: 'observation',
          title: `写入 ${entries.length} 个区域观测（合成）`,
          detail: entries
            .map(([regionId, sample]) =>
              `${regionId} ${sample.count} 人 / 置信 ${sample.confidence}${sample.valid ? '' : ` / 无效（${sample.reason ?? '未说明'}）`}`)
            .join('；') + ` · 状态 ${current.state}`,
        });
        break;
      }

      case 'incident': {
        if (!step.incident) {
          this.pushEvent({ ...base, kind: 'system', title: '事件配置缺失', detail: 'incident 步骤缺少 incident 配置。' });
          return;
        }
        const incident = this.host.safety.createIncident({
          type: step.incident.type,
          description: step.incident.description,
          severity: step.incident.severity,
          affected: {
            region_ids: step.incident.region_ids,
            corridor_ids: step.incident.corridor_ids,
            exit_ids: step.incident.exit_ids,
          },
          source: 'simulation',
          actor: actor.username,
        });
        this.host.safety.confirmIncident(incident.id, actor);
        this.incidentIds.push(incident.id);
        if (step.recompute !== false) this.host.safety.recompute(actor, `simulation:${step.id}`);
        const current = this.currentState();
        this.pushEvent({
          ...base,
          kind: 'incident',
          title: `事件已确认：${step.title}`,
          detail: `${incident.id} · ${step.incident.type} · 约束版本 ${this.host.safety.getVersions().constraint} · 状态 ${current.state}`,
        });
        break;
      }

      case 'resolve_incident': {
        const resolved: string[] = [];
        for (const id of this.incidentIds) {
          const incident = this.host.safety.getIncidentStore().get(id);
          if (incident?.status === 'confirmed') {
            this.host.safety.resolveIncident(id, actor, '仿真：出口恢复通行');
            resolved.push(id);
          }
        }
        if (step.recompute !== false) this.host.safety.recompute(actor, `simulation:${step.id}`);
        const current = this.currentState();
        this.pushEvent({
          ...base,
          kind: 'incident',
          title: resolved.length > 0 ? `解除 ${resolved.length} 起事件并重新规划` : '没有需要解除的事件',
          detail: `${resolved.join(', ') || '—'} · 状态 ${current.state}`,
        });
        break;
      }

      case 'refresh_baseline': {
        const normal = this.host.scenario.ui_demos?.normal;
        if (!normal) {
          this.pushEvent({ ...base, kind: 'system', title: '基线数据缺失', detail: '场景未配置 ui_demos.normal，无法补采基线。' });
          return;
        }
        const confidence = step.confidence ?? config.baseline_confidence;
        const now = this.now();
        const store = this.host.safety.getObservationStore();
        let written = 0;
        let kept = 0;
        for (const region of this.host.scenario.regions) {
          if (!region.enabled) continue;
          const series = normal.series[region.id];
          if (!series || series.length === 0) {
            kept += 1;
            continue;
          }
          const latest = store.latest(region.id);
          if (latest) {
            const assessment = assessObservation(latest, this.host.scenario.config, now);
            // 只补采仿真自己的观测：人工反馈、真实 provider、低置信与无效观测都不覆盖。
            // 注意：stale 也会让 assessment.trusted=false，所以这里必须分开判断。
            if (latest.source === 'field_report' || latest.provider !== 'sim-live'
              || assessment.lowConfidence || assessment.invalid) {
              kept += 1;
              continue;
            }
            if (!assessment.stale) {
              kept += 1;
              continue;
            }
          }
          this.ingest(region.id, series[series.length - 1], confidence, step, true);
          written += 1;
        }
        if (step.recompute !== false) this.host.safety.recompute(actor, `simulation:${step.id}`);
        const current = this.currentState();
        this.pushEvent({
          ...base,
          kind: 'observation',
          title: `补采 ${written} 个区域基线；保留 ${kept} 个`,
          detail: `保留原因：现场反馈、仍可疑或仍在 ${this.host.scenario.config.max_observation_age_seconds}s 时效内 · 状态 ${current.state}`,
        });
        break;
      }

      case 'agent': {
        const regionId = step.agent_region_id;
        if (!regionId) {
          this.pushEvent({ ...base, kind: 'system', title: '调查区域缺失', detail: 'agent 步骤缺少 agent_region_id。' });
          return;
        }
        const run = await this.host.runAgent({
          regionId,
          trigger: `simulation:${step.id}`,
          actor,
        });
        this.lastRunId = run.run_id;
        this.pushEvent({
          ...base,
          kind: 'agent',
          title: `Agent ${run.status}：${step.title}`,
          detail: `${run.run_id} · ${run.investigation.rounds.length} 轮调查 · ${run.trace.length} 次工具调用 · ${run.summary}`,
        });
        if (run.work_orders.length > 0) {
          this.pushEvent({
            ...base,
            kind: 'work_order',
            title: `创建 ${run.work_orders.length} 个待审批工单`,
            detail: run.work_orders
              .map(order => `${String(order.id ?? '—')} ${String(order.title ?? '')}`.trim())
              .join('；') + ' · Agent 不审批、不派发',
          });
        }
        break;
      }

      case 'await_human': {
        const pending = this.pendingOrders();
        this.runState = 'awaiting_human';
        this.awaitingStep = step;
        this.clearTimer();
        this.pushEvent({
          ...base,
          kind: 'human',
          title: '仿真暂停：等待人工操作',
          detail: pending.length > 0
            ? `待审批工单 ${pending.length} 个；审批与派发必须由管理员完成。`
            : '当前没有待审批工单；可直接继续复核。',
        });
        break;
      }

      default: {
        this.pushEvent({ ...base, kind: 'system', title: '未知步骤', detail: `不支持的 action：${String((step as { action?: string }).action)}` });
      }
    }
  }

  private ingest(
    regionId: string,
    count: number,
    confidence: number,
    step: UiSimulationStep,
    valid = true,
    reason?: string,
  ): void {
    this.host.safety.ingestObservation({
      regionId,
      count,
      confidence,
      source: 'simulation',
      provider: 'sim-live',
      modelVersion: 'sim-live/1.0.0',
      observedAt: this.now(),
      valid,
      invalidReason: reason,
      evidence: {
        synthetic: true,
        simulation: true,
        step_id: step.id,
        note: '合成仿真观测，不是真实场馆数据',
      },
    }, this.actor);
  }

  private planSummary(result: RecomputeResult): string {
    const plan = result.plan
      ? `方案 ${result.plan.plan_id}，疏散 ${result.plan.evacuated_persons}/${result.plan.total_persons} 人`
      : '未生成方案（规划被跳过或被拒绝）';
    return `${plan}；校验${result.validation?.valid ? '通过' : '未通过'}；状态 ${result.snapshot.state}`;
  }

  private async advance(): Promise<void> {
    const config = this.config;
    if (!config || this.runState === 'finished' || this.runState === 'idle') return;
    const step = config.steps[this.cursor];
    if (!step) {
      this.finish();
      return;
    }
    const before = this.currentState();
    this.cursor += 1;
    try {
      await this.execute(step);
    } catch (error) {
      this.pushEvent({
        step_id: step.id,
        phase: step.phase,
        kind: 'system',
        state: null,
        title: '仿真步骤失败',
        detail: (error as Error).message,
      });
      if (this.runState === 'running') this.runState = 'paused';
      this.clearTimer();
    }
    const after = this.currentState();
    if (before.state !== after.state) {
      this.pushEvent({
        step_id: step.id,
        phase: step.phase,
        kind: 'state',
        state: after.state,
        title: `安全状态 ${before.state} → ${after.state}`,
        detail: after.headline,
      });
    }
    if (this.runState === 'awaiting_human') this.clearTimer();
    if (this.cursor >= config.steps.length && this.runState !== 'awaiting_human') this.finish();
  }

  private finish(): void {
    if (this.runState === 'finished') return;
    this.clearTimer();
    this.runState = 'finished';
    this.awaitingStep = null;
    this.finishedAt = this.now().toISOString();
    this.pushEvent({
      step_id: 'finish',
      phase: '结束',
      kind: 'system',
      state: this.currentState().state,
      title: '仿真结束',
      detail: '所有剧本步骤已执行；合成数据不会自动变成真实结论。',
    });
  }

  async start(actor: OpsActor, options: SimulationOptions = {}): Promise<SimulationStatus> {
    const config = this.config;
    if (!config) return this.getStatus();
    this.abort();
    const autoplay = options.autoplay !== false;
    this.actor = cloneActor(actor);
    this.runState = autoplay ? 'running' : 'paused';
    this.startedAt = this.now().toISOString();
    this.pushEvent({
      step_id: 'start',
      phase: '仿真',
      kind: 'system',
      state: null,
      title: `仿真开始：${config.name}`,
      detail: config.notice,
    });
    if (!autoplay) return this.getStatus();
    this.schedule();
    await this.advance();
    return this.getStatus();
  }

  async step(): Promise<SimulationStatus> {
    const config = this.config;
    if (!config || this.runState === 'finished' || this.runState === 'idle') return this.getStatus();
    this.clearTimer();
    this.awaitingStep = null;
    this.runState = 'running';
    await this.advance();
    if (this.runState === 'running') this.runState = 'paused';
    return this.getStatus();
  }

  pause(): SimulationStatus {
    if (this.runState === 'running') {
      this.clearTimer();
      this.runState = 'paused';
      this.pushEvent({
        step_id: 'pause',
        phase: '仿真',
        kind: 'human',
        state: null,
        title: '仿真已暂停',
        detail: '观测不再推进；超过 90 秒有效期后系统会按 fail-closed 降级。',
      });
    }
    return this.getStatus();
  }

  async resume(): Promise<SimulationStatus> {
    if (!this.config || this.runState === 'finished' || this.runState === 'idle') return this.getStatus();
    const wasAwaiting = this.runState === 'awaiting_human';
    this.runState = 'running';
    this.awaitingStep = null;
    this.pushEvent({
      step_id: 'resume',
      phase: '仿真',
      kind: 'human',
      state: null,
      title: '继续仿真',
      detail: wasAwaiting ? '人工步骤已完成或已跳过，继续复核。' : '仿真继续推进。',
    });
    this.schedule();
    if (wasAwaiting) await this.advance();
    return this.getStatus();
  }

  /** 全局重置 / 一键推演时静默停止，不产生额外事件。 */
  abort(): void {
    this.clearTimer();
    this.ticking = false;
    this.runState = 'idle';
    this.cursor = 0;
    this.events = [];
    this.sequence = 0;
    this.startedAt = null;
    this.finishedAt = null;
    this.incidentIds = [];
    this.lastRunId = null;
    this.awaitingStep = null;
  }

  getStatus(): SimulationStatus {
    const config = this.config;
    const safetyStatus = this.host.safety.getStatus();
    if (!config) {
      return {
        available: false,
        reason: '当前场景未配置 ui_demos.simulation；为保证场景可替换，不在代码里写死仿真剧本。',
        running: false,
        paused: false,
        awaiting_human: false,
        finished: false,
        name: '',
        notice: '',
        started_at: null,
        finished_at: null,
        sequence: this.sequence,
        step_index: 0,
        step_total: 0,
        progress: 0,
        steps: [],
        current: null,
        state: safetyStatus.state.state,
        headline: safetyStatus.state.headline,
        counts: {
          observations: safetyStatus.observations.length,
          untrusted_regions: safetyStatus.state.reasons.filter(reason => reason.code === 'untrusted_observation').length,
          pending_work_orders: this.pendingOrders().length,
          work_orders: this.host.ops.listWorkOrders().length,
          agent_runs: this.host.listAgentRuns(50).length,
        },
        next_actions: [],
        events: [],
      };
    }

    const total = config.steps.length;
    const awaiting = this.runState === 'awaiting_human';
    // current 表示“刚刚执行完的那一步”，而不是下一步；面板叙事与日志才对得上。
    const displayStep = awaiting && this.awaitingStep
      ? this.awaitingStep
      : this.cursor > 0
        ? config.steps[this.cursor - 1] ?? null
        : null;
    const displayIndex = displayStep
      ? config.steps.findIndex(item => item.id === displayStep.id) + 1
      : total;
    const orders = this.host.ops.listWorkOrders();

    return {
      available: true,
      running: this.runState === 'running',
      paused: this.runState === 'paused',
      awaiting_human: awaiting,
      finished: this.runState === 'finished',
      name: config.name,
      notice: config.notice,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      sequence: this.sequence,
      step_index: this.cursor,
      step_total: total,
      progress: total > 0 ? Number((this.cursor / total).toFixed(4)) : 0,
      steps: config.steps.map((item, index) => ({
        index: index + 1,
        id: item.id,
        phase: item.phase,
        title: item.title,
        action: item.action,
      })),
      current: displayStep ? {
        index: displayIndex,
        total,
        id: displayStep.id,
        phase: displayStep.phase,
        title: displayStep.title,
        narrative: displayStep.narrative,
        action: displayStep.action,
      } : null,
      state: safetyStatus.state.state,
      headline: safetyStatus.state.headline,
      counts: {
        observations: safetyStatus.observations.length,
        untrusted_regions: safetyStatus.state.reasons.filter(reason => reason.code === 'untrusted_observation').length,
        pending_work_orders: orders.filter(order => order.status === 'PENDING_APPROVAL').length,
        work_orders: orders.length,
        agent_runs: this.host.listAgentRuns(50).length,
      },
      next_actions: awaiting ? (this.awaitingStep?.next_actions ?? []) : [],
      events: this.events.slice(-60),
    };
  }
}
