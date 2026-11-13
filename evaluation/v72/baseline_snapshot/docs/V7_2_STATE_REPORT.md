# SkyGuard 现有状态描述报告

> 版本：`v7.2.0-research.1`（见根目录 `VERSION`）
> 报告时间：2026-11-10
> 工作树：`claude/ecstatic-feistel-74fd5b`，HEAD `345f4d1`（V7.0 提交），V7.1/V7.2 改动未提交
> 证据运行：`evaluation/v72/v72-final-20261110T014910/`
> 结论先行：**Research Prototype + 可复现合成证据 + Shadow ready-for-review（默认关闭）；不是 Production Ready，不能宣称国一或真实场馆效果。**

## 1. 项目当前定位

SkyGuard 是面向大型活动散场的应急疏散辅助决策原型：
感知 → 预测 → VoI 主动调查 → 人员/工单 → 人工审批 → 执行 → 反馈 → 重新评估。
安全内核独立：规划器、Validator、四态状态机（NORMAL/REROUTE/DEGRADED/REJECT）、审计。
未知/不可用一律 fail-closed；Agent 只能创建待审批工单，不能审批或控制无人机。

当前研发阶段：

| 阶段 | 状态 |
| --- | --- |
| MVP / V6 | 完整业务闭环、多区域风险图、联合 VoI、序贯调查、MCP 工具 |
| V6.1–V6.5 | 科研级审计、30 种子、证据冻结、真实数据感知评测、AgentArts 契约、资源预留/事务/持久化 |
| V7.0 | 预测集成（Kalman/ARIMA/Holt-Winters/在线 LSTM/regime/conformal/漂移）、时间扩展 MPC、拥堵反馈、联合 VoI、只读预览 API |
| V7.1 | 滚动重规划机理 A-G、事件触发、ACI+变点区间、Shadow Mode（默认关闭）、出口/通道/双向压力 |
| V7.2 | 路线稳定性 A-F、承诺式求解与紧急覆盖、双向共享容量修正、场馆标定流水线、Shadow 回放压力、AgentArts stub + ONNX CPU 链路 |

## 2. 当前代码与能力

### 2.1 安全主链路（未重写）

- `backend/src/services/safety/`：场景/网络/观测/风险/Validator/状态机/审计/决策服务；
- 规划器：既有 `planEvacuation`（SPFA 时间扩展最小费用流）仍是默认发布路径；
- V7 研究求解器 `solveTimeExpandedPlan` 仅用于研究/预览/Shadow；
- 四态、独立校验、未知不可用、版本漂移失效、审计 trace 保持不变。

### 2.2 V7.2 新增能力

| 能力 | 位置 | 状态 |
| --- | --- | --- |
| 稳定性策略（迟滞/切换惩罚/承诺/自适应） | `planning/route-stability.ts` | 实现 + 6 测试 |
| 承诺式逐区域求解、容量预留、份额回退 | `planning/stable-solver.ts` | 实现 + 容量复核 |
| MPC 稳定性集成、运行中故障、紧急覆盖 | `planning/mpc-planner.ts` | 实现 + 回归 |
| 双向通道共享容量迭代 | `planning/strategies.ts` | 实现 + 8 轮随机回归 |
| 场馆标定档案/校验/应用/估计/观测适配 | `safety/calibration/venue-calibration.ts` | 实现 + 8 测试 |
| Shadow 求解器注入、快照人数一致性 | `planning/v7-adapter.ts` | 实现 + 4 压力测试 |
| V7.2 证据编排 | `scripts/v72-experiments.ts` | stability/calibration/shadow/huawei |
| ONNX 参考模型导出与 CPU 基准 | `python/ascend/` | 已执行（CPU） |
| AgentArts 状态核验 | `scripts/v72-huawei-status.ts` | 本地 stub；真实平台未配置 |

## 3. 当前验证状态（本机，2026-11-10）

