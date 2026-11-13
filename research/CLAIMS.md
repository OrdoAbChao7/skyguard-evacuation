# 技术主张与证据

> 状态定义：**已验证** = 本仓库代码/测试/实验可直接复现；**部分验证** = 机制存在但缺少真实数据/设备；
> **未验证** = 只有接口或文档；**禁止表述** = 无证据且容易误导。

| # | 主张 | 证据 | 状态 | 边界 |
| --- | --- | --- | --- | --- |
| C01 | 系统实现完整的感知→预测→VoI→调度→审批→反馈闭环 | `npm run demo:mvp`；HTTP 集成测试；实验 E 20/20 | 已验证（合成数据） | 不代表真实场馆 |
| C02 | Agent 只创建待审批工单，不能审批/派发/控制无人机 | `ops.ts` 角色校验；MCP 测试；Agent 测试 | 已验证 | 演示身份码非正式认证 |
| C03 | 独立 Validator 不信任规划器 | `validator.ts` 纯函数；故障注入 5/5 检出 | 已验证（注入故障） | 不证明物理世界安全 |
| C04 | 四态状态机优先级 DEGRADED>REJECT>REROUTE>NORMAL | `state-machine.ts`；6/6 故障注入 | 已验证 | 不替代现场判断 |
| C05 | VoI 在模拟中降低调查成本 | 实验 A：VoI 1.77 min vs 固定 3.57 min | 部分验证 | 风险收益略低；参数未标定 |
| C06 | 预测在突增场景仍脆弱 | 实验 B：自适应 MAE 25.1/59.5/79.7；覆盖率 91%/84%/79% | 已验证（局限） | 不得声称真实精度 |
| C07 | MCP 15 工具可被标准客户端调用 | `mcp.test.ts` 官方 SDK 客户端 | 已验证 | AgentArts 是否支持 stdio MCP 未确认 |
| C08 | AgentArts 适配器按官方运行时契约调用、可探测、失败不伪装、有界多步 | `agentarts.test.ts`（官方路径/会话头/`query`+`inputs`/`data.text`）、`agentarts-runtime.test.ts`（多步/重复调用/等待人工） | 已验证（本地 stub） | **未实机连接**；无真实租户与平台 Trace |
| C09 | 昇腾边云路径已实现 | 仅 provider 探针与外部推理契约 | 未验证 | 无 NPU/CANN/`.om` |
| C10 | 无人机观察已实现 | 工单请求 + 审批 + 模拟反馈 | 部分验证 | 无真实无人机/飞控 |
| C11 | 人群计数精度（公开数据集） | ShanghaiTech Part A test，P2PNet 官方权重：MAE 57.24/RMSE 96.04/NAE 0.1319；二次复跑一致 | PARTIALLY_SUPPORTED | 公开数据集/官方权重，非自训练模型或真实场馆；许可未核验 |
| C12 | 已接入华为云 AgentArts | 无租户/凭证/官方 API 文档 | 禁止表述 | 只能写适配器与 Runbook |
| C13 | 可获国家一等奖 | 无评分证据 | 禁止表述 | 只能陈述已完成工作 |
| C14 | 实验可复现 | 固定种子；`evaluation/competition/*.json`、`evaluation/v6/*.json` | 已验证 | 结果依赖本机与配置 |
| C15 | 多区域联合调查提高总风险收益 | V6.2 30 种子（目标轮换）：0.2154 vs 0.0472，d_z=2.06，覆盖 6.74 vs 1.59；公平复跑（C20）0.1711 vs 0.0446，d_z=1.27 | PARTIALLY_SUPPORTED | 成本 2.3×；V6.2 效应量受信息权限差异放大；V6.1 同目标设计效率不显著；效率低于随机/启发式 |
| C16 | 冷却+退避重试提高调查成功率 | V6.1：同 2 次尝试预算下 92% vs 92%，检测/决策相同 | **不支持** | V6-B 的 91% vs 68.6% 是 2 次 vs 1 次尝试，不是重试效应 |
| C17 | 邻居信息可改善短时预测 | V6-C：相对改进 4.8%/5.1%/8.4% | 部分验证（合成） | 共享趋势假设；真实数据未验证 |
| C18 | 人群计数评测流程可用 | `evaluation/real-data/`：数据加载、P2PNet 适配、per-image 结果、复算与复跑 | VERIFIED | 仅单数据集；不证明真实场馆精度 |
| C19 | 感知派生数据可端到端进入前端展示（时间轴/热力/区域查询） | `data/perception/citystreet-display/`（CityStreet C3，60 帧）+ `tests/perception/display-api.test.ts` 12 用例 + `PerceptionReplayPanel.test.tsx` 7 用例 | VERIFIED（仅展示链路） | 派生显示数据、近似配准、**无真值**；不得用于报告精度，且不参与规划/校验 |
| C20 | 在相同动作覆盖与相同预算下，多区域 VoI 的总风险降低仍高于单区域，但效率不占优 | `evaluation/voi-v2/2026-11-08T17-00-16-896Z/`（30 seeds × 40 trials）：多 0.1711 vs 单 0.0446，配对差 0.1265 [0.1209,0.1321]，d_z=1.27；效率 0.2971 vs 0.2643，差 0.0328 [0.0140,0.0515] | PARTIALLY_SUPPORTED | 合成数据、目标轮换；随机效率 0.3433、启发式 0.3961 高于多区域；V6.2 效应量被信息权限放大 |
| C21 | 调查预算准入计入候选动作自身成本与预留，越界候选被拒绝 | `backend/src/services/mvp/budget.ts`；`budget.test.ts`（0.9+1.0>1.0、等值允许、NaN、预留）；`agent-budget.test.ts` | VERIFIED | 仅业务预算；派发时的资源预留尚未与工单联动 |
| C22 | MCP HTTP 与网页 API 共享同一业务状态 | `tests/mvp/mcp-http.test.ts`：通过 `/mcp` 创建工单，网页侧 `getMvpService()` 读到同一工单 | VERIFIED（单实例） | 无独立 MCP 鉴权层；多实例一致性未实现 |
| C23 | 重复观测被忽略且乱序旧观测不覆盖较新观测 | `ObservationStore.ingest`；`tests/safety/observations.test.ts` | VERIFIED（存储层） | 仅按来源/提供方/模型/观测时间/人数判重；未做跨来源相关性建模 |
| C24 | 工单创建时预留人员/预算，审批确认，拒绝/取消/过期/失败释放，完成结算 | `ops.ts`、`reservations.test.ts`（8 组）、HTTP 409 | VERIFIED（单实例） | 预算结算用声明值；多实例并发未支持 |
| C25 | 统一状态快照跨安全/工单/预算/Agent/审计原子提交，损坏时拒绝启动 | `persistent-store.ts`、`state-persistence.test.ts`、进程重启与双副本损坏实测 | VERIFIED（单实例） | 不是分布式事务；内存审计视图可能落后于 JSONL |
| C26 | 预测可靠性失败时 VoI 预测动作被阻断，且不替代四态 | `prediction.ts` reliability、`availability.ts`、`prediction.test.ts` | VERIFIED | 阈值来自场景；预测本身仍是启发式 |
| C27 | 人数只有在校准/面积/置信度同时满足时才生成可信区域观测 | `perception/adapter.ts`、`adapter.test.ts`、质量 API | VERIFIED（门禁逻辑） | CityStreet/P2PNet 无现场标定；不产生精度主张 |

