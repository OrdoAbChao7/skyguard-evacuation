# SkyGuard 研究算法升级报告（2026-11-09）

> 本报告只记录**实际实现并有原始数据**的算法工作；合成实验不得表述为真实人群/场馆结果。
> 原始证据：`evaluation/v65/`、`evaluation/final/`、`evaluation/real-data-partB-cross/`。

## 1. 预测驱动的规划需求

### 1.1 实现

- 场景新增 `planning.demand_mode = observed | predicted | robust` 与 `prediction_horizon_minutes`。
- `SafetyDecisionService` 在每次重算时构造规划需求：
  - `observed`：最新观测；
  - `predicted`：`max(观测, 预测点估计)`；
  - `robust`：`max(观测, 预测区间上界)`；
  - 预测不可靠/数据不足时回退 `observed_fallback`。
- **安全不变量**：预测只能上调需求，不能低于当前观测；因此预测错误不会导致少规划。
- 每个方案带 `demand_provenance`（区域、观测、预测、区间上界、可靠性、来源），Validator 独立核对：
  预测模式需求不得低于观测，不得超过区间上界（`prediction_demand_exceeds_interval`）。

### 1.2 实验

`evaluation/final/prediction-planning/2026-11-09T06-33-13-854Z/`：30 seeds × 6 机制 × 3 模式，
同一合成序列与场景，按 10 倍人流压力、3 分钟窗口制造容量约束。

| 机制 | 可靠率 | observed 未解决 | predicted 未解决 | robust 未解决 |
| --- | --- | --- | --- | --- |
| stable | 0.667 | 2108.3 | 2122.0 | 2257.7 |
| surge | 0 | 3462.3 | 3462.3（回退） | 3462.3（回退） |
| decline | 0.133 | 2747.7 | 2747.7 | 2747.7 |
| periodic | 0 | 1987.3 | 回退 | 回退 |
| missing | 1.0 | 2080.0 | 2080.0 | 2085.0 |
| noisy | 0 | 1921.0 | 回退 | 回退 |

**结论（负向/中性）**：预测确实改变了规划需求（stable 的 robust 需求平均 +25.6 人），
但在静态、非时间分阶段的规划模型中，预测上调需求只增加未解决人数，不改善吞吐。
这证明“预测→规划”链路已真实存在，同时说明需要时间分阶段到达/滚动重规划才能体现收益；
不得据此宣称预测提升疏散效率。

## 2. 预测区间：regime-aware 校准与可靠性门禁

### 2.1 实现

- 方法选择步长与最终 horizon 一致（v4）；`selectForecastMethod` 按时间戳寻找 h 步目标，支持缺失/不规则采样。
- `regimeIntervalFactor`：近期斜率、加速度或 10 分钟增长超过阈值时，将区间安全系数从 1.5 提高到 6；
  只加宽区间，不缩小。
- 可靠性新增 `regime_unstable`：机制切换窗口直接标记 failed。
- 场景新增 `config.prediction_action_enabled`，当前为 **false**：预测区间未通过覆盖率校准前，
  预测动作不得进入 VoI。

### 2.2 V6.5 结果（30 seeds，`evaluation/v65/2026-11-09T06-33-02-508Z/`）

| 机制 | 95% 覆盖 | 说明 |
| --- | --- | --- |
| stable | 0.9914 | 接近名义 |
| surge（全部） | **0.8667** | 起点 <38：0.7881；≥38：0.9314 |
| decline | — | 可靠性门禁后剩余样本覆盖 0.977 |
| missing | — | 0.982 |
| periodic / noisy | — | 可靠性门禁几乎全部阻断 |

- 可靠子集 surge 覆盖仍只有约 0.69（主要是突增起点前的窗口）；因此**预测动作默认禁用**。
- surge 整体覆盖从上一轮 0.7376 提升到 0.8667，但仍未达到 0.95；这是模型失效，不是可忽略噪声。

## 3. 联合 VoI

### 3.1 实现

- `backend/src/services/mvp/joint-voi.ts`：粒子表示跨区域联合信念；共享压力潜变量 + 区域独立扰动
  （Gaussian-copula 的混合实现），粒子权重按观测似然更新；信息价值按**联合熵**计算，
  风险项取最坏区域期望风险；固定 seed 可复现。
