# 创新点—证据映射

| 创新点 | 可运行证据 | 实验证据 | 边界 |
| --- | --- | --- | --- |
| 1. 风险/信息价值驱动的主动调查 | `voi.ts`、`agent.ts`、Agent 控制台、MCP 工具 | 实验 A：VoI vs 固定/随机/启发式；5 种子、Bootstrap、权重敏感性、Pareto | 参数合成；不宣称全面优于基线 |
| 2. 固定摄像头 + 无人机 + 预测的多源感知 | `ingest.ts`、`prediction.ts`、UAV 工单、摄像头健康 | 实验 B：5 方法滚动验证；MAE/RMSE/覆盖率/峰值 | 无真实视频/无人机；预测突增弱 |
| 2b. 多区域风险传播与联合调查（V6） | `risk-graph.ts`、`multi-voi.ts`、多区域面板 | V6.2 30 种子：总收益 4.6×、成本 2.3×；V6.1 同目标效率不显著。**V6.4 公平复跑**（相同动作覆盖 + 观测采样）：多 0.1711 vs 单 0.0446，配对差 0.1265 [0.1209,0.1321]，d_z=1.27；效率 0.2971 vs 0.2643，随机/启发式效率更高 | 覆盖权重/传播系数为启发式；V6.2 效应量受信息权限放大 |
| 3. 融合场地/预测/资源的安全约束调度 | `ops.ts`、工单状态机、人员推荐、规划器+Validator | 实验 C：48 组扰动、5/5 故障注入；实验 E：20/20 闭环 | 合成场地；无真实人员/通道 |
| 可信安全决策（支撑） | `validator.ts`、`state-machine.ts`、审批权限、上下文版本 | 实验 D：6/6 状态机用例；0 错误发布 | 不证明现场安全 |
| AgentArts/MCP（平台） | `agentarts.ts`（官方运行时契约、有界多步、状态分离）、`mcp/server.ts`（stdio + HTTP）、标准 SDK 测试 | 15 工具、权限拒绝、幂等、运行时接线、多步等待、重复调用停止、MCP/网页共享状态 | **未实机连接 AgentArts**；HTTP MCP 无独立鉴权层 |
| 昇腾边云（平台） | `providers/ascend.ts`、`docs/ASCEND_DEPLOYMENT.md` | 仅环境探针与契约 | **未实机验证** |

## 对外表述模板

> SkyGuard 在合成体育场场景中实现了“感知—调查—预测—调度—审批—反馈”闭环；
> 独立校验与四态状态机在注入故障实验中阻止了错误发布；VoI 在模拟中降低了调查成本，
> 但风险收益与预测精度仍受合成参数限制。AgentArts 与昇腾目前为适配层/接入路径，未实机验证。

## V6.5 增补

| 创新点 | 可运行证据 | 实验证据 | 边界 |
| --- | --- | --- | --- |
| 资源生命周期与可信工单 | `ops.ts` 预留/取消/幂等指纹、`reservations.test.ts`、HTTP 409 | 预算边界、并发同人、过期重确认、场景版本失效全部通过 | 单实例；预算结算用声明值 |
| 单实例事务状态与恢复 | `persistent-store.ts`、`state-persistence.test.ts`、启动 fail closed | 跨业务恢复；backup/temp 恢复；双副本损坏 exit 1 | 无多实例事务；内存视图仍可能落后于审计文件 |
| AgentArts 失败语义 | 官方契约、重试/SSE/越权/续接 stub 测试 | 5xx/超时重试、4xx 不重试、截断 SSE 拒绝、越权无副作用 | **无真实租户/Trace** |
| 预测不确定性传播 | `prediction.ts` reliability、`availability.ts`、`prediction.test.ts` | 30 种子 × 6 机制；surge 95% 覆盖 0.738；periodic/noisy 预测动作几乎全阻断 | 合成机制；区间非正式置信区间 |
| 感知→决策门禁 | `perception/adapter.ts`、`adapter.test.ts`、质量 API、前端面积/密度 | 图像/显示帧→人数→面积→密度；未标定/面积不符/低置信度 fail closed | CityStreet 无真值；P2PNet 非现场 |

## V7.0 增补（预测 / 动态规划 / 联合 VoI）

最终证据：`evaluation/v70/v70-final-20261109T195122/`（根 `MANIFEST.json` + 三组独立清单）。
复现：`npm run benchmark:v70`。

| 创新点 | 可运行证据 | 实验证据 | 边界 |
| --- | --- | --- | --- |
| 状态感知预测集成与不确定性 | `forecast-advanced.ts`（Kalman/ARIMA/Holt-Winters/在线 LSTM/regime/conformal/漂移）、`forecast-advanced.test.ts`、`GET /api/v1/mvp/v70/forecast/:regionId` | 30 种子 × 7 机制 × 11 方法：集成显著优于 persistence/EMA/linear/Kalman/LSTM，但劣于 ARIMA/Holt-Winters/旧自适应；无单一最优；surge 95% 覆盖 0.748 | 合成数据；区间非正式置信区间；不得用于安全告警 |
| 漂移与状态检测 | `detectRegime`、`detectDrift`（Page-Hinkley + 误差比） | regime_shift 突增/下降检测率 1.0，stable 误报 0.016；periodic/surge regime 准确率有限 | 短窗口不稳定；只作提示 |
| 滚动时域 MPC + 队列执行反馈 | `mpc-planner.ts`、`congestion.ts`、`GET /api/v1/safety/v70/mpc-preview`、`planning-v70.test.ts` | 30 种子容量受压场景：未疏散 613→0，完成时间 19→8.33；相对仅重规划，预测/队列反馈无显著增量 | BPR/服务衰减未标定；即时响应假设；不代表真实场馆 |
| 受限 MILP 与最大流/最短路径对照 | `strategies.ts`（受限二进制出口分配枚举、最大流、容量盲最短路径） | milp_restricted 完成时间 11.30、队列 18523，显著优于 static_mcf；shortest_path 容量盲、校验失败 | 仅 ≤5 个竞争区域枚举；非全局 MILP |
| 联合 VoI（相关性 + 冗余） | `joint-voi.ts`、`joint-voi.test.ts`、`GET /api/v1/mvp/v70/joint-investigation` | 30×40 公平实验：总收益略低（−0.0026），最坏区域风险略低（−0.0007）；Oracle 覆盖 1.0 | 合成相关性；启发式近似；不得宣称全面更优 |
| 可信预览边界 | `v70/research.ts`、`v70-api.test.ts` | 观测不可信 fail closed；只读不改变版本；带预测步骤不声明已验证 | 预览不发布方案 |
| 求解器稳健性 | `minCostMaxFlowDijkstra`、既有安全测试 201/201 | 避免零费用残量环回溯死循环；安全主链路 SPFA 未改 | 新方法仅用于研究求解器 |