## 引用规则

1. 对外材料引用 C05/C06 时必须带“合成数据/模拟”限定；
2. C08 必须同时写“未实机验证”；
3. C12/C13 不得出现在任何对外材料中；C11 引用必须带“ShanghaiTech Part A / P2PNet 官方权重 / CPU / 非真实场馆”限定；
4. 新增技术主张必须在本表登记，并关联 `SOURCES.jsonl` ID 或仓库证据路径。

## Release labels（V6.1）

| ID | Label | 说明 |
| --- | --- | --- |
| C01 | VERIFIED | 合成数据下的闭环与测试 |
| C02 | VERIFIED | 权限与状态机测试 |
| C03 | VERIFIED | 注入故障下独立校验 |
| C04 | VERIFIED | 状态机 6/6 |
| C05 | PARTIALLY_SUPPORTED | 模拟成本收益；参数未标定 |
| C06 | VERIFIED | 作为“预测局限”被验证 |
| C07 | VERIFIED | 官方 SDK 协议测试 |
| C08 | PARTIALLY_SUPPORTED | 适配器/契约；未实机 |
| C09 | UNVERIFIED | 无 NPU/CANN |
| C10 | PARTIALLY_SUPPORTED | 工单/模拟反馈；无飞控 |
| C11 | PARTIALLY_SUPPORTED | ShanghaiTech Part A 公开数据集；非真实场馆 |
| C12 | UNVERIFIED | 无 AgentArts 租户 |
| C13 | UNVERIFIED | 无评分证据 |
| C14 | VERIFIED | 固定种子 + 复算脚本 |
| C15 | PARTIALLY_SUPPORTED | 同预算总收益更高；效率不显著 |
| C16 | PARTIALLY_SUPPORTED | 重试机制存在，但同预算不提高成功率 |
| C17 | PARTIALLY_SUPPORTED | 合成相关序列；真实数据未验证 |
| C18 | VERIFIED | 真实数据流水线已运行；精度范围有限 |
| C19 | VERIFIED | 仅证明展示链路与数据治理；无精度含义 |

