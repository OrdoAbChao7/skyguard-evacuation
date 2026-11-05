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
