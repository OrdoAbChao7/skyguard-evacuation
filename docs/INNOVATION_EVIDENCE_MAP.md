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

## 2026-11-09 第二轮新增

| 创新点 | 实现 | 实验/证据 | 主张边界 |
| --- | --- | --- | --- |
| 预测驱动规划需求 | `decision-service.ts` observed/predicted/robust + `demand_provenance` | `evaluation/final/prediction-planning/2026-11-09T06-33-13-854Z/` | 只上调、不可靠回退；静态模型无吞吐收益 |
| regime-aware 预测区间 | `prediction.ts` `regimeIntervalFactor` | `evaluation/v65/2026-11-09T06-33-02-508Z/`；surge 0.8667 | 未达 0.95；预测动作默认禁用 |
| 联合粒子 VoI | `joint-voi.ts` 联合熵/最坏区域风险/相关性 | `evaluation/final/joint-voi/2026-11-09T06-47-12-412Z/` | 负向：未超过多区域加权 |
| 拥堵反馈规划 | `planning/congestion.ts` BPR + 队列仿真 | `evaluation/final/congestion/2026-11-09T06-32-03-427Z/` | 最大队列 76.1→0；最终吞吐不变 |
| Validator 独立约束 | horizon/在留/出口等待/全区域/总量/截断 | `safety-acceptance.test.ts`、`congestion.test.ts` | 仍共享 EffectiveNetwork |
| 公开数据集跨域 | P2PNet A 权重 → Part B test | `evaluation/real-data-partB-cross/` | MAE 22.16；域迁移，非现场 |
| 浏览器 E2E | Playwright 管理员/staff | `frontend/e2e/smoke.spec.ts` | 本地/CI，非真机 |
