# V7.5.2 质量守恒审计 (MASS_CONSERVATION)

**结论**: 在当前仿真内核中，整数质量守恒已修复。600/600 次运行、每次 240 个 tick，逐 tick 残差恒为 0；`completed + unserved = initial + inflow` 对每一次运行成立；没有负队列，没有把排队人数当作已完成。

---

## 1. 账本定义

```text
region_queue(t) = Σ 全部区域当前排队人数（含闸口区域）
in_transit(t)   = Σ 全部走廊管道中的批次人数
present(t)      = region_queue(t) + in_transit(t)

expected(t)     = initial_persons + cumulative_inflow(t) - completed(t)
residual(t)     = expected(t) - present(t)          // 必须为 0
```

引擎在每个 tick 的第 8 步计算上述四项；只要 `residual !== 0` 立即抛出异常，运行终止而不是继续记录“漂亮结果”。

---

## 2. 为什么不会重复计数

旧 V7.5 的核心错误之一，是把“瓶颈队列”既留在 `currentPops` 又写入 `bottleneckQueues`，下一步再次计费；同时 `unserved = finalRemaining` 不包含队列，导致 `unserved` 恒为 0，而 `completed` 可以达到初始人数的 1.46–4.64 倍。

V7.5.2 的修复方式：

1. **区域队列只有一个所有者**：`vault.regionQueue`。人从区域进入走廊时，先从区域队列扣除，再加入管道批次；管道到达时，从管道批次移除，再加入目标区域队列。任何时刻一个人只在一个容器里。
2. **出口完成是唯一删除点**：只有 `exit` 边界服务成功的人从系统中移除并计入 `completed`。区域队列减少但人进入管道，不算完成；管道到达，不算完成。
3. **inflow 用整数信用**：`credit += rate * dt`，`floor` 后才加入队列，余数保留到下一 tick；不会产生小数人，也不会丢失小数信用。
4. **unserved 是最终 `present`**：包含区域队列 + 闸口队列 + 在途批次；因此结束时的 `completed + unserved` 必然等于 `initial + inflow`。
5. **没有“策略声明完成”入口**：策略只能产生路线候选；引擎不会读取策略的任何完成声明。

---

## 3. 600 次运行结果

数据文件：[`raw/runs.jsonl`](raw/runs.jsonl)（600 行，一行一次运行）。

| 检查项 | 结果 |
| :--- | :--- |
| 运行数 | 600（4 策略 × 5 场景 × 30 种子） |
| 每次 tick 数 | 240（60 min / 0.25 min） |
| `mass_balance_residual != 0` 的运行 | **0** |
| 逐 tick 账本残差非 0 的 tick | **0** |
| `min_region_queue < 0` | **0** |
| `min_exit_queue < 0` | **0** |
| `completed + unserved != initial + inflow` | **0** |
| `oracle_reads != 0` | **0** |

逐 tick 账本探针见 [`evidence/ledger-probes.json`](evidence/ledger-probes.json)。示例：

```json
// ST-02 STATIC, tick 239 (t=59.75)
{"region_queue":49022,"in_transit":340,"exit_queue":11338,
 "completed_cumulative":59300,"inflow_cumulative":0,
 "present":60700,"expected_present":60700,"residual":0}

// ST-02 GREEDY, tick 239
{"region_queue":29142,"in_transit":5900,"exit_queue":21920,
 "completed_cumulative":63038,"inflow_cumulative":0,
 "present":56962,"expected_present":56962,"residual":0}
```

这两行直接证明：未服务的人没有被“消失”，也没有被重复计为完成；它们分布在区域队列、在途批次和闸口队列中。

---

## 4. 旧 V7.5 的失败证据

来自 V7.5.1 审计（[`../audit_v751/AUDIT_SUMMARY.md`](../audit_v751/AUDIT_SUMMARY.md)）与旧 [`../benchmark-results.json`](../benchmark-results.json)：

| 场景 | 初始人数 | 旧 STATIC completed 均值 | 倍数 | 旧 unserved |
| :--- | ---: | ---: | ---: | ---: |
| ST-01 | 15,300 | 38,758 | 2.53× | 0 |
| ST-02 | 45,000 | 184,315 | 4.10× | 0 |
| ST-03 | 40,000 | 159,619 | 3.99× | 0 |
| ST-04 | 35,000 | 113,738 | 3.25× | 0 |
| ST-05 | 30,000 | 136,667 | 4.56× | 0 |

审计原文结论：`75/75 探针正残差；completed/expected 1.46–4.64×；unserved 恒 0`。这不是“算法优劣”问题，而是账本失效；旧 makespan、queue、chattering 结论因此不能用。

V7.5.2 不再出现任何 `completed > initial + inflow` 的运行。ST-02 的 `completed` 均值 53,165–63,985，`unserved` 56,015–66,835；ST-03 的 `completed` 78,511，`unserved` 1,489；ST-05 全部 45,000 完成。

---

## 5. 回归测试

[`backend/tests/simulation/v752.test.ts`](../../../backend/tests/simulation/v752.test.ts) 覆盖：

- 无流入、固定流入（60 人/min × 10 min）、容量不足出口、走廊封闭/恢复、多出口分流；
- 每个 tick 的 `residual === 0`；
- 出口容量 60/min、5 min、初始 1,000 人时，`completed = 300`，`unserved = 700`，队列不为 0；
- 封闭期间不产生虚假完成，恢复后继续完成；
- 同一策略 + 同一种子，`decision_log_hash` 与 `tick_ledger_hash` 一致。

运行：

```bash
npx tsx --test backend/tests/simulation/v752.test.ts
```

结果：10/10 通过；全后端 327/327 通过（见 [BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md)）。

---

## 6. 必须保留的限制

1. **聚合计数，不是个体轨迹**：没有唯一 person ID；`switched_persons` 是切换时刻的队列人数，不是去重后的独立人数。
2. **当前压力场景没有外部流入**：`inflow_schedule` 均为空；流入账本由单元测试覆盖，尚未进入 600 次基准。
3. **`max_queue_persons` 在出口服务之后采样**：因此 1,000 人、15 人/tick 的场景峰值为 985，而不是初始 1,000；这不影响质量守恒，但报告时必须说明口径。
4. **`unserved` 包含在途人员**：他们不是“被遗忘”，而是仿真结束时尚未跨过出口边界。
5. **不声称现实人员安全**：质量守恒是仿真账本属性，不是现实疏散保证。
