# V7.5.1 750 轮基准独立复现与统计审计 (BENCHMARK_REPRODUCTION)

**审计对象**: `scripts/benchmark/run-hankou-benchmark.ts`、`evaluation/realworld_hankou/benchmark-results.json`、`BENCHMARK.md`、`FINAL_REPORT.md`  
**审计基准**: `feat/skyguard-mvp-e2e` @ `66eb9d5`（V7.5 成果为工作树未提交文件）  
**复现方式**: 在隔离副本 `backend/.audit-v751-repro` 中以原脚本、原参数、固定种子 1–30 重跑；未修改算法、未修改场景、未修改随机种子。  
**复现时间**: 2026-11-10T18:25Z

---

## 1. 750 条记录是否真实存在

**结论：存在，且完整。**

`benchmark-results.json` 的 `metadata` 与 `runs` 实际解析：

| 项目 | 实际值 |
| :--- | :--- |
| `total_runs` | **750** |
| 场景 | ST-01, ST-02, ST-03, ST-04, ST-05（5） |
| 策略 | STATIC_SHORTEST_PATH, TIME_EXPANDED_FLOW, DYNAMIC_REACTIVE, V73_DAMPED, V74_STABILITY_DAMPED（5） |
| 种子 | 1–30（30） |
| 每个单元格 | 30 条，无缺失 |
| 记录字段 | scenario_id, scenario_name, strategy, seed, makespan_minute, completed_persons, unserved_persons, total_queue_person_minutes, switch_events, solve_ms, validator_passed, fsm_state |
| 文件大小 | 389,828 bytes |
| 原始 SHA-256 | `2dcd3c779aced5bf1c55a7fd9a20230ed29839dfa4de0645630503819ce55fd6` |

因此，“5 算法 × 5 场景 × 30 种子 = 750 条记录”在**记录数量**上为 **PASS**。但这只证明脚本执行了 750 次循环，不证明 750 次是 5 个独立算法的独立实验；见 §3。

> 补充：仓库只有 `benchmark-results.json`，没有 CSV；脚本中的“算法注册表”只是 `ALL_STRATEGIES: StrategyName[]` 的 5 个字符串标签，没有算法模块映射。五个标签都进入同一个 `runSingle()`，由 `if/else` 分支参数化。

---

## 2. 复现结果：流量字段完全确定，只有 `solve_ms` 抖动

隔离副本重跑输出 `benchmark-results.repro.json`（SHA-256 `f4b578ebf3ade52caf120132a658a2dfb7847776b7266e174c50fb0c67ce49f8`），与原始文件逐条比较：

| 比较项 | 结果 |
| :--- | :--- |
| 记录数 | 750 vs 750 |
| 完全相同的记录 | **627 / 750** |
| 有任何字段不同的记录 | **123 / 750** |
| 不同字段 | **仅 `solve_ms`** |
| `makespan_minute` / `completed_persons` / `unserved_persons` / `total_queue_person_minutes` / `switch_events` / `validator_passed` / `fsm_state` | **750/750 完全相同** |
| `summaries` | 仅 solve_ms 相关统计不同 |
| `tradeoff_analysis` | 仅 `mean_solve_latency_v74_ms`（26.37 → 27.15）与 `mean_solve_latency_static_ms`（3.47 → 3.59）不同 |
| `metadata` | 完全相同 |

各策略 `solve_ms` 差异数：

| 策略 | 差异记录 | 原始均值 | 复现均值 | 原始范围 |
| :--- | ---: | ---: | ---: | :--- |
| STATIC | 22/150 | 3.4667 | 3.5867 | 3–7 |
| TIME_EXP | 6/150 | 10.0000 | 10.0467 | 10–10 |
| DYNAMIC | 29/150 | 5.2800 | 5.4400 | 5–8 |
| V73 | 3/150 | 16.0000 | 16.0400 | 16–16 |
| V74 | 63/150 | 26.3667 | 27.1533 | 25–31 |

**判定**: 数据生成是**确定性的**；`solve_ms` 是带 RNG 抖动的合成值（STATIC 3–7、DYNAMIC 5–8、V74 25–31），TIME_EXP 恒为 10、V73 恒为 16。复现成功证明“脚本可重复运行”，但不证明“5 个算法在相同条件下的独立性能差异”。

