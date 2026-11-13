# V7.5 最终交付

> 版本：`v7.5.0-research.1`
> 最终证据：`evaluation/v75/v75-final-20261110/`（33 个根文件；根清单 SHA-256 复核 0 不一致）
> 结论：**PARTIALLY VERIFIED 研究原型**。合成证据完整、可复现；真实场馆、AgentArts 实机、昇腾 NPU、Docker 部署均未验证。

## 1. 交付物

### 1.1 代码

| 模块 | 文件 |
| --- | --- |
| 低误报检测 | `backend/src/services/safety/detection/surge.ts` |
| 紧急状态机 | `backend/src/services/safety/emergency/emergency-state.ts` |
| 多传感器融合 | `backend/src/services/safety/fusion/fusion.ts` |
| 多目标 | `backend/src/services/safety/planning/multi-objective.ts` |
| MPC 集成 | `backend/src/services/safety/planning/mpc-planner.ts`（状态机有效性输入、容量感知承诺、冷却） |
| 承诺配置 | `backend/src/services/safety/planning/v73-stability.ts` |

### 1.2 实验脚本

- `v75-detection-benchmark.ts`（30×7×7）
- `v75-commitment-benchmark.ts`（30×8×10）
- `v75-multiobjective-benchmark.ts`（30×8×14）
- `v75-fusion-benchmark.ts`（30×9×5）
- `v75-ascend-pipeline.ts`、`v75-agentarts-status.ts`、`v75-production-checks.ts`
- `v75-experiments.ts`（`--only=detection,fusion` 等；`V75_INCLUDE_PRODUCTION/BROWSER`）

### 1.3 测试

- `v75-detection.test.ts`、`v75-fusion.test.ts`、`v75-emergency.test.ts`、
  `v75-multiobjective.test.ts`、`v75-commitment-redteam.test.ts`、`v75-redteam.test.ts`；
- 后端总计 **317/317** 通过。

### 1.4 文档

- [V75_IMPLEMENTATION_REPORT.md](V75_IMPLEMENTATION_REPORT.md)
- [V75_EXPERIMENT_REPORT.md](V75_EXPERIMENT_REPORT.md)
- [V75_INDEPENDENT_AUDIT.md](V75_INDEPENDENT_AUDIT.md)
- 本文件

## 2. 实际改进（相对 V7.4 / 基线）

| 项 | V7.4 / 基线 | V7.5 | 说明 |
| --- | --- | --- | --- |
| 检测精确率 | CUSUM 0.8054；3σ 0.8276 | **1.0000** | 合成机制；代价 1–2 步延迟 |
| 检测无变化误报率 | CUSUM 0.3222；3σ 0.2778 | **0.0000** | 消融定位持续性与多传感器确认 |
| 承诺切换（vs 标准 MPC 3820.8） | 自适应 1369.0（V7.3/7.4） | 全局 1561.1；自适应 1369.0 | V7.5 未超越 V7.4 自适应；区域选择性 1623.7 为负结果 |
| 紧急状态机 | 无显式状态机 | NORMAL→警告→覆盖→恢复 | 承诺失效、恢复校验、不可发布计数 |
| 多目标 | 单一门控 | Pareto/膝点/约束选择 | 238/240 实例有权衡；离线分析 |
| 融合 | 无统一融合管线 | fail-closed 融合 | 严格条件 unsafe fuse 0；可用率 0.7497 |

**结论**：V7.5 的主要增量是**检测误报归因、显式状态机、融合 fail-closed 与多目标分析**；
承诺切换没有超过 V7.4 自适应，区域选择性与容量感知为负结果，必须如实报告。

## 3. 负结果（保留）

1. 区域选择性承诺切换 1623.7，高于全局承诺 1561.1 与自适应 1369.0；
2. 容量感知承诺切换 −63.2 [−132.8, +6.4]（Holm 不显著），未疏散升至 13.74；
3. 融合点估计 MAE 5.538，与 reliability_weighted 同级；偏置条件 13.33，无法消除；
4. 严格时间/队列约束下稳定配置经常不可行，多目标选择退回无承诺 139/240；
5. 检测延迟增加 1–2 步；
6. 紧急状态机 0 响应仅为控制步内测量。

## 4. P0 / P1 / P2

### P0

- 无未解决 P0。V7.5 未修改安全内核；四态、独立校验、未知/不可用 fail-closed 保持。

### P1

- `SensorObservation.delayed` 未被检测器使用（延迟按当前值处理）；
- 融合输出未自动接入 MPC/状态机，需调用方传入观测有效性；
- 区域选择性/容量感知承诺需要重新设计（当前为负结果）。

### P2

- 生产检查脚本硬编码 `localhost:8010`；
- `verify:evidence` 只复核 `LATEST` 运行；
- 求解耗时单机测量，不作为性能主张；
- 承诺参数未做完整敏感性网格。

## 5. 安全与可靠性

- 317/317 后端测试、17/17 前端测试、typecheck、build、两个 demo 通过；
- `verify:evidence` 178/178；V7.2 基线 299 文件通过；
- 浏览器 E2E 通过（登录/指挥中心/代理 API，0 console/page error）；
- 红队覆盖：重复紧急请求、迟滞、执行截断、确定性、承诺出口失效、headroom 夹紧、观测无效不可发布；
- 既有覆盖：过期审批/幂等/持久化/越权 Agent 测试通过。

## 6. 华为生态状态

| 项 | 状态 |
| --- | --- |
| AgentArts | `not_configured`；本地官方契约 stub 通过（会话头、幂等键、SSE） |
| 昇腾 NPU | 无 `npu-smi`/`atc`/CANN；**未实机** |
| ONNX | CPUExecutionProvider，checker valid，p50 0.0106ms，max_abs_diff 0 |
| OM | 未执行；无 `.om` 文件 |
| Docker | daemon 不可用 → **BLOCKED** |

**不得**将 CPU ONNX 基准表述为 NPU 性能，也不得表述为 AgentArts 已接入。

## 7. 可复现

```bash
npm run benchmark:v75 --prefix backend
npm run benchmark:v75 --prefix backend -- --only=detection,fusion
V75_INCLUDE_PRODUCTION=1 npm run benchmark:v75 --prefix backend
```

E2E 需要 dev servers 与 Playwright：

```bash
npm run dev:backend
npm run dev:frontend
node frontend/e2e/smoke.mjs --out evaluation/v75/<run>/browser_e2e.json
```

## 8. Git 状态

- 分支：`claude/ecstatic-feistel-74fd5b`（工作树）；
- 按任务规则**未 commit / 未 push / 未创建 PR / 未 tag / 未 reset / 未 stash / 未 clean**；
- 所有 V7.5 变更为工作树未提交状态；V7.2/V7.3/V7.4 证据未改写。

## 9. 最终判定

| 维度 | 判定 |
| --- | --- |
| 算法实现 | VERIFIED（代码 + 测试） |
| 合成实验证据 | VERIFIED（33 文件哈希一致、178/178 检查） |
| 基线保护 | VERIFIED（299 文件） |
| 浏览器 E2E | VERIFIED（冒烟） |
| 真实场馆/传感器 | NOT VERIFIED |
| AgentArts / Ascend / Docker | BLOCKED |
| 整体 | **PARTIALLY VERIFIED 研究原型，不是 Production Ready** |
