/**
 * 主干智能体（本地确定式运行时）。
 *
 * 职责：接收异常 → 读取态势 → 识别信息缺口 → 评估 VoI → 调用工具取证 →
 * 整合证据 → 推荐人员 → 创建待审批工单 → 输出可审计决策。
 *
 * 边界：
 *  - 路线规划与安全校验由专业算法完成，Agent 只调用工具；
 *  - Agent 不能审批、派发、封闭出口或控制无人机起飞；
 *  - 本地模式固定标记为 LOCAL_DEMO，不得伪装成 AgentArts 实机运行。
 */
import { randomUUID } from 'node:crypto';
import type { InvestigationOutcome, SafetyScenario } from '../safety/types';
import type { SafetyStatus } from '../safety/decision-service';
import type { ToolRegistry, ToolResult } from './tools';
import type { OpsActor } from './ops';
import type { AvailabilityMap } from './voi';
import { applyEvidence, decideInvestigation, priorBelief, type BeliefEntry, type VoIDecision } from './voi';
import { buildInvestigationAvailability } from './availability';
import { actionAvailability, createInvestigationSession, recordAttempt } from './investigation-session';
import type { PredictionResult } from './prediction';

export type AgentRunStatus = 'completed' | 'awaiting_approval' | 'awaiting_evidence' | 'needs_human' | 'failed';
export type AgentRuntimeMode = 'LOCAL_DEMO' | 'AGENTARTS_CONNECTED' | 'AGENTARTS_UNAVAILABLE';

export interface ToolCallTrace {
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  status: 'ok' | 'error';
  result_summary: string;
  source: string;
  confidence: number | null;
  duration_ms: number;
  evidence_id?: string;
}

export interface InvestigationRound {
  round: number;
  decision: VoIDecision;
  selected_action_id: string | null;
  selected_kind: string | null;
  outcome: InvestigationOutcome | null;
  pending: boolean;
  note: string;
}

export interface AgentRun {
  run_id: string;
  /** 与 run_id 相同的 Trace 关联 ID，供审计与平台关联。 */
  trace_id: string;
  mode: AgentRuntimeMode;
  runtime_detail: string;
  scenario_id: string;
  trigger: string;
  region_id: string;
  status: AgentRunStatus;
  started_at: string;
  completed_at: string;
  state: SafetyStatus['state'];
  belief_before: BeliefEntry[];
  belief_after: BeliefEntry[];
  entropy_before_bits: number | null;
  entropy_after_bits: number | null;
  risk_before: number | null;
  risk_after: number | null;
  investigation: {
    required: boolean;
    reason: string;
    rounds: InvestigationRound[];
    pending_work_order_ids: string[];
    stopped_reason: string | null;
  };
  prediction: PredictionResult | null;
  camera: Record<string, unknown> | null;
  risk: Record<string, unknown> | null;
  staff_recommendation: Record<string, unknown> | null;
  work_orders: Array<Record<string, unknown>>;
  recommendations: string[];
  trace: ToolCallTrace[];
  summary: string;
  limitations: string[];
}

export interface AgentRunOptions {
  regionId: string;
  trigger: string;
  actor?: OpsActor;
}

const AGENT_ACTOR: OpsActor = { username: 'skyguard-agent', role: 'agent', kind: 'agent' };

function toBeliefSummary(belief: BeliefEntry[]): BeliefEntry[] {
  return belief.map(item => ({ ...item, probability: Number(item.probability.toFixed(6)) }));
}

function entropyOf(belief: BeliefEntry[]): number {
  return -belief.reduce((sum, item) => sum + (item.probability > 0 ? item.probability * Math.log2(item.probability) : 0), 0);
}

function riskOf(belief: BeliefEntry[], lossMatrix: Record<string, Record<string, number>>, decisions: string[]): number {
  const perDecision = decisions.map(decision => belief.reduce((sum, item) => {
    const loss = lossMatrix[item.hypothesis_id]?.[decision];
    return sum + item.probability * (typeof loss === 'number' ? loss : 1);
  }, 0));
  return perDecision.length > 0 ? Math.min(...perDecision) : 0;
}

