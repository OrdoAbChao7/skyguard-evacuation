# V7.5.2 基准协议 (BENCHMARK_PROTOCOL)

**设计**: 4 个真实策略代码路径 × 5 个合成压力场景 × 30 个种子 = **600 次运行**。没有 750 次，也没有用 5 个标签冒充 5 个算法。

---

## 1. 运行矩阵

| 维度 | 取值 |
| :--- | :--- |
| 策略 | `STATIC_SHORTEST_PATH`, `GREEDY_DYNAMIC`, `V73_STABILITY`, `V74_COMMITMENT` |
| 场景 | ST-01, ST-02, ST-03, ST-04, ST-05 |
| 种子 | 1–30（整数） |
| 总运行 | 4 × 5 × 30 = 600 |
| 仿真步长 | `dt = 0.25 min` |
| 控制周期 | `1.0 min` |
| 时长 | 每场景 60 min（240 tick） |

种子按场景和策略复用；同一种子下四个策略看到相同的传感器随机流（common random numbers）。

---

## 2. 输出与保留规则

- **所有 600 次运行都写入** [`raw/runs.jsonl`](raw/runs.jsonl)，不删除失败/负面结果；
- 每次运行包含：场景、策略、种子、初始人数、流入、完成、未服务、质量残差、最终队列、完整指标、验收字段、决策日志哈希、逐 tick 账本哈希；
- 代表性决策日志（seed 1）写入 [`decision-logs/`](decision-logs/)；
- 逐 tick 账本探针写入 [`evidence/ledger-probes.json`](evidence/ledger-probes.json)；
- 汇总写入 [`benchmark-summary.json`](benchmark-summary.json)；
- 运行元数据（分支、HEAD、种子、场景、代码 SHA-256）写入 [`run-metadata.json`](run-metadata.json)。

---

## 3. 指标

| 指标 | 定义 |
| :--- | :--- |
| `completed_persons` | 跨过出口边界的人数（唯一完成口径） |
| `unserved_persons` | 仿真结束时仍在区域队列/闸口队列/在途的人数 |
| `makespan_minute` | 首次达到 `present=0` 的时间；未清空则记为 60 |
| `p50/p95_evacuation_minute` | 完成人数累计曲线的 50%/95% 分位时间 |
| `throughput_persons_per_min` | `completed / makespan` |
| `max_density` | 区域峰值密度（人/m²） |
| `max_queue_persons` | 区域/闸口等待峰值（出口服务后采样） |
| `max_exit_queue_persons` | 闸口区域队列峰值 |
| `queue_person_minutes` | 等待人数 × 时间的积分（离散求和） |
| `backpressure_activations` | 下游密度 > `rhoCrit` 的区域-tick 计数 |
| `route_switches` | 已验证路线实际改变次数（按区域决策记录） |
| `switched_persons` | 切换时刻该区域队列人数之和（事件人数，不是去重人数） |
| `rerouted_persons_after_event` | 旧路线被真实封控破坏、随后改用不同已验证路线的区域人数（每区域最多一次） |
| `closed_corridor_attempts` | 候选路线使用封闭通道的发布层拒绝次数 |
| `closed_exit_attempts` | 候选路线使用封闭出口的发布层拒绝次数 |
| `unvalidated_executions` | 未授权路线进入运动/出口服务的次数（必须为 0） |
| `unknown_corridor_entries` | 实际进入未知/无容量通道的次数（必须为 0） |
| `dangerous_route_publications` | 危险密度目的地路线被发布的次数（必须为 0） |
| `oracle_reads` | 决策/校验层读取地面真值的次数（结构上必须为 0） |
| `solve_ms_mean/p50/p95` | 策略 + 校验的实际耗时（不计入可复现哈希） |

---

## 4. 统计方法

- 每个场景 × 策略：30 个种子；
- 报告 `mean`、样本标准差、`median`、`min`、`max`；
- 95% 置信区间：对 30 个观测做 500 次 bootstrap 重采样，取 2.5%/97.5% 分位；
- 配对比较：同一场景、同一种子下两策略的差值；
  - 均值差；
  - 配对 bootstrap 95% CI（500 次）；
  - 符号翻转置换检验（2,000 次）双侧 p 值；最小可达 p 约为 0.0005（1/2001），因此报告中的 0.0005 是下限而非精确值；
  - treatment/baseline 胜负计数与平局计数；
- 等权归一化比较：先算每个场景的均值差，再对 5 个场景等权平均，避免 ST-02 因人数多而支配总体结论。

所有 p 值均为**探索性**，未做多重比较校正；报告用于判断方向与不确定性，不作为确证性统计检验。

---

## 5. 验收字段

每次运行记录：

```text
mass_balance
no_unvalidated_execution
no_unknown_corridor_entry
no_dangerous_route_publication
no_negative_region_queue
backpressure_activated
max_density
max_exit_queue_persons
closure_window_applied
blocked_route_attempts
blocked_exit_attempts
rerouted_persons_after_event
degraded_observations
degraded_decisions
oracle_reads_zero
queue_observed
```

场景级汇总（[`benchmark-summary.json`](benchmark-summary.json) 的 `scenarioAcceptance`）额外区分：

- `all_mass_balance`
- `all_no_unvalidated_execution`
- `all_no_unknown_corridor_entry`
- `all_no_dangerous_route_publication`
- `any_backpressure_activated`
- `any_closure_window`
- `any_blocked_route_attempt`
- `any_blocked_exit_attempt`
- `any_reroute`
- `any_degraded_observation`
- `any_degraded_decision`
- `all_oracle_reads_zero`

“any”表示该场景至少有一个策略/种子触发；“all”表示 120 次运行全部满足。两者不能混写。

---

## 6. 公共随机数与确定性

- `SensorStream` 每区域每 tick 固定 4 次抽样；
- 随机流只由 seed 决定，不由策略决定；
- 路线求解、遍历、排序均确定性；
- `decision_log_hash` / `tick_ledger_hash` 不包含运行时 `solve_ms`；
- 同策略同种子重复运行应得到相同哈希；不同策略即使完成人数相同，决策日志哈希也应不同（因为观测相同但决策路径不同）。

---

## 7. 已知统计限制

**大多数结果对种子不敏感**：

- ST-01、ST-03、ST-05：四个策略的 `completed` 在 30 个种子上完全相同；
- ST-04：只有两个完成值（59,385 与 49,962），分别对应静态/贪心与 V73/V74；
- ST-02：存在种子方差（GREEDY std 1,317，V73 std 2,671，V74 std 3,586），是唯一有明显种子效应的场景。

原因：当前模型没有随机需求到达或随机事件时间；唯一随机源是传感器噪声，而噪声很少跨过路线选择的离散阈值。因此 30 个种子是真实执行的 30 次，但**有效独立重复远少于 30**。报告不得把退化 CI 写成“高置信度”。

---

## 8. 复现命令

```bash
# 1) 生成压力场景（只写 data/scenarios/hankou-v752-stress.json）
npx tsx scripts/simulation/v752/generate-scenarios.ts

# 2) 运行 600 次基准（只写 evaluation/realworld_hankou/v752/）
npx tsx scripts/simulation/v752/run-benchmark.ts

# 3) 运行 V7.5.2 回归测试
npx tsx --test backend/tests/simulation/v752.test.ts

# 4) 校验 SHA-256 清单
npx tsx scripts/simulation/v752/verify-manifest.ts
```

详细环境与输出见 [REPRODUCE.md](REPRODUCE.md)。
