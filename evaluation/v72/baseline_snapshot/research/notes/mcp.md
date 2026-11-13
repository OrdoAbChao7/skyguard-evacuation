# MCP 笔记

## 协议事实（S11）

- 官方规范站点：`modelcontextprotocol.io`，本轮确认版本 **2025-06-18**。
- 传输：stdio 与 Streamable HTTP；本仓库使用 stdio。
- 工具调用包含结构化输入输出；支持 OAuth 2.1（HTTP 场景），本仓库未实现。

## 本仓库实现

- 官方 SDK `@modelcontextprotocol/sdk` 1.32.2（S12）。
- `backend/src/mcp/server.ts` 注册 15 个工具；与本地 Agent 共用 `ToolRegistry`。
- 每个工具有：Zod Schema、允许角色、超时（2~10s）、来源标记、审计动作 `tool.<name>`。
- 结构化错误码：`UNKNOWN_TOOL / FORBIDDEN / INVALID_ARGUMENT / TIMEOUT / EXECUTION_ERROR`。
- 幂等：`create_candidate_work_order` 支持 `idempotency_key`，MCP 测试验证重复调用返回同一工单。
- 权限：agent 身份调用 `submit_worker_feedback` 被拒绝；审批/派发没有工具。

## 安全边界

- stdio 依赖进程本地信任；没有内置鉴权层。
- 不暴露文件读写/命令执行。
- 生产部署需在网关层加认证、限流与审计汇聚。

## 未完成

- AgentArts 是否支持直接挂载该 MCP Server 未确认（S34 缺口）。
- 未实现 Streamable HTTP/OAuth 传输。