function likelihoodKindForSource(source: string): 'camera_query' | 'staff_check' | 'uav_request' | 'history_query' | 'prediction' {
  if (source === 'field_report') return 'staff_check';
  if (source === 'uav_observation') return 'uav_request';
  if (source === 'recorded_video' || source === 'live_video') return 'camera_query';
  if (source === 'simulation') return 'history_query';
  return 'camera_query';
}

function summarizeToolResult(result: ToolResult): string {
  if (!result.ok) return `失败：${result.error ?? 'unknown error'}`;
  const data = result.data as Record<string, unknown> | null;
  if (!data) return 'ok';
  if ('outcome' in data) return `outcome=${String(data.outcome)}${data.pending ? '（待人工证据）' : ''}`;
  if ('state' in data) return `state=${JSON.stringify((data.state as any)?.state ?? data.state)}`;
  if ('prediction' in data) return `prediction=${JSON.stringify((data.prediction as any)?.predicted_count ?? null)}`;
  if ('cameras' in data) return `cameras=${(data.cameras as unknown[]).length}`;
  if ('work_order' in data) return `work_order=${(data.work_order as any)?.id ?? 'created'}`;
  if ('recommended' in data) return `recommended=${(data.recommended as any)?.staff_id ?? 'none'}`;
  if ('regions' in data) return `regions=${(data.regions as unknown[]).length}`;
  if ('points' in data) return `points=${(data.points as unknown[]).length}`;
  if ('rules' in data) return `rules=${(data.rules as unknown[]).length}`;
  return 'ok';
}

export class AgentService {
  constructor(
    private readonly scenario: SafetyScenario,
    private readonly tools: ToolRegistry,
  ) {}

  getMode(): AgentRuntimeMode {
    return 'LOCAL_DEMO';
  }

  getRuntimeDetail(): string {
    return '本地确定式运行时：由 VoI 引擎选择调查动作并调用工具；未连接华为云 AgentArts。';
  }

  async run(options: AgentRunOptions): Promise<AgentRun> {
    const startedAt = new Date();
    const runId = `RUN-${randomUUID().slice(0, 8)}`;
    const actor = options.actor ?? AGENT_ACTOR;
    const trace: ToolCallTrace[] = [];
    const evidence: Array<Record<string, unknown>> = [];
    const pendingWorkOrders: Record<string, unknown>[] = [];

    const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      const result = await this.tools.invoke(name, args, actor);
      trace.push({
        seq: trace.length + 1,
        tool: name,
        args,
        ok: result.ok,
        status: result.ok ? 'ok' : 'error',
        result_summary: summarizeToolResult(result),
        source: result.source,
        confidence: result.confidence,
        duration_ms: result.duration_ms ?? 0,
      });
      return result;
    };

    const statusResult = await call('get_crowd_status', { region_id: options.regionId });
    if (!statusResult.ok) {
      return this.failedRun(runId, options, startedAt, trace, statusResult.error ?? '无法读取态势');
    }
    const status = statusResult.data as {
      state: SafetyStatus['state'];
      regions: Array<{
        region_id: string;
        observation: { trusted: boolean; confidence: number; source: string; age_seconds: number | null; count: number; density: number } | null;
        risk: { level: string; trusted: boolean; count: number; density: number } | null;
      }>;
      summary: Record<string, unknown>;
    };
    const regionStatus = status.regions[0];

    const cameraResult = await call('get_camera_status', { region_id: options.regionId });
    const camera = cameraResult.ok
      ? (cameraResult.data as { cameras: Array<Record<string, unknown>> }).cameras[0] ?? null
      : null;

    const predictionResult = await call('predict_crowd_trend', { region_id: options.regionId, horizon_minutes: 5 });
    const prediction = predictionResult.ok ? predictionResult.data as PredictionResult : null;