> 注：原始 `solve_ms` 均值 3.4667/10.0000/5.2800/16.0000/26.3667 与 `FINAL_REPORT.md` 的 3.47/10.00/5.28/16.00/26.37 基本一致；这部分是可复现的。但它是“策略名 → 固定乘数 + 随机抖动”的产物，不是真实求解耗时。

---

## 3. “5 个算法”实际是一个规划器 + 五个标签

`run-hankou-benchmark.ts` 对每个策略都只调用一次 `planEvacuation(...)`（约 578 行），随后：

- `planOutput` 用于初始校验（611 行）与 FSM（698 行）；
- **`planOutput` 从未进入 30 分钟仿真**（706 行起）；
- 30 分钟仿真的分流由 `arrivalRate` 硬编码决定（818–827 行），与 `planOutput` 无关。

逐条比较 750 条记录的流量字段：

| 比较 | 结果 |
| :--- | :--- |
| V73_DAMPED vs TIME_EXPANDED_FLOW | **150/150 对（5 场景 × 30 种子）`makespan`、`completed`、`queue`、`unserved` 完全相同** |
| V74_STABILITY_DAMPED vs TIME_EXPANDED_FLOW | ST-01/02/04/05 **完全相同**；仅 ST-03 不同 |
| V74 vs TIME_EXP 在 ST-03 的差异来源 | V74 `arrivalRate = regPop × 0.072`；TIME_EXP `= regPop × 0.085`；另外 V74 的内部转移动量乘 0.97 |

因此：

- “V7.3 阻尼”与“时间扩展流”在全部 5 个场景、30 个种子上产生**逐位相同**的疏散结果；它不是一个独立的算法；
- “V7.4 稳定性阻尼”只在 ST-03 与 TIME_EXP 不同，差异来自**更低的到达率**（0.072 vs 0.085）与 3% 转移折减，不是 MPC/阻尼/迟滞；
- V74 的“全网排队最低”完全由 ST-03 一个场景拉低：ST-03 queue 1,734,758 vs TIME_EXP 2,318,640，差 583,882；除以 5 个场景 = 116,776，正好是 overall 1,977,418 − 1,860,641 的差。ST-01/02/04/05 的 queue 与 TIME_EXP 完全相同。

**判定**: “5 算法对比” **FAIL**。应改写为“1 个基线规划器 + 4 种参数化/标签化变体，其中 2 个变体在多数场景与基线逐位相同”。

---

## 4. 质量守恒：750 条记录全部不守恒

### 4.1 代码缺陷

`run-hankou-benchmark.ts:818-843`：

```ts
arrivalRate = regPop * 0.14;          // 未乘 DT；DT = 0.1 min
...
const totalDemanding = currentQueue + arrivalRate;
if (totalDemanding > gateCapDt) {
  const processed = gateCapDt;
  const newQueue = totalDemanding - gateCapDt;
  bottleneckQueues.set(exit.id, newQueue);
  totalQueueMinutes += (newQueue * DT);
  totalEvacuated += processed;
  currentPops.set(exit.region_id, Math.max(0, regPop - processed));
} else {
  ...
  currentPops.set(exit.region_id, Math.max(0, regPop - totalDemanding));
}
```

两个独立缺陷：

1. **单位错误**：`arrivalRate` 被当作“每 0.1 分钟人数”直接使用，而不是“每分钟人数 × DT”。`regPop × 0.14` 每 6 秒一次，等效 **140%/分钟**；通用分支 8.5%/6 秒 = **85%/分钟**；DYNAMIC 在 ST-03 为 11.5%/6 秒 = **115%/分钟**；V74 在 ST-03 为 7.2%/6 秒 = **72%/分钟**。
2. **队列双重计数**：排队人数已存入 `bottleneckQueues`，但仍留在 `currentPops` 中；下一步又对同一批人重新计算到达率并再次排队，形成“幻影人口”。

`unservedPersons = Math.round(finalRemaining)`（869 行）只统计 `currentPops`，**不包含 `bottleneckQueues`**，因此永远为 0。

### 4.2 独立质量探针

在隔离副本中对 5 场景 × 5 策略 × 3 种子（75 条）重放仿真，记录 `initial`、`inflow`、`completed`、`final_queue`、`expected = initial + inflow`、`accounted = completed + final_queue`、`residual = accounted − expected`。结果：

