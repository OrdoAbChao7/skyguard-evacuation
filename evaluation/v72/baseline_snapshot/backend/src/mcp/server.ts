/**
 * SkyGuard MCP Server。
 *
 * 两种传输共用同一份工具注册表与同一个 `MvpService` 单例：
 *  - stdio：开发用客户端入口（`npm run mcp`），独立进程；
 *  - Streamable HTTP：挂载在既有 Express 服务的 `/mcp`（单实例内与网页共享
 *    工单、人员、证据与会话状态，见 G03）。
 *
 * 身份由服务端环境变量决定，客户端不能通过请求参数自报 admin。
 * stdio 模式下 stdout 只能输出 MCP 协议消息，日志一律写 stderr。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandler } from 'express';
import type { OpsActor } from '../services/mvp/ops';
import { getMvpService, type MvpService } from '../services/mvp';

export function resolveActor(service: MvpService = getMvpService()): OpsActor {
  const role = process.env.MCP_ACTOR_ROLE ?? 'agent';
  const username = process.env.MCP_ACTOR_NAME ?? 'mcp-agent';
  if (role === 'staff') {
    const staffId = process.env.MCP_STAFF_ID ?? '';
    const code = process.env.MCP_STAFF_CODE ?? '';
    const member = service.ops.authenticateStaff(staffId, code);
    if (!member) {
      console.error('[mcp] staff 身份校验失败：缺少或错误的 MCP_STAFF_ID / MCP_STAFF_CODE；写操作将被拒绝。');
      return { username, role: 'viewer' };
    }
    return { username: member.name, role: 'staff', staff_id: member.id };
  }
  // 云端/HTTP 入口只接受受限角色，忽略客户端自报身份。
  const effectiveRole = ['agent', 'viewer'].includes(role) ? role : 'agent';
  return { username, role: effectiveRole };
}

/** 创建绑定到指定服务实例与身份的 MCP Server（stdio 与 HTTP 共用）。 */
export function createMcpServer(service: MvpService = getMvpService(), actor: OpsActor = resolveActor(service)): McpServer {
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
  return server;
}

/**
 * Express 路由：无状态 Streamable HTTP MCP。
 *
 * 每个请求新建 transport/server，但底层 `MvpService` 是进程内单例，
 * 因此 HTTP MCP 与网页 API 读写的是同一份业务状态。
 */
export function mcpHttpHandler(): RequestHandler {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP 端点只接受 POST' } });
      return;
    }
    const service = getMvpService();
    const server = createMcpServer(service);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[mcp/http] 请求处理失败：', (error as Error).message);
      if (!res.headersSent) {
        res.status(500).json({ error: { code: 'MCP_HTTP_ERROR', message: 'MCP 请求处理失败' } });
      }
    }
  };
}

export async function main(): Promise<void> {
  const service = getMvpService();
  const actor = resolveActor(service);
  const server = createMcpServer(service, actor);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mcp] SkyGuard MCP Server 已启动：${service.registry.list().length} 个工具；actor=${actor.role}`);
}

// 仅当作为独立入口执行时启动 stdio；被 Express 引用的模块不应启动第二个进程。
if (require.main === module) {
  void main().catch(error => {
    console.error('[mcp] 启动失败：', error);
    process.exit(1);
  });
}
