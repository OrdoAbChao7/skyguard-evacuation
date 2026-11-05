/**
 * SkyGuard MCP Server（stdio 传输）。
 *
 * 使用官方 `@modelcontextprotocol/sdk`，工具定义与本地 Agent 共用同一注册表，
 * 因此权限、参数校验、审计完全一致。
 *
 * 启动：
 *   npm run mcp --prefix backend
 *
 * 身份：
 *   MCP_ACTOR_ROLE=agent|viewer|staff（默认 agent）
 *   MCP_ACTOR_NAME（默认 mcp-agent）
 *   role=staff 时必须提供 MCP_STAFF_ID / MCP_STAFF_CODE，否则反馈工具会被拒绝。
 *
 * 注意：stdio 模式下 stdout 只能输出 MCP 协议消息，日志一律写 stderr。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { OpsActor } from '../services/mvp/ops';
import { getMvpService } from '../services/mvp';

function resolveActor(): OpsActor {
  const role = process.env.MCP_ACTOR_ROLE ?? 'agent';
  const username = process.env.MCP_ACTOR_NAME ?? 'mcp-agent';
  if (role === 'staff') {
    const staffId = process.env.MCP_STAFF_ID ?? '';
    const code = process.env.MCP_STAFF_CODE ?? '';
    const member = getMvpService().ops.authenticateStaff(staffId, code);
    if (!member) {
      console.error('[mcp] staff 身份校验失败：缺少或错误的 MCP_STAFF_ID / MCP_STAFF_CODE；写操作将被拒绝。');
      return { username, role: 'viewer' };
    }
    return { username: member.name, role: 'staff', staff_id: member.id };
  }
  return { username, role };
}

export async function main(): Promise<void> {
  const service = getMvpService();
  const actor = resolveActor();
  const server = new McpServer(
    { name: 'skyguard-mcp', version: '0.1.0' },
    { instructions: 'SkyGuard 应急疏散辅助决策工具。Agent 只能创建待审批工单，不能审批、派发或控制无人机起飞。' },
  );

  for (const summary of service.registry.list()) {
    const definition = service.registry.get(summary.name);
    if (!definition) continue;
    // SDK 泛型在动态注册 Zod schema 时会过深；参数校验仍由注册表完成。
    (server.registerTool as any)(
      definition.name,
      {
        title: definition.title,
        description: `${definition.description}\n允许角色：${definition.roles.join('/')}；数据来源：${definition.source}。`,
        inputSchema: definition.inputSchema,
      },
      async (args: unknown) => {
        const result = await service.registry.invoke(definition.name, args, actor);
        return {
          isError: !result.ok,
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              tool: result.tool,
              ok: result.ok,
              source: result.source,
              confidence: result.confidence,
              generated_at: result.generated_at,
              duration_ms: result.duration_ms ?? null,
              error: result.error ?? null,
              error_code: result.error_code ?? null,
              data: result.data,
            }, null, 2),
          }],
        };
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mcp] SkyGuard MCP Server 已启动：${service.registry.list().length} 个工具；actor=${actor.role}`);
}

void main().catch(error => {
  console.error('[mcp] 启动失败：', error);
  process.exit(1);
});
