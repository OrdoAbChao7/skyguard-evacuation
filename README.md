# SkyGuard — 应急疏散辅助决策原型

SkyGuard 是一个**独立的安全决策研究原型**：把
「人群感知 → 风险评估 → 容量约束疏散规划 → 独立安全校验 → 四态状态机 → 指挥大屏」
串成一条可审计、可复现的闭环。

> ⚠️ **这是研究原型，不是应急指挥系统。**
> 当前场景数据为合成演示数据，昇腾硬件推理未经实测，不能用于真实疏散指挥。
> 引用前必读 [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md)。

## 项目状态

> **当前状态唯一事实来源：** [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md)<br>
> 阶段：Research Prototype Candidate（V6.2 证据已冻结，V6.4/V6.5 工程与实验加固进行中）；不是 Production Ready。

- 本仓库从灵小禅（Lingshan AI Guide）仓库中的 SkyGuard 安全业务域拆分而来，
  与文旅导览业务**完全切割**：没有游客端、RAG、数字人、管理后台。
- **疏散引擎原样保留**：时间扩展最小费用流规划器、15 类硬约束独立校验器、
  四态状态机、审计日志与感知 provider 均未改动行为。
- **新场景尚未确定**。因此场景层被显式做成可替换输入：
  区域 / 通道 / 出口 / 演示脚本 / 大屏底图与地标 / 模拟基线全部在
  `data/scenarios/*.json` 中声明，换场景不需要改疏散代码。
  详见 [`docs/SCENARIO.md`](docs/SCENARIO.md)。
- 默认场景为 `stadium-evacuation.json`（合成体育场散场）；`venue-default.json` 保留为旧版合成场馆。场景仅用于验证闭环，不代表任何真实建筑。

## MVP 端到端闭环（华为 ICT 方向）

在安全内核之上新增了完整业务闭环，首个场景为**大型体育场散场**（合成数据）：

```text
回放/模拟人流 → 异常发现 → Agent 主动调查（VoI）→ 预测与风险评估
→ 人员推荐 → 待审批工单 → 管理员审批 → 工作人员接单/执行
→ 现场反馈写回观测 → 重新规划与评估
```

- **感知**：视频回放、CSV/JSON 回放、模拟观测、摄像头健康；固定摄像头与无人机观察统一契约。
- **预测**：`adaptive-forecast-v3`，滚动验证选择 persistence/EMA/linear/damped/blend，输出趋势、区间、数据充分性与不确定性说明。
- **VoI**：贝叶斯后验 + 信息熵 + 预期风险降低 + 时间/资源/失败成本，参数全部来自场景文件。
- **Agent**：本地确定式主干 Agent；AgentArts 官方运行时契约与有界多步已实现但**未实机连接**，界面明确区分 `LOCAL DEMO`、平台可达性与业务闭环状态。
- **MCP**：官方 SDK 实现 15 个工具，stdio 与同进程 Streamable HTTP `/mcp` 共用权限、Schema、超时与审计。
- **人员与工单**：推荐算法（技能/状态/通道距离）、完整状态机、人工审批、接单执行反馈；工单创建即预留人员/预算，拒绝/取消/过期/失败释放，完成结算。
- **状态与恢复**：单实例 `MVP_STATE_FILE` 原子快照覆盖安全/工单/预算/Agent/审计；损坏或版本超前时 fail closed。
- **感知门禁**：图像/派生帧 → 人数 → 面积/标定门禁 → 区域观测；未标定数据不进入安全域。
- **前端**：大屏新增预测、摄像头、人员、Agent 控制台、审批中心与工单面板。

命令：

```powershell
npm run dev               # 同时启动后端 + 前端
npm run demo:mvp          # 三个端到端场景（正常 / 局部积聚 / 不可信与容量不足）
npm run experiments:mvp   # 四组可复现实验 → evaluation/MVP_REPORT.md
npm run mcp --prefix backend   # 标准 MCP stdio Server
```

文档：

- [`docs/MVP_ARCHITECTURE.md`](docs/MVP_ARCHITECTURE.md)
- [`docs/MVP_RUNBOOK.md`](docs/MVP_RUNBOOK.md)
- [`docs/AGENTARTS_INTEGRATION.md`](docs/AGENTARTS_INTEGRATION.md)
- [`docs/MCP_TOOLS.md`](docs/MCP_TOOLS.md)
- [`docs/VOI_MODEL.md`](docs/VOI_MODEL.md)
- [`docs/PREDICTION_MODEL.md`](docs/PREDICTION_MODEL.md)
- [`docs/MVP_LIMITATIONS.md`](docs/MVP_LIMITATIONS.md)
- [`evaluation/MVP_REPORT.md`](evaluation/MVP_REPORT.md)