## Release labels（V6.4，2026-11-09）

| ID | Label | 说明 |
| --- | --- | --- |
| C08 | PARTIALLY_SUPPORTED | 官方契约与有界多步已实现；仍无真实租户 |
| C15 | PARTIALLY_SUPPORTED | 公平复跑总收益仍更高；效应量缩小，效率不占优 |
| C20 | PARTIALLY_SUPPORTED | 合成公平实验；不得替代 V6.2 冻结结果 |
| C21 | VERIFIED | 预算准入含候选与预留；派发联动未完成 |
| C22 | VERIFIED | 单实例 HTTP MCP 与网页共享状态 |
| C23 | VERIFIED | 存储层去重与乱序保护 |

### 判定规则

- VERIFIED：代码、测试或原始数据可直接复现；
- PARTIALLY_SUPPORTED：机制/模拟证据存在，但缺真实数据或完整标定；
- HEURISTIC：未标定的工程规则（风险传播、覆盖权重、人员距离评分）；
- UNVERIFIED：只有接口/文档或完全缺少证据。

## 30 天 AgentArts 方案的待验证目标与假设（2026-11-05）

下列条目是设计目标，尚未实施或验证，不改变上表既有主张的证据状态。用户确认可取得租户和场馆协作条件，不等于本仓库已完成平台调用或现场验证。方案、实验方法和完成判据见 [ICT_AGENTARTS_30_DAY_PLAN.md](../docs/ICT_AGENTARTS_30_DAY_PLAN.md)。

| ID | 待验证目标或假设 | 计划证据 | 当前状态 | 结论边界 |
| --- | --- | --- | --- | --- |
| H01 | 真实 AgentArts 能完成工具调用、人工审批等待、现场反馈后续接的完整业务流程 | 方案 E1/E4：真实租户 Trace、应用版本、工单/API 回执与失败恢复记录 | UNVERIFIED | 尚无本次实机结果；健康 HTTP 成功不构成完整流程验证 |
| H02 | 在相同资源、时限和观测权限下，证据新鲜度/去重与预算约束可改善主动核查的成本或决策损失 | 方案 E2：独立环境、强基线、配对比较、消融、参数错配与原始数据 | UNVERIFIED | V6.1/V6.2 为合成且设计敏感；不能预先承诺优于全部基线 |
| H03 | 原型可减少场馆人员完成核查任务的时间，且不增加遗漏与操作错误 | 方案 E3：真实参与者、等价任务、顺序平衡、任务记录与区间 | UNVERIFIED | 20% 为预先声明的产品期望值；小样本受控任务不代表真实疏散效果 |

### 2026-11-06：假设的执行与判定补充

[竞赛改进执行方案](../docs/ICT_IMPROVEMENT_EXECUTION_PLAN.md) 将 H01–H03 细化为可验收工作包；没有新增实测结果，三项仍为 UNVERIFIED。

- H01：必须有真实平台工具回执、人工等待后续接与恢复证据；健康成功或一次工具调用不能替代完整链路验证。
- H02：统一物理动作覆盖、资源与时间约束，使用概率采样和独立隐藏真值；主比较预先指定为改进策略对风险优先规则、对现有多区域 VoI。证据去重/时效属于待检验增量，预算正确性属于硬约束，不能靠不安全对照制造收益。
- H03：计划 8 名参与者、48 次交叉任务仅为探索性设计；48 次任务不能当作 48 个独立参与者。报告任务耗时、完成率及错误；小样本未出现错误不证明错误率不增加。
- 任何正面或负面结果在实际实施后按协议登记，保留旧结果；不得根据这份设计将 C08/C09/C12 或任何现场验证等级升级。

