# AgentArts / ModelArts Studio 检索笔记

## 事实

- 2026-11-05 公开检索未找到华为云 **AgentArts 独立 API 文档**（端点、鉴权、请求体）。
- 可访问的官方入口：ModelArts Studio 产品页（S15）、ModelArts Studio 文档（S18）、API Explorer（S16）。
- 检索到的信息多为产品发布/媒体文章，不能作为接口契约依据。

## 本仓库做法

- 实现可配置 HTTP 适配器：`backend/src/services/mvp/agentarts.ts`。
- 默认运行模式 `LOCAL_DEMO`；只有 `AGENT_RUNTIME=agentarts` 且健康探测 2xx 才标记 `AGENTARTS_CONNECTED`。
- 路径/请求体均为可配置模板，默认值不是官方承诺；接入前必须按租户文档覆盖。
- 平台返回的工具决策必须经过本地注册表的角色、Schema、超时校验后才执行。
- 失败、401、非 JSON、超时都显式失败，不回退伪装。

## 未完成

- 真实租户健康探测与工作流调用；
- 平台 Trace/评估接口确认；
- MCP 在 AgentArts 中的真实接入方式（直接 stdio / 插件 / HTTP 桥接）未确认。

## 证据与边界

- 契约测试：`backend/tests/mvp/agentarts.test.ts`（本地 stub）。
- 运行时接线：`backend/tests/mvp/agentarts-runtime.test.ts`（本地 stub）。
- 对外只能表述“适配层完成，未实机验证”（C08/C12）。
