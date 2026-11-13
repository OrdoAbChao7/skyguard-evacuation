# 研究日志

## 2026-11-05 · 竞赛强化检索

检索目标：AgentArts/ModelArts Studio、MCP、VoI、人群计数、预测、疏散规划、人机协同、昇腾。

| 查询 | 结果 | 决策 |
| --- | --- | --- |
| 华为云 AgentArts 智能体开发 API 文档 | 未命中官方 API 文档；仅有产品报道；ModelArts Studio/API Explorer 可查 | 适配器保持可配置模板；明确“未实机验证”；不虚构端点 |
| P2PNet crowd counting | 命中官方 GitHub 与 arXiv 2101.02383 | 记录为可选模型入口，不集成、不宣称精度 |
| NWPU-Crowd dataset | 命中官方 benchmark 与 arXiv 2001.08086 | 记录数据集入口；未下载 |
| Howard 1966 Information Value Theory | 确认 DOI 10.1109/TSSC.1966.300074 | 作为 VoI 理论来源 |
| MCP specification | 确认 2025-06-18 版本与官方站点 | 固定 SDK 1.32.2；stdio 实现 |
| HiAscend CANN / ModelArts Studio docs | 命中 hiascend.com/document 与 support.huaweicloud.com/modelarts-studio/ | 写入昇腾部署文档；无设备不宣称实测 |

## 决策记录

1. 研究库只收录可追溯 URL；未打开页面标记 `canonical-url-not-fetched`，不冒充已验证。
2. 任何“平台已接入/设备已实测/预测准确率”主张一律降级为未验证或禁止表述。
3. 预测模型从固定 0.5 混合升级为滚动验证选择；实验显示突增场景仍是弱点，保留为局限。
4. VoI 增加多随机种子、Bootstrap、权重敏感性与 Pareto，不再只报均值。
5. 工单增加上下文版本与幂等键，避免审批后环境变化仍派发。

## 2026-11-05 · V6.1 科研审计

1. 公平预算配对实验：V6-A 的多区域 0.083 vs 0.024 未做预算配对；V6.1 同预算/同证据重做为 0.189 vs 0.030（成本 7.7×，效率差 CI 含 0）。
2. 序贯审计：V6-B 的 91% vs 68.6% 是 2 次 vs 1 次尝试的差异；同 2 次预算下重试与不重试均为 92%，**重试不提高成功率**。
3. 严格滚动预测：自适应在 stable/decline/missing 更好，surge/periodic persistence 略优；区间覆盖率未稳定达标。
4. 风险图敏感性：damping/覆盖权重会改变排序与推荐；仍为未标定启发式。
5. 感知匹配：贪心改为最大基数二分匹配，补反例测试；仍无数据集/权重/真实精度。
6. 来源审计：12 verified-search / 20 canonical-not-fetched / 6 known-literature；未逐条核验作者与许可证。

## 2026-11-09 · V7.0 预测、动态规划与联合 VoI

1. 预测：新增 Kalman/ARIMA/Holt-Winters/在线 LSTM/regime/conformal/漂移/状态感知集成；30 种子 × 7 机制 × 11 方法。集成显著优于 persistence/EMA/linear/Kalman/LSTM，但劣于 ARIMA/Holt-Winters/旧自适应；无单一最优；surge 95% 覆盖 0.748。负结果保留。
2. 规划：新增可配置时间扩展求解器、最大流、容量盲最短路径、受限 MILP、滚动 MPC、FIFO+BPR+出口服务衰减。容量受压场景：MPC 未疏散 0、完成时间 8.33，static_mcf 未疏散 613、完成时间 19；预测/队列反馈相对仅重规划无显著增量。
3. 联合 VoI：新增相关性/冗余/顺序选择；公平实验显示总收益略低、最坏区域风险略低，效应量小。
4. 审计修复：SPFA 零费用残量环死循环（Dijkstra+势函数）、残差区域身份丢失、预览参数无界、预测到达被当事实、CRLF 证据字节不一致。
5. 证据：`evaluation/v70/v70-final-*`；后端 201/201、前端 16/16、构建与 demo 通过。全部合成数据，未实机验证 AgentArts/昇腾。

