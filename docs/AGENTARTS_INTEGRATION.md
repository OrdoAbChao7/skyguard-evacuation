# AgentArts 接入说明

> 实现：`backend/src/services/mvp/agentarts.ts`
>
> 契约测试：`backend/tests/mvp/agentarts.test.ts`、`backend/tests/mvp/agentarts-runtime.test.ts`
>
> 状态查询：`GET /api/v1/mvp/agent/runtime?probe=1`

## 1. 先说结论（2026-11-09）

- 已按华为云官方文档实现**运行时调用契约**：
  `POST /runtimes/{runtime_name}/invocations`，带 `Authorization` 与
  `x-hw-agentarts-session-id` 会话头，请求体使用 `query` + `inputs`。
  官方文档：<https://support.huaweicloud.com/api-agentarts/InvokeRuntime.html>（页面更新 2026-11-04）。
- 本仓库**仍没有真实 AgentArts 租户、API 凭证或租户内已发布应用**，
  因此**没有完成实机联调**，也不能声称“已接入 AgentArts”。
- 已实现的是：官方契约适配器 + 本地 HTTP stub 契约测试 + 有界多步编排 +
  平台可达性与业务闭环状态分离。
- 旧的模板契约（`/v1/agents/{agent_id}/invoke`）保留为 `AGENTARTS_CONTRACT=template`，
  仅用于本地测试，**不得冒充官方接口**。

## 2. 运行模式

| 模式 | 触发条件 | 界面标识 | 行为 |
| --- | --- | --- | --- |
| `LOCAL_DEMO` | 默认；`AGENT_RUNTIME` 未设为 `agentarts` | `LOCAL DEMO` | 本地确定式 Agent + VoI，完整演示可用 |
| `AGENTARTS_CONNECTED` | `AGENT_RUNTIME=agentarts` 且健康探测 HTTP 成功 | `AGENTARTS CONNECTED` | 平台返回工具决策，本地执行并做权限校验；有界多步 |
| `AGENTARTS_UNAVAILABLE` | 配置缺失、探测失败、调用失败或超时 | `AGENTARTS UNAVAILABLE` | 显式失败，不回退伪装 |

`GET /api/v1/mvp/dashboard` 中的 `agentarts` 字段新增：

- `connectivity`: `not_requested` / `misconfigured` / `unreachable` / `reachable`
- `business_closure`: `{ verified, verified_at, app_version, note }`
- `last_successful_call_at` / `last_tool_call_at`

**健康探测成功只更新 `connectivity=reachable`，不会把 `business_closure.verified` 置为 true。**
只有拿到真实租户的完整链路证据（平台 Trace + 工具回执 + 人工审批等待 + 反馈后续接）
才允许人工更新 `business_closure`。

## 3. 配置

| 环境变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `AGENT_RUNTIME` | 否 | `local` | 设为 `agentarts` 才尝试远程 |
| `AGENTARTS_BASE_URL` | 是 | — | 租户端点根地址 |
| `AGENTARTS_API_KEY` | 是 | — | Bearer 凭证 |
| `AGENTARTS_RUNTIME_NAME` | 官方契约必填 | 回退 `AGENTARTS_AGENT_ID` | 租户发布页的运行时名 |
| `AGENTARTS_AGENT_ID` | 模板契约必填 | — | 平台智能体 ID |
| `AGENTARTS_CONTRACT` | 否 | `official` | `official` / `template` |
| `AGENTARTS_INVOKE_MODE` | 否 | 不发送 | `debug` / `published` |
| `AGENTARTS_SESSION_HEADER` | 否 | `x-hw-agentarts-session-id` | 会话头名称 |
| `AGENTARTS_PROJECT_ID` | 否 | — | 项目/租户标识（按租户要求） |
| `AGENTARTS_INVOKE_PATH` | 否 | `/runtimes/{runtime_name}/invocations` | 官方默认路径 |
| `AGENTARTS_HEALTH_PATH` | 否 | `/health` | 健康探测路径（按租户实际配置） |
| `AGENTARTS_TIMEOUT_MS` | 否 | `8000` | 单次请求超时 |
| `AGENTARTS_HEALTH_RETRIES` | 否 | `1` | 健康探测重试次数（0~3，仅 GET） |
| `AGENTARTS_MAX_STEPS` | 否 | `4` | 单次运行的最大平台决策步数（1~10） |
| `AGENTARTS_AUTO_CONTINUE` | 否 | `false` | 工单反馈后是否自动续接平台运行 |

> 密钥只能通过本地环境或部署密钥注入，禁止写入仓库。

## 4. 官方契约

### 健康探测

