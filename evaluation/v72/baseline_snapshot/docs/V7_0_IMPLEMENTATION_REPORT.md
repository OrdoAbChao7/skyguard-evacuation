# SkyGuard V7.0 实施报告

> 日期：2026-11-09。范围：V7.1 预测与动态规划、V7.2 联合感知与拥堵、V7.3 集成与可信边界。
> 最终证据运行：`evaluation/v70/v70-final-20261109T195122/`。全部为合成/模拟数据，不代表真实场馆效果。

## 1. 执行摘要

本轮完成了当前环境可独立完成的 V7 研发：

- 新增研究级预测引擎（Kalman、ARIMA、Holt-Winters、在线 LSTM、regime、conformal、漂移、状态感知集成）；
- 新增动态规划组件（可配置时间扩展求解器、最大流、容量盲最短路径、受限 MILP 枚举、滚动时域 MPC）；
- 新增动态拥堵执行模型（FIFO 队列、BPR 行程时间放大、出口拥挤服务衰减）；
- 新增联合 VoI（区域相关性、动作冗余、预算内顺序选择、跨轮次记忆）；
- 新增四个只读研究 API，观测不可信时 fail closed；
- 完成 30 固定种子的三组对照实验、配对统计、Bootstrap、Holm 校正、敏感性、消融与失败案例；
- 修复审计发现的求解器死循环、残差区域身份丢失、预览参数无界与证据字节不一致问题；
- 后端 201/201、前端 17/17、构建、安全 demo、MVP demo 通过。

**核心结论（必须与负向结果一起引用）**

1. 预测集成显著优于 persistence/EMA/linear/Kalman/在线 LSTM，但**劣于 ARIMA/Holt-Winters/旧自适应**，且**没有单一方法全场景最优**；surge 95% 覆盖仅 0.748。
2. 滚动重规划在容量受压合成场景中把未疏散人数从 613 降到 0、完成时间从 19 降到 8.33 分钟；但**预测与队列反馈相对“仅重规划”没有显著增量收益**。
3. 联合 VoI 相对现有多区域 VoI：总风险降低略低（−0.0026），最坏区域风险略低（−0.0007），效应量很小；**不能宣称全面更优**。
4. 所有动态/拥堵参数均为未标定启发式；真实场馆效果、AgentArts、昇腾、Docker/CI 仍为外部阻塞。

## 2. V7.1 预测

### 2.1 实现

| 模块 | 内容 |
| --- | --- |
| `forecast-advanced.ts` | Kalman 局部线性趋势；ARIMA(1,1,0)；Holt-Winters（加性趋势/季节）；在线 LSTM（隐藏 4、截断 BPTT）；regime 检测；Page-Hinkley 输入漂移 + 误差漂移；split-conformal 90/95 区间；状态感知集成与消融开关 |
| `prediction.ts` | 既有 `adaptive-forecast-v3` 保持不变，作为安全主链路默认预测 |
| 测试 | 确定性、无未来依赖、Kalman 线性外推、ARIMA 常数、HW 周期、LSTM 确定性、regime 分类、conformal 覆盖率、退化输入 |

### 2.2 实验设计

- 30 个固定种子（20261109–20261138）；7 种机制：stable / surge / decline / periodic / missing / noisy / regime_shift；
- 60 点序列、1 分钟间隔、预测 5 步；每个滚动起点只用过去数据训练/选择/校准；
- 11 种方法：persistence、ema、damped、blend、linear、kalman、arima、holt_winters、lstm_online、adaptive（旧滚动选择）、ensemble_v70；
- 统计：按种子聚合 95% CI、配对绝对误差、Bootstrap、seed-cluster Bootstrap、Cohen's d_z、Holm-Bonferroni（10 个基线）。

### 2.3 结果（最终运行）