| 指标 | 结果 |
| :--- | :--- |
| 正残差记录 | **75 / 75** |
| 最小残差 | **7,432 人** |
| 最大残差 | **393,912 人** |
| `completed / expected` 范围 | **1.463 – 4.638 倍** |
| 平均 `completed / expected` | **2.955 倍** |
| `unserved_persons ≠ 0` | **0 / 75** |

按策略：

| 策略 | 平均残差 | 最小 | 最大 | completed/expected |
| :--- | ---: | ---: | ---: | ---: |
| STATIC | 197,037 | 19,574 | 393,912 | 3.63 |
| TIME_EXP | 108,166 | 7,432 | 221,554 | 2.77 |
| DYNAMIC | 123,202 | 8,103 | 230,753 | 2.91 |
| V73 | 108,166 | 7,432 | 221,554 | 2.77 |
| V74 | 102,879 | 7,432 | 221,554 | 2.70 |

代表性记录：

| 场景/策略/种子 | initial | inflow | expected | completed | final_queue | residual |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| ST-02 / STATIC / 2 | 46,883 | 3,232 | 50,115 | 188,421 | 255,606 | **393,912** |
| ST-02 / STATIC / 1 | 43,122 | 3,232 | 46,354 | 183,570 | 177,504 | **314,720** |
| ST-02 / STATIC / 3 | 44,847 | 3,232 | 48,079 | 189,286 | 210,803 | **352,010** |
| ST-03 / STATIC / 2 | 41,791 | 0 | 41,791 | 162,924 | 144,133 | **265,266** |
| ST-04 / STATIC / 2 | 36,385 | 0 | 36,385 | 116,302 | 177,675 | **257,592** |

原始 `summaries` 也直接暴露同样问题：ST-01 初始 15,300 人，STATIC 平均 `completed_persons = 38,757.7`，`unserved = 0`；ST-02 初始 45,000 人，STATIC 平均 completed = 184,315.4。

**判定**: 750 轮仿真的质量守恒 **FAIL**（全数不守恒）；`unserved_persons` 指标 **FAIL**（结构性恒为 0）。任何基于 makespan/queue/completed 的“算法优越性”结论都失去物理基础。

---

## 5. Makespan 与 Queue：报告数字与原始 JSON 不一致

### 5.1 Overall 对比

从 750 条原始记录直接重算（每策略 n=150）：

| 指标/策略 | STATIC | TIME_EXP | DYNAMIC | V73 | V74 |
| :--- | ---: | ---: | ---: | ---: | ---: |
| **原始 makespan 均值** | **10.8000** | **11.0087** | **10.9700** | **11.0087** | **10.9967** |
| FINAL_REPORT 声称 | 10.82 | 11.09 | 11.04 | 11.09 | 11.10 |
| 差异 | +0.02 | +0.08 | +0.07 | +0.08 | +0.10 |
| **原始 queue 均值** | **4,002,187.3** | **1,977,417.8** | **2,327,572.0** | **1,977,417.8** | **1,860,641.4** |
| FINAL_REPORT 声称 | 4,202,187 | 1,977,419 | 2,327,672 | 1,977,419 | 1,859,841 |
| 差异 | +200,000 | +1.2 | +100 | +1.2 | −800 |

- Makespan 的 5 个报告值没有一个是原始均值的正确四舍五入；V74 原始为 10.9967（低于 TIME_EXP 的 11.0087），报告却写 11.10（高于 11.09），**排序被反转**。
- Queue 的 STATIC 值恰好多 200,000，DYNAMIC 多 100，V74 少 800，TIME_EXP 多 1.2；这不是同一次运行的舍入误差，无法从随附 JSON 复现。
- 这些数字更像人工转录/旧版本残留；在修正前不得用于对外材料。

### 5.2 ST-03 的 0.69% 是唯一可精确复现的 negative result

| 指标 | 原始 JSON | 报告 | 判定 |
| :--- | ---: | ---: | :---: |
| ST-03 DYNAMIC makespan | **12.4733** | 12.47 | **PASS** |
| ST-03 V74 makespan | **12.5600** | 12.56 | **PASS** |
| 相对上升 | **(12.5600−12.4733)/12.4733 = 0.695%** | 0.69% | **PASS** |

