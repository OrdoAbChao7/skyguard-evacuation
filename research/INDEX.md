# SkyGuard 研究资料库

> 目的：把技术主张与可追溯来源绑定，区分**官方证据、论文、工程文档、未验证推测**。
> 本库不是论文库，不复制受版权保护全文，只记录链接、版本、用途与局限。

## 目录

| 文件 | 内容 |
| --- | --- |
| `SOURCES.jsonl` | 34 条来源（JSONL，字段：id/title/url/type/verification/license/topics/maps_to） |
| `CLAIMS.md` | 技术主张 → 证据 → 状态（已验证/部分验证/未验证/禁止表述） |
| `RESEARCH_GAPS.md` | 仍缺失的外部证据与检索限制 |
| `RESEARCH_LOG.md` | 检索日期、查询、结论与决策 |
| `notes/` | 8 篇专题笔记 |

## 来源统计（2026-11-05）

| 类型 | 数量 |
| --- | --- |
| 官方文档/标准/规范 | 14 |
| 论文 | 7 |
| 代码/数据集 | 5 |
| 指南/手册/其他 | 8 |
| 检索缺口记录 | 1 |
| **合计** | **34** |

验证状态：

- `verified-search`：本轮检索命中并确认 URL（12 条）；
- `canonical-url-not-fetched`：使用官方/项目规范 URL，但本轮未逐页打开（18 条）；
- `known-literature`：经典论文/DOI，本轮未核验全文（4 条）；
- `gap` 类型 1 条（S34），其验证状态为 `verified-search`：检索不到官方资料，作为缺口记录。

> 只要状态不是 `verified-search`，在对外材料中引用时必须注明“未逐页核验”。

## 专题笔记

1. [`notes/agentarts.md`](notes/agentarts.md) — AgentArts/ModelArts Studio 检索结论与适配边界
2. [`notes/mcp.md`](notes/mcp.md) — MCP 2025-06-18、stdio、工具安全
3. [`notes/voi.md`](notes/voi.md) — VoI 理论与本仓库模型映射
4. [`notes/crowd-counting.md`](notes/crowd-counting.md) — 人群计数数据集与模型、视频计数局限
5. [`notes/forecasting.md`](notes/forecasting.md) — 滚动验证、基线与区间校准
6. [`notes/evacuation-planning.md`](notes/evacuation-planning.md) — 时间扩展流、独立校验
7. [`notes/human-in-the-loop.md`](notes/human-in-the-loop.md) — 审批、权限与 AI 风险管理
8. [`notes/evaluation-and-ascend.md`](notes/evaluation-and-ascend.md) — 统计评估、CANN/MindSpore 边云路径

## 模块映射（摘要）

| 模块 | 主要来源 |
| --- | --- |
| VoI | S01 S02 S03 |
| 预测 | S22 S23 S24 S28 |
| 感知 | S04 S05 S06 S07 S08 S09 S10 S29 |
| 规划/校验 | S20 S21 |
| MCP | S11 S12 S13 S14 |
| AgentArts/昇腾 | S15 S16 S17 S18 S19 S34 |
| 人机协同/治理 | S25 S26 S27 S30 |
| 工程 | S31 S32 S33 |