    const riskResult = await call('evaluate_region_risk', { region_id: options.regionId });
    const risk = riskResult.ok ? riskResult.data as Record<string, unknown> : null;

    const policy = this.scenario.investigation;
    const session = policy ? createInvestigationSession(options.regionId) : null;
    const policyBelief = policy ? priorBelief(policy) : [];
    let belief = policyBelief;
    let beliefUpdatedFromEvidence = false;

    const observation = regionStatus?.observation ?? null;
    const trustedObservation = Boolean(observation?.trusted);
    if (policy && observation && trustedObservation) {
      const outcome: InvestigationOutcome = observation.density >= (this.scenario.regions.find(item => item.id === options.regionId)?.thresholds?.high_density ?? this.scenario.config.default_thresholds.high_density)
        ? 'signal_congested'
        : 'signal_normal';
      belief = applyEvidence(policy, belief, likelihoodKindForSource(observation.source), outcome);
      beliefUpdatedFromEvidence = true;
      evidence.push({
        evidence_id: `EV-OBS-${randomUUID().slice(0, 6)}`,
        kind: 'observation',
        summary: `可信观测：${observation.count} 人 / 密度 ${observation.density}（${observation.source}）`,
        source: observation.source,
        confidence: observation.confidence,
        observed_at: new Date().toISOString(),
      });
    }

    const informationGap = !observation || !trustedObservation;
    const rounds: InvestigationRound[] = [];
    const pendingIds: string[] = [];
    let stoppedReason: string | null = null;
    let investigationsUsed = 0;
    let pendingEvidence = false;
    let uavAvailable = false;