| 项目 | 结果 |
| --- | --- |
| 后端测试 | **242/242** |
| 前端测试 | **17/17** |
| TypeScript | 后端 `tsc --noEmit` 通过；前端随构建通过 |
| 生产构建 | `npm run build` 通过 |
| 安全 demo | 三场景全部符合预期 |
| MVP demo | 三场景全部通过 |
| V7.2 证据 | `benchmark:v72` 四组证据；根清单 30 文件 |
| 证据一致性 | `verify:evidence` **146/146** |
| 冻结证据 | 46/46 文件哈希通过 |
| 版本冻结 | `evaluation/v72/freeze_v72.json` + `BASELINE_SHA256` + `SHA256SUMS` |

环境版本：

- Node `v24.19.0`，npm `11.17.0`，TypeScript `5.9.3`；
- Python `3.13.7`，ONNX `1.23.2`，ONNX Runtime `1.29.0`，NumPy `2.4.3`；
- 依赖版本由 `backend/package-lock.json`、`frontend/package-lock.json` 与
  `backend/python/ascend/requirements-v72.lock.txt` 固定。

## 4. 关键实验结论与代价

30 种子 × 6 场景 × 6 策略（A-F）：

| 策略 | 未疏散 | 完成时间 | 队列人·分钟 | 最大密度 | 切换人数 |
| --- | --- | --- | --- | --- | --- |
| A legacy_static | 784.9 | 19.00 | 57772.6 | 1.963 | 0 |
| B 标准 MPC | 0 | 9.89 | 19481.7 | 2.696 | 5261.8 |
| C 迟滞 | 0 | 9.94 | 20824.1 | 2.769 | 4268.3 |
| D 切换惩罚 | 0 | 10.34 | 22103.1 | 2.776 | 3334.3 |
| E 承诺窗口 | 0 | 10.41 | 22209.2 | 2.776 | 3334.7 |
| F 自适应 | 0 | 10.41 | 22209.2 | 2.776 | 3334.7 |

- 迟滞：切换 −18.9%，完成时间 +0.05 分钟；
- 切换惩罚/承诺：切换 −36.6%，完成时间 +0.45–0.51 分钟；
- 代价：队列 +1.3k–2.7k 人·分钟、最大密度 +0.07–0.08、求解耗时约翻倍；
- 所有 MPC 未疏散为 0；差异经 Holm 校正显著；
- 惩罚与承诺在当前参数下结果几乎相同；自适应退化为承诺；高需求时承诺被安全护栏拒绝；
- 运行中出口故障：MPC 故障后 0 条路线使用故障出口；legacy 静态方案平均 1.13 条。

**这些是合成场景/未标定参数下的相对结论，不是真实场馆效果。**

## 5. 证据与冻结状态

### 5.1 V7.2 证据

`evaluation/v72/v72-final-20261110T014910/`：

- `stability_*`：30×6×6 对照、配对/Bootstrap/Holm、逐场景与负向结果；
- `calibration_*`：合成档案校验、应用、参数估计、观测适配器结果；
- `shadow_stress_*`：240 次回放、确定性、完整性、回退原因；
- `huawei_*`：AgentArts `not_configured` + 本地契约 stub；Ascend/ONNX CPU 基准；
- `V72_SUMMARY.md`、根 `MANIFEST.json`（30 文件，含 `ascend/` 子目录）。

### 5.2 版本冻结

本次版本固定：

- 版本号：`v7.2.0-research.1`；
- 冻结清单：`evaluation/v72/freeze_v72.json`；
- 逐文件哈希：`evaluation/v72/BASELINE_SHA256`；
- 证据目录哈希：`evaluation/v72/SHA256SUMS`；
- 规模：299 个文件、约 11.8 MB；
- 校验：`npm run freeze:verify --prefix backend`（或 `npx tsx backend/scripts/v72-version-freeze.ts --verify`）。

冻结范围：源码、测试、脚本、依赖锁、场景/场馆数据、V7.2 证据、核心文档与 CI 配置。
不含：`node_modules`、`dist`、`__pycache__`、开发中间运行目录、冻结产物自身。

