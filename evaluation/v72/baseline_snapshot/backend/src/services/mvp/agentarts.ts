/**
 * 华为云 AgentArts 运行时适配器。
 *
 * 重要事实（不得省略）：
 *  - 本仓库没有真实 AgentArts 租户、API 凭证或已确认的平台接口文档；
 *  - 因此**未完成实机联调**，默认运行模式固定为 LOCAL_DEMO；
 *  - 下面的 URL 路径与请求体是**可配置模板**，默认值不是官方接口承诺，
 *    接入前必须按租户控制台/官方文档填写 AGENTARTS_INVOKE_PATH / HEALTH_PATH
 *    并完成契约验证（docs/AGENTARTS_INTEGRATION.md）。
 *
 * 设计原则：
 *  - 连接状态只由真实 HTTP 探测决定，不能由配置存在与否推定；
 *  - 远程返回的决策必须经过本地工具注册表的权限与参数校验后才执行；
 *  - 超时、鉴权失败、响应结构不符都会显式失败，不回退伪装成已连接。
 */
import { z } from 'zod';

export type AgentArtsMode = 'LOCAL_DEMO' | 'AGENTARTS_CONNECTED' | 'AGENTARTS_UNAVAILABLE';

/** 平台可达性与业务闭环是两件事，必须分开报告（G02）。 */
export type AgentArtsConnectivity = 'not_requested' | 'misconfigured' | 'unreachable' | 'reachable';

export interface AgentArtsConfig {
  runtime: 'local' | 'agentarts';
  baseUrl: string | null;
  apiKey: string | null;
  agentId: string | null;
  projectId: string | null;
  /** official = 华为云 AgentArts 运行时调用契约；template = 本地测试用的模板契约。 */
  contract: 'official' | 'template';
  runtimeName: string;
  invokeMode: 'debug' | 'published' | null;
  sessionHeader: string;
  invokePath: string;
  healthPath: string;
  timeoutMs: number;
  healthRetries: number;
  /** select 调用在 timeout/429/5xx 时的额外重试次数（0~3）。 */
  invokeRetries: number;
  /** 重试退避基数（毫秒，最终按 2^attempt 截断）。 */
  retryBaseMs: number;
}

export interface AgentArtsBusinessClosure {
  /**
   * 只有拿到真实租户的完整链路证据（平台 Trace + 工具回执 + 人工审批等待
   * + 反馈后续接）才允许置为 true；健康探测或单次工具调用不能提升此状态。
   */
  verified: boolean;
  verified_at: string | null;
  app_version: string | null;
  note: string;
}

export interface AgentArtsStatus {
  mode: AgentArtsMode;
  configured: boolean;
  runtime_requested: 'local' | 'agentarts';
  base_url: string | null;
  agent_id: string | null;
  /** official = /runtimes/{runtime_name}/invocations；template = 旧测试模板。 */
  contract: 'official' | 'template';
  runtime_name: string;
  invoke_mode: 'debug' | 'published' | null;
  invoke_path: string;
  health_path: string;
  missing_config: string[];
  invoke_retries: number;
  detail: string;
  checked_at: string | null;
  http_status: number | null;
  /** 当前网络可达性；仅由真实健康探测更新。 */
  connectivity: AgentArtsConnectivity;
  /** 业务闭环验证状态；与可达性独立。 */
  business_closure: AgentArtsBusinessClosure;
  last_successful_call_at: string | null;
  last_tool_call_at: string | null;
}

export interface AgentArtsDecision {
  tool: string;
  arguments: Record<string, unknown>;
  reasoning: string;
  /** 平台返回的文本消息（工作流/智能体可能只返回文本，不返回工具决策）。 */
  text?: string;
  raw?: unknown;
}

export interface AgentArtsSelectInput {
  /** 当前加载的场景 ID；由 MvpService 注入，不允许适配器写死具体场馆。 */
  scenarioId?: string;
  regionId: string;
  trigger: string;
  traceId: string;
  /** 全链路会话 ID（同一次运行的多个步骤共用）；缺省使用 traceId。 */
  sessionId?: string;
  /** 官方运行时契约的 query 字段（单/多智能体必填）。 */
  query?: string;
  context: Record<string, unknown>;
  tools: Array<{ name: string; description: string; roles: string[] }>;
}

const DecisionSchema = z.object({
  decision: z.object({
    tool: z.string().min(1),
    arguments: z.record(z.unknown()).default({}),
    reasoning: z.string().default(''),
  }).optional(),
  tool: z.string().min(1).optional(),
  arguments: z.record(z.unknown()).optional(),
  reasoning: z.string().optional(),
}).passthrough();