    if (policy && informationGap) {
      const staffResult = await call('recommend_staff', { region_id: options.regionId, required_skills: ['crowd_check'] });
      const staffRecommendation = staffResult.ok
        ? staffResult.data as { recommended: { staff_id: string } | null }
        : { recommended: null };
      const uavResult = await call('get_venue_information', {});
      const uavUnits = uavResult.ok
        ? ((uavResult.data as { uav_units: Array<{ status: string }> }).uav_units ?? [])
        : [];
      const trendResult = await call('get_region_trend', { region_id: options.regionId });
      const trendPoints = trendResult.ok
        ? ((trendResult.data as { points: unknown[] }).points ?? []).length
        : 0;

      uavAvailable = uavUnits.some(unit => unit.status === 'available');
      const availability: AvailabilityMap = buildInvestigationAvailability(policy, {
        cameraOnline: Boolean(camera && camera.state !== 'offline'),
        cameraReason: `摄像头离线：${String(camera?.reason ?? '无可用设备')}`,
        staffAvailable: Boolean(staffRecommendation.recommended),
        staffReason: '没有满足技能与可达性要求的可用工作人员',
        uavAvailable,
        uavReason: '没有可用无人机或未获批准',
        historyPoints: trendPoints,
      });

      for (let round = 1; round <= policy.max_investigations; round += 1) {
        // 每轮重新检查预算、冷却与重试次数；已用成本 + 候选成本必须放得进预算。
        if (session) {
          for (const policyAction of policy.actions) {
            const status = actionAvailability(policy, policyAction, session);
            if (!status.available) {
              availability[policyAction.id] = { available: false, reason: status.reason ?? '当前不可用' };
            }
          }
        }
        const decision = decideInvestigation(policy, belief, { availability, investigationsUsed });
        const selected = decision.recommended_action_id;
        const action = policy.actions.find(item => item.id === selected) ?? null;

        if (!decision.should_investigate || !action) {
          stoppedReason = decision.stop_reason ?? 'agent_stopped';
          rounds.push({
            round,
            decision,
            selected_action_id: null,
            selected_kind: null,
            outcome: null,
            pending: false,
            note: this.stopNote(decision),
          });
          break;
        }

        investigationsUsed += 1;
        // 同一调查动作在同一轮决策中不重复选择；否则会浪费调查轮次。
        availability[action.id] = { available: false, reason: '本轮已执行' };
        let outcome: InvestigationOutcome = 'inconclusive';
        let pending = false;
        let note = '';
        let toolResult: ToolResult | null = null;

        if (action.kind === 'camera_query') {
          toolResult = await call('request_supplemental_observation', { region_id: options.regionId, channel: 'camera' });
          outcome = toolResult.ok ? (toolResult.data as { outcome: InvestigationOutcome }).outcome : 'unavailable';
          note = `摄像头查询结果：${outcome}`;
        } else if (action.kind === 'staff_check') {
          toolResult = await call('request_supplemental_observation', { region_id: options.regionId, channel: 'staff' });
          pending = Boolean(toolResult.ok && (toolResult.data as { pending?: boolean }).pending);
          outcome = 'inconclusive';
          note = pending ? '已创建现场核查工单，等待审批与工作人员反馈' : '现场核查请求失败';
          if (pending) {
            const order = (toolResult?.data as { work_order?: Record<string, unknown> & { id?: string } }).work_order;
            if (order?.id) {
              pendingIds.push(order.id);
              pendingWorkOrders.push(order);
            }
          }
        } else if (action.kind === 'uav_request') {
          toolResult = await call('request_uav_observation', {
            region_id: options.regionId,
            reason: `VoI 评估选择无人机补充观察：${action.label}`,
          });
          pending = Boolean(toolResult.ok && (toolResult.data as { pending?: boolean }).pending);
          outcome = 'inconclusive';
          note = pending ? '已创建无人机观察工单，等待审批与持证操作员执行' : '无人机请求失败';
          if (pending) {
            const order = (toolResult?.data as { work_order?: Record<string, unknown> & { id?: string } }).work_order;
            if (order?.id) {
              pendingIds.push(order.id);
              pendingWorkOrders.push(order);
            }
          }
        } else if (action.kind === 'history_query') {
          toolResult = await call('get_region_trend', { region_id: options.regionId });
          if (toolResult.ok) {
            const points = (toolResult.data as {
              points: Array<{ count: number; valid: boolean }>;
            }).points.filter(item => item.valid);
            if (points.length >= 2) {
              const first = points[0].count;
              const last = points[points.length - 1].count;
              outcome = last >= first * 1.15 ? 'signal_congested' : last <= first * 0.85 ? 'signal_normal' : 'inconclusive';
            } else {
              outcome = 'unavailable';
            }
            note = `历史趋势：${points.length} 个点，判定 ${outcome}`;
          }
        } else {
          toolResult = await call('predict_crowd_trend', { region_id: options.regionId, horizon_minutes: 5 });
          if (toolResult.ok) {
            const result = toolResult.data as PredictionResult;
            const region = this.scenario.regions.find(item => item.id === options.regionId)!;
            const threshold = region.thresholds?.high_density ?? this.scenario.config.default_thresholds.high_density;
            outcome = result.sufficient && result.predicted_count !== null && result.predicted_count / region.area_m2 >= threshold
              ? 'signal_congested'
              : result.sufficient && result.trend.direction === 'rising'
                ? 'signal_congested'
                : result.sufficient && result.trend.direction === 'falling'
                  ? 'signal_normal'
                  : 'inconclusive';
            note = `预测趋势：${outcome}`;
          }
        }

        if (toolResult && toolResult.ok) {
          evidence.push({
            evidence_id: `EV-${action.id}-${randomUUID().slice(0, 6)}`,
            kind: action.kind,
            summary: note,
            source: toolResult.source,
            confidence: toolResult.confidence,
            observed_at: toolResult.generated_at,
          });
        }

        if (outcome !== 'unavailable') {
          belief = applyEvidence(policy, belief, action.kind, outcome);
          beliefUpdatedFromEvidence = true;
        }

        // 资源与时间成本按实际尝试结算；失败尝试也计费（不自动免费）。
        if (session) {
          recordAttempt(session, action, { success: outcome !== 'unavailable', outcome });
        }

        rounds.push({
          round,
          decision,
          selected_action_id: action.id,
          selected_kind: action.kind,
          outcome,
          pending,
          note,
        });

        if (pending) {
          pendingEvidence = true;
          stoppedReason = 'awaiting_human_evidence';
          break;
        }

        // 若调查仍然无法提供新信息，继续下一轮前重新计算可用性与 VoI。
        if (outcome === 'inconclusive' && round >= policy.max_investigations) {
          stoppedReason = 'evidence_inconclusive';
        }
      }

      // 信息缺口尚未闭合时，补建两类互补证据请求（地面核查 + 空中观察），均需人工审批。
      if (pendingEvidence) {
        const hasOrder = (type: string) => pendingWorkOrders.some(order => order.type === type);
        if (!hasOrder('scene_verification')) {
          const staffCheck = await call('request_supplemental_observation', {
            region_id: options.regionId,
            channel: 'staff',
          });
          const order = (staffCheck.data as { work_order?: Record<string, unknown> & { id?: string } } | null)?.work_order;
          if (order?.id) {
            pendingIds.push(order.id);
            pendingWorkOrders.push(order);
          }
        }
        if (uavAvailable && !hasOrder('uav_observation')) {
          const uavResult = await call('request_uav_observation', {
            region_id: options.regionId,
            reason: '固定摄像头数据不可信，申请无人机补充观察以核实区域人流。',
          });
          const order = (uavResult.data as { work_order?: Record<string, unknown> & { id?: string } } | null)?.work_order;
          if (order?.id) {
            pendingIds.push(order.id);
            pendingWorkOrders.push(order);
          }
        }
      }
    } else if (policy) {
      stoppedReason = 'data_trusted_no_investigation';
    } else {
      stoppedReason = 'no_investigation_policy';
    }