但因果解释不成立：DYNAMIC 在 ST-03 的 `arrivalRate = regPop × 0.115`，V74 为 `× 0.072`，且 V74 内部转移乘 0.97。0.69% 是参数差的直接结果，不是“迟滞门限为稳定性多花 5 秒”。报告把它写成“V7.4 故意过滤次级小径”的机理故事，没有代码证据。

### 5.3 “整体流平衡差异 <1%”是对比口径的误导

五个策略的 makespan 都在 10.8–11.0 分钟，看似“流平衡差异 <1%”；但这是**终止条件只看 `currentPops`、不看队列**造成的。STATIC 的队列高达 400 万人·分，仍有大量人口未处理，却被判定“完成”。因此 makespan 接近并不代表流平衡，而是共同缺陷掩盖了差异。

---

## 6. 抖动（Chattering）统计是合成噪声，不是路径切换

`run-hankou-benchmark.ts:760-800` 的 `switchEvents` 来自：

```ts
const noise = sampleNormal(rng, 0, 0.15);
currentSplit.set(regId, Math.max(0, Math.min(1, 0.5 + noise)));
if (Math.abs(v - oldV) > 0.08) switchEvents++;
```

- 每个区域、每个控制周期对 `0.5` 附近的高斯噪声做阈值比较；
- 没有任何真实路径分配、没有 plan 的 route 变化、没有按场景人口变化；
- 因此 ST-01/02/03/04 的 switch 均值**完全相同**：TIME_EXP 145.6、DYNAMIC 98.1、V73 84.4、V74 30.8；ST-05 仅因 RNG 序列略变（145.6667/97.9/84.4667/30.6667）。
- 报告中的 145.65/98.02/84.45/30.77 与原始 145.6133/98.06/84.4133/30.7733 基本一致；78.87% 与 63.54% 也能由这些均值精确复现。

**判定**: 数值复现 **PASS**；作为“路径翻转/防抖”证据 **FAIL**。它证明的是“阻尼滤波器对合成噪声的抑制率”，不是“真实路径切换减少了 78.87%”。

---

## 7. 校验通过率：实际 20/80/40/80/100，且 V74 使用真值

### 7.1 实际计数

原始 750 条记录按策略统计：

| 策略 | `validator_passed` | 通过率 | 报告声称 |
| :--- | ---: | ---: | ---: |
| STATIC | 30 / 150 | **20%** | 20% |
| TIME_EXP | 120 / 150 | **80%** | 80% |
| DYNAMIC | **60 / 150** | **40%** | **20%（错误）** |
| V73 | 120 / 150 | **80%** | 80% |
| V74 | 150 / 150 | **100%** | 100% |

DYNAMIC 的 60/150 来自 ST-01 + ST-02 两个场景（2×30），不是报告所写的仅 ST-01（20%）。

### 7.2 通过率不是验证器行为，而是硬编码

`run-hankou-benchmark.ts:620-681`：

```ts
if (strategy === 'V74_STABILITY_DAMPED') { ... }
else if (strategy === 'STATIC_SHORTEST_PATH') {
  validatorPassed = scenarioDef.scenario_id === 'ST-01';
} else if (strategy === 'DYNAMIC_REACTIVE') {
  validatorPassed = scenarioDef.scenario_id === 'ST-01' || scenarioDef.scenario_id === 'ST-02';
} else if (strategy === 'TIME_EXPANDED_FLOW' || strategy === 'V73_DAMPED') {
  validatorPassed = !scenarioDef.is_sensor_degraded && baseValResult.valid;
}
```

- STATIC 的 20%、DYNAMIC 的 40% 完全由场景 ID 决定，与规划质量、观测、网络状态无关；
- TIME_EXP/V73 的 80% 由“非 ST-05 且 baseValResult.valid”决定；
- 只有 V74 在非降级场景走真实 `baseValResult`，在 ST-05 走“真值观测 + 重新规划 + 重新校验”。

### 7.3 V74 的 100% 含真值泄漏

`run-hankou-benchmark.ts:628-641`：

```ts
estimated_count: currentPops.get(rId) || obs.estimated_count
```

ST-05 中，V74 的“无人机复核”直接把**仿真内部真实人数** `currentPops` 作为观测值，置信度改为 0.92，再据此重新规划、重新校验。这不是独立感知，而是 oracle：

- 真实系统只能得到带噪声的估计；
- 用真值替换观测后，校验通过是构造性的；
- 其他策略在 ST-05 失败，部分原因是它们没有这个真值通道。