| 机制 | 最佳方法 (MAE) | ensemble_v70 MAE | 集成 95% 覆盖 |
| --- | --- | --- | --- |
| stable | lstm_online (9.72) | 10.84 | 0.933 |
| surge | holt_winters (72.34) | 98.01 | 0.748 |
| decline | linear (8.43) | 10.67 | 0.983 |
| periodic | holt_winters (64.12) | 83.46 | 0.982 |
| missing | lstm_online (11.47) | 12.56 | 0.932 |
| noisy | lstm_online (67.72) | 76.67 | 0.933 |
| regime_shift | arima (87.25) | 114.93 | 0.809 |

配对（ensemble − 基线，Holm 校正后全部显著）：

- 优于 persistence −2.76、ema −8.03、damped −5.83、blend −6.89、linear −17.33、kalman −3.18、lstm −33.25；
- 劣于 arima +4.16、holt_winters +8.16、adaptive +2.01。

Regime / 漂移：

- regime_shift 突增与下降段漂移检测率均 1.0，stable 误报率 0.016；
- regime 可接受标签准确率：stable 0.891、surge 0.487、decline 0.953、periodic 0.182、missing 0.833、noisy 0.424、regime_shift 0.885；
- 结论：regime 只能作为候选筛选提示，不能自动切换安全策略。

消融（10 种子子集，surge MAE）：完整 97.46；无 regime 99.52；无漂移放大 97.46；正态区间 97.46；等权 101.80。
（消融在 10 个种子上运行，用于方向性判断，不替代 30 种子主结果。）

## 3. V7.1 动态规划

### 3.1 实现

- `strategies.ts`：可配置时间扩展求解器（容量/成本随分钟变化、预测到达注入、出口分配限制）、
  时间扩展最大流、容量盲最短路径、受限二进制出口分配 MILP 枚举（≤5 个竞争区域、≤32 分支）；
- `congestion.ts`：1 分钟离散 FIFO 队列、BPR 行程时间放大（a=0.15, b=2）、
  出口拥挤服务衰减（factor=1/(1+q/(μ·5))，下限 0.5）；所有参数标注为未标定启发式；
- `mpc-planner.ts`：观测/预测 → 求解 → 只执行第一个控制步 → 残差反馈 → 重规划；
  预测到达只用于规划，执行按当前实际在场人数截断；
- `min-cost-flow.ts`：新增 Dijkstra + 势函数求解器，供研究使用；安全主链路 SPFA 规划器未改动。

### 3.2 实验设计

- 30 种子；合成体育场网络；初始需求 650–1000/区域，2–3 次合成入流（150–350 人，第 2–7 分钟）；
- 所有策略面对相同实际入流与同一执行模型；只有 mpc_* 使用带误差预测（时间 ±1 分钟、人数 ×[0.8,1.2]）；
- 策略：static_mcf、shortest_path、max_flow、milp_restricted、reactive_mcf、mpc_forecast、mpc_queue；
- 指标：完成率、未疏散、完成时间、队列人·分钟、最大队列、平均/P95 等待、切换人数、校验通过率。

### 3.3 结果（最终运行，均值）

| 策略 | 未疏散 | 完成时间(min) | 队列人·分钟 | 最大队列 | P95 等待 | 校验通过率 |
| --- | --- | --- | --- | --- | --- | --- |
| static_mcf | 613.3 | 19.00 | 51395 | 5228 | 12.13 | 1.0 |
| shortest_path | 1441.6 | 24.00 | 70344 | 4772 | 19.97 | 0.0 |
| max_flow | 613.3 | 17.13 | 38000 | 3825 | 6.63 | 0.0 |
| milp_restricted | 613.3 | 11.30 | 18523 | 2991 | 4.47 | 0.0 |
| reactive_mcf | 0 | 8.40 | 13681 | 3861 | 1.00 | 0.0 |
| mpc_forecast | 0 | 8.30 | 13843 | 3888 | 1.00 | 0.0 |
| mpc_queue | 0 | 8.33 | 13866 | 3888 | 1.00 | 0.0 |

关键配对：

