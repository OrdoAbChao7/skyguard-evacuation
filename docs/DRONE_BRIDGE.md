# 无人机派发桥接（V7.7）

> 定位：**人工审批后的观察任务派发桥接**，不是无人机飞控，也不是自主调度。
> 默认 `outbox` 模式只生成派发包，不发送任何网络请求；HTTP 模式只向运维配置的无人机平台发送观察任务请求。

## 1. 能力与边界

| 能力 | 当前状态 | 边界 |
| --- | --- | --- |
| 读取已审批的 `uav_observation` 工单 | 已实现 | 只读；桥接不创建、不审批、不指派工单 |
| 生成结构化派发包 | 已实现 | 默认 `outbox`，不联网；派发包不含航点、速度、姿态或控制指令 |
| HTTP 发送观察任务请求 | 已实现，已用本机 mock 端点验证 | **未与真实无人机平台联调**；需要部署方配置端点和 token |
| 幂等与单位占用 | 已实现 | 同一工单不能重复占用同一无人机；失败/过期后可重新派发 |
| 观察数据回传 | 未实现专用回调 | 由被指派的持证操作员通过现有工单反馈闭环；未来可增加签名回调 |
| 真实无人机起飞/控制 | **禁止** | 系统不提供飞控接口；不得声称“已控制无人机” |

**核心原则：**

1. Agent 只能创建 `PENDING_APPROVAL` 工单，不能调用桥接、审批或派发。
2. 只有 `admin` / `safety_operator` 可以显式生成派发包。
3. 桥接只接受已批准且已指派给具备 `uav_operation` 技能人员的工单。
4. 桥接不修改工单状态；接单、执行、反馈仍由工作人员完成。
5. 场景中的无人机单位是合成状态（`source: synthetic_uav_fleet`，`verified: false`），`real_hardware_verified` 恒为 `false`。

## 2. 工作流

```text
Agent / 人工创建 uav_observation 工单
        ↓
PENDING_APPROVAL（等待人工审批）
        ↓ 管理员批准
APPROVED
        ↓ 管理员指派具备 uav_operation 的人员
ASSIGNED / ACCEPTED
        ↓ 管理员显式调用桥接
生成派发包（outbox）或发送观察任务请求（http）
        ↓
持证操作员在外部无人机平台执行
        ↓
工作人员通过现有工单反馈提交观察结果
        ↓
安全域写入 uav_observation 观测并重新评估
```

桥接**不会**自动监听 `ASSIGNED` 事件并发送；每次派发都必须由授权人员显式调用 API。

## 3. 配置

```dotenv
# outbox（默认）| http | disabled
SKYGUARD_DRONE_BRIDGE_MODE=outbox

# 仅 http 模式需要；只允许 http/https，URL 不得包含用户名或密码
# SKYGUARD_DRONE_BRIDGE_URL=http://127.0.0.1:9000/dispatch

# 仅 http 模式需要；通过 Authorization: Bearer 发送，不要写进 URL
# SKYGUARD_DRONE_BRIDGE_TOKEN=

# 可选
# SKYGUARD_DRONE_BRIDGE_TIMEOUT_MS=5000
# SKYGUARD_DRONE_BRIDGE_TTL_MINUTES=15
# SKYGUARD_DRONE_BRIDGE_SIMULATED=true
# SKYGUARD_DRONE_BRIDGE_FILE=drone-dispatches.json
```

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SKYGUARD_DRONE_BRIDGE_MODE` | `outbox` | `outbox` 只写派发包；`http` 发送到配置端点；`disabled` 完全禁用 |
| `SKYGUARD_DRONE_BRIDGE_URL` | 空 | HTTP 端点；必须是 http/https，不得带 userinfo |
| `SKYGUARD_DRONE_BRIDGE_TOKEN` | 空 | Bearer token；只从环境变量读取，API/审计/日志不返回 |
| `SKYGUARD_DRONE_BRIDGE_TIMEOUT_MS` | `5000` | HTTP 超时，范围 1000–30000ms |
| `SKYGUARD_DRONE_BRIDGE_TTL_MINUTES` | `15` | 派发包有效期，范围 1–1440 分钟 |
| `SKYGUARD_DRONE_BRIDGE_SIMULATED` | `true` | 没有真实无人机平台时必须保持 true |
| `SKYGUARD_DRONE_BRIDGE_FILE` | 空 | 可选持久化文件；相对路径按 `DATA_ROOT` 解析 |

**注意**：`http` 模式在 URL 缺失或非法时 fail-closed，派发返回 503；不会退回 outbox。

## 4. API

### 4.1 读取桥接状态

```http
GET /api/v1/mvp/drone-bridge/status
```

返回模式、是否配置、是否模拟、可用无人机、待处理派发包、最近一次派发和配置错误。
**不返回**端点 token、完整 URL 或请求头。

### 4.2 读取派发记录

```http
GET /api/v1/mvp/drone-bridge/dispatches?limit=20
```

返回派发摘要，包括 `effective_status`（`QUEUED / SENT / FAILED / EXPIRED`）。
读接口在原型阶段开放；不包含凭据。

### 4.3 生成派发包

```http
POST /api/v1/mvp/drone-bridge/dispatches
Authorization: Bearer <admin-or-safety-operator-token>
Content-Type: application/json