const OfficialResponseSchema = z.object({
  event: z.string().optional(),
  data: z.object({
    text: z.string().nullable().optional(),
    node_id: z.string().optional(),
    node_type: z.string().optional(),
    workflow_id: z.string().optional(),
    workflow_name: z.string().optional(),
  }).passthrough().optional(),
  createdTime: z.number().optional(),
}).passthrough();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 解析平台响应：普通 JSON，或 SSE/流式 `data:` 事件（取最后一个可解析事件）。
 * 截断/部分写入的 JSON 会显式失败，不会当作成功。
 */
function parseAgentArtsText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('响应为空');
  if (/^data:/m.test(trimmed)) {
    const payloads = trimmed
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .filter(payload => payload && payload !== '[DONE]');
    let lastError: Error | null = null;
    for (let index = payloads.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(payloads[index]);
      } catch (error) {
        lastError = error as Error;
      }
    }
    throw new Error(`SSE 事件中没有可解析的 JSON${lastError ? `：${lastError.message}` : ''}`);
  }
  return JSON.parse(trimmed);
}

export function loadAgentArtsConfig(env: NodeJS.ProcessEnv = process.env): AgentArtsConfig {
  const runtime = env.AGENT_RUNTIME === 'agentarts' ? 'agentarts' : 'local';
  const contract = env.AGENTARTS_CONTRACT === 'template' ? 'template' : 'official';
  const runtimeName = env.AGENTARTS_RUNTIME_NAME?.trim() || env.AGENTARTS_AGENT_ID?.trim() || '';
  const invokeMode = env.AGENTARTS_INVOKE_MODE === 'debug' || env.AGENTARTS_INVOKE_MODE === 'published'
    ? env.AGENTARTS_INVOKE_MODE
    : null;
  return {
    runtime,
    baseUrl: env.AGENTARTS_BASE_URL?.trim() || null,
    apiKey: env.AGENTARTS_API_KEY?.trim() || null,
    agentId: env.AGENTARTS_AGENT_ID?.trim() || null,
    projectId: env.AGENTARTS_PROJECT_ID?.trim() || null,
    contract,
    runtimeName,
    invokeMode,
    sessionHeader: env.AGENTARTS_SESSION_HEADER?.trim() || 'x-hw-agentarts-session-id',
    invokePath: env.AGENTARTS_INVOKE_PATH?.trim()
      || (contract === 'official' ? '/runtimes/{runtime_name}/invocations' : '/v1/agents/{agent_id}/invoke'),
    healthPath: env.AGENTARTS_HEALTH_PATH?.trim() || '/health',
    timeoutMs: Number(env.AGENTARTS_TIMEOUT_MS ?? 8000),
    healthRetries: Math.max(0, Math.min(3, Number(env.AGENTARTS_HEALTH_RETRIES ?? 1))),
    invokeRetries: Math.max(0, Math.min(3, Number(env.AGENTARTS_INVOKE_RETRIES ?? 1))),
    retryBaseMs: Math.max(10, Math.min(5000, Number(env.AGENTARTS_RETRY_BASE_MS ?? 250))),
  };
}

export function missingConfig(config: AgentArtsConfig): string[] {
  const missing: string[] = [];
  if (!config.baseUrl) missing.push('AGENTARTS_BASE_URL');
  if (!config.apiKey) missing.push('AGENTARTS_API_KEY');
  if (config.contract === 'official') {
    if (!config.runtimeName) missing.push('AGENTARTS_RUNTIME_NAME（或 AGENTARTS_AGENT_ID）');
  } else if (!config.agentId) {
    missing.push('AGENTARTS_AGENT_ID');
  }
  return missing;
}

export class AgentArtsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentArtsUnavailableError';
  }
}

export class AgentArtsClient {
  private lastSuccessAt: string | null = null;
  private lastToolCallAt: string | null = null;

  constructor(private readonly config: AgentArtsConfig = loadAgentArtsConfig()) {}

  getConfig(): AgentArtsConfig {
    return this.config;
  }

  /** 记录一次本地工具执行（由编排层调用）；不代表平台业务闭环已验证。 */
  recordToolCall(at: string = new Date().toISOString()): void {
    this.lastToolCallAt = at;
  }

  private callHistory(): Pick<AgentArtsStatus, 'last_successful_call_at' | 'last_tool_call_at'> {
    return { last_successful_call_at: this.lastSuccessAt, last_tool_call_at: this.lastToolCallAt };
  }

  /** 实例状态：静态配置 + 本次进程内的调用历史。 */
  status(): AgentArtsStatus {
    return { ...this.staticStatus(), ...this.callHistory() };
  }

