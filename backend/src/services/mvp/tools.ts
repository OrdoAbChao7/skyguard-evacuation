/**
 * 智能体工具注册表（MCP 与本地 Agent 共用同一份实现）。
 *
 * 权限：每个工具声明允许的角色；MCP Server 与本地 Agent 都必须经过同一检查。
 * 审计：每次调用都会写入安全域审计日志（工具名、参数、结果、耗时）。
 * 边界：工具不会暴露任意文件读写或命令执行；Agent 只能创建待审批工单。
 */
import { randomUUID } from 'node:crypto';
import type { OpsActor } from './ops';
import { observationTools } from './tools/definitions/observation';
import { planningTools } from './tools/definitions/planning';
import { workOrderTools } from './tools/definitions/work-orders';
import type { ToolContext, ToolDefinition, ToolResult } from './tools/core';

export * from './tools/core';

export function createToolDefinitions(ctx: ToolContext): ToolDefinition[] {
  return [
    ...observationTools(ctx),
    ...planningTools(ctx),
    ...workOrderTools(ctx),
  ];
}

export class ToolRegistry {
  private definitions = new Map<string, ToolDefinition>();
  private actor: OpsActor;

  constructor(
    definitions: ToolDefinition[],
    private readonly recordAudit: ToolContext['recordAudit'],
    actor: OpsActor = { username: 'local-agent', role: 'agent', kind: 'agent' },
  ) {
    for (const definition of definitions) this.definitions.set(definition.name, definition);
    this.actor = actor;
  }

  setActor(actor: OpsActor): void {
    this.actor = actor;
  }

  getActor(): OpsActor {
    return this.actor;
  }

  list(): Array<Pick<ToolDefinition, 'name' | 'title' | 'description' | 'roles' | 'source' | 'timeout_ms'>> {
    return Array.from(this.definitions.values()).map(definition => ({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      roles: definition.roles,
      source: definition.source,
      timeout_ms: definition.timeout_ms,
    }));
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  async invoke(name: string, rawArgs: unknown, actor?: OpsActor): Promise<ToolResult> {
    const definition = this.definitions.get(name);
    const startedAt = Date.now();
    const generatedAt = new Date().toISOString();
    const effectiveActor = actor ?? this.actor;

    if (!definition) {
      return { tool: name, ok: false, data: null, source: 'tool-registry', confidence: null, error: `unknown tool: ${name}`, error_code: 'UNKNOWN_TOOL', generated_at: generatedAt };
    }
    if (!definition.roles.includes(effectiveActor.role)) {
      return {
        tool: name,
        ok: false,
        data: null,
        source: definition.source,
        confidence: null,
        error: `角色 ${effectiveActor.role} 无权调用 ${name}（允许：${definition.roles.join('/')}）`,
        error_code: 'FORBIDDEN',
        generated_at: generatedAt,
        duration_ms: Date.now() - startedAt,
      };
    }

    const parsed = definition.inputSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        tool: name,
        ok: false,
        data: null,
        source: definition.source,
        confidence: null,
        error: `参数校验失败：${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`,
        error_code: 'INVALID_ARGUMENT',
        generated_at: generatedAt,
        duration_ms: Date.now() - startedAt,
      };
    }

    try {
      const result = await Promise.race([
        definition.handler(parsed.data, effectiveActor),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`tool timeout after ${definition.timeout_ms}ms`)), definition.timeout_ms);
        }),
      ]);
      const duration = Date.now() - startedAt;
      this.recordAudit({
        tool: name,
        actor: effectiveActor,
        args: parsed.data,
        result: result.ok ? 'success' : 'failure',
        error: result.error,
        duration_ms: duration,
        source: definition.source,
      });
      return {
        tool: name,
        ...result,
        error_code: result.ok ? undefined : (result.error_code ?? 'EXECUTION_ERROR'),
        generated_at: generatedAt,
        duration_ms: duration,
      };
    } catch (error) {
      const duration = Date.now() - startedAt;
      const message = (error as Error).message;
      this.recordAudit({
        tool: name,
        actor: effectiveActor,
        args: parsed.data,
        result: 'failure',
        error: message,
        duration_ms: duration,
        source: definition.source,
      });
      return {
        tool: name,
        ok: false,
        data: null,
        source: definition.source,
        confidence: null,
        error: message,
        error_code: /timeout/i.test(message) ? 'TIMEOUT' : 'EXECUTION_ERROR',
        generated_at: generatedAt,
        duration_ms: duration,
      };
    }
  }
}

export function evidenceFromTool(result: ToolResult, kind: string, summary: string): {
  evidence_id: string;
  kind: string;
  summary: string;
  source: string;
  confidence: number | null;
  observed_at: string;
} {
  return {
    evidence_id: `EV-${randomUUID().slice(0, 8)}`,
    kind,
    summary,
    source: result.source,
    confidence: result.confidence,
    observed_at: result.generated_at,
  };
}
