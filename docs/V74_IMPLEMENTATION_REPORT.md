# SkyGuard V7.4 实施报告

> 日期：2026-11-10。版本：`v7.4.0-research.1`。
> 最终证据：`evaluation/v74/v74-final-20261110T105851/`（31 文件）。
> 全部为合成/夹具数据；无真实场馆、AgentArts 实机或昇腾 NPU 证据。

## 1. 执行摘要

V7.4 针对 V7.3 暴露的「稳定性—效率」矛盾做研究，而非堆叠功能：

1. **执行感知稳定性门控**：候选承诺方案必须通过执行投影（makespan/queue 容差）才能采用；
2. **Pareto 份额扫描**：枚举承诺份额 0.8/0.6/0.4/0.2，在门控内选切换最少者；
3. **风险触发承诺释放**：最大区域风险超过阈值时自动释放承诺；
4. **区域选择性承诺**：只对低风险区域保持承诺；
5. **Surge/regime 检测**：现有 CUSUM+spike 与 3σ 基线对比；
6. **标定质量**：时钟同步、缺失区间、传感器可靠性代理、动态容量计划；
7. **生产工程**：Docker/CI/浏览器 E2E/API 负载检查；
8. **红队**：门控/Pareto/动态容量/时钟偏移回归。

**核心结论**

- 严格零容差门控下，**无法在降低切换的同时不增加完成时间**；门控拒绝全部承诺，回退标准 MPC。
- 1 分钟门控 + 2000 人·分钟队列容差（Pareto）切换 3820.8→1837.7（−52%），完成时间 +0.575 分钟、队列 +862；
  未疏散 3.81（标准 16.47，自适应 0）；安全违规 0.013。
- 高风险自动释放：切换 −322.8，完成 +0.408、队列 +424、未疏散 2.87。
- 风险敏感惩罚（riskDiscount 0.9）与 V7.3 自适应结果**完全相同**——负结果，参数未改变决策。
- CUSUM 检测率 100%，3σ 基线 76.7%/73.3%；中位延迟相同（5/7 步）。
- 标定质量：时钟偏移拒绝、缺失检测、可靠性代理、动态容量计划均实现并有测试。
- 浏览器 E2E 通过：登录 → 指挥中心 → 代理 API；Docker daemon 不可用（BLOCKED）。

## 2. 稳定性—效率研究

### 2.1 实现

`mpc-planner.ts` 新增：

- `executionGate`：对基线与候选运行 `simulateRoutesExecution`，比较 makespan/queue；
- `paretoStability`：枚举承诺份额，在门控内选切换加权人数最少者；
- `releaseOnRiskThreshold` / `regionSelectiveRiskThreshold`（`v73-stability.ts`）；
- 结果字段：`pareto_candidates`、`gate_rejections`、`commitment_releases`。

安全硬条件不变：未疏散不增加、逐分钟容量为空、目标劣化护栏、振荡护栏、出口不可用紧急覆盖。

### 2.2 A-F 策略

| 代号 | 策略 | 机制 |
| --- | --- | --- |
| A | legacy_static | 一次规划 |
| B | mpc_standard | 标准 MPC |
| C | mpc_adaptive_v73 | V7.3 自适应（无门控） |
| D | mpc_risk_adaptive | 风险敏感惩罚（riskDiscount 0.9） |
| E | mpc_emergency_release | 风险 >0.5 自动释放承诺 |
| F | mpc_pareto_gate | 份额 0.8/0.6/0.4/0.2 + 1min/2000 门控 |

30 种子 × 8 场景 × 6 策略；结果见 [V7.4 实验报告](V74_EXPERIMENT_REPORT.md)。

### 2.3 研究问题回答

- **能否不增加完成时间而降低切换？** 不能（本模型/机制）。零容差门控拒绝所有承诺；1 分钟容差可降 52% 切换但 +0.575 分钟。
- **紧急条件能否立即覆盖承诺？** 能。出口不可用立即释放；高风险阈值释放（E）记录 2.62 次/场景。
- **区域风险/密度能否动态影响惩罚？** 已实现风险加权与选择性承诺；区域敏感性在当前场景下收益有限（见下）。
- **迟滞与 MPC 能否合作而不振荡？** 能降低振荡（571.9→93.4 全自适应；Pareto 136.1），但固定种子下不保证逐例。
- **动态容量下能否保持稳定？** 规划/执行/复核口径一致，容量违规 0；动态容量场景切换收益缩小。

## 3. 预测与感知

- 新增 `v74-surge-detection.ts`：CUSUM+spike vs 3σ；
- 结果：CUSUM 检测率 100%，3σ 76.7%/73.3%，中位延迟 5/7；稳定段误报率均约 33% 种子（每 100 步约 0.6）；
- 未训练/未引入 P2PNet、CSRNet 权重；ShanghaiTech 现有实验与权重可用性审计见部署/限制文档；
- 不把 crowd counting 指标当作疏散真值。

## 4. 标定质量

新增 `calibration/quality.ts`：

- 时钟同步：按 provider 应用偏移，超过 30s 拒绝；
- 缺失区间：按期望间隔/容差检测；
- 传感器可靠性：可用性×置信度×稳定性代理，`estimated`；
- 动态容量计划：区间校验、重叠拒绝、因子夹取、MPC 因子转换；
- 观测质量：缺失/过期/低置信度/无效/重复时间戳/覆盖率。

## 5. 华为生态与生产

- AgentArts：新增 trace 关联头 `x-skyguard-trace-id`；保留幂等键/会话/SSE/重试；
- 真实平台仍 `not_configured`；本地 stub 通过；
- Ascend：ONNX checker valid、CPU p50≈0.011ms；无 NPU/CANN/OM；
- Docker：Dockerfile 存在，daemon 不可用 → 未构建；
- CI：YAML 解析通过；新增 benchmark:v74 步骤；
- 浏览器 E2E：Playwright 登录/指挥中心/API 冒烟通过；
- 负载：状态端点 100 次/并发 10，p95≈7.3ms（本地单机，不代表规划吞吐）。

## 6. 红队修复

- 门控不能增加切换人数：候选必须严格优于基线，否则回退；
- Pareto 候选必须容量为空、未疏散不增加、门控通过；
- 动态容量计划非法区间/越界拒绝；
- 时钟偏移超限拒绝；
- AgentArts trace 头验证；
- 新增 `v74-redteam`（4）、`v74-calibration-quality`（5）、trace 测试（1）。

## 7. 验证

- 后端 **283/283**、前端 **17/17**；
- 构建、安全 demo、MVP demo；
- `npm run benchmark:v74`：31 文件根清单；
- `verify:evidence` **166/166**；
- V7.2 基线快照 299 文件通过；V7.3 证据未改写；
- 浏览器 E2E 通过。

## 8. 外部阻塞

真实场馆/摄像机/授权数据、AgentArts 租户、昇腾 NPU/CANN/OM、Docker daemon、第三方安全评审/演练。
