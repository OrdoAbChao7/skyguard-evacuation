/**
 * AgentArts 有界多步运行。
 *
 * 平台只负责选择工具；本地执行权限、参数与超时校验，并在工单创建后停下等待人工审批。
 */
import { randomUUID } from 'node:crypto';
import type { SafetyDecisionService } from '../safety/decision-service';
import type { SafetyScenario } from '../safety/types';
import type { AgentRun, ToolCallTrace } from './agent';
import type { AgentArtsClient } from './agentarts';
import type { CameraHealth } from './ingest';
import type { OpsActor } from './ops';
import type { PredictionService } from './prediction';
import type { ToolRegistry } from './tools';

export interface AgentArtsRunSource {
  scenario: SafetyScenario;
  safety: SafetyDecisionService;
  prediction: PredictionService;
  registry: ToolRegistry;
  agentArts: AgentArtsClient;
  cameraHealth(regionId?: string): CameraHealth[];
}

export async function runWithAgentArts(
  source: AgentArtsRunSource,
  options: {
    regionId: string;
    trigger: string;
    actor?: OpsActor;
  },
): Promise<AgentRun> {
  const actor: OpsActor = options.actor ?? { username: 'skyguard-agent', role: 'agent', kind: 'agent' };
  const startedAt = new Date().toISOString();
  const traceId = `RUN-${randomUUID().slice(0, 8)}`;
  const maxSteps = Math.max(1, Math.min(10, Number(process.env.AGENTARTS_MAX_STEPS ?? 4)));
  const trace: ToolCallTrace[] = [];
  const pendingIds: string[] = [];
  const workOrders: Array<Record<string, unknown>> = [];
  const decisions: Array<Record<string, unknown>> = [];
  let runStatus: AgentRun['status'] = 'completed';
  let stoppedReason: string | null = null;
  let lastSignature: string | null = null;

  // 有界多步：平台可以连续选择工具；本地负责每一步的权限、参数与超时校验。
  for (let step = 1; step <= maxSteps; step += 1) {
    const current = source.safety.getStatus();
    const versions = source.safety.getVersions();
    const decision = await source.agentArts.select({
      scenarioId: source.scenario.scenario_id,
      regionId: options.regionId,
      trigger: options.trigger,
      traceId: `${traceId}-S${step}`,
      sessionId: traceId,
      context: {
        step,
        safety_state: current.state,
        versions,
        region: current.regions.find(region => region.id === options.regionId) ?? null,
        risk: current.risks.find(risk => risk.regionId === options.regionId) ?? null,
        camera: source.cameraHealth(options.regionId)[0] ?? null,
        prediction: source.prediction.predict(options.regionId),
        venue: source.scenario.venue ?? null,
        previous_steps: decisions,
        pending_work_orders: pendingIds,
      },
      tools: source.registry.list().map(tool => ({ name: tool.name, description: tool.description, roles: tool.roles })),
    });

    const signature = `${decision.tool}:${JSON.stringify(decision.arguments)}:${versions.observation}:${versions.constraint}:${pendingIds.length}`;
    if (!decision.tool) {
      // 平台只返回文本：成功调用，但不是工具决策；停止并转人工，不伪造执行。
      decisions.push({ step, tool: null, reasoning: decision.reasoning, text: decision.text ?? null, ok: true });
      runStatus = 'needs_human';
      stoppedReason = 'platform_text_only';
      break;
    }
    if (signature === lastSignature) {
      stoppedReason = 'no_progress_repeated_call';
      break;
    }
    lastSignature = signature;

    // 工单创建必须带幂等键；平台未提供时由本地按运行/步骤稳定生成。
    const toolArgs: Record<string, unknown> = decision.tool === 'create_candidate_work_order'
      ? {
        ...decision.arguments,
        idempotency_key: decision.arguments.idempotency_key
          ?? `agentarts:${traceId}:${step}`,
      }
      : decision.arguments;

    const toolResult = await source.registry.invoke(decision.tool, toolArgs, actor);
    source.agentArts.recordToolCall();
    trace.push({
      seq: trace.length + 1,
      tool: decision.tool,
      args: toolArgs,
      ok: toolResult.ok,
      status: toolResult.ok ? 'ok' : 'error',
      result_summary: toolResult.ok
        ? `AgentArts 第 ${step} 步工具执行成功`
        : (toolResult.error ?? 'failed'),
      source: toolResult.source,
      confidence: toolResult.confidence,
      duration_ms: toolResult.duration_ms ?? 0,
    });
    decisions.push({
      step,
      tool: decision.tool,
      arguments: toolArgs,
      reasoning: decision.reasoning,
      ok: toolResult.ok,
    });

    if (!toolResult.ok) {
      runStatus = 'failed';
      stoppedReason = `tool_failed:${toolResult.error ?? 'unknown'}`;
      break;
    }

    const data = toolResult.data as { work_order?: Record<string, unknown> & { id?: string } } | null;
    if (data?.work_order?.id) {
      pendingIds.push(data.work_order.id);
      workOrders.push(data.work_order);
      runStatus = 'awaiting_approval';
      stoppedReason = 'awaiting_human_approval';
      break;
    }
    if (step === maxSteps) stoppedReason = 'max_steps_reached';
  }

  const finalStatus = source.safety.getStatus();
  const currentCamera = source.cameraHealth(options.regionId)[0] ?? null;
  return {
    run_id: traceId,
    trace_id: traceId,
    mode: 'AGENTARTS_CONNECTED',
    runtime_detail: `华为云 AgentArts：连接探测成功；平台返回工具决策，本地执行并做权限校验；有界 ${maxSteps} 步，重复调用即停止。`,
    scenario_id: source.scenario.scenario_id,
    trigger: options.trigger,
    region_id: options.regionId,
    status: runStatus,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    state: finalStatus.state,
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
      pending_work_order_ids: pendingIds,
      stopped_reason: stoppedReason,
    },
    prediction: source.prediction.predict(options.regionId),
    camera: currentCamera as unknown as Record<string, unknown> | null,
    risk: (finalStatus.risks.find(risk => risk.regionId === options.regionId) ?? null) as unknown as Record<string, unknown> | null,
    staff_recommendation: null,
    work_orders: workOrders,
    recommendations: trace.length > 0
      ? [
        `AgentArts 共执行 ${trace.length} 步工具调用。`,
        ...(stoppedReason ? [`停止原因：${stoppedReason}`] : []),
      ]
      : [
        decisions[0]?.text
          ? `AgentArts 返回文本（未执行工具）：${String(decisions[0].text).slice(0, 300)}`
          : 'AgentArts 未返回任何工具决策。',
      ],
    trace,
    summary: `AgentArts 决策：${trace.length} 步（${trace.map(item => item.tool).join(' → ') || '无工具调用'}）；状态 ${runStatus}。`,
    limitations: [
      'AgentArts 路径未经真实租户实机验证；工具执行仍受本地权限与安全校验约束。',
      '平台等待人工审批时不保持长连接；审批/反馈后是否续接由 AGENTARTS_AUTO_CONTINUE 控制。',
    ],
  };
}