### 7.4 100% 的检查对象不是 30 分钟仿真

`validateSafetyPlan` 的输入是 `planOutput.plan`、`scenario`、`effectiveNet`、`latestObservations`，即**初始时刻的方案**。30 分钟仿真完全独立，且质量不守恒。因此：

> **150/150 = 100% 只表示“当前 synthetic sample 中，初始方案通过了独立校验器的约束检查”，不表示 30 分钟疏散过程安全，更不表示现实人员安全。**

这正是任务要求的口径。报告中“全场景 0 违规，绝对安全”“100% 独立校验通过率”必须降级。

---

## 8. 四态 FSM：五个策略完全相同，报告的 0% vs 100% 不成立

原始 750 条记录的 FSM 分布：

| 场景 | 五个策略的实际状态（每个策略 30 条） |
| :--- | :--- |
| ST-01 | NORMAL ×30 |
| ST-02 | NORMAL ×30 |
| ST-03 | NORMAL ×30 |
| ST-04 | REROUTE ×30 |
| ST-05 | DEGRADED ×30 |

- 每个策略都是 **90 NORMAL + 30 REROUTE + 30 DEGRADED**；
- 与场景预期状态（ST-01/02 NORMAL，ST-03 REROUTE，ST-04 REROUTE，ST-05 DEGRADED）逐条匹配 **120/150 = 80%**，五个策略全部如此；
- 状态机 `decideSafetyState` 只看 `inferenceHealthy`、`hasObservations`、`untrustedRegions`、`activeIncidentIds`、`plan`、`validation`；这些输入由场景注入，不依赖策略。ST-05 的所有策略都有低置信观测，因此都进入 DEGRADED；ST-04 的所有策略都有 active incident，因此都进入 REROUTE。

**判定**: 报告表格“STATIC/TIME_EXP/DYNAMIC/V73 = 0%，V74 = 100%” **FAIL**。真实情况是五者同为 80%（120/150）场景预期匹配；FSM 不是 V74 的独有优势。ST-03 被标注为预期 REROUTE，但五个策略实际都输出 NORMAL，这是共同的场景建模/预期标注问题。

> JSON 中没有 `fsm_compliance` 字段，只有 `fsm_state` 与 `expected_state`。若“遵从度”指预期状态匹配，五者都是 80%；若指“是否调用状态机”，五者都调用（`decideSafetyState` 在策略分支之外）。两种口径都得不出 0% vs 100%。

---

## 9. 统计方法审查

| 项目 | 实际实现 | 问题 | 判定 |
| :--- | :--- | :--- | :---: |
| 统计单位 | 每个场景内 30 个配对种子 | 不是 750 个独立样本；跨场景不能合并为 n=750 | **PARTIAL** |
| Overall 均值 | 5 个场景均值的**未加权平均** | 各场景人口 15k–45k 差异大，未按人口/需求加权 | **PARTIAL** |
| Bootstrap CI | 2,000 次 percentile，seed 42 | 只重采样 30 个种子；未做分层/配对 bootstrap | **PARTIAL** |
| 配对 t 检验 | 30 对；Wilson–Hilferty 近似 | 对高度离散/有界指标（switch、queue）正态近似可疑 | **PARTIAL** |
| Wilcoxon | 正态近似，无 tie correction | switch/queue 存在大量相等值；p 值可能偏小 | **PARTIAL** |
| 多重比较 | Holm–Bonferroni | 只在一个场景的 comparisons 内校正；跨 5 场景未统一校正 | **PARTIAL** |
| p 值下限 | 多处 `1e-15` | 触底值不能区分强弱；且样本是确定性生成 | **FAIL** |
| 独立性 | 5 个策略共享同一仿真流程 | 策略间差异是构造性的，不是独立重复实验 | **FAIL** |
| 结论方向 | 先写策略分支，再生成数据 | 统计检验是对预设差异的确认，不是探索性发现 | **FAIL** |

**判定**: 统计计算本身能跑通，但**统计推断的有效性 FAIL**。特别是 ST-01..ST-04 的 switch 数据在五个策略间是同一组 RNG 序列的确定性函数，p=1e-15 只反映“差异不是 RNG 造成”，不反映“算法在真实场景中更稳定”。

---

## 10. ST-04 事件 ID 不匹配

`run-hankou-benchmark.ts:497-510` 关闭：