## V7.0 新增主张（2026-11-09）

> 全部证据来自 `evaluation/v70/<run>/`（30 固定种子、合成数据）。负向与混合结果同样登记，不因不利而删除。

| # | 主张 | 证据 | 状态 | 边界 |
| --- | --- | --- | --- | --- |
| C28 | `ensemble_v70` 集成 Kalman/ARIMA/Holt-Winters/在线 LSTM 与可解释基线，并输出 regime、conformal 区间与漂移标记 | `backend/src/services/mvp/forecast-advanced.ts`；`tests/mvp/forecast-advanced.test.ts`；`evaluation/v70/<run>/prediction_*` | PARTIALLY_SUPPORTED | 合成数据；集成不是任何单一机制的最佳方法；surge 95% 覆盖低于名义值 |
| C29 | Regime 检测在短滚动窗口上不稳定：periodic/surge/noisy 的可接受标签准确率有限 | `prediction_summary.json` 的 `regime.accuracy` | VERIFIED（负向） | 只能作为候选筛选提示，不得用于自动切换安全策略 |
| C30 | Page-Hinkley + 误差漂移检测能在 regime_shift 上检测到突增/下降，stable 误报率低 | `prediction_summary.json` 的 `drift` | PARTIALLY_SUPPORTED | 合成机制；检测用于放大区间，不改变四态 |
| C31 | 滚动时域 MPC + 队列执行反馈在容量受压的合成场景中降低未疏散人数与完成时间 | `evaluation/v70/<run>/planning_*`；`planning-v70.test.ts` | VERIFIED（合成） | 合成需求/入流；BPR 与服务衰减参数未标定；不代表真实场馆 |
| C32 | 预测与队列反馈相对“仅滚动重规划”没有显著增量收益 | `planning_summary.json` 的 `paired.reactive_mcf` | VERIFIED（负向） | 本模型假设即时响应；未建模调度延迟/预留提前期，不能外推为“预测无用” |
| C33 | 联合 VoI 相对现有多区域 VoI：总风险降低略低、最坏区域风险略低，效应量很小 | `joint_voi_summary.json` 的 `paired` | PARTIALLY_SUPPORTED（混合） | 合成相关性；启发式近似，不是联合 POMDP 精确解；不得宣称联合 VoI 全面更优 |
| C34 | 受限二进制出口分配 MILP 枚举在静态计划上降低完成时间与队列人·分钟 | `planning_summary.json` 的 `milp_restricted` | VERIFIED（合成） | 仅竞争最激烈的 ≤5 个区域参与二进制选择；不是全局 MILP 求解器 |
| C35 | V7 预览 API（预测/联合 VoI/MPC/拥堵）只读，观测不可信时 fail closed | `tests/mvp/v70-api.test.ts` | VERIFIED | 预览不发布方案；带预测的 MPC 步骤不声明“已验证” |
| C36 | 研究用 Dijkstra+势函数求解器避免零费用残量环导致的路径回溯死循环，且不改变安全主链路 SPFA 规划器 | `min-cost-flow.ts` 新增方法；既有安全测试 199/199 | VERIFIED | 新方法只用于 V7 研究求解器 |

### V7 引用规则

1. C28 必须同时报告各机制最佳方法与集成 MAE，不得只报集成优于 persistence；
2. C31/C32 必须同时报告“合成场景、未标定 BPR/服务衰减、即时响应假设”；
3. C33 必须同时报告 benefit 与 worst-region risk 两个方向，不得只引用有利指标；
4. C34 必须披露受限候选出口集合；
5. 任何 V7 数字不得表述为真实场馆疏散效果或预测精度。

## V7.1 新增主张（2026-11-09）

> 证据：`evaluation/v71/v71-final-20261109T211702/`（30 固定种子、合成数据）。
> 负向/混合结果同样登记，不得只引用有利指标。

