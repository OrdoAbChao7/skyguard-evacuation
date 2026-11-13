# V7.3 AgentArts 状态与幂等证据

> 运行 ID：`v73-final-20261110T101711`。**local stub 不是实机**；无租户/凭证时不声称已接入。

## 1. 真实平台

- 状态：not_configured
- 契约：official
- 缺失配置：AGENTARTS_BASE_URL、AGENTARTS_API_KEY、AGENTARTS_RUNTIME_NAME（或 AGENTARTS_AGENT_ID）
- 说明：无真实 AgentArts 租户/凭证；未发起平台请求。

## 2. 本地官方契约 stub

- 健康：{"mode":"AGENTARTS_CONNECTED","connectivity":"reachable","http_status":200}
- 决策：{"tool":"camera_query","reasoning":"stub decision"}
- 会话头存在：true
- 重试复用幂等键：true
- 请求捕获：[{"session":"session-v73","idempotency":"7f42f2b853819655796c4ecb90638006e85c4de47b6f4dd9fb22b5c4fc9e0bd1","traceId":"trace-v73-1"},{"session":"session-v73","idempotency":"7f42f2b853819655796c4ecb90638006e85c4de47b6f4dd9fb22b5c4fc9e0bd1","traceId":"trace-v73-1"}]

## 3. 适配器能力

- 官方契约、SSE、会话头、幂等键、有界重试：已实现并有测试；
- 工具权限门、人工审批、反馈续接：由既有 AgentArts 运行时测试覆盖；
- 真实多步工作流/Trace 仍需要租户环境。

## 4. 边界

- 没有真实平台 Trace、工具回执或审批等待证据；
- 不得把本地 stub 表述为 AgentArts 连接成功。