  staticStatus(): AgentArtsStatus {
    const missing = missingConfig(this.config);
    const configured = missing.length === 0;
    const mode: AgentArtsMode = this.config.runtime === 'agentarts' && configured
      ? 'AGENTARTS_UNAVAILABLE'
      : 'LOCAL_DEMO';
    const connectivity: AgentArtsConnectivity = this.config.runtime !== 'agentarts'
      ? 'not_requested'
      : !configured
        ? 'misconfigured'
        : 'unreachable';
    return {
      mode,
      configured,
      runtime_requested: this.config.runtime,
      base_url: this.config.baseUrl,
      agent_id: this.config.agentId,
      contract: this.config.contract,
      runtime_name: this.config.runtimeName,
      invoke_mode: this.config.invokeMode,
      invoke_path: this.config.invokePath,
      health_path: this.config.healthPath,
      missing_config: missing,
      invoke_retries: this.config.invokeRetries,
      detail: !configured
        ? `缺少配置：${missing.join('、')}；本地模式可用，未连接 AgentArts。`
        : this.config.runtime === 'agentarts'
          ? '配置已提供，尚未完成健康探测。'
          : '当前运行模式为本地演示；未请求连接 AgentArts。',
      checked_at: null,
      http_status: null,
      connectivity,
      business_closure: {
        verified: false,
        verified_at: null,
        app_version: null,
        note: '业务闭环未验证：健康探测或单次工具调用不等于平台工作流、人工审批等待与反馈续接已验证。',
      },
      last_successful_call_at: null,
      last_tool_call_at: null,
    };
  }

  private resolve(pathTemplate: string): string {
    if (!this.config.baseUrl) throw new AgentArtsUnavailableError('AGENTARTS_BASE_URL 未配置');
    const replaced = pathTemplate
      .replace('{runtime_name}', encodeURIComponent(this.config.runtimeName || this.config.agentId || ''))
      .replace('{agent_id}', encodeURIComponent(this.config.agentId ?? ''));
    return new URL(replaced, this.config.baseUrl).toString();
  }

