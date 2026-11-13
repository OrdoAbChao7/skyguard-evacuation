# SkyGuard 正式交付说明（V6.2）

## 1. 项目定位

SkyGuard 是面向大型活动散场的**主动感知、风险调查与可信现场协同**科研原型。
核心闭环：

```text
人流感知 → 短时预测 → VoI 主动调查 → 人员调度 → 待审批工单
→ 管理员审批 → 工作人员接单/执行/反馈 → 重新评估
```

安全内核独立于 Agent：规划器生成方案，独立 Validator 判定硬约束，四态状态机决定可发布性；
Agent 只组织工具和证据，不能审批、派发或控制无人机。

## 2. 架构与技术栈

- 后端：Node.js 24 + TypeScript + Express + Zod
- 前端：React 19 + Vite + SVG 态势图
- 数据：JSON 场景/回放 + JSONL 审计 + 可选工单快照
- 智能体：本地确定式 Agent；AgentArts 可配置 HTTP 适配器（未实机）
- 工具：官方 MCP SDK，stdio，15 个工具
- 安全：JWT 角色、限流、CORS/CSP 配置、请求 ID、生产错误脱敏
- 部署：Dockerfile、GitHub Actions 配置（未实机运行）

详细模块见 `docs/MVP_ARCHITECTURE.md`、`docs/COMPETITION_TECHNICAL_REPORT.md`。

## 3. 三个可证明创新

1. **信息价值驱动的序贯主动调查**：贝叶斯后验 + 熵 + 风险损失 − 成本；预算、重试、冷却、冲突。
2. **多区域风险传播与联合调查**：区域图、风险传播、覆盖权重、联合 VoI；30 种子配对实验。
3. **安全约束下的人机协同**：独立 Validator、四态状态机、上下文失效、审批与反馈闭环。

证据等级严格区分：VERIFIED / PARTIALLY_SUPPORTED / HEURISTIC / UNVERIFIED（见 `research/CLAIMS.md`）。

## 4. 本地运行

```powershell
npm run setup
npm run dev          # 后端 8010 + 前端 5173
```

- 管理员：`admin / skyguard2026`（部署前必须改）
- 工作人员：`STF-01`~`STF-08`，演示登录码见场景文件（1001~1008）
- 大屏：`/`；登录：`/login`；工作人员移动端：`/staff`

## 5. 演示与复现

```powershell
npm run demo          # 原安全域三场景
npm run demo:mvp      # MVP 三场景
npm run benchmark:competition --prefix backend
npm run benchmark:v6 --prefix backend
npm run benchmark:v62 --prefix backend
npm run verify:evidence --prefix backend
npm run manifest:evidence --prefix backend
```

一键复现：`evaluation/v62/reproduce.ps1`。

## 6. 数据与证据

| 层 | 位置 |
| --- | --- |
| 原始实验 | `evaluation/v61/`（冻结）、`evaluation/v62/`、`evaluation/v6/`、`evaluation/competition/` |
| 汇总/校验 | `evaluation/v61/verification.json`、`evaluation/MANIFEST.json` |
| 报告 | `evaluation/V6_2_REPORT.md`、`evaluation/COMPETITION_REPORT.md`、`evaluation/V6_1_REPORT.md` |

- V6.1 冻结：`evaluation/v61/FREEZE.sha256`；V6.1 复跑输出到临时目录，不覆盖冻结数据。
- 清单：`evaluation/DATA_MANIFEST.md`，SHA-256 可校验。
- 治理规则：`docs/DATA_GOVERNANCE.md`。

## 7. 关键结果（合成数据）

| 项 | 结果 |
| --- | --- |
| 多区域 VoI（30 种子） | 总风险降低 0.2154 vs 0.0472；成本 0.584 vs 0.253；效率差 +0.0917 [0.0755,0.1079]（目标轮换设计） |
| 同目标设计（V6.1） | 效率差不显著；说明结论依赖目标策略 |
| 序贯调查 | 同 2 次尝试预算：成功率 90.9%，检测 77.7%，决策 96.0% |
| 预测 | stable/decline/missing 自适应更好；surge/periodic persistence 略优；区间覆盖率未稳定达标 |
| 安全 | 故障注入 5/5，状态机 6/6，错误发布 0，闭环 20/20 |
| 测试 | 后端 104/104，前端 8/8 |
| 证据一致性 | 134/134 checks；46/46 文件哈希 |

## 8. 外部依赖

- 华为云 AgentArts 租户/凭证/官方 API（未接入）
- 昇腾 NPU/CANN/`.om`（未实测）
- 真实场地测绘、人流/视频、无人机（未接入）
- Docker daemon / GitHub Actions 运行环境（未验证）
- 公开人群数据集与模型权重（未运行）

## 9. 已知限制

- 全部为合成数据；不能证明真实场馆效果。
- 风险传播/覆盖权重/人员评分是未标定启发式。
- 预测区间覆盖率未稳定达到 90/95%。
- 单进程内存状态；工单 JSON 快照非数据库。
- 无浏览器 E2E、无多实例/事务。
- 未通过消防/公共安全/功能安全认证。

## 10. 发布定位

**Research Prototype Candidate**：可复现、可审计、可演示；
不是生产系统，不替代现场指挥，不构成获奖承诺。