```http
GET {AGENTARTS_BASE_URL}{AGENTARTS_HEALTH_PATH}
Authorization: Bearer <API_KEY>
```

任意 2xx 视为连通；非 2xx、超时、网络错误都标记 `unreachable`。

### 运行时调用

```http
POST {AGENTARTS_BASE_URL}/runtimes/{runtime_name}/invocations
Authorization: Bearer <API_KEY>
Content-Type: application/json
x-hw-agentarts-session-id: <trace_id，≤64 字符>
X-Invoke-Mode: published            # 可选
```

```json
{
  "query": "为区域 R_EAST_STAND 选择下一步安全调查工具……",
  "inputs": {
    "scenario_id": "stadium-evacuation-v1",
    "region_id": "R_EAST_STAND",
    "trigger": "crowd_surge_alert",
    "trace_id": "RUN-XXXXXXXX-S1",
    "context": { "safety_state": {}, "region": {}, "risk": {}, "camera": {}, "prediction": {}, "previous_steps": [], "pending_work_orders": [] },
    "tools": [{ "name": "get_crowd_status", "description": "...", "roles": ["agent"] }]
  }
}
```

### 响应解析

官方成功响应：

```json
{ "event": "message",
  "data": { "text": "{\"tool\":\"get_crowd_status\",\"arguments\":{\"region_id\":\"R_EAST_STAND\"},\"reasoning\":\"...\"}",
            "node_id": "node_end", "node_type": "End" },
  "createdTime": 1760169416635 }
```

- 若 `data.text` 是包含 `tool` / `decision.tool` 的 JSON，按工具决策执行；
- 若 `data.text` 只是自然语言，则视为**成功的平台消息，但不是工具决策**：
  运行状态记为 `needs_human`，停止原因 `platform_text_only`，不执行任何工具；
- 缺少 `data.text` 且没有工具决策 → 显式失败；
- 模板模式仍接受 `{decision:{tool,...}}` 与扁平 `{tool,...}`（仅本地测试）。

## 5. 有界多步编排

`runWithAgentArts` 不再“一次选择、一次调用即结束”：

1. 最多 `AGENTARTS_MAX_STEPS` 步；
2. 每步重新读取安全态势、版本、预测、摄像头、前序步骤与待审批工单；
3. 平台返回的工具仍经过本地注册表：角色、Zod Schema、超时、审计；
4. 工具创建待审批工单后立即停止，运行状态 `awaiting_approval`，不保持长连接；
5. 同一工具+参数+上下文版本重复出现 → `no_progress_repeated_call`，不再执行；
6. 工具失败 → `failed`，不重放写操作；
7. 人工反馈后，若 `AGENTARTS_AUTO_CONTINUE=true` 且运行处于等待状态，
   触发一次续接；平台故障不影响本地工单闭环。

## 6. 已完成验证

- 官方契约：路径、会话头、`query`/`inputs`、`data.text` 决策解析
  （`agentarts.test.ts`，本地 HTTP stub）；
- 只返回文本时不伪造工具决策（同上）；
- 健康探测成功 ≠ 业务闭环：`connectivity=reachable` 且 `business_closure.verified=false`；
- 运行时接线：健康成功后执行平台选择的工具；失败时 `AGENTARTS_UNAVAILABLE` 且不执行工具；
- 多步：先读取态势再创建工单，第二步后停止为 `awaiting_approval`；
- 重复调用检测：只执行第一次，第二次未执行；
- 以上均为本地 stub，**不是**真实平台调用。

## 7. 完成真实接入还需要（外部阻塞）

1. 真实租户的 AgentArts 控制台访问权限与已发布运行时；
2. 在控制台创建/发布主干 Agent 或工作流，配置工具（若平台支持 MCP，
   配置 MCP Server；否则按官方插件/HTTP 方式桥接本仓库工具 API）；
3. 用真实 `AGENTARTS_*` 配置启动，调用 `?probe=1` 确认 `connectivity=reachable`；
4. 用真实租户跑一次完整链路：工具调用 → 待审批工单 → 人工审批/派发 → 现场反馈 → 续接；
5. 保存脱敏请求/响应、平台 Trace、应用版本与运行记录，人工更新
   `business_closure` 与 `research/CLAIMS.md`。

在上述步骤完成前，任何材料都不得声称“已完成 AgentArts 平台集成”。

## 8. 来源

- 官方运行时调用文档：<https://support.huaweicloud.com/api-agentarts/InvokeRuntime.html>
- 官方认证与调用示例：<https://support.huaweicloud.com/api-agentarts/agentarts_07_0035.html>
- 官方自定义 MCP 文档：<https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0136.html>
- 华为云 ModelArts Studio：<https://www.huaweicloud.com/product/modelarts-studio.html>