| # | 主张 | 证据 | 状态 | 边界 |
| --- | --- | --- | --- | --- |
| C37 | 滚动重规划是 V7.1 性能提升的主要来源 | `replanning_summary.json`：B vs A 未疏散 −682.8 [−715.8, −649.9]，完成时间 −5.11 [−5.29, −4.94] | VERIFIED（合成） | 合成场景/入流；不代表真实场馆 |
| C38 | V7 时间扩展 MPC 在完成时间/队列上优于 legacy 周期重规划，但路线切换人数显著更高 | D vs B：完成时间 8.81 vs 13.88，队列 14373 vs 43383，切换 4390 vs 754 | VERIFIED（合成） | 未标定 BPR/服务衰减；切换成本未优化 |
| C39 | 事件触发对 legacy 规划器节省重规划与求解时间且不损失完成率；对 V7 MPC 变差 | C vs B：重规划 −2.57，求解 −0.28ms；I vs G：完成时间 10.29 vs 8.81 | VERIFIED（混合） | 仅本模型/阈值；不得默认开启 |
| C40 | 预测与队列反馈相对仅滚动重规划没有显著增量收益 | G vs F 完成时间 −0.027 [−0.068, 0.015]；G vs E +0.033 [−0.001, 0.068] | VERIFIED（负向） | 即时响应、无调度延迟假设；不能外推为“预测无用” |
| C41 | ACI + 变点检测改善 surge/regime_shift 95% 覆盖，但整体覆盖无显著提升且宽度/门控失败率上升 | surge 0.748→0.846；regime_shift 0.809→0.907；整体覆盖差 0.0000 [−0.0119, 0.0119]；periodic 0.982→0.833 | VERIFIED（混合） | 合成机制；区间非正式置信区间；不得用于安全告警 |
| C42 | 预测可靠性门控在区间过宽/校准不足/覆盖低于目标时阻断预测 | `conformal.test.ts`；`v71-hardening` NaN/异常输入；`forecast-advanced` reliability | VERIFIED | 门控阈值是工程参数；不替代四态 |
| C43 | 路线稳定启发式未降低切换人数且增加求解成本 | H vs G：切换 4960 vs 4745，求解 3.13 vs 1.81ms | VERIFIED（负向） | 需状态增广/切换代价 MILP |
| C44 | Shadow Mode 默认关闭、只记录不发布、双方案独立校验、超时/异常回退 | `v7-adapter.ts`、`shadow-mode.test.ts`、`v70-api.test.ts`、`docs/V7_SHADOW_MODE.md` | VERIFIED（本地） | 超时非抢占；内存记录；未启用 |
| C45 | 公开数据集许可与入口已核验到不同等级；没有公开疏散决策标签 | `docs/DATASET_CANDIDATES_V71.md` | PARTIAL | MOT20/SDD/NWPU 已核验；JHU/ETH/UCY/CityStreet 未核验；不得把静态计数当动态预测 |
| C46 | 出口故障、通道封控与双向压力场景下规划/校验保持一致 | `v71-hardening.test.ts`；A-G `exit_failure`/`corridor_closure`/`bidirectional_stress` | VERIFIED（合成） | 未标定容量；场景为合成 |

### V7.1 引用规则

1. C37/C38 必须报告切换成本与未标定参数；
2. C39 必须同时说明“legacy 有效、V7 有害”，不得只引用 legacy；
3. C40 必须说明即时响应假设，不得写成“预测无用”；
4. C41 必须同时报告 surge/regime_shift 改善与 periodic 下降/宽度/门控失败率；
5. C44 必须写“默认关闭、未启用、不是安全批准”；
6. C45 不得把公开数据静态计数精度表述为动态疏散预测精度。

## V7.2 新增主张（2026-11-10）

> 证据：`evaluation/v72/v72-final-20261110T014910/`（30 固定种子、合成数据）。
> 负向/混合结果同样登记；不得只引用有利指标。