- 场景 `investigation.correlation` 配置共享压力权重、粒子数与 seed。
- 强制执行 `max_investigations`，修复多区域轮次未生效的问题。
- 多区域 API 增加 `joint_decision` 字段（叠加式，不破坏旧结构）。

### 3.2 公平实验（`evaluation/final/joint-voi/2026-11-09T06-47-12-412Z/`）

30 seeds × 10 trials × 3 个相关性强度（0 / 0.45 / 0.8）；所有策略共享真实世界、动作权限、预算与随机数流。

| 相关性 | 策略 | 总风险降低 | 最坏区域风险降低 | 成本 |
| --- | --- | --- | --- | --- |
| 0 | multi | 0.1775 | -0.0015 | 0.693 |
| 0 | joint | 0.1691 | -0.0023 | 0.765 |
| 0.45 | multi | 0.1816 | -0.0014 | 0.683 |
| 0.45 | joint | 0.1683 | -0.0024 | 0.660 |
| 0.8 | multi | 0.1900 | -0.0012 | 0.678 |
| 0.8 | joint | 0.1712 | -0.0015 | 0.633 |

联合 − 多区域配对差（总风险降低）：0: -0.0084；0.45: -0.0133；0.8: -0.0188。

**结论（负向）**：当前联合粒子 VoI 在总风险降低上没有超过现有多区域加权 VoI，且相关性越强差距越大；
最坏区域风险也没有改善。联合策略优于随机/固定/单区域贪心，但不足以替代多区域加权。
可能原因：联合评分采用最坏区域风险目标，而评估采用总风险；粒子近似与单区域后验更新不一致。
该负向结果保留在原始数据中，不通过更换指标掩盖。

## 4. 拥堵反馈与拥堵感知规划

### 4.1 实现

- `backend/src/services/safety/planning/congestion.ts`：
  - BPR 型容量折减 `effective = base / (1 + α·(flow/base)^β)`，下限由 `max_capacity_reduction` 控制；
  - `planWithCongestion`：按方案实际通道利用率折减容量并迭代重规划，只会更保守；
  - `simulateCongestion`：逐分钟通道/出口队列结转，统计已服务、未服务队列、最大队列、拥堵分钟数。
- 场景 `planning.congestion` 可启用；默认场景已启用 BPR 参数（未标定）。

### 4.2 实验（`evaluation/final/congestion/2026-11-09T06-32-03-427Z/`）

4 个需求规模 × 3 个 BPR alpha = 12 组；静态规划 vs 拥堵感知规划，同一仿真。

| 指标 | 静态 | 拥堵感知 |
| --- | --- | --- |
| 平均已服务 | 2349.1 | 2349.1 |
| 平均未服务队列 | 604.2 | 604.2 |
| 平均最大通道队列 | 76.1 | **0** |

**结论**：拥堵感知规划通过更保守的容量与错峰分配消除了仿真中的通道排队，
但在当前“总出口容量决定最终吞吐”的场景下，没有改变最终已服务/未服务人数。
这支持“拥堵反馈影响队列与调度时序”，但不支持“提升总疏散量”的主张。

## 5. Validator 强化

- horizon 只取场景值；`solver_truncated` hard 拒绝；
- 区域在留容量逐分钟检查；出口前排队计入区域占用；
- 所有启用区域观测/传感器故障检查；停用区域/通道/出口一致性；
- 从 routes 重算 `exit_totals`/`corridor_totals`，校验 `step.persons`；
- 预测需求 provenance 与区间上界校验；
- 规划器路径分解方向自检。

## 6. 公开数据集

- ShanghaiTech Part A test（182 图，P2PNet SHTechA 权重）：MAE 57.2418 / RMSE 96.0415 / NAE 0.1319（V6.3 证据保留）。
- 新增 Part B test 跨域评测（316 图，同一 Part A 权重，`evaluation/real-data-partB-cross/`）：
  MAE 22.1614 / RMSE 34.0471 / NAE 0.1786；F1@8px 0.7052；CPU 平均 1448 ms/图；6/6 复算通过。
  **这是域迁移结果，不是 Part B 官方权重基准，也不是现场精度。**
- NWPU-Crowd 本地不可用；CSRNet 对照未运行（外部依赖）。

## 7. 复现

```bash
npm run benchmark:v65 --prefix backend
npm run benchmark:prediction-planning --prefix backend
npm run benchmark:congestion --prefix backend
npm run benchmark:joint-voi --prefix backend
npm run manifest:final --prefix backend -- --verify
```