## 竞赛级证据与交付

| 交付物 | 位置 |
| --- | --- |
| 统一基准（多随机种子、置信区间、敏感性、Pareto、故障注入） | [`evaluation/COMPETITION_REPORT.md`](evaluation/COMPETITION_REPORT.md) |
| V6 科研报告（多区域 VoI、重试、邻居预测、多事件） | [`evaluation/V6_REPORT.md`](evaluation/V6_REPORT.md) |
| V6.1 科研审计（公平预算、序贯审计、严格滚动预测、图敏感性） | [`evaluation/V6_1_REPORT.md`](evaluation/V6_1_REPORT.md) |
| V6.2 30 种子统计与最终交付 | [`evaluation/V6_2_REPORT.md`](evaluation/V6_2_REPORT.md)、[`docs/FINAL_DELIVERY.md`](docs/FINAL_DELIVERY.md)、[`RELEASE_AUDIT_FINAL.md`](RELEASE_AUDIT_FINAL.md) |
| V6.4 公平 VoI 与工程加固 | [`docs/V6_4_IMPLEMENTATION_REPORT.md`](docs/V6_4_IMPLEMENTATION_REPORT.md)、[`evaluation/voi-v2/`](evaluation/voi-v2/) |
| V6.5 资源/状态/预测/感知加固 | [`docs/V6_5_IMPLEMENTATION_REPORT.md`](docs/V6_5_IMPLEMENTATION_REPORT.md)、[`evaluation/v65/`](evaluation/v65/) |
| 研究资料库（38 条来源、10 篇专题笔记） | [`research/INDEX.md`](research/INDEX.md) |
| 当前状态事实源 | [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) |
| 6–8 分钟演示脚本 | [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md)、[`docs/DEMO_SCRIPT_6_8MIN.md`](docs/DEMO_SCRIPT_6_8MIN.md) |
| 答辩问题库 | [`docs/DEFENSE_QA.md`](docs/DEFENSE_QA.md)（40 问）、[`docs/QA_BANK.md`](docs/QA_BANK.md) |
| 核心研究贡献 | [`docs/RESEARCH_CONTRIBUTIONS.md`](docs/RESEARCH_CONTRIBUTIONS.md) |
| 完整技术报告 | [`docs/COMPETITION_TECHNICAL_REPORT.md`](docs/COMPETITION_TECHNICAL_REPORT.md) |
| 论文初稿 | [`docs/PAPER_DRAFT.md`](docs/PAPER_DRAFT.md) |
| 论文/技术报告大纲 | [`docs/PAPER_OUTLINE.md`](docs/PAPER_OUTLINE.md) |
| 创新点—证据映射 | [`docs/INNOVATION_EVIDENCE_MAP.md`](docs/INNOVATION_EVIDENCE_MAP.md) |
| 部署手册 / 昇腾路径 | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)、[`docs/ASCEND_DEPLOYMENT.md`](docs/ASCEND_DEPLOYMENT.md) |
| 发布审计 | [`RELEASE_AUDIT_REPORT.md`](RELEASE_AUDIT_REPORT.md)、[`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) |
| 真实数据评测 | [`evaluation/real-data/REPORT.md`](evaluation/real-data/REPORT.md)、[`docs/REAL_DATASET_EVALUATION.md`](docs/REAL_DATASET_EVALUATION.md) |
| 数据治理 | [`docs/DATA_GOVERNANCE.md`](docs/DATA_GOVERNANCE.md)、[`evaluation/DATA_MANIFEST.md`](evaluation/DATA_MANIFEST.md) |
| 容器与 CI | `Dockerfile`、`.github/workflows/ci.yml` |

```powershell
npm run benchmark:competition   # 竞赛级基准 → evaluation/COMPETITION_REPORT.md
npm run benchmark:v6            # V6 多区域/重试/邻居预测 → evaluation/V6_REPORT.md
npm run benchmark:v61           # V6.1（复跑请设 V61_OUT_DIR，避免覆盖冻结数据）
npm run benchmark:v62           # V6.2 30 种子统计 → evaluation/V6_2_REPORT.md
npm run verify:evidence         # 原始数据 → 汇总数字一致性校验
npm run manifest:evidence       # 证据 SHA-256 清单
```

### 工程加固

- 可配置 CORS、CSP、读接口鉴权（`READ_AUTH_REQUIRED`）、请求 ID、进程内限流；
- 生产环境错误响应不返回内部细节；
- 工单支持上下文版本失效与可选 JSON 快照持久化；
- 多区域协同面板：传播风险排序 + 联合 VoI；
- 工作人员移动端：`/staff`（登录后可接单、执行、反馈）；
- AgentArts 健康探测带有限重试，Trace ID 贯穿审计；
- MCP 工具结构化错误码与幂等键。

## 架构

```text
┌─────────────────────────────────────────────────────────────┐
│ 指挥大屏 /             React + SVG 态势图 · 5s 轮询           │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP（读免鉴权 / 写需 JWT + 运维角色）
┌───────────────────────────▼─────────────────────────────────┐
│ API  /api/v1/safety/*      Express + Zod                    │
├─────────────────────────────────────────────────────────────┤
│ 决策编排 SafetyDecisionService                                │
│   观测 → 风险评估 → 容量约束规划 → 独立校验 → 四态状态机 → 发布/拒绝 │
├──────────────┬──────────────┬──────────────┬────────────────┤
│ 感知 provider │ 规划器        │ 独立校验器    │ 状态机          │
│ 模拟/视频/昇腾 │ 时间扩展最小费用流 │ 15 类硬约束 │ NORMAL/REROUTE/ │
│              │              │              │ DEGRADED/REJECT │
├──────────────┴──────────────┴──────────────┴────────────────┤
│ 数据层  场景(区域/通道/出口/地图) · 观测 · 事件 · 方案 · 审计 JSONL │
└─────────────────────────────────────────────────────────────┘
```

**责任边界（不可跨越）**

| 角色 | 可以做 | 不可以做 |
| --- | --- | --- |
| 感知 | 提供人数、置信度、来源 | 决定路线是否安全 |
| 规划器 | 产生候选方案 | 自我认证方案安全 |
| 独立校验器 | 判定硬约束是否满足 | 参与生成方案 |
| 状态机 | 决定能发布什么 | 修改约束 |
| 大模型 | 自然语言录入辅助 | 判定约束、把失败方案改写为通过 |

## 快速开始

```powershell
npm run setup          # 安装 backend / frontend 依赖
npm run dev            # 同时启动 backend（8010）与 frontend（5173）

# 或分别启动
npm run dev:backend    # http://localhost:8010
npm run dev:frontend   # http://localhost:5173（代理 /api 到 8010）
```

生产构建：

```powershell
npm run build          # backend tsc + frontend vite build
npm start              # 由后端托管 frontend/dist
```

访问：

- 指挥大屏：`http://localhost:5173/`（开发）或 `http://localhost:8010/`（构建后）
- 操作登录：`/login`
- API：`/api/v1/safety/status`、`/api/v1/safety/scenario`、`/api/v1/safety/scenarios`
- 感知回放（只读、纯展示）：`/api/v1/perception/displays`、`/api/v1/perception/displays/citystreet-display`

### 认证

读取接口开放（便于大屏轮询）；所有**写接口**要求 JWT 且角色为 `admin` 或 `safety_operator`。

首次启动时按环境变量初始化管理员账号并写入 `data/admin_config.json`：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SKYGUARD_ADMIN_USERNAME` | `admin` | 首次初始化后以配置文件为准 |
| `SKYGUARD_ADMIN_PASSWORD` | `skyguard2026` | **部署前必须修改** |
| `SECRET_KEY` / `JWT_SECRET` | 开发默认值 | 未设置时打印警告；生产必须显式配置 |
| `SAFETY_SCENARIO_FILE` | `stadium-evacuation.json` | 场景文件名或绝对路径 |
| `PORT` | `8010` | 服务端口 |
| `DATA_ROOT` | 仓库 `data/` | 数据根目录 |

参考 [`.env.example`](.env.example)。

## 换场景

1. 复制 `data/scenarios/stadium-evacuation.json` 为新文件，替换区域 / 通道 / 出口 / 演示脚本；
2. 在 `map` 中设置底图与地标（可选），在 `simulation_baseline` 中设置模拟观测基线；
3. 启动时设置 `SAFETY_SCENARIO_FILE=<新文件名>`，或登录后调用
   `POST /api/v1/safety/admin/reload-scenario {"file":"<新文件名>"}` 热切换；
4. 用 `GET /api/v1/safety/scenarios` 查看全部候选场景及结构校验结果。

场景字段与校验清单见 [`docs/SCENARIO.md`](docs/SCENARIO.md)。

## 测试与证据

```powershell
npm test                              # 后端 175 用例 + 前端 16 用例
npm run demo                          # 进程内跑完 A/B/C 三个演示场景并校验最终状态
npm run bench                         # 实测规划/校验/决策延迟 → evaluation/performance.json
npm run benchmark:voi-v2              # 公平 VoI 复跑 → evaluation/voi-v2/<run-id>/
npm run benchmark:v65                 # 预测实验 → evaluation/v65/<run-id>/
```

| 证据 | 当前结果 |
| --- | --- |
| 后端测试（安全 + MVP + V6/V6.1 + 感知 + 状态） | 175 / 175 通过 |
| 前端测试 | 16 / 16 通过 |
| 演示场景 A（常规） | `NORMAL`，1000/1000 人分配完毕 |
| 演示场景 B（出口火灾） | `REROUTE`，原方案重规划 |
| 演示场景 C（容量不足） | `REJECT`，明确给出 180 人未解决并要求人工介入 |
| 性能基准 | 见 [`evaluation/performance.json`](evaluation/performance.json)（本机实测） |
| MVP 业务闭环 | `npm run demo:mvp`：A 正常 / B 局部积聚 / C 不可信与容量不足 全部通过 |
| MVP 自动化测试 | 预测、VoI、预算、证据生命周期、人员工单、感知、Agent、HTTP 闭环、MCP stdio/HTTP、AgentArts 官方契约 |
| 公平 VoI 复跑 | 见 [`evaluation/voi-v2/`](evaluation/voi-v2/)（相同动作覆盖 + 观测采样；不覆盖 V6.2） |
| V6.5 预测实验 | 见 [`evaluation/v65/`](evaluation/v65/)（30 种子 × 6 机制；surge 覆盖率 0.738） |
| 统一状态/资源预留 | `MVP_STATE_FILE` 原子快照；工单创建预留、重启恢复、损坏 fail closed |
| MVP 实验 | 见 [`evaluation/MVP_REPORT.md`](evaluation/MVP_REPORT.md)（固定种子，可复现） |
| 竞赛级基准 | 见 [`evaluation/COMPETITION_REPORT.md`](evaluation/COMPETITION_REPORT.md)（5 种子、CI、故障注入） |

> 测试通过 ≠ 具备实际应急指挥资质；所有性能数字均为本机测量值，不是产能承诺。

## 目录

```text
backend/
  src/services/safety/        # 疏散引擎（规划器、校验器、状态机、感知 provider、审计）
  src/services/perception/    # 感知回放展示包加载与一致性校验（不参与判定）
  src/api/v1/safety.ts        # 安全 API
  src/api/v1/perception.ts    # 感知回放只读 API
  src/api/v1/auth.ts          # 最小 JWT 认证
  tests/safety/               # 安全域测试
  tests/perception/           # 感知回放展示包测试
  scripts/                    # 演示、基准、隔离 E2E 服务
  python/crowd_service.py     # CPU 视频人群计数（可选）
frontend/
  src/pages/command-center/   # 指挥大屏
  src/pages/LoginPage.tsx     # 运维登录
  public/scenarios/           # 场景底图
data/scenarios/               # 场景定义（可替换）
data/perception/              # 感知回放展示包（派生数据 + PROVENANCE；底图不入库）
docs/                         # 场景指南、局限、决策记录
evaluation/                   # 性能实测产物
```

## 来源与边界

- 来源：灵小禅仓库 `feat/skyguard-migration` 分支的 SkyGuard 安全业务域
  （提交 `d03d38b`）及其后的 UI 改版。拆分时只保留安全域，
  疏散步线与判定语义保持不变；场景文件路径、地图层与基线改为数据驱动。
- 原项目的 AIC 竞赛成绩（96.0% / 98.0% 等）**不属于本仓库**，不得在此引用。
- 本仓库不绑定任何具体真实场馆；新场景落定前，所有场景均标注为合成数据。

## 许可与使用

研究原型，未通过任何消防 / 公共安全 / 功能安全标准认证。
未经现场测绘、标定、失效模式分析与专业评审，不得用于真实疏散。
