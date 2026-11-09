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
| C24 | 工单创建时预留人员/预算；审批确认；拒绝/取消/过期释放；完成或已开始后失败按声明值结算 | `ops.ts`、`reservations.test.ts`（11 组）、HTTP 409 | VERIFIED（单实例） | 预算结算用声明值；未开始失败/取消不结算；多实例陈旧读未支持 |
| C25 | 统一状态快照跨安全/工单/预算/Agent/审计原子提交；损坏时拒绝启动；跨进程写入有文件锁+磁盘 revision CAS | `persistent-store.ts`、`state-persistence.test.ts`（含双实例 CAS）、进程重启与双副本损坏实测 | VERIFIED（单写者） | 不是分布式事务；多实例陈旧读仍需重启；内存审计视图可能落后于 JSONL |
| C26 | 预测可靠性失败时 VoI 预测动作被阻断，且不替代四态 | `prediction.ts` reliability、`availability.ts`、`prediction.test.ts`；场景显式 `prediction_max_relative_interval_width` | VERIFIED | 阈值已写入场景；门槛只看区间宽度，surge 欠覆盖仍会放行，见 R-01 |
| C27 | 人数只有在校准/面积/置信度同时满足时才生成可信区域观测；显示 API 与 ingest 共用同一判据 | `perception/adapter.ts` 的 `deriveSafetyValidity`、`adapter.test.ts`、质量 API | VERIFIED（门禁逻辑） | CityStreet/P2PNet 无现场标定；不产生精度主张 |
| C28 | 冻结证据按 LF 字节在 Windows/Linux 一致；校验命令默认只读 | `.gitattributes`、`verify-evidence.ts`、根清单 46/46、`verify:evidence` 134/134 | VERIFIED | 仅覆盖已登记清单；新证据需单独 manifest |

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