{
  "work_order_id": "WO-XXXXXXXX",
  "uav_unit_id": "UAV_HANKOU_01",
  "idempotency_key": "optional-stable-key"
}
```

`uav_unit_id` 可省略，服务端选择第一个可用且未被占用的无人机单位。
`idempotency_key` 可省略，默认使用工单 ID。

**响应状态：**

| 状态 | 含义 |
| --- | --- |
| `201` | 新建派发包；`outbox` 为 `QUEUED`，`http` 成功为 `SENT` |
| `200` | 相同幂等键返回已有派发包，`duplicate: true` |
| `403` | 调用方不是 `admin` / `safety_operator`（含 Agent、staff） |
| `409` | 工单类型/状态/审批/技能/单位/幂等冲突 |
| `502` | HTTP 端点失败；派发记录为 `FAILED`，不会冒充已送达 |
| `503` | 桥接禁用或配置无效 |

**派发包示例：**

```json
{
  "schema": "skyguard.drone-dispatch/v1",
  "dispatch_id": "DD-1A2B3C4D",
  "work_order_id": "WO-XXXXXXXX",
  "region": { "id": "R_S04_L1_CREST", "name": "S04 滩顶平台" },
  "task": {
    "type": "uav_observation",
    "title": "S04 滩顶平台无人机补充观察",
    "description": "核实区域人流",
    "priority": "high",
    "required_skills": ["uav_operation"]
  },
  "assigned_operator": {
    "staff_id": "STAFF_GATE_04",
    "name": "演示操作员",
    "role": "crowd_control",
    "skills": ["uav_operation"]
  },
  "uav_unit": {
    "id": "UAV_HANKOU_01",
    "name": "江汉关—粤汉码头段空中巡逻无人机",
    "status": "available",
    "source": "synthetic_uav_fleet",
    "verified": false
  },
  "approval": {
    "by": "admin",
    "role": "admin",
    "at": "2026-11-18T09:00:00.000Z",
    "note": "同意无人机观察"
  },
  "safety": {
    "human_approved": true,
    "agent_may_not_dispatch": true,
    "no_autonomous_flight": true,
    "simulated": true
  },
  "created_at": "2026-11-18T09:01:00.000Z",
  "expires_at": "2026-11-18T09:16:00.000Z"
}
```

**HTTP 请求头：**

```text
Content-Type: application/json
Authorization: Bearer <SKYGUARD_DRONE_BRIDGE_TOKEN>
Idempotency-Key: <派发幂等键>
X-SkyGuard-Dispatch-Id: DD-...
X-SkyGuard-Work-Order-Id: WO-...
User-Agent: SkyGuard-DroneBridge/1.0
```

外部平台应返回 JSON：

```json
{ "accepted": true, "external_id": "platform-task-001", "message": "queued" }
```

`accepted: false` 或非 2xx 都记为 `FAILED`，不会把失败写成成功。

## 5. 安全设计

1. **角色门禁**：API 使用 `operatorOnly`（JWT + `admin` / `safety_operator`）；服务层再次拒绝 `agent` / `staff`。
2. **工单门禁**：类型必须是 `uav_observation`；状态必须是 `ASSIGNED` / `ACCEPTED`；必须有非 Agent 的人工批准；上下文不能 stale；资源预留必须有效。
3. **人员门禁**：被指派人员必须具备 `uav_operation` 技能。
4. **单位门禁**：只选 `status=available` 且未被进行中派发包占用的无人机单位；显式指定的单位也会校验。
5. **幂等**：同一幂等键返回同一派发包；同一工单存在进行中的派发包时，不同键返回 409。
6. **无飞控指令**：派发包只有观察任务、区域、操作员、单位和审批信息；没有航点、速度、姿态或飞控命令。
7. **HTTP 安全**：只允许 http/https；拒绝 URL 内 userinfo；`redirect: 'error'`；超时；响应体上限 64KB；只保存 `accepted` / `external_id` / `message` 等摘要。
8. **凭据保护**：token 只从环境变量读取；状态、列表、审计和错误信息不返回 token；端点 URL 去 query/fragment 后展示。
9. **审计**：`drone_bridge.dispatch_queued` / `dispatch_sent` / `dispatch_failed` / `dispatch_rejected` / `reset` 写入审计日志。
10. **不修改工单**：桥接不调用 `accept` / `start` / `complete`；工单状态由工作人员按现有流程推进。

## 6. 验证

```bash
cd backend
npx tsx --test tests/mvp/drone-bridge.test.ts
npm test
npm run build
```

测试覆盖：

- outbox 不联网、不修改工单状态；
- Agent / staff 被拒绝；
- 非 UAV 工单、未审批/未指派、无技能人员被拒绝；
- 无可用无人机单位时 fail-closed；
- 幂等键复用与工单冲突；
- HTTP 成功、HTTP 500 失败、token 不出现在响应；
- 派发记录持久化与重载；
- HTTP API 权限与读接口不泄漏端点凭据。

本机 HTTP 测试使用本地 mock 端点，**不是真实无人机平台**。

## 7. 已知限制

- 没有真实无人机平台、机场、图传或飞控接口；`real_hardware_verified` 恒为 false。
- 无人机单位状态来自合成场景，不是实时机队状态。
- 没有专用观察回调；观察结果由工作人员通过现有工单反馈提交。
- 没有航点规划、空域审批、地理围栏、失联返航或避障；这些必须由外部持证运营系统负责。
- 没有真实空域/飞行法规校验；部署方必须自行完成合规审批。
- 默认 `simulated=true`；即使 HTTP 发送成功，也只证明端点可达，不证明真实无人机执行。

## 8. 接入真实平台时

1. 由部署方提供无人机运营平台的 HTTPS 端点、认证方式和接口契约。
2. 在本地环境设置 `SKYGUARD_DRONE_BRIDGE_MODE=http`、`SKYGUARD_DRONE_BRIDGE_URL`、`SKYGUARD_DRONE_BRIDGE_TOKEN`。
3. 保持 `SKYGUARD_DRONE_BRIDGE_SIMULATED=true` 完成联调；确认请求/响应、幂等和失败语义。
4. 只有完成真实平台联调、空域审批和运营方确认后，才考虑设置 `SKYGUARD_DRONE_BRIDGE_SIMULATED=false`；当前仓库没有完成这一步。
5. 外部平台必须保留自己的人机确认、持证操作员和飞控安全边界；SkyGuard 不替代这些控制。

## 9. 禁止表述

- “已控制无人机”“无人机自动起飞”“自主派发无人机”。
- “已接入真实无人机平台”“已完成无人机实机验证”。
- “派发包包含飞控指令”“系统可替代持证操作员/空域审批”。
- 把本机 mock 端点测试描述为真实平台联调。