| # | 主张 | 证据 | 状态 | 边界 |
| --- | --- | --- | --- | --- |
| C47 | 迟滞显著降低 V7 MPC 切换人数，代价是完成时间/队列小幅上升 | C vs B：切换 −993.5 [−1227.4, −759.7]，完成时间 +0.05 [0.0005, 0.0995]，队列 +1342.4 [1093.3, 1591.5] | VERIFIED（合成） | 参数未标定；密度 +0.073 |
| C48 | 切换惩罚/承诺窗口显著降低切换人数，但完成时间与队列代价更大 | D/E vs B：切换约 −1927 [−2193, −1662]，完成时间 +0.45–0.51，队列 +2.6k–2.7k | VERIFIED（合成，混合） | 高需求时被安全护栏拒绝；非免费 |
| C49 | 承诺式逐区域求解是贪心多商品近似，必须容量复核与份额回退 | `stable-solver.ts`、`v72-stability`、`v72-redteam` | VERIFIED（实现/测试） | 非联合最优；冲突时显式报告 |
| C50 | 运行中出口故障触发紧急覆盖，承诺失效且故障后不再使用故障出口 | `midrun_exit_failure`：MPC 0 条故障后使用；legacy 1.13 条 | VERIFIED（合成） | 故障注入为研究/演练 |
| C51 | 双向通道共享容量修正消除「计划超物理容量」的 P0 缺陷 | `v72-redteam` 8 轮双向随机需求；`strategies.ts` 迭代共享 | VERIFIED（实现/测试） | 迭代启发式，非全局最优 |
| C52 | 场馆标定流水线强制来源分级，合成数据不能冒充实测/calibrated | `v72-calibration.test.ts`；`synthetic_claims_measured` | VERIFIED（实现/测试） | 当前仅合成档案；未做真实标定 |
| C53 | Shadow 回放证明同输入快照、双校验、安全回退、确定性与篡改标记 | 240 次回放：确定性 0 不一致；篡改 40/40 标记 | VERIFIED（本地） | 适配器层；未覆盖真实并发/持久化 |
| C54 | AgentArts 仅有本地官方契约 stub，未接入真实平台 | `huawei_status.json`：`not_configured`；stub 会话头/SSE/决策通过 | PARTIAL | 缺租户/凭证；不得声称已接入 |
| C55 | 新增 ONNX 参考模型导出与 CPU 推理基准，无 NPU 实机证据 | `ascend/onnx_cpu_benchmark.json`：p50≈0.015ms，max_abs_diff=0 | PARTIAL | CPUExecutionProvider；参考模型非生产预测器 |

### V7.2 引用规则

1. C47/C48 必须同时报告切换下降与完成时间/队列/密度代价；
2. C48 必须说明高需求下承诺被拒绝，不得写成「总是有效」；
3. C49 必须披露贪心近似与容量回退；
4. C50 必须说明是注入故障，不是真实事故；
5. C52 不得把合成标定表述为真实场馆参数；
6. C53 必须写「Shadow 默认关闭、未启用、不是安全批准」；
7. C54/C55 必须写「无真实平台/NPU 证据」。

## V7.3 新增主张（2026-11-10）

> 证据：`evaluation/v73/v73-final-20261110T101711/`（30 固定种子、合成数据）。
> 负向/混合结果同样登记；不得只引用有利指标。

| # | 主张 | 证据 | 状态 | 边界 |
| --- | --- | --- | --- | --- |
| C56 | V7.2 冻结基线可独立复核、可检测篡改，且 V7.3 未改写历史证据 | `evaluation/v72/freeze_audit.json`：299/299；篡改失败、恢复通过；0 字节变化 | VERIFIED（本地） | Windows 主机；非第三方审计 |
| C57 | 自适应稳定性显著降低切换与振荡，优于标准 MPC | F vs B：切换 −2451.7 [−2646.6, −2256.9]；振荡 −478.5 [−550.2, −406.8]；Holm p=0 | VERIFIED（合成） | 参数未标定；密度/队列/完成时间上升 |
| C58 | 自适应稳定性以完成时间/队列/密度为代价，且高动态容量压力下收益缩小 | F vs B：完成 +0.96、队列 +3968、密度 +0.296；dynamic_capacity 切换 3072.9 vs 3226.0 | VERIFIED（混合） | 不得宣称全面更优 |
| C59 | 自适应策略降低未疏散/安全违规，标准 MPC 在共享容量下会出现未疏散 | F vs B：未疏散 −16.47；安全违规 −0.054 | VERIFIED（合成） | 安全违规=容量+未疏散代理，不是完整 Validator |
| C60 | 场馆导入流水线支持 JSON/CSV/视频/公开/授权，并强制来源分级 | `v73-calibration-import`、`v73-venue-import`、8 测试 | VERIFIED（实现/夹具） | 无真实数据；public/authorized 仅契约 |
| C61 | Shadow 运营验证可检测过期快照与冲突观测并 fail-closed | 80 次：stale 10/10、conflict 10/10；确定性 0 不一致 | VERIFIED（适配器层） | 合成；未覆盖真实并发/持久化 |
| C62 | AgentArts 重试复用幂等键，失败后可恢复；真实平台仍未接入 | `v73-agentarts`：同一键重试、不同 trace 不同键；`not_configured` | PARTIAL | 无租户/Trace；本地 stub |
| C63 | OM 元数据校验拒绝伪造 NPU 证据；当前无 NPU/OM | `v73-ascend`：ONNX checker valid、CPU 基准；OM `not_executed` | PARTIAL | CPU 不代表 NPU |

