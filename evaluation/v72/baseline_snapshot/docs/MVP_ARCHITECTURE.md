# SkyGuard MVP 架构

> 项目：SkyGuard——面向大型活动的主动感知与现场协同管理智能体  
> 首个场景：大型体育场散场（合成数据）  
> 本文件描述实际实现，不描述未实现的平台能力。

## 1. 总览

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ 前端指挥大屏（React + SVG）                                                │
│  态势地图 · 预测 · 摄像头 · 工作人员 · Agent 控制台 · 审批 · 工单          │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ HTTP /api/v1（读开放，写需 JWT）
┌───────────────────────────────▼──────────────────────────────────────────┐
│ API 层  Express + Zod                                                     │
│   /safety/*   既有安全内核（规划、校验、状态机、审计）                      │
│   /mvp/*      MVP 业务编排（预测、Agent、人员、工单、回放）                 │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────┐
│ 编排层  MvpService                                                        │
│   SafetyDecisionService · PredictionService · OpsService · ReplayService   │
│   ToolRegistry · AgentService · AgentArtsClient                            │
└───────┬───────────────┬───────────────┬───────────────┬──────────────────┘
        │               │               │               │
┌───────▼─────┐ ┌───────▼─────┐ ┌───────▼─────┐ ┌───────▼────────┐
│ 安全内核     │ │ 预测/VoI     │ │ 人员/工单    │ │ 工具与运行时    │
│ 规划器       │ │ ema-linear  │ │ 推荐/状态机  │ │ MCP 15 tools   │
│ 15 类校验    │ │ Bayesian VoI│ │ 审批/反馈    │ │ Local/AgentArts│
│ 四态状态机   │ │ 证据更新     │ │ 审计         │ │ Trace          │
└─────────────┘ └─────────────┘ └─────────────┘ └────────────────┘
        │
┌───────▼──────────────────────────────────────────────────────────────────┐
│ 数据层  data/scenarios/*.json · data/replays/* · data/audit/*.jsonl        │
└──────────────────────────────────────────────────────────────────────────┘
```

## 2. 目录

```text
backend/src/
  services/safety/           既有安全内核（未重写）
    planning/evacuation-planner.ts
    planning/min-cost-flow.ts
    validator.ts
    state-machine.ts
    audit.ts
    observations.ts
    providers/{simulation,video,ascend}.ts
  services/mvp/
    index.ts                 编排与单例
    prediction.ts            EMA + 线性预测
    voi.ts                   Bayesian VoI
    ops.ts                   人员推荐 + 工单状态机
    ingest.ts                CSV/JSON 回放 + 摄像头健康
    tools.ts                 15 个工具（MCP 与本地共用）
    agent.ts                 本地主干 Agent
    agentarts.ts             AgentArts 适配器
  api/v1/
    safety.ts                既有安全 API
    mvp.ts                   MVP API
  mcp/server.ts              MCP stdio Server
frontend/src/pages/command-center/
  CommandCenterPage.tsx      既有大屏
  MvpPanels.tsx              预测/Agent/人员/审批/工单面板
frontend/src/services/
  safetyApi.ts               既有安全 API 客户端
  mvpApi.ts                  MVP API 客户端
data/scenarios/
  venue-default.json         合成演示场馆（旧）
  stadium-evacuation.json    体育场散场场景（MVP）
```

## 3. 数据流

### 3.1 感知

```text
视频回放 / CSV / JSON / 模拟
        │
        ▼
ReplayService / SafetyDecisionService.ingestObservation
        │  写入 ObservationStore（保留最近 200 条/区域）
        ▼
assessObservation → 可信 / 过期 / 低置信 / 无效
        │
        ├──► 风险评估（密度 + 趋势 + 事件 + 出口可达性）
        ├──► 预测服务（可信点位 + EMA/线性）
        └──► 摄像头健康（在线 / 降级 / 离线 / 未知）
```

### 3.2 安全内核

```text
观测 + 事件 + 场景
      ▼
resolveEffectiveNetwork（剔除 closed / unknown / 容量未知）
      ▼
planEvacuation（时间扩展最小费用最大流）
      ▼
validateSafetyPlan（15 类硬约束，独立重建）
      ▼
decideSafetyState（DEGRADED > REJECT > REROUTE > NORMAL）
      ▼
发布 / 拒绝 / 要求人工
```

### 3.3 Agent 调查与工单

```text
异常/信息缺口
      ▼
抓取态势、摄像头、预测、风险
      ▼
计算动作可用性（摄像头在线？人员可达？无人机可用？）
      ▼
VoI 排序 → 选择动作 / 停止 / 转人工
      ▼
工具调用（摄像头查询 / 现场核查请求 / 无人机请求 / 历史 / 预测）
      ▼
证据更新信念（贝叶斯）→ 风险与熵变化
      ▼
人员推荐 → 创建 PENDING_APPROVAL 工单
      ▼
人工审批 → 派发 → 工作人员接单/执行/反馈
      ▼
反馈写回 field_report 观测 → 重新规划与评估 → 新一轮决策
```

## 3.4 人员推荐算法

输入：目标区域、所需技能、可选岗位偏好。

1. 遍历场景 `staff`，读取运行时状态（available / busy / off_duty）；
2. 排除非 available、缺少必需技能、按现有通道不可达的人员；
3. 用 Dijkstra 在开放且容量已知的通道上计算从人员所在区域到目标区域的通行时间；
4. 打分：`100 - 通行分钟数 × 2 + 岗位匹配(12) + 技能匹配(10/4)`；
5. 按分数降序返回候选与理由；没有候选时返回 `shortage=true` 与原因，
   **不会**伪造一个不可用人员。

派发时再次校验人员状态，避免推荐后被其他工单占用。

## 3.5 审批与工单状态机

```text
DRAFT → PENDING_APPROVAL → APPROVED → ASSIGNED → ACCEPTED → IN_PROGRESS → COMPLETED
                         └→ REJECTED                         └→ FAILED
```

- 非法流转直接抛 `WorkOrderTransitionError`，不存在“跳过审批”的路径；
- `approve/reject/assign` 仅 admin / safety_operator；
- `accept/start/complete/fail` 仅 staff，且 `staff_id` 必须等于 `assigned_staff_id`；
- 完成反馈会写回 `field_report` 观测并调用安全域重算；
- 拒绝必须填写审批意见；失败必须填写原因；
- 所有流转写入审计日志与工单 `history`。

## 4. 职责边界

| 角色 | 可以做 | 不可以做 |
| --- | --- | --- |
| 感知 Provider | 提供人数、置信度、来源 | 判定路线安全 |
| 预测服务 | 给出趋势与区间 | 发布安全结论 |
| VoI 引擎 | 排序调查动作、给出停止依据 | 编造概率/成本 |
| Agent | 组织工具、整合证据、生成建议 | 计算安全路线、审批、派发、控制无人机 |
| 安全规划器 | 生成候选方案 | 自我认证 |
| 独立校验器 | 判定硬约束 | 参与生成 |
| 状态机 | 决定可发布性 | 修改约束 |
| 管理员 | 审批、拒绝、派发 | 绕过校验器发布 |
| 工作人员 | 接单、执行、反馈 | 操作未指派给自己的工单 |

## 5. 场景适配

场景文件同时承载：

- 区域 / 通道 / 出口 / 阈值（安全内核）；
- 场馆规则、无人机资源、工作人员名册（MVP）；
- 调查先验/似然/损失/权重/动作成本（VoI）；
- 演示脚本、模拟基线、地图层。

体育场逻辑没有写死在 Agent 或前端：Agent 读取 `policy.actions` 与工具清单，
前端读取 `/mvp/dashboard` 的区域、人员、工单与预测。换场景只需新增 JSON，
再按 `docs/SCENARIO.md` 校验。

## 6. 审计与 Trace

| 记录 | 位置 |
| --- | --- |
| 安全操作（观测、事件、规划、校验、方案） | `data/audit/audit-YYYY-MM-DD.jsonl` |
| 工具调用（MCP 与本地 Agent 共用） | 同上，动作 `tool.<name>` |
| 工单流转 | 同上，动作 `work_order.<status>` |
| Agent 运行 | 同上，动作 `agent.run` + 运行对象内 `trace[]` |
| 决策 Trace（规划阶段） | `AuditLog.startTrace/addStage/finishTrace` |

不记录、不展示模型隐藏思维链；只记录可复核的工具参数、结果摘要、来源、耗时与结论。