  private async request(pathTemplate: string, init: RequestInit, sessionId?: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await fetch(this.resolve(pathTemplate), {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey ?? ''}`,
          ...(this.config.projectId ? { 'X-Project-Id': this.config.projectId } : {}),
          ...(this.config.invokeMode ? { 'X-Invoke-Mode': this.config.invokeMode } : {}),
          ...(sessionId ? { [this.config.sessionHeader]: sessionId.slice(0, 64) } : {}),
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 有界重试：只对超时/网络错误/429/5xx 重试；4xx 业务错误立即返回。
   * 平台决策请求本身不执行本地工具，重试不会重复产生本地副作用。
   */
  private async invokeWithRetry(body: unknown, sessionId: string): Promise<Response> {
    const attempts = this.config.invokeRetries + 1;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.request(this.config.invokePath, {
          method: 'POST',
          body: JSON.stringify(body),
        }, sessionId);
        if (response.ok) return response;
        if ((response.status === 429 || response.status >= 500) && attempt < attempts - 1) {
          await response.text().catch(() => undefined);
          await sleep(Math.min(5000, this.config.retryBaseMs * 2 ** attempt));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error as Error;
        if (attempt < attempts - 1) {
          await sleep(Math.min(5000, this.config.retryBaseMs * 2 ** attempt));
          continue;
        }
      }
    }
    throw new AgentArtsUnavailableError(
      `AgentArts 调用在 ${attempts} 次尝试后失败：${lastError?.message ?? 'unknown'}`,
    );
  }

  async healthCheck(): Promise<AgentArtsStatus> {
    const base = this.staticStatus();
    const history = this.callHistory();
    if (this.config.runtime !== 'agentarts') {
      return { ...base, ...history, checked_at: new Date().toISOString(), detail: '运行模式为 local；未探测 AgentArts。' };
    }
    if (!base.configured) {
      return { ...base, ...history, connectivity: 'misconfigured', checked_at: new Date().toISOString() };
    }
    let lastDetail = '';
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt <= this.config.healthRetries; attempt += 1) {
      try {
        const response = await this.request(this.config.healthPath, { method: 'GET' });
        if (response.ok) {
          return {
            ...base,
            ...history,
            mode: 'AGENTARTS_CONNECTED',
            connectivity: 'reachable',
            checked_at: new Date().toISOString(),
            http_status: response.status,
            detail: '健康探测成功：平台网络可达（仅代表连通，不代表完整工作流已验证）。',
          };
        }
        lastDetail = `健康探测失败：HTTP ${response.status}。请核对 AGENTARTS_HEALTH_PATH 与鉴权配置。`;
        lastStatus = response.status;
      } catch (error) {
        lastDetail = `健康探测失败：${(error as Error).message}`;
      }
      if (attempt < this.config.healthRetries) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
    return {
      ...base,
      ...history,
      mode: 'AGENTARTS_UNAVAILABLE',
      connectivity: 'unreachable',
      checked_at: new Date().toISOString(),
      http_status: lastStatus,
      detail: `${lastDetail}（已重试 ${this.config.healthRetries} 次）`,
    };
  }

  /** 请求平台返回下一步工具决策；任何结构不符或超时都显式失败。 */
  async select(input: AgentArtsSelectInput): Promise<AgentArtsDecision> {
    if (this.config.runtime !== 'agentarts') {
      throw new AgentArtsUnavailableError('当前运行模式为 local，不会调用 AgentArts');
    }
    const missing = missingConfig(this.config);
    if (missing.length > 0) {
      throw new AgentArtsUnavailableError(`AgentArts 缺少配置：${missing.join('、')}`);
    }

    // 官方契约：POST /runtimes/{runtime_name}/invocations
    //   body = { query, inputs, plugin_configs? }
    // 模板契约：仅用于本地 stub 测试，不得冒充官方接口。
    const body = this.config.contract === 'official'
      ? {
        query: input.query
          ?? `为区域 ${input.regionId} 选择下一步安全调查工具；触发来源 ${input.trigger}；只允许返回允许角色内的工具决策。`,
        inputs: {
          scenario_id: input.scenarioId ?? 'unknown',
          region_id: input.regionId,
          trigger: input.trigger,
          trace_id: input.traceId,
          context: input.context,
          tools: input.tools,
        },
      }
      : {
        agent_id: this.config.agentId,
        project_id: this.config.projectId,
        input: {
          scenario: input.scenarioId ?? 'unknown',
          region_id: input.regionId,
          trigger: input.trigger,
          trace_id: input.traceId,
          context: input.context,
        },
        tools: input.tools,
        contract_version: 'skyguard-agentarts-v1',
      };

    const response = await this.invokeWithRetry(body, input.sessionId ?? input.traceId);
    const text = await response.text();
    if (!response.ok) {
      throw new AgentArtsUnavailableError(`AgentArts 调用失败：HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    let parsed: unknown;
    try {
      parsed = parseAgentArtsText(text);
    } catch {
      throw new AgentArtsUnavailableError(`AgentArts 返回不是有效 JSON/SSE：${text.slice(0, 200)}`);
    }

    if (this.config.contract === 'official') {
      const official = OfficialResponseSchema.safeParse(parsed);
      if (!official.success) {
        throw new AgentArtsUnavailableError(
          `AgentArts 官方响应结构不符合契约：${official.error.issues.map(issue => issue.message).join('; ')}`,
        );
      }
      const replyText = typeof official.data.data?.text === 'string' ? official.data.data.text : null;
      let decisionPayload: unknown = null;
      if (replyText) {
        try { decisionPayload = JSON.parse(replyText); } catch { decisionPayload = null; }
      }
      const decisionValidated = DecisionSchema.safeParse(decisionPayload ?? parsed);
      if (decisionValidated.success) {
        const decision = decisionValidated.data.decision ?? {
          tool: decisionValidated.data.tool,
          arguments: decisionValidated.data.arguments,
          reasoning: decisionValidated.data.reasoning,
        };
        if (decision?.tool) {
          this.lastSuccessAt = new Date().toISOString();
          return {
            tool: decision.tool,
            arguments: (decision.arguments ?? {}) as Record<string, unknown>,
            reasoning: decision.reasoning ?? '',
            raw: parsed,
          };
        }
      }
      if (replyText) {
        // 工作流/智能体只返回文本：这是成功调用，但不是工具决策；由编排层停止并转人工。
        this.lastSuccessAt = new Date().toISOString();
        return {
          tool: '',
          arguments: {},
          reasoning: replyText.slice(0, 2000),
          text: replyText,
          raw: parsed,
        };
      }
      throw new AgentArtsUnavailableError('AgentArts 官方响应缺少 data.text，且未包含工具决策');
    }

    const validated = DecisionSchema.safeParse(parsed);
    if (!validated.success) {
      throw new AgentArtsUnavailableError(`AgentArts 返回结构不符合契约：${validated.error.issues.map(issue => issue.message).join('; ')}`);
    }
    const decision = validated.data.decision ?? {
      tool: validated.data.tool,
      arguments: validated.data.arguments,
      reasoning: validated.data.reasoning,
    };
    if (!decision?.tool) {
      throw new AgentArtsUnavailableError('AgentArts 返回缺少 decision.tool');
    }
    this.lastSuccessAt = new Date().toISOString();
    return {
      tool: decision.tool,
      arguments: (decision.arguments ?? {}) as Record<string, unknown>,
      reasoning: decision.reasoning ?? '',
      raw: parsed,
    };
  }
}
