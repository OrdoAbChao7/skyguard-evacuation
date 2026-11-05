# AGENTS.md — SkyGuard 独立项目开发准则

本仓库是从灵小禅仓库拆出的**独立安全决策项目**。任何 Agent 修改代码、场景或文档前，
必须先读本文件与 [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md)。

## 1. 不可触碰的边界

1. **场景是数据，判定是代码**：区域 / 通道 / 出口 / 演示脚本 / 地图层只能通过
   `data/scenarios/*.json` 修改；不得把具体场景写死进 TS/TSX。
2. **规划器不得自我认证**：`validator.ts` 必须独立重建约束，不读 `plan.status`
   或规划器的中间成功标志。任何"让校验器复用规划结果"的改动都必须拒绝。
3. **未知一律不可用**：`status: unknown` 与 `capacity_per_min: null` 必须继续被排除在规划之外，
   并在被使用时由校验器报硬违规。
4. **状态优先级固定**：`DEGRADED > REJECT > REROUTE > NORMAL`。数据不可信时不得下
   "方案不可行"的结论。
5. **不得伪造数据**：场景中的面积、容量、置信度、provenance 必须如实标注；
   性能数字只能来自 `npm run bench` 的本机实测，并保留原始 JSON。

## 2. 换场景的流程

见 [`docs/SCENARIO.md`](docs/SCENARIO.md)。核心原则：新增 JSON + 可选底图，
不改疏散引擎；新场景必须通过结构校验、`npm test` 与 `npm run demo`。

## 3. 验证要求

修改安全域代码后必须运行：

```powershell
npm test          # 后端 42 用例 + 前端 4 用例
npm run demo      # A/B/C 演示场景最终状态必须与 expected_state 一致
npm run build     # backend tsc + frontend vite build
```

涉及规划 / 校验性能时额外运行 `npm run bench`，并提交重新生成的
`evaluation/performance.json`。

## 4. 对外表述

- 只能说"研究原型 / 辅助决策"，不能说"应急指挥系统"或"已通过安全认证"；
- 未在真实昇腾设备上跑过的推理，不得表述为"已完成昇腾适配"；
- 合成场景数据不得表述为真实场馆测绘结果；
- 不得引用灵小禅仓库的历史竞赛成绩作为本仓库成果。

---

## 5. SkyGuard MVP 增量约定（2026-11-05）

本仓库在安全内核之上新增 MVP 业务闭环（体育场散场）。修改相关代码时必须遵守：

1. **Agent 不得越权**：Agent 只能创建 `PENDING_APPROVAL` 工单；审批、派发必须由
   `admin` / `safety_operator` 完成；接单、执行、反馈必须由被指派的 `staff` 完成。
2. **VoI 参数只能来自场景文件**：先验、似然、损失、成本、权重不得由大模型生成，
   也不得在代码里写死；修改必须同步 `docs/VOI_MODEL.md` 与实验。
3. **AgentArts 不得伪装**：没有真实租户与实机调用时，界面必须显示 `LOCAL DEMO` /
   `AGENTARTS UNAVAILABLE`；不得声称已完成平台集成。
4. **MCP 工具与本地 Agent 共用一份实现**（`services/mvp/tools.ts`），
   新增工具必须声明角色、Schema、超时并写入审计。
5. **前端不得写死演示结果**：预测、Agent、人员、工单、审批状态全部来自后端 API。
6. **不允许删除或弱化原安全测试**；MVP 改动后至少运行：
   `npm test`、`npm run demo`、`npm run demo:mvp`、`npm run build`，
   实验相关改动还要运行 `npm run experiments:mvp` 并提交新报告。
7. **模拟与真实严格区分**：人员位置、无人机、概率参数、实验数据均为合成；
   没有真实硬件与凭证时，只能完成适配器、契约测试和接入文档。

---

## 6. 竞赛强化阶段约定（2026-11-05）

### 6.1 四个审查角色

| 角色 | 关注点 | 产出 |
| --- | --- | --- |
| 架构师 | 模块边界、场景配置与代码分离、前后端一致性 | P0/P1 缺陷与修复 |
| 算法审查 | VoI 归一化/敏感性、预测泄漏/区间、规划/调度约束 | 回归测试与实验 |
| 安全审查 | 独立校验、四态、权限、过期审批、MCP 注入面 | 故障注入与修复 |
| 实验评估 | 多种子、置信区间、失败案例、原始数据 | `evaluation/COMPETITION_REPORT.md` |

### 6.2 新增硬性规则

1. 工单必须记录 `context_version`；观测/约束/场景变化后标记 `stale`，派发前必须由管理员重新确认。
2. Agent 创建工单必须带幂等键（重试不得产生重复任务）。
3. 预测必须用时间顺序滚动验证；禁止未来数据泄漏；区间必须报告覆盖率。
4. VoI 实验必须报告多种子、置信区间、成本-收益权衡与敏感性，不得只报均值。
5. 研究主张必须登记到 `research/CLAIMS.md`；未实机验证的平台/硬件必须标记。
6. 安全加固默认项：限流、请求 ID、生产错误脱敏；CORS/CSP/读鉴权按环境配置。
7. 不把 `stale` 工单、未校验方案、DEGRADED 数据展示为可用/已验证。