### V7.3 引用规则

1. C57/C58/C59 必须同时报告切换/振荡下降与时间/队列/密度代价；
2. C58 必须说明动态容量下收益缩小；
3. C61 必须写「适配器层、合成、Shadow 默认关闭」；
4. C62 必须写「本地 stub、未接入真实平台」；
5. C63 必须写「无 NPU/CANN/OM、CPU 基准不是 NPU 性能」。

## V7.4 新增主张（2026-11-10）

> 证据：`evaluation/v74/v74-final-20261110T105851/`（30 固定种子 × 8 场景，n=240 配对；合成数据）。
> 负向结果同样登记；不得只引用有利指标。

| # | 主张 | 证据 | 状态 | 边界 |
| --- | --- | --- | --- | --- |
| C64 | 执行感知承诺门控可在有界完成时间/队列代价下显著降低切换 | F vs B：切换 −1983.1 [−2168.5, −1797.7]；完成 +0.575 [0.487, 0.663] min；队列 +861.9 [742.3, 981.5] 人·min；Holm p<0.05 | VERIFIED（合成，有界） | 门控只作用于承诺路径；参数 1min/2000 未做完整敏感性 |
| C65 | 存在「零完成时间代价的稳定性」机制 | 0/0 容差门控拒绝全部候选并回退标准 MPC；无任何配置同时降切换且不增完成时间 | **不支持 / 已证伪（本模型）** | 不能外推为所有模型不可能，只能陈述本执行模型 |
| C66 | 风险敏感切换惩罚（riskDiscount 0.9）改变决策并优于 V7.3 自适应 | D 与 C 在 240/240 样本逐指标完全相同；自适应模式在承诺/拥堵时绕过惩罚比较 | **NOT_SUPPORTED** | 机制未被触发；不得声称有效 |
| C67 | 高风险阈值可自动释放承诺，及时改派 | 平均 2.62 次释放/场景；未疏散 2.87，完成 +0.408、队列 +424 | PARTIALLY_SUPPORTED（合成） | 引入少量未疏散；阈值未标定 |
| C68 | 动态容量下规划/执行/复核口径一致，MPC 变体无容量违规 | dynamic_capacity：B/C/F 容量违规 0；静态 A 6.43 次/场景 | VERIFIED（合成） | 动态因子为注入值，非真实容量 |
| C69 | CUSUM+spike 检测优于 3σ 基线 | surge/regime 检测率 100%/100% vs 76.7%/73.3%；中位延迟 5/7 相同；稳定段种子误报率均 33.3% | VERIFIED（合成，混合） | noisy 机制两者均 0；误报未改善 |
| C70 | 标定质量门控可拒绝超限时钟偏移、检测缺失、生成可靠性代理与动态容量计划 | 90s 偏移拒绝；110s 缺失检出；可靠性 0.3447/0.14；计划校验通过 | VERIFIED（夹具） | 可靠性是代理非准确率；无真实数据 |
| C71 | 生产检查可脚本化验证 CI/API/负载/浏览器 E2E | CI YAML ok；API 3/3；100 次/并发 10 p95 7.32ms；E2E 通过 | PARTIAL | Docker BLOCKED；单机负载；E2E 仅冒烟 |
| C72 | AgentArts 适配器支持 trace 关联且重试复用幂等键 | `agentarts_status.json`：session/idempotency/trace；stub 通过 | PARTIAL（本地 stub） | 真实平台 `not_configured`；无平台 Trace |

### V7.4 引用规则

1. C64 必须同时报告切换下降与 +0.575min/+862 队列代价，不得写「免费稳定性」；
2. C65 只能表述为「本执行模型下不支持」，不得外推；
3. C66 必须写「负结果/机制未触发」；
4. C67 必须写「引入少量未疏散、阈值未标定」；
5. C69 必须同时报告 33% 稳定段种子误报与 noisy 失效；
6. C70 必须写「夹具、可靠性非准确率」；
7. C71 必须写「Docker 未验证、单机负载、冒烟 E2E」；
8. C72 必须写「本地 stub、未接入真实平台」。

## V7.5 新增主张（2026-11-10）