冻结规则：

1. 冻结后不得改写 `evaluation/v72/v72-final-20261110T014910/` 内任何文件；
2. 任何源码/参数/证据变化必须提升版本号并重新生成冻结清单，保留旧版本；
3. 校验失败时先定位差异，不得直接重写清单“修复”；
4. `verify:evidence` 同时校验 V7.2 根清单与版本冻结。

## 6. 安全与红队状态

已修复的 P0：

1. 双向通道两个方向各得全额容量，计划可能超物理容量；
2. 承诺候选合并后仍可能超容量。

已修复的 P1：V7.1 稳定化接口语义错误、预测 NaN/Infinity 污染、相机离线/未来时间戳未拒绝。
P2 保留：Shadow 超时非抢占、记录仅内存；双向共享容量迭代非全局最优。

红队覆盖：过期/伪造观测、相机离线、预测突变、双向容量冲突、运行中出口/通道故障、
Shadow 异常/校验失败/预算为零/快照篡改、重复回放确定性、标定来源冒用。
详见 [V7.2 红队报告](V7_2_RED_TEAM_REPORT.md)。

## 7. 华为生态状态（不得夸大）

- AgentArts：`not_configured`，缺 `AGENTARTS_BASE_URL`、`AGENTARTS_API_KEY`、
  `AGENTARTS_RUNTIME_NAME`/`AGENTARTS_AGENT_ID`；未发起真实平台请求；
  本地官方契约 stub 验证会话头一致、trace 区分、SSE `data.text` 决策解析；
- Ascend：无 `npu-smi`、无 `atc`/CANN；ONNX CPU 基准 p50≈0.015ms、`max_abs_diff=0`；
  有 ATC 命令模板与所需证据清单；
- **没有 NPU/OM 实机证据，没有 AgentArts 租户/Trace，不得声称已接入或已实机。**

## 8. Git 与仓库状态

- 分支：`claude/ecstatic-feistel-74fd5b`；HEAD：`345f4d1`（V7.0 提交）；
- 工作树有 V7.1/V7.2 未提交改动与未跟踪文件（50+ 项）；
- 未执行 reset/clean/stash/分支切换；未 commit/push/PR/tag；
- 冻结证据 46/46 未变；V7.1/V7.2 证据均为新增，不覆盖旧证据。

## 9. 外部阻塞

| 阻塞 | 影响 |
| --- | --- |
| 真实场馆几何/容量/时序 | 无法验证真实疏散效果与标定 |
| 真实摄像机/授权数据 | 无法完成真实感知标定与隐私合规验证 |
| AgentArts 租户/凭证/Trace | 无法完成平台实机与业务闭环验证 |
| 昇腾 NPU/CANN/atc | 无法给出 NPU 性能/OM 证据 |
| Docker/CI 实跑 | 本机通过，但未在 CI 环境实际运行 |
| 专业安全评审/现场演练 | 无法替代真实安全验收 |

## 10. 复现命令

```bash
npm test
npm run build
npm run demo
npm run demo:mvp
npm run benchmark:v72
npm run verify:evidence
npm run freeze:verify --prefix backend
```

单独运行 V7.2 子实验：

```bash
npm run benchmark:v72 -- --only=stability
npm run benchmark:v72 -- --only=calibration
npm run benchmark:v72 -- --only=shadow
npm run benchmark:v72 -- --only=huawei
```

## 11. 成熟度结论

- 研究：有可证伪的机理实验、配对统计、负向结果与证据链；
- 工程：安全内核未重写，Shadow 默认关闭，标定/部署链路有可运行脚本；
- 验证：合成数据、CPU ONNX、适配器层 Shadow；
- 缺口：真实场馆、平台、NPU、第三方安全评审。

**因此当前状态是「可信研究原型 + 可复现合成证据 + Shadow ready-for-review（默认关闭）」，
不是生产系统，也不是可以预先宣称的竞赛名次。**
