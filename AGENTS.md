# AGENTS.md — SkyGuard 独立项目开发准则

本仓库是从灵小禅仓库拆出的**独立安全决策项目**。任何 Agent 修改代码、场景或文档前，
必须先读本文件与 [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md)。

## 1. 不可触碰的边界

1. **场景是数据，判定是代码**：区域 / 通道 / 出口 / 演示脚本 / 地图层只能通过
   `data/scenarios/*.json` 修改；不得把具体场景写死进 TS/TSX。
2. **规划器不得自我认证**：`validator.ts` 必须独立重建约束，不读 `plan.status`
   或规划器的中间成功标志。任何"让校验器复用规划结果"的改动都必须拒绝。
3. **未知一律不可用**：`status: unknown` 与 `capacity_per_min: null` 必须继续被排除在规划之外，
   并在被使用时由校验器报硬违规。
4. **状态优先级固定**：`DEGRADED > REJECT > REROUTE > NORMAL`。数据不可信时不得下
   "方案不可行"的结论。
5. **不得伪造数据**：场景中的面积、容量、置信度、provenance 必须如实标注；
   性能数字只能来自 `npm run bench` 的本机实测，并保留原始 JSON。

## 2. 换场景的流程

见 [`docs/SCENARIO.md`](docs/SCENARIO.md)。核心原则：新增 JSON + 可选底图，
不改疏散引擎；新场景必须通过结构校验、`npm test` 与 `npm run demo`。

## 3. 验证要求

修改安全域代码后必须运行：

```powershell
npm test          # 后端 42 用例 + 前端 4 用例
npm run demo      # A/B/C 演示场景最终状态必须与 expected_state 一致
npm run build     # backend tsc + frontend vite build
```

涉及规划 / 校验性能时额外运行 `npm run bench`，并提交重新生成的
`evaluation/performance.json`。

## 4. 对外表述

- 只能说"研究原型 / 辅助决策"，不能说"应急指挥系统"或"已通过安全认证"；
- 未在真实昇腾设备上跑过的推理，不得表述为"已完成昇腾适配"；
- 合成场景数据不得表述为真实场馆测绘结果；
- 不得引用灵小禅仓库的历史竞赛成绩作为本仓库成果。
