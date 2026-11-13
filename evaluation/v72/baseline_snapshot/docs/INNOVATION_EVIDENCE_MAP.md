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

## V7.1 增补（机理、预测区间、Shadow）

证据：`evaluation/v71/v71-final-20261109T211702/`；复现：`npm run benchmark:v71`。

| 创新点 | 可运行证据 | 实验证据 | 边界 |
| --- | --- | --- | --- |
| 滚动重规划机理归因 | `mpc-planner.ts`、`v71-replanning-benchmark.ts` | 30×5×9：B vs A 未疏散 −682.8、完成时间 −5.11；V7 完成时间 8.81 vs legacy 13.88；切换 4390 vs 754 | 合成；未标定参数；切换成本未优化 |
| 预测/队列反馈消融 | E/F/G vs D | 完成时间差 ±0.03，CI 跨零；无显著增量 | 即时响应假设；不能外推为预测无用 |
| 事件触发边界 | C vs B；I vs G | legacy 重规划 −2.57、求解 −0.28ms；V7 完成时间 10.29 vs 8.81 | 阈值未标定；不得默认开启 |
| 自适应 conformal + 变点 | `conformal.ts`、`conformal.test.ts`、`v71-prediction-benchmark.ts` | surge 0.748→0.846；regime_shift 后段 0.809→0.907；periodic 0.982→0.833；整体覆盖差 0 | 合成；非正式置信区间；门控失败率上升 |
| Shadow Mode 工程准备 | `v7-adapter.ts`、`decision-service`、`shadow-mode.test.ts`、`GET /safety/v70/shadow` | 默认关闭；双方案独立校验；超时/异常回退；V7 不发布 | 超时非抢占；内存记录；未启用 |
| 出口/通道/双向压力 | `v71-hardening.test.ts`、A-G 场景 | 出口故障/通道封控/双向压力下规划与校验一致 | 合成容量 |
| 公开数据许可核验 | `docs/DATASET_CANDIDATES_V71.md` | MOT20/SDD/NWPU 已核验；UCF/ShanghaiTech 部分；JHU/ETH/UCY/CityStreet 未核验 | 无公开疏散决策标签 |

## V7.2 增补（稳定性、标定、可信集成）

证据：`evaluation/v72/v72-final-20261110T014910/`；复现：`npm run benchmark:v72`。

| 创新点 | 可运行证据 | 实验证据 | 边界 |
| --- | --- | --- | --- |
| 路线稳定性 A-F（迟滞/切换惩罚/承诺/自适应） | `route-stability.ts`、`v72-stability-benchmark.ts`、`v72-stability.test.ts` | 切换 5261.8→4268.3（迟滞）→3334.3（惩罚/承诺）；完成 +0.05/+0.45–0.51；队列 +1.3k–2.7k；密度 +0.07–0.08 | 合成；参数未标定；非免费 |
| 承诺式逐区域求解 + 紧急覆盖 | `stable-solver.ts`、`mpc-planner.ts`、`v72-redteam.test.ts` | 高需求冲突显式报告；运行中出口故障后 0 条路线使用故障出口；legacy 1.13 条 | 贪心多商品近似；冲突时拒绝 |
| 双向通道共享容量修正 | `strategies.ts` 迭代共享；`v72-redteam` 8 轮随机需求 | 逐分钟容量复核通过；消除 220>180 超限 | 迭代启发式，非全局最优 |
| 场馆标定流水线 | `venue-calibration.ts`、`v72-calibration.test.ts`、`stadium-synthetic-profile.json` | 合成档案 0 错误；合成冒充实测被拒绝；观测适配器拒绝离线/过期/未来时间戳 | 仅合成档案；未真实标定 |
| Shadow 回放压力 | `v72-shadow-stress.ts`、`ShadowSolver` 注入、`integrity` | 240 次：确定性 0 不一致；篡改 40/40 标记；异常/失败/预算回退 | 适配器层；未启用 |
| ONNX 部署链路准备 | `backend/python/ascend/*`、`export_forecast_onnx.py`、`benchmark_onnx.py` | CPU p50≈0.015ms、max_abs_diff=0；ATC 模板 | CPUExecutionProvider；无 NPU |