    // 人员推荐与候选工单（只有风险非正常或存在信息缺口时才生成）。
    let staffRecommendation: Record<string, unknown> | null = null;
    const workOrders: Array<Record<string, unknown>> = [...pendingWorkOrders];
    const riskLevel = String((risk as { risk?: { level?: string } } | null)?.risk?.level ?? 'unknown');
    const region = this.scenario.regions.find(item => item.id === options.regionId);
    const watchThreshold = region?.thresholds?.watch_density ?? this.scenario.config.default_thresholds.watch_density;
    const densityElevated = Boolean(observation && observation.density >= watchThreshold);
    const shouldDispatch = informationGap
      || (densityElevated && ['watch', 'high', 'critical'].includes(riskLevel));

    if (shouldDispatch) {
      const recommendationResult = await call('recommend_staff', {
        region_id: options.regionId,
        required_skills: ['crowd_control'],
        preferred_roles: ['crowd_control'],
      });
      staffRecommendation = recommendationResult.ok
        ? recommendationResult.data as Record<string, unknown>
        : null;

      const orderListResult = await call('get_work_order_status', {});
      const existing = orderListResult.ok
        ? (orderListResult.data as { work_orders: Array<{ id: string; status: string; region_id?: string; type: string }> }).work_orders
        : [];
      const hasOpenRegionOrder = existing.some(order =>
        order.region_id === options.regionId
        && !['COMPLETED', 'FAILED', 'REJECTED'].includes(order.status),
      );
      if (!hasOpenRegionOrder && riskLevel !== 'normal') {
        const recommended = (staffRecommendation as { recommended?: { staff_id: string; reasons: string[]; score: number } } | null)?.recommended;
        const orderResult = await call('create_candidate_work_order', {
          type: 'crowd_control',
          title: `${status.regions[0]?.region_id ?? options.regionId} 人流疏导建议`,
          description: `风险等级 ${riskLevel}，建议在区域入口实施分流与限流，并回报现场执行结果。`,
          priority: riskLevel === 'critical' ? 'critical' : riskLevel === 'high' ? 'high' : 'medium',
          region_id: options.regionId,
          required_skills: ['crowd_control'],
          evidence: evidence.slice(-3).map(item => ({
            evidence_id: String(item.evidence_id),
            kind: String(item.kind),
            summary: String(item.summary),
            source: String(item.source),
          })),
          recommendation: recommended
            ? { staff_id: recommended.staff_id, reasons: recommended.reasons, score: recommended.score }
            : { staff_id: null, reasons: ['无可用人员，需人工协调'], score: null },
          submit: true,
        });
        if (orderResult.ok) {
          const order = (orderResult.data as { work_order: Record<string, unknown> }).work_order;
          workOrders.push(order);
          pendingIds.push(String(order.id));
        }
      }
    }