> 证据：`evaluation/v75/v75-final-20261110/`（30 固定种子；检测/融合为确定性合成序列，承诺/多目标为 30×8 场景）。
> 负向结果与混合结果同样登记；不得只引用有利指标。

| # | 主张 | 证据 | 状态 | 边界 |
| --- | --- | --- | --- | --- |
| C73 | 双阈值 + 持续性 + 多传感器可靠性确认在合成机制上实现零稳定/噪声/冲突误报，且保持 100% 召回 | `detection_summary.json`：reliability_dual recall 1.0 / precision 1.0 / FPR 0；stable/noisy/conflicting 误报 0 | VERIFIED（合成） | 延迟 1–2 步；合成序列；不是真实预警精度 |
| C74 | 误报下降可分解为「持续性」与「多传感器确认」：前者抑制稳定/噪声，后者抑制冲突 | 消融：persist=1 stable FPR 0.1667、noisy 0.0333；无多传感器 conflicting FPR 0.20；完整检测器均为 0 | VERIFIED（合成） | 机制为合成；延迟成本不同 |
| C75 | 区域选择性承诺相对全局承诺/自适应未降低切换 | 区域选择性 1623.7 vs 全局 1561.1 / 自适应 1369.0；队列 23904.6 vs 23998.6，密度 2.4677 vs 2.4409 | **NOT_SUPPORTED（负结果）** | 本参数与场景下；不得表述为改进 |
| C76 | 容量感知承诺（headroom 0.9）降低切换 | 切换 −63.2 [−132.8, +6.4]，Holm p=0.075 不显著；未疏散 13.74、安全违规 0.0458 | **NOT_SUPPORTED（负结果）** | 当前出口-区域匹配粒度不足；不是容量感知无效的普遍结论 |
| C77 | 紧急状态机可执行 NORMAL→警告→覆盖→恢复→NORMAL，失效承诺并阻止未校验恢复 | `emergency-state.ts`、`v75-emergency.test.ts`、`v75-commitment-redteam.test.ts`、`stability_rows.json` | VERIFIED（仿真/测试） | 0 响应为控制步内；不替代四态/校验/审批 |
| C78 | 紧急释放+恢复在零未疏散下降低切换与队列，但不是全面最优 | 切换 2214.4 vs 标准 3820.8；队列 22820 vs 20030；相对全局承诺切换更高 | PARTIALLY_SUPPORTED（折中） | 参数未标定；事件注入为仿真 |
| C79 | 多目标选择存在真实权衡，严格时间/队列约束下稳定配置经常不可行 | 238/240 实例有 Pareto 权衡；约束选择退回无承诺 139/240；稳定膝点切换 1206.6、效率膝点 3704.7 | VERIFIED（合成，离线） | 膝点为离线分析上界，不是在线算法 |
| C80 | 融合管线在冲突/时钟偏移下 fail-closed，且不静默输出 | 严格条件 unsafe fuse 0；冲突/偏移 fail-closed 1.0；过期拒绝 1200、重复拒绝 3600 | VERIFIED（合成） | 可用率 0.7497；必须接入降级链路 |
| C81 | 融合的点估计误差不优于可靠性加权，且无法消除持续偏置 | 管线 MAE 5.538 vs reliability_weighted 11.989（仅可用步）、median 4.677；偏置条件管线 13.33 vs median 5.17 | **NOT_SUPPORTED（点估计优势/偏置）** | 融合价值在决策正确性 0.9719 vs 0.7744 与审计 |
| C82 | V7.5 生产检查与浏览器 E2E 可脚本化复现；Docker/AgentArts/NPU 仍阻塞 | `browser_e2e.json` passed；CI YAML ok；API 3/3；Docker BLOCKED；AgentArts not_configured；无 npu-smi/atc | PARTIAL | E2E 仅冒烟；单机；无真实平台/NPU |

### V7.5 引用规则

1. C73/C74 必须同时报告 1–2 步延迟与合成数据性质；
2. C75/C76/C81 必须写明负结果，不得调参后改写为主张；
3. C77 必须写「仿真控制步内响应，不是实时时延保证」；
4. C78 必须同时报告相对标准 MPC 与相对全局承诺的差异；
5. C79 必须写「离线膝点上界」与「约束选择退回无承诺」；
6. C80 必须同时报告可用率损失与 fail-closed 语义；
7. C82 必须写「Docker 未验证、AgentArts stub、无 NPU」。