## 2026-11-09 · V7.1 研究验证与 Shadow Mode

1. 滚动重规划机理 A-G + H/I：30 种子 × 5 场景。B vs A 未疏散 −682.8、完成时间 −5.11；V7 MPC 完成时间 8.81 vs legacy 13.88，但切换 4390 vs 754；预测/队列反馈无显著增量；事件触发对 legacy 省算力、对 V7 有害；路线稳定无效。
2. 预测区间：ACI + 变点 + 偏差校正；surge 0.748→0.846，regime_shift 后段 0.809→0.907，但 periodic 0.982→0.833，整体覆盖无显著提升；门控失败率上升。
3. Shadow Mode：默认关闭、统一快照、双方案独立校验、超时/异常回退、只读 API；V7 永不发布。
4. 红队：修复事件触发退化、空窗口强制重规划、conformal surge 失效、Shadow 预算回退；新增 17 个测试。
5. 数据：MOT20/SDD/NWPU 许可已核验，UCF-QNRF/ShanghaiTech 部分，JHU/ETH/UCY/CityStreet 未核验；无公开疏散决策标签。
6. 验证：后端 219/219、前端 17/17、构建与 demo 通过；证据 `evaluation/v71/v71-final-20261109T211702/`。

## 2026-11-10 · V7.2 路线稳定性、场馆标定与可信集成准备

**目标**：在 V7.1 基础上降低 MPC 路线切换，修正容量一致性，建立场馆标定与 Shadow 回放证据。

**完成**：
- Track A：迟滞/切换惩罚/承诺/自适应四类机制；承诺式逐区域求解；紧急覆盖；30×6×6 对照。
- 容量 P0：双向通道共享容量迭代；已用容量显式传递；承诺候选容量复核与份额回退。
- Track B：场馆标定档案、校验、参数估计、相机/观测适配器、版本与变更清单。
- Track C：ShadowSolver 注入、快照人数一致性、240 次回放（异常/校验失败/预算/过期/篡改/确定性）。
- 华为：AgentArts 状态（not_configured）+ 本地官方契约 stub；ONNX 参考模型导出 + CPU 基准 + ATC 模板。
- 红队：双向超容量、承诺超容量、预测 NaN/Infinity、相机离线/未来时间戳，全部回归。

**关键结果**：
- 切换 5261.8（B）→4268.3（迟滞，−18.9%）→3334.3（惩罚/承诺，−36.6%）；
- 完成时间 +0.05 / +0.45–0.51；队列 +1.3k–2.7k；密度 +0.07–0.08；求解约翻倍；
- 运行中出口故障：MPC 0 条故障后使用故障出口；legacy 1.13 条；
- Shadow：确定性 0 不一致；篡改 40/40 标记；V7 从未发布；
- 全量后端 242/242、前端 17/17。

**负向/混合**：稳定性增加密度/队列；惩罚与承诺结果几乎相同；自适应退化；高需求承诺被拒绝；
标定仅合成；ONNX 仅 CPU；无 AgentArts/NPU 实机。

**证据**：`evaluation/v72/v72-final-20261110T014910/`（`npm run benchmark:v72`）。

## 2026-11-10 · V7.3 自适应稳定性、真实世界导入与运营验证

**目标**：在 V7.2 冻结基线上降低切换/振荡，建立真实场馆导入、Shadow 运营验证与部署证据。