- MPC 相对 static_mcf：未疏散 −613.3 [−665.7, −560.9]，完成时间 −10.67 [−10.8, −10.5]，队列 −37529；
- MPC 相对 reactive_mcf：未疏散 0.00，完成时间 −0.07（Holm p=0.15），队列 +185.7 [−127.0, +498.4]（Holm p=0.49）；
- **预测与队列反馈没有显著增量收益**；收益主要来自滚动重规划本身。
- 校验通过率为 0 的静态/MPC 行：shortest/maxflow 容量盲或不完整；MPC 第一步含入流/预测到达，
  无法对应当前观测做独立校验，因此标记为条件投影而非“失败”。

## 4. V7.2 联合 VoI

### 4.1 实现

- `joint-voi.ts`：区域相关性（间接信息权重 = correlation × 图边权）、覆盖重叠冗余折扣、
  预算内顺序选择、跨轮次已选动作记忆；
- 参数来自场景 `investigation.joint`：correlation 0.5、redundancy_penalty 0.6、max_sequence 3；
- 与多区域 VoI 共用同一策略、似然、损失、预算与动作可用性。

### 4.2 实验设计

- 30 种子 × 40 trial；真实状态按 0.5 概率共享潜在因子（合成相关性）；
- 所有策略共享动作覆盖、观测采样随机数（common random numbers）与预算；
- 策略：random、fixed、greedy（单区域）、multi（现有多区域）、joint、oracle（上界）。

### 4.3 结果（最终运行，均值）

| 策略 | 风险降低 | 最坏区域终风险 | 检测准确率 | 成本 | 效率 |
| --- | --- | --- | --- | --- | --- |
| random | 0.0863 | 0.1087 | 0.7225 | 0.3943 | 0.330 |
| fixed | 0.0474 | 0.1097 | 0.7146 | 0.4000 | 0.119 |
| greedy | 0.0508 | 0.1096 | 0.7118 | 0.2630 | 0.300 |
| multi | 0.1655 | 0.1031 | 0.7496 | 0.5798 | 0.296 |
| joint | 0.1629 | 0.1024 | 0.7480 | 0.5801 | 0.284 |

- joint − multi：benefit −0.0026 [−0.0044, −0.0008]（Holm 显著，d_z=−0.08）；
  worst-region risk −0.0007 [−0.0012, −0.0002]；成本 +0.0003（不显著）。
- Oracle（10 种子）检测覆盖 1.0、成本 0.059；作为上界，不可实现。
- 相关性敏感性（joint）：0 / 0.5 / 0.8 时 benefit 0.180 / 0.177 / 0.176；最坏风险 0.101 / 0.101 / 0.101。

## 5. V7.3 集成与可信边界

### 5.1 只读 API

| 接口 | 作用 | 安全边界 |
| --- | --- | --- |
| `GET /api/v1/mvp/v70/forecast/:regionId` | 集成预测 + 区间 + 可靠性 | 观测不足 fail closed；不替代四态 |
| `GET /api/v1/mvp/v70/joint-investigation` | 联合 VoI 决策 | 不建单、不审批、不改变状态 |
| `GET /api/v1/safety/v70/mpc-preview` | MPC 滚动投影 + 执行指标 | 观测不可信 fail closed；带预测步骤为条件投影 |
| `GET /api/v1/safety/v70/congestion-preview` | 当前方案拥堵投影 | 只读；不发布方案 |

### 5.2 安全加固

- 查询参数钳制：forecast horizon ≤30、MPC control interval 1–10、planning horizon ≤30、max steps ≤40、joint max sequence 1–6；
- 相关性/冗余参数钳制到 [0,1]；
- 预览不把预测到达计入“已到达”人数（`actualArrivals` 为空），避免把预测当事实；
- 生产环境 5xx 不回显内部错误消息；
- 只有对应当前观测的 MPC 第一步执行独立校验；后续步骤标记条件投影；
- `.gitattributes` 增加 `evaluation/** -text`，保证跨平台证据字节稳定。

