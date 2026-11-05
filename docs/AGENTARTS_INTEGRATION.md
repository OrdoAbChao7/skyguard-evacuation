# AgentArts 接入说明

> 实现：`backend/src/services/mvp/agentarts.ts`  
> 契约测试：`backend/tests/mvp/agentarts.test.ts`  
> 状态查询：`GET /api/v1/mvp/agent/runtime?probe=1`

## 1. 先说结论（2026-11-05）

本次对华为云 AgentArts 的公开资料检索结果：

- 未检索到 `huaweicloud.com` 上 **AgentArts 的公开 API 文档、鉴权流程或端点说明**；
  公开信息主要是产品发布报道与第三方文章。
- 华为云可公开访问的智能体/模型开发入口是
  [ModelArts Studio](https://www.huaweicloud.com/product/modelarts-studio.html) 与
  [API Explorer](https://console.huaweicloud.com/apiexplorer)。
- 因此本仓库**没有真实 AgentArts 租户、凭证或已确认的接口契约**，
    **未完成实机联调**。

在此前提下，本仓库完成的是：可配置运行时适配器 + 契约测试 + 明确的状态展示。
**不会**把本地规则引擎伪装成 AgentArts 实际调用，也不会保留“已连接”的假状态。

## 2. 运行模式

| 模式 | 触发条件 | 界面标识 | 行为 |
| --- | --- | --- | --- |
| `LOCAL_DEMO` | 默认；`AGENT_RUNTIME` 未设为 `agentarts` | `LOCAL DEMO` | 本地确定式 Agent + VoI，完整演示可用 |
| `AGENTARTS_CONNECTED` | `AGENT_RUNTIME=agentarts` 且健康探测 HTTP 成功 | `AGENTARTS CONNECTED` | 平台返回工具决策，本地执行并做权限校验 |
| `AGENTARTS_UNAVAILABLE` | 配置缺失、探测失败、调用失败或超时 | `AGENTARTS UNAVAILABLE` | 显式失败，不回退伪装 |

`GET /api/v1/mvp/dashboard` 中的 `agentarts` 字段与前端徽标来自同一个后端状态。

## 3. 配置

| 环境变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `AGENT_RUNTIME` | 否 | `local` | 设为 `agentarts` 才尝试远程 |
| `AGENTARTS_BASE_URL` | 是 | — | 租户端点根地址 |
| `AGENTARTS_API_KEY` | 是 | — | Bearer 凭证 |
| `AGENTARTS_AGENT_ID` | 是 | — | 平台智能体 ID |
| `AGENTARTS_PROJECT_ID` | 否 | — | 项目/租户标识（以实际 API 为准） |
| `AGENTARTS_INVOKE_PATH` | 否 | `/v1/agents/{agent_id}/invoke` | **模板默认值，未经官方确认** |
| `AGENTARTS_HEALTH_PATH` | 否 | `/health` | **模板默认值，未经官方确认** |
| `AGENTARTS_TIMEOUT_MS` | 否 | `8000` | 请求超时 |
| `AGENTARTS_HEALTH_RETRIES` | 否 | `1` | 健康探测重试次数（0~3，仅 GET） |

> 默认路径只是占位模板，**不是**华为云官方接口承诺。接入时必须用租户控制台/API Explorer
> 确认真实路径、请求体与鉴权方式，再通过环境变量覆盖。

## 4. 契约

### 健康探测

```http
GET {AGENTARTS_BASE_URL}{AGENTARTS_HEALTH_PATH}
Authorization: Bearer <API_KEY>
```

任意 2xx 视为连通；非 2xx、超时、网络错误都标记 `AGENTARTS_UNAVAILABLE`。

### 决策请求

```http
POST {AGENTARTS_BASE_URL}{AGENTARTS_INVOKE_PATH}
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "agent_id": "...",
  "project_id": "...",
  "contract_version": "skyguard-agentarts-v1",
  "input": {
    "scenario": "stadium-evacuation",
    "region_id": "R_EAST_STAND",
    "trigger": "crowd_surge_alert",
    "context": { "safety_state": {}, "region": {}, "risk": {}, "camera": {}, "prediction": {} }
  },
  "tools": [{ "name": "get_crowd_status", "description": "...", "roles": ["agent"] }]
}
```

### 决策响应（两种结构均接受）

```json
{ "decision": { "tool": "request_supplemental_observation",
                "arguments": { "region_id": "R_EAST_STAND", "channel": "staff" },
                "reasoning": "摄像头降级，需要现场证据" } }
```

或扁平结构 `{ "tool": "...", "arguments": {...}, "reasoning": "..." }`。

### 本地执行约束

平台返回的 `tool` 必须：

1. 存在于本地工具注册表；
2. 当前 actor（默认 `agent`）有权限调用；
3. 参数通过 Zod 校验；
4. 在超时时间内完成。

任一不满足即失败，不执行任何危险动作。

## 5. 已完成验证

- 缺少配置 → `LOCAL_DEMO`，不尝试远程；
- 健康探测 200 → `AGENTARTS_CONNECTED`；503 → `AGENTARTS_UNAVAILABLE`；
- 决策响应包裹/扁平两种结构都能解析；
- 401、非 JSON、超时都会显式抛错；
- 以上均由本地 HTTP stub 做契约测试，**不是**真实平台调用；
- 运行时接线已验证：健康探测成功后 `MvpService.runAgent(runtime=agentarts)` 会执行平台返回的工具；
  探测失败时返回 `AGENTARTS_UNAVAILABLE` 且不执行任何工具（`tests/mvp/agentarts-runtime.test.ts`）。

## 6. 完成真实接入还需要

1. 获取真实租户的 AgentArts 控制台访问权限与 API 文档；
2. 在控制台创建主干 Agent，配置工具（若平台支持 MCP，则配置 MCP Server 地址；
   若不支持，则按官方插件/HTTP 方式桥接本仓库工具 API）；
3. 用真实的 `AGENTARTS_*` 配置启动，调用 `?probe=1` 确认健康；
4. 用真实租户跑一次决策请求，保存请求/响应与 Trace；
5. 更新本文档与 `docs/MVP_LIMITATIONS.md`，把“未实机验证”改为实际结果。

在上述步骤完成前，任何材料都不得声称“已完成 AgentArts 平台集成”。

## 7. 来源

- 华为云 ModelArts Studio：<https://www.huaweicloud.com/product/modelarts-studio.html>
- 华为云 API Explorer：<https://console.huaweicloud.com/apiexplorer>
- 公开检索未找到 AgentArts 官方 API 文档（检索日期 2026-11-05）。
