# MCP 工具服务

> 实现：`backend/src/mcp/server.ts`（官方 `@modelcontextprotocol/sdk` 1.32.2）  
> 工具定义：`backend/src/services/mvp/tools.ts`（MCP 与本地 Agent 共用）  
> 启动：`npm run mcp --prefix backend`（stdio）

## 1. 传输与安全边界

- 传输：标准 MCP **stdio**；stdout 只输出协议消息，日志写 stderr。
- 身份：`MCP_ACTOR_ROLE=agent|viewer|staff`（默认 `agent`）。
  - `staff` 模式必须同时提供 `MCP_STAFF_ID` 与 `MCP_STAFF_CODE`，否则降级为 `viewer`。
- 参数：每个工具用 Zod Schema 校验，失败直接返回错误。
- 权限：工具声明 `roles`，注册表统一检查；MCP 与本地 Agent 走同一检查。
- 超时：每个工具有独立超时（2~10 秒）。
- 错误码：`UNKNOWN_TOOL / FORBIDDEN / INVALID_ARGUMENT / TIMEOUT / EXECUTION_ERROR`。
- 幂等：`create_candidate_work_order` 支持 `idempotency_key`，重复调用返回同一工单。
- 审计：每次调用写入 `data/audit/audit-YYYY-MM-DD.jsonl`，动作名为 `tool.<name>`。
- 不暴露任意文件读写、任意命令执行或 shell 能力。

## 2. 工具清单

| # | 工具 | 作用 | 允许角色 | 关键输入 |
| --- | --- | --- | --- | --- |
| 1 | `get_crowd_status` | 区域人数/密度/置信度/可信度与安全状态摘要 | 全部 | `region_id?` |
| 2 | `get_region_trend` | 时间序列 + 预测趋势 | 全部 | `region_id`, `window_minutes?` |
| 3 | `get_camera_status` | 摄像头在线/降级/离线与判定原因 | 全部 | `region_id?` |
| 4 | `request_supplemental_observation` | 摄像头查询直接取证；人员核查创建待审批工单 | agent/admin/operator | `region_id`, `channel=camera\|staff` |
| 5 | `request_uav_observation` | 创建无人机观察请求（待审批，不会自动起飞） | agent/admin/operator | `region_id`, `reason` |
| 6 | `get_venue_information` | 场馆、区域、出口、无人机资源 | 全部 | — |
| 7 | `get_venue_rules` | 场馆规则（安全/审批/无人机/人员） | 全部 | `category?` |
| 8 | `predict_crowd_trend` | 调用 ema-linear-v1 预测 | 全部 | `region_id`, `horizon_minutes?` |
| 9 | `evaluate_region_risk` | 风险评估 + 预测摘要 | 全部 | `region_id` |
| 10 | `recommend_staff` | 按技能、状态、通道距离推荐人员 | 全部 | `region_id`, `required_skills?` |
| 11 | `calculate_candidate_plan` | 调用规划器 + 独立校验器 | agent/admin/operator | `trigger?` |
| 12 | `validate_candidate_plan` | 独立校验当前候选方案 | agent/admin/operator/staff | — |
| 13 | `create_candidate_work_order` | 创建 **PENDING_APPROVAL** 工单 | agent/admin/operator | 工单字段 |
| 14 | `get_work_order_status` | 查询工单与流转历史 | 全部 | `work_order_id?`, `status?` |
| 15 | `submit_worker_feedback` | 工作人员完成工单并回写观测 | **仅 staff** | `work_order_id`, `note`, `observation?` |

### 不可用能力（刻意缺失）

- 审批、拒绝、派发工单：只能通过 HTTP API 的管理员身份完成；
- 封闭出口、控制无人机起飞、发布疏散路线：没有对应工具；
- Agent 不能自我批准或绕过独立校验器。

## 3. 返回格式

```json
{
  "tool": "get_crowd_status",
  "ok": true,
  "source": "safety-observation-store",
  "confidence": null,
  "generated_at": "2026-11-05T...",
  "duration_ms": 3,
  "error": null,
  "data": { "...": "..." }
}
```

`source` 与 `confidence` 必须随结果返回；前端与文档都按这两个字段区分数据来源。

## 4. 客户端配置示例

Claude Desktop / 兼容 MCP 的客户端：

```json
{
  "mcpServers": {
    "skyguard": {
      "command": "node",
      "args": [
        "<仓库绝对路径>/backend/node_modules/tsx/dist/cli.mjs",
        "<仓库绝对路径>/backend/src/mcp/server.ts"
      ],
      "env": {
        "DATA_ROOT": "<仓库绝对路径>/data",
        "SAFETY_SCENARIO_FILE": "<仓库绝对路径>/data/scenarios/stadium-evacuation.json",
        "MCP_ACTOR_ROLE": "agent",
        "SECRET_KEY": "change-me"
      }
    }
  }
}
```

## 5. 已验证内容

- 官方 SDK Client 通过 stdio 连接真实 MCP Server；
- 15 个工具全部可列出；
- `get_crowd_status` 返回 8 个区域；
- `submit_worker_feedback` 在 agent 身份下被拒绝；
- `create_candidate_work_order` 能创建待审批工单；
- 见 `backend/tests/mvp/mcp.test.ts`。

## 6. 与 AgentArts 的关系

华为云 AgentArts 是否支持直接接入当前 stdio MCP、以及具体的插件/HTTP 桥接方式，
**本仓库未获得官方公开接口文档或租户验证**。因此：

- MCP Server 本身按标准协议实现并通过协议级测试；
- AgentArts 侧使用可配置的 HTTP 运行时适配器（见 `docs/AGENTARTS_INTEGRATION.md`）；
- 不宣称 AgentArts 已完成 MCP 直接接入；真实接入方式需按租户控制台文档确认。