**完成**：
- Phase 0：299 文件独立复核 + 篡改/CRLF/UTF-8/只读检查 + 基线快照；
- Phase 1：自适应惩罚、振荡检测、风险加权、多目标、动态容量；30×8×6 实验；
- Phase 2：JSON/CSV/视频/公开/授权导入、方向性容量、场馆约束；
- Phase 3：Shadow 80 次运营回放、stale/conflict fail-closed、路由切换比较；
- Phase 4：AgentArts 幂等键/重试/恢复；
- Phase 5：ONNX checker、CPU 基准、OM 元数据校验、ATC 模板；
- Phase 6：红队修复（动态容量 P0、CSV 崩溃、人数上限、冲突 fail-closed）。

**关键结果**：
- 切换 3820.8→1369.0（−64%），振荡 571.9→93.4（−84%），未疏散 16.47→0，安全违规 0；
- 代价：完成 +0.96、队列 +3968、密度 +0.296；动态容量收益缩小；
- 后端 273/273；verify:evidence 156/156；V7.2 基线快照通过。

**负向/混合**：密度/队列上升；动态容量收益缩小；无真实场馆/AgentArts/NPU 证据。

**证据**：`evaluation/v73/v73-final-20261110T101711/`（`npm run benchmark:v73`）。

## 2026-11-10 · V7.4 执行感知门控、稳定性边界与竞赛证据

**目标**：回答 V7.3 留下的「稳定性是否免费」问题；补齐 surge/regime 对照、标定质量、生产检查与浏览器 E2E。

**完成**：
- 执行感知门控（makespan/queue 容差）、Pareto 份额扫描、风险触发释放、区域选择性承诺；
- 30 种子 × 8 场景 × 6 策略配对实验；Holm 校正；
- CUSUM+spike vs 3σ（30 种子 × 4 机制）；
- 标定质量：时钟同步/缺失/可靠性代理/动态容量计划；
- 生产检查（Docker/CI/API/负载）+ Playwright 冒烟 E2E；
- 红队 4 项 + 标定质量 5 项 + AgentArts trace 1 项。

**关键结果**：
- Pareto 门控：切换 3820.8→1837.7（−52%），完成 +0.575min，队列 +862，未疏散 3.81；
- 自适应 V7.3：切换 −64%，完成 +0.963min，队列 +3968，未疏散 0；
- 紧急释放：切换 −8.5%，完成 +0.408min，未疏散 2.87；
- 0/0 容差门控拒绝全部候选 → 零代价稳定性不成立；
- 风险敏感惩罚与 V7.3 逐样本相同 → NOT_SUPPORTED；
- 动态容量 MPC 容量违规 0；CUSUM 100% vs 3σ 76.7%/73.3%；
- 后端 283/283、前端 17/17、verify:evidence 166/166、E2E 通过。

**负向/混合**：无零代价稳定性；风险折扣无效；检测稳定段误报约 33%；noisy 检测 0；
Docker BLOCKED；AgentArts stub；Ascend CPU only。

**证据**：`evaluation/v74/v74-final-20261110T105851/`（`npm run benchmark:v74`）。

## 2026-11-10：V7.5 风险自适应检测、状态机、多目标与融合

- 检测：reliability_dual recall 1.0 / precision 1.0 / FPR 0；延迟 1–2 步；消融分离持续性与多传感器确认；
- 承诺：全局/自适应切换 1561/1369 vs 标准 3821；区域选择性 1624 与容量感知均为负结果；
- 状态机：NORMAL→覆盖→恢复→NORMAL；承诺失效与未校验恢复阻断通过测试；0 控制步响应；
- 多目标：238/240 实例存在权衡；约束选择退回无承诺 139/240；
- 融合：冲突/偏移 unsafe fuse 0、决策准确率 0.972 vs 0.774、可用率 0.750、偏置不消除；
- 后端 315/315、前端 17/17、verify:evidence 178/178、V7.2 基线 299 文件通过、E2E 通过。

**负向/混合**：区域选择性承诺、容量感知承诺、融合点估计/偏置、严格约束下的稳定性不可行；
Docker BLOCKED；AgentArts stub；Ascend CPU only。

**证据**：`evaluation/v75/v75-final-20261110/`（`npm run benchmark:v75`）。