    const statusAfterResult = await call('get_crowd_status', { region_id: options.regionId });
    const finalState = statusAfterResult.ok
      ? (statusAfterResult.data as { state: SafetyStatus['state'] }).state
      : status.state;

    const finalEntropy = policy ? entropyOf(belief) : null;
    const finalRisk = policy ? riskOf(belief, policy.loss_matrix, policy.decisions) : null;
    const initialEntropy = policy ? entropyOf(policyBelief) : null;
    const initialRisk = policy ? riskOf(policyBelief, policy.loss_matrix, policy.decisions) : null;
    const stateName = finalState.state;
    let runStatus: AgentRunStatus = 'completed';
    if (pendingEvidence) runStatus = 'awaiting_evidence';
    else if (['DEGRADED', 'REJECT'].includes(stateName)) runStatus = 'needs_human';
    else if (pendingIds.length > 0) runStatus = 'awaiting_approval';

    const recommendations = this.buildRecommendations({
      regionId: options.regionId,
      riskLevel,
      rounds,
      pendingIds,
      runStatus,
      prediction,
    });
    const summary = this.buildSummary({
      regionId: options.regionId,
      state: stateName,
      informationGap,
      rounds,
      pendingIds,
      riskLevel,
      runStatus,
      beliefUpdatedFromEvidence,
      initialEntropy,
      finalEntropy,
      initialRisk,
      finalRisk,
    });