### 5.3 审计发现与修复

| 级别 | 问题 | 状态 |
| --- | --- | --- |
| P0 | 受限出口集合下 SPFA 零费用残量环导致路径回溯死循环 | 已修复：研究求解器改用 Dijkstra+势函数；新增回归测试；安全主链路未改 |
| P0 | 执行残差把未分配人员折叠为 `__unrouted__`，丢失区域身份，MPC 永久无法再次路由 | 已修复：按区域保留身份；新增高需求回归测试 |
| P0 | 预览查询参数无界，可造成 CPU 耗尽 | 已修复：服务层钳制；新增 API 上限测试 |
| P0 | 预览把预测到达计入总输入/完成，可能夸大结果 | 已修复：预测只用于规划，不计入实际到达 |
| P1 | 出口容量在队列反馈中被双重扣减 | 已修复：改为与执行模型一致的拥挤服务衰减 |
| P1 | Windows 检出 CRLF 导致 V6.5 证据字节校验失败 | 已修复：`.gitattributes` + 证据字节恢复 |
| P1 | `verify:evidence` 重写冻结的 `evaluation/v61/verification.json` | 已修复：默认只校验，`--write` 才更新；冻结清单恢复 46/46 |
| P1 | 预测/队列反馈无增量收益 | 保留为负向研究结论，不调参制造优势 |
| P2 | Regime 检测在短窗口不稳定 | 已记录；只作提示 |
| P2 | 联合 VoI 总收益略低 | 已记录；不宣称全面更优 |
| P2 | V7 预览前端面板 | 已实施：显式“运行 V7 预览”按钮、API 驱动、只读/未标定标注；前端测试 17/17 |

## 6. 验证与复现

```bash
npm test                    # 后端 201/201 + 前端 17/17
npm run build
npm run demo                # 安全三场景
npm run demo:mvp            # MVP 三场景
npm run benchmark:v70       # 预测 + 规划 + 联合 VoI（30 种子）
```

证据：`evaluation/v70/v70-final-20261109T195122/`

- `prediction_rows.json` / `prediction_summary.json` / `prediction_README.md` / `prediction_MANIFEST.json`
- `planning_rows.json` / `planning_summary.json` / `planning_README.md` / `planning_MANIFEST.json`
- `joint_voi_rows.json` / `joint_voi_summary.json` / `joint_voi_README.md` / `joint_voi_MANIFEST.json`
- `V70_SUMMARY.md` / `MANIFEST.json` / `run_metadata.json`

## 7. 未完成与外部资源

| 项 | 状态 | 所需资源 |
| --- | --- | --- |
| 真实场馆时序/入流/调度延迟 | 未验证 | 场馆数据、标定、现场协作 |
| 人群速度/出口服务率标定 | 未标定 | 实测数据 |
| AgentArts 真实租户/Trace | 未接入 | 租户、凭证、已发布运行时 |
| 昇腾 NPU/CANN/.om | 未实机 | 昇腾设备与 CANN 环境 |
| Docker/CI 实跑 | 未运行 | Docker daemon / CI 运行环境 |
| 前端 V7 预览面板 | 已实施（按钮触发、只读） | 仍需视觉验收与真实数据演示 |
| 专业安全评审/演练 | 无 | 消防与安全专业机构 |

## 8. 参赛成熟度评估

- **研究完整性**：V7 三个方向均有实现、强基线、30 种子、配对统计、消融、敏感性与失败案例；
- **诚实性**：负向/混合结果全部保留并写入 README、summary、CLAIMS、LIMITATIONS；
- **安全性**：独立校验、四态、fail-closed 与人工授权边界未被削弱；预测不得绕过校验；
- **平台与实机**：AgentArts/昇腾/真实场馆仍为外部阻塞，不能宣称实机验证；
- **成熟度**：Research Prototype + Reproducible Synthetic Evidence；
  **不是 Production Ready，也不是真实场馆效果验证**。国一目标是研发目标，不是可预先宣称的结果。