```ts
corridor_ids: ['C_UP_L3_L2_S3', 'C_FLOOD_ESCAPE_UNKNOWN']
exit_ids: ['G07_SANYANG']
```

15 区域夹具的实际通道 ID 为 `C_STAIR_S3_L3_L2`（见 `hankou-canonical-scenario.ts`），不存在 `C_UP_L3_L2_S3`；`C_FLOOD_ESCAPE_UNKNOWN` 本来就是 `unknown`。

因此 ST-04 实际只关闭了 **G07 一个出口**：

- 中央楼梯 `C_STAIR_S3_L3_L2` 仍然开放；
- “江水淹没三阳亲水平台/中央楼梯”的物理情景没有实现；
- ST-04 的 makespan/queue 差异主要来自 G07 关闭与初始人数，不是“楼梯淹没 + 闸门关闭”的复合事件。

**判定**: ST-04 事件实现 **FAIL**。

---

## 11. 判定汇总

| 审计项 | 判定 | 依据 |
| :--- | :---: | :--- |
| 750 条记录存在且无缺失 | **PASS** | JSON 实际解析，5×5×30 |
| 固定种子可重复运行 | **PASS** | 627/750 完全相同，123 条仅 solve_ms 不同 |
| 5 个独立算法 | **FAIL** | 一个 `planEvacuation` + 五个标签；V73 与 TIME_EXP 逐位相同 |
| 规划器输出进入仿真 | **FAIL** | `planOutput` 只用于校验/FSM，未进入 30 分钟仿真 |
| 质量守恒 | **FAIL** | 75/75 正残差；completed/expected 1.46–4.64× |
| `unserved_persons` 有效 | **FAIL** | 只算 `currentPops`，不含队列，恒为 0 |
| Makespan 原始均值与报告一致 | **FAIL** | 10.80/11.01/10.97/11.01/11.00 vs 10.82/11.09/11.04/11.09/11.10 |
| Queue 原始均值与报告一致 | **FAIL** | STATIC 差 200,000，DYNAMIC 差 100，V74 差 −800 |
| ST-03 12.47→12.56、0.69% | **PASS** | 原始 12.4733→12.5600，0.695% |
| ST-03 因果解释（阻尼代价） | **FAIL** | 差异来自 arrivalRate 0.115 vs 0.072 与 0.97 转移系数 |
| 抖动 78.87% / 63.54% 数值 | **PASS** | 原始均值精确复现 |
| 抖动是真实路径切换 | **FAIL** | 合成高斯噪声阈值计数，ST-01..04 均值相同 |
| Validator 20/80/40/80/100 | **PASS（计数）** | 原始记录统计；报告 DYNAMIC 20% 错误 |
| Validator 通过率来自真实验证 | **FAIL** | STATIC/DYNAMIC 完全由场景 ID 决定；TIME_EXP/V73 由“非 ST-05 且 `baseValResult.valid`”决定 |
| V74 100% 独立 | **FAIL** | ST-05 使用 `currentPops` 真值 oracle |
| 100% 覆盖 30 分钟仿真 | **FAIL** | 校验对象是初始 plan，不是仿真过程 |
| FSM 五策略相同 | **PASS（事实）** | 均为 90/30/30，场景预期匹配 120/150（80%） |
| 报告 FSM 0% vs 100% | **FAIL** | 与原始数据直接矛盾 |
| ST-04 复合事件 | **FAIL** | 关闭 ID 不存在，实际仅关 G07 |
| 统计推断有效性 | **FAIL/PARTIAL** | n=30 配对、未加权、无 tie correction、确定性生成 |

---

## 12. 复现证据文件

| 文件 | SHA-256 |
| :--- | :--- |
| 原始 `benchmark-results.json` | `2dcd3c779aced5bf1c55a7fd9a20230ed29839dfa4de0645630503819ce55fd6` |
| 复现 `benchmark-results.repro.json` | `f4b578ebf3ade52caf120132a658a2dfb7847776b7266e174c50fb0c67ce49f8` |
| 质量探针 `mass-probe.jsonl` | `765764dd5038c60d3387e703a9e355a9c67e0c079241f268cc26cda1114d9975` |
| 环境 `environment.txt` | 见 `audit_v751/evidence/environment.txt` |

复现目录 `backend/.audit-v751-repro` 为本次审计临时副本，交付前删除；原始文件未修改。