    return {
      run_id: runId,
      trace_id: runId,
      mode: this.getMode(),
      runtime_detail: this.getRuntimeDetail(),
      scenario_id: this.scenario.scenario_id,
      trigger: options.trigger,
      region_id: options.regionId,
      status: runStatus,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      state: finalState,
      belief_before: toBeliefSummary(policyBelief),
      belief_after: toBeliefSummary(belief),
      entropy_before_bits: initialEntropy === null ? null : Number(initialEntropy.toFixed(6)),
      entropy_after_bits: finalEntropy === null ? null : Number(finalEntropy.toFixed(6)),
      risk_before: initialRisk === null ? null : Number(initialRisk.toFixed(6)),
      risk_after: finalRisk === null ? null : Number(finalRisk.toFixed(6)),
      investigation: {
        required: informationGap,
        reason: informationGap ? '观测不可信或预测数据不足' : '观测可信且数据充分，无需调查',
        rounds,
        pending_work_order_ids: pendingIds,
        stopped_reason: stoppedReason,
      },
      prediction,
      camera,
      risk,
      staff_recommendation: staffRecommendation,
      work_orders: workOrders,
      recommendations,
      trace,
      summary,
      limitations: [
        '本地运行时由确定性规则与 VoI 模型驱动，不是华为云 AgentArts 实机运行。',
        '场景中的先验、似然、损失与人员位置均为合成数据，未经真实场馆标定。',
        '无人机与昇腾推理未连接真实设备；相关动作只创建待审批请求。',
      ],
    };
  }

  private stopNote(decision: VoIDecision): string {
    switch (decision.stop_reason) {
      case 'voi_below_threshold': return `最佳 VoI 低于阈值 ${decision.stop_threshold}，停止调查。`;
      case 'max_investigations_reached': return '达到最大调查轮次，停止调查。';
      case 'no_available_action': return '没有可用调查动作，转人工。';
      default: return '无需继续调查。';
    }
  }

  private buildRecommendations(input: {
    regionId: string;
    riskLevel: string;
    rounds: InvestigationRound[];
    pendingIds: string[];
    runStatus: AgentRunStatus;
    prediction: PredictionResult | null;
  }): string[] {
    const recommendations: string[] = [];
    if (input.runStatus === 'needs_human') {
      recommendations.push('当前安全状态要求人工介入：请恢复感知或调整现场约束后再发布路线。');
    }
    if (input.rounds.length > 0) {
      const selected = input.rounds.filter(round => round.selected_action_id).map(round => round.selected_kind).join('、');
      recommendations.push(`已按 VoI 选择调查动作：${selected || '无'}。`);
    }
    if (input.pendingIds.length > 0) {
      recommendations.push(`已创建 ${input.pendingIds.length} 个待审批工单；Agent 不会自动派发或执行。`);
    }
    if (input.riskLevel === 'high' || input.riskLevel === 'critical') {
      recommendations.push('建议管理人员优先审批人流疏导任务，并持续观察该区域趋势。');
    }
    if (input.prediction && input.prediction.trend.direction === 'rising') {
      recommendations.push(`预测显示人流上升（${input.prediction.trend.rate_per_minute ?? '—'} 人/分钟），建议提前部署疏导人员。`);
    }
    if (recommendations.length === 0) recommendations.push('当前无需额外处置，保持常态监测。');
    return recommendations;
  }

  private buildSummary(input: {
    regionId: string;
    state: string;
    informationGap: boolean;
    rounds: InvestigationRound[];
    pendingIds: string[];
    riskLevel: string;
    runStatus: AgentRunStatus;
    beliefUpdatedFromEvidence: boolean;
    initialEntropy: number | null;
    finalEntropy: number | null;
    initialRisk: number | null;
    finalRisk: number | null;
  }): string {
    const parts = [
      `区域 ${input.regionId} 当前安全状态 ${input.state}，风险等级 ${input.riskLevel}。`,
      input.informationGap ? '检测到信息缺口，启动主动调查。' : '数据可信，未启动调查。',
    ];
    if (input.rounds.some(round => round.selected_action_id)) {
      parts.push(`执行 ${input.rounds.filter(round => round.selected_action_id).length} 轮调查。`);
    }
    if (input.beliefUpdatedFromEvidence && input.initialEntropy !== null && input.finalEntropy !== null) {
      parts.push(`信念熵 ${input.initialEntropy.toFixed(3)} → ${input.finalEntropy.toFixed(3)} bit，预期风险 ${input.initialRisk?.toFixed(3)} → ${input.finalRisk?.toFixed(3)}。`);
    }
    if (input.pendingIds.length > 0) parts.push(`创建 ${input.pendingIds.length} 个待审批工单，等待人工审批与执行。`);
    parts.push(`运行状态：${input.runStatus}。`);
    return parts.join('');
  }

  private failedRun(runId: string, options: AgentRunOptions, startedAt: Date, trace: ToolCallTrace[], error: string): AgentRun {
    return {
      run_id: runId,
      trace_id: runId,
      mode: 'LOCAL_DEMO',
      runtime_detail: this.getRuntimeDetail(),
      scenario_id: this.scenario.scenario_id,
      trigger: options.trigger,
      region_id: options.regionId,
      status: 'failed',
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      state: { state: 'DEGRADED', headline: '无法读取安全状态', reasons: [], publishable: false, validated_route_display_allowed: false, candidate_route_display_allowed: false, requires_operator_action: true, last_valid_observation_at: null, active_incident_ids: [], decided_at: new Date().toISOString() },
      belief_before: [],
      belief_after: [],
      entropy_before_bits: null,
      entropy_after_bits: null,
      risk_before: null,
      risk_after: null,
      investigation: { required: false, reason: 'failed to read status', rounds: [], pending_work_order_ids: [], stopped_reason: 'status_unavailable' },
      prediction: null,
      camera: null,
      risk: null,
      staff_recommendation: null,
      work_orders: [],
      recommendations: [],
      trace,
      summary: `Agent 运行失败：${error}`,
      limitations: ['本地确定性运行时；未连接 AgentArts。'],
    };
  }
}

