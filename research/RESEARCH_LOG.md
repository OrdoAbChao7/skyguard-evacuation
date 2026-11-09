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
