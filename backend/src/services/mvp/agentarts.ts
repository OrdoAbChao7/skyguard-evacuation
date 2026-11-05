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

export interface AgentArtsConfig {
  runtime: 'local' | 'agentarts';
  baseUrl: string | null;
  apiKey: string | null;
  agentId: string | null;
  projectId: string | null;
  invokePath: string;
  healthPath: string;
  timeoutMs: number;
  healthRetries: number;
}

export interface AgentArtsStatus {
  mode: AgentArtsMode;
  configured: boolean;
  runtime_requested: 'local' | 'agentarts';
  base_url: string | null;
  agent_id: string | null;
  invoke_path: string;
  health_path: string;
  missing_config: string[];
  detail: string;
  checked_at: string | null;
  http_status: number | null;
}

export interface AgentArtsDecision {
  tool: string;
  arguments: Record<string, unknown>;
  reasoning: string;
  raw?: unknown;
}

export interface AgentArtsSelectInput {
  regionId: string;
  trigger: string;
  traceId: string;
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

export function loadAgentArtsConfig(env: NodeJS.ProcessEnv = process.env): AgentArtsConfig {
  const runtime = env.AGENT_RUNTIME === 'agentarts' ? 'agentarts' : 'local';
  return {
    runtime,
    baseUrl: env.AGENTARTS_BASE_URL?.trim() || null,
    apiKey: env.AGENTARTS_API_KEY?.trim() || null,
    agentId: env.AGENTARTS_AGENT_ID?.trim() || null,
    projectId: env.AGENTARTS_PROJECT_ID?.trim() || null,
    invokePath: env.AGENTARTS_INVOKE_PATH?.trim() || '/v1/agents/{agent_id}/invoke',
    healthPath: env.AGENTARTS_HEALTH_PATH?.trim() || '/health',
    timeoutMs: Number(env.AGENTARTS_TIMEOUT_MS ?? 8000),
    healthRetries: Math.max(0, Math.min(3, Number(env.AGENTARTS_HEALTH_RETRIES ?? 1))),
  };
}

export function missingConfig(config: AgentArtsConfig): string[] {
  const missing: string[] = [];
  if (!config.baseUrl) missing.push('AGENTARTS_BASE_URL');
  if (!config.apiKey) missing.push('AGENTARTS_API_KEY');
  if (!config.agentId) missing.push('AGENTARTS_AGENT_ID');
  return missing;
}

export class AgentArtsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentArtsUnavailableError';
  }
}

export class AgentArtsClient {
  constructor(private readonly config: AgentArtsConfig = loadAgentArtsConfig()) {}

  getConfig(): AgentArtsConfig {
    return this.config;
  }

  staticStatus(): AgentArtsStatus {
    const missing = missingConfig(this.config);
    const configured = missing.length === 0;
    const mode: AgentArtsMode = this.config.runtime === 'agentarts' && configured
      ? 'AGENTARTS_UNAVAILABLE'
      : 'LOCAL_DEMO';
    return {
      mode,
      configured,
      runtime_requested: this.config.runtime,
      base_url: this.config.baseUrl,
      agent_id: this.config.agentId,
      invoke_path: this.config.invokePath,
      health_path: this.config.healthPath,
      missing_config: missing,
      detail: !configured
        ? `缺少配置：${missing.join('、')}；本地模式可用，未连接 AgentArts。`
        : this.config.runtime === 'agentarts'
          ? '配置已提供，尚未完成健康探测。'
          : '当前运行模式为本地演示；未请求连接 AgentArts。',
      checked_at: null,
      http_status: null,
    };
  }

  private resolve(pathTemplate: string): string {
    if (!this.config.baseUrl) throw new AgentArtsUnavailableError('AGENTARTS_BASE_URL 未配置');
    const replaced = pathTemplate.replace('{agent_id}', encodeURIComponent(this.config.agentId ?? ''));
    return new URL(replaced, this.config.baseUrl).toString();
  }

  private async request(pathTemplate: string, init: RequestInit): Promise<Response> {
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
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<AgentArtsStatus> {
    const base = this.staticStatus();
    if (this.config.runtime !== 'agentarts') {
      return { ...base, checked_at: new Date().toISOString(), detail: '运行模式为 local；未探测 AgentArts。' };
    }
    if (!base.configured) {
      return { ...base, checked_at: new Date().toISOString() };
    }
    let lastDetail = '';
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt <= this.config.healthRetries; attempt += 1) {
      try {
        const response = await this.request(this.config.healthPath, { method: 'GET' });
        if (response.ok) {
          return {
            ...base,
            mode: 'AGENTARTS_CONNECTED',
            checked_at: new Date().toISOString(),
            http_status: response.status,
            detail: '健康探测成功：已连接 AgentArts（仅代表连通，不代表完整工作流已验证）。',
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
      mode: 'AGENTARTS_UNAVAILABLE',
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
    const response = await this.request(this.config.invokePath, {
      method: 'POST',
      body: JSON.stringify({
        agent_id: this.config.agentId,
        project_id: this.config.projectId,
        input: {
          scenario: 'stadium-evacuation',
          region_id: input.regionId,
          trigger: input.trigger,
          trace_id: input.traceId,
          context: input.context,
        },
        tools: input.tools,
        contract_version: 'skyguard-agentarts-v1',
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AgentArtsUnavailableError(`AgentArts 调用失败：HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AgentArtsUnavailableError(`AgentArts 返回不是 JSON：${text.slice(0, 200)}`);
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
    return {
      tool: decision.tool,
      arguments: (decision.arguments ?? {}) as Record<string, unknown>,
      reasoning: decision.reasoning ?? '',
      raw: parsed,
    };
  }
}
