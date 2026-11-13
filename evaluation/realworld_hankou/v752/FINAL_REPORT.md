# SkyGuard V7.5.2 — 仿真内核修复与算法有效性重新验证 · 最终报告

**版本**: V7.5.2 Simulation Integrity Remediation  
**分支**: `feat/v752-simulation-integrity`  
**基线 HEAD**: `345f4d1660573c44de12ad26fa19136a6a5e9122`  
**日期**: 2026-11-11  
**性质**: 内部研究与证据复核，不是第三方认证；未执行 commit/push/PR/tag。

---

## 0. 一页结论

| 维度 | 结论 | 判定 |
| :--- | :--- | :---: |
| 质量守恒 | 600/600 次运行、240 tick/次，逐 tick 残差为 0；`completed + unserved = initial + inflow` | **PASS** |
| 规划器进入仿真 | 策略路线 → 安全校验 → 授权 → 走廊/出口执行；策略差异改变完成人数 | **PASS** |
| 独立算法数量 | 4 个可执行代码路径；3 类独立机制（V73/V74 共用稳定性原语） | **PASS（带口径）** |
| Oracle 消除 | 策略/校验不读取 `regionQueue`；`oracle_reads=0`；权威事件状态仍按设计输入 | **PASS（带口径）** |
| 动态安全校验 | 每控制 tick 校验；0 未授权执行、0 未知通道进入、0 危险路线发布 | **PASS** |
| 压力场景 | ST-02 触发反压/改派；ST-04 触发封控/改派/恢复；ST-05 触发传感器降级 | **PASS（带口径）** |
| 实验可信度 | 600 次真实运行、原始记录与哈希齐全；但 4/5 场景无种子方差、场景为合成 | **PARTIAL** |
| 总体 | 核心仿真完整性已修复；外部效度与统计重复不足，不能判 PASS | **PARTIAL** |

**最终判定：PARTIAL。** 这不是“失败”，也不是“可以对外宣称真实世界已验证”。它表示：本轮要求的仿真内核修复与证据链已经成立；但实验的种子方差、场景真实性和外部效度仍不足以支持更强的结论。

---

## 1. 质量守恒是否真正修好？

**是，但只到“整数聚合人数”层级。**

- 账本：`present = 区域队列 + 闸口队列 + 在途批次`；`expected = initial + inflow - completed`；
- 600/600 次运行、每次 240 tick，`residual = 0`；
- 没有负队列；
- 没有 `completed > initial + inflow`；
- 出口边界是唯一完成点；排队与在途都保留在 `unserved`；
- 单元测试覆盖无流入、固定流入、容量不足、封控/恢复、多出口分流。

旧 V7.5 的 `completed` 为初始人数的 1.46–4.64 倍、`unserved` 恒 0；该结果已永久失效。详见 [MASS_CONSERVATION.md](MASS_CONSERVATION.md)。

**限制**：没有个体 ID；`switched_persons` 是切换时刻人数，不是去重人数；当前压力场景没有外部流入（仅单元测试覆盖）；不声称现实人员安全。

---

## 2. 规划器是否真正进入动态仿真？

**是。**

- 策略每控制 tick 产生候选路线；
- 安全校验通过后写入 `activeRoutes` 与 `authorizedRegions`；
- 引擎按 `activeRoutes.next_hop_region_id` 把人从区域移入走廊；
- 路线改变会改变走廊选择、出口选择、队列位置、反压与完成人数；
- 静态策略冻结路线，封控后其路线被安全校验持续拒绝（ST-02：1,540 次封闭出口尝试；ST-04：165 次封闭通道尝试）；
- 贪心在 ST-02 比静态多完成 **4,685 人**（95% CI 4,135–5,148，p=0.0005），并产生 510 次实际路线切换；
- V74 在 ST-02 比 V73 少完成 **10,465 人**（95% CI 9,085–11,958，p=0.0005）。

如果规划器只是报告标签，这些差异不会出现在人口流动和完成人数上。详见 [STRATEGY_INTEGRATION.md](STRATEGY_INTEGRATION.md)。

---

## 3. 真正独立的算法到底有几个？

**4 个可执行策略代码路径，3 类独立机制。**

| 类别 | 策略 | 说明 |
| :--- | :--- | :--- |
| 静态 | `STATIC_SHORTEST_PATH` | 首次“全部区域观测可信”时冻结路线表，之后不重算 |
| 贪心 | `GREEDY_DYNAMIC` | 每个控制 tick 重算最小费用路线 |
| 稳定性族 | `V73_STABILITY` | 候选 vs 已承诺路线，切换惩罚/迟滞 |
| 稳定性族 | `V74_COMMITMENT` | V7.3 + 承诺窗口 + 风险释放 |

V73/V74 共用 `shouldUseCommitment` 和 `adaptiveSwitchPenalty`，是同一稳定性机制的两个配置，不是两个完全独立的算法范式。行为上：

- ST-02：四种策略完成人数/密度/切换显著不同；
- ST-04：静态/贪心完成人数相同，但贪心改派 15,570 人；V73/V74 少完成 9,423 人；
- ST-01/ST-03/ST-05：四种策略结果相同或几乎相同，不能声称“全面优势”。

因此本轮运行 **4×5×30 = 600** 次，而不是旧 V7.5 的 5×5×30 = 750 次。旧 750 轮的 5 个标签实际只有一个 `planEvacuation` 规划器，V73 与 TIME_EXP 在 150/150 对记录中逐位相同；该对比永久撤回。

---

## 4. Oracle 是否彻底消除？

**人群计数的地面真值 oracle：是。任何权威输入：不是，且不应这样声称。**

- `GroundTruthVault` 是 `engine.ts` 私有类，不导出；
- 唯一读取入口是 `SensorStream` 的 `asSensorTruth()` 适配器；
- 策略签名只有 `ObservedSnapshot`；
- 安全校验输入只有 `ObservedSnapshot`、权威事件状态、候选路线、上次已验证路线；
- 600/600 次运行 `oracle_reads = 0`；
- 没有 `currentPops` 注入，没有“真值替换观测”。

但安全校验仍读取**权威事件状态**（已确认的封控/恢复命令）来判断通道/出口是否关闭。这是事件/命令馈送，不是人群计数 oracle；策略只看到带延迟的观测状态。若评审把“任何权威输入”都定义为 oracle，则应表述为“人群真值 oracle 已消除；权威事件状态仍按设计输入”，不能写“彻底消除所有 oracle”。详见 [SENSOR_TRUST_BOUNDARY.md](SENSOR_TRUST_BOUNDARY.md)。

---

## 5. 安全校验是否覆盖动态执行？

**是。**

- 每个控制 tick、每个区域重新校验；
- 检查通道/出口存在性、封闭/未知、容量、观测可信度、危险目的地密度、路径经过不可信区域；
- 四态优先级 `DEGRADED > REJECT > REROUTE > NORMAL`；
- `rejected` / `no_route` 立即删除活动路线与授权；
- 执行层用 `authorizedRegions` 硬门；未授权路线不得移动；
- 600/600 次运行：`unvalidated_executions=0`、`unknown_corridor_entries=0`、`dangerous_route_publications=0`、`oracle_reads=0`。

ST-02 静态策略在 t=5 后 55 个控制 tick 持续被拒绝（1,540 次封闭出口尝试）；ST-04 静态策略 165 次封闭通道尝试；ST-05 225 次/run 不可信观测全部走 `degraded_continue`，没有新路线发布。

**限制**：这是仿真约束校验，不是现实安全认证；不能写“100% 人员安全”“绝对安全”“第三方认证”。详见 [SAFETY_VALIDATION.md](SAFETY_VALIDATION.md)。

---

## 6. ST-02、ST-04、ST-05 是否真正达到场景目标？

### ST-02：达到，但“是否触发反压”依赖策略

- 120,000 人；t=5 关闭 7 个辅助闸口；出口容量 25%；
- 42/120 次运行触发反压；43/120 次峰值密度 ≥ 2.0；全场景最大 2.938；
- 90/120 次运行有事件后改派；
- 静态 1,540 次封闭出口尝试；贪心 28 次后改派，改派 32,679 人；
- 结论：**封控、排队、改派、反压均真实发生**；但 V73 多数通过降低峰值密度避免反压，不能要求每个策略都触发。

### ST-04：达到“封控/改派/恢复”，但没有提高完成人数

- 60,000 人；t=5 关闭 11 条 L3→L2 通道 + G07；t=20 恢复；
- 120/120 次运行出现封闭尝试；90/120 次运行有改派；
- 静态：165 次封闭通道尝试、60 次封闭出口尝试、0 改派；
- 贪心：11 次封闭通道尝试、15,570 人改派；
- 恢复后最终状态 NORMAL；
- 但贪心完成人数与静态相同（59,385），V73/V74 少完成 9,423 人。**机制成立，性能优势不成立。**

### ST-05：达到“降级/恢复/fail-closed”，但没有策略差异

- 45,000 人；S01/S03/S07 在 5–30 min 降级；
- 225 次不可信观测/run；225 次 `degraded_continue`/run；0 次 `rejected`；
- 全部 45,000 人完成，最终 NORMAL；
- 没有 oracle，没有未授权执行；
- 四个策略结果相同：**边界行为成立，算法优势不成立。**

详见 [STRESS_SCENARIOS.md](STRESS_SCENARIOS.md)。

---

## 7. V7.4 是否仍然优于 V7.3？

**否。必须撤回“V7.4 优于 V7.3”的结论。**

| 场景 | V73 completed | V74 completed | 差值（V74−V73） | 95% CI | p |
| :--- | ---: | ---: | ---: | :--- | ---: |
| ST-01 | 18,000 | 18,000 | 0 | [0, 0] | 1.0 |
| ST-02 | 63,629.7 | 53,165.0 | **−10,464.8** | [−11,958.0, −9,084.9] | 0.0005 |
| ST-03 | 78,511 | 78,511 | 0 | [0, 0] | 1.0 |
| ST-04 | 49,962 | 49,962 | 0 | [0, 0] | 1.0 |
| ST-05 | 45,000 | 45,000 | 0 | [0, 0] | 1.0 |

ST-02 中 V74 在 29/30 个种子上比 V73 更差；ST-04 完成人数持平，但 V74 切换更少（3.0 vs 10.2）。V74 没有在任何场景显著优于 V73。旧 V7.4 的“稳定性/优越性”结论不再成立。

---

## 8. 哪些指标发生了变化？

| 指标 | 旧 V7.5 | V7.5.2 |
| :--- | :--- | :--- |
| 运行数/算法 | 750（5 标签，1 个规划器） | 600（4 代码路径） |
| completed | 初始人数 1.46–4.64× | 不超过 initial+inflow；逐 run 对账 |
| unserved | 恒 0 | 真实值：ST-02 56k–67k，ST-03 1,489 |
| makespan | 5.3–14.4 min（不可信） | 17.25–60 min；ST-02/03/04 触顶 60 |
| max density | 0.17–0.5，反压从未激活 | ST-02 最大 2.938；42/120 run 触发反压 |
| route switches | 合成噪声阈值计数；78.87%/63.54% | 实际路线记录；ST-02 510/354/75，ST-04 17.9/10.2/3.0 |
| 安全 | 150/150 初始方案；ST-05 用 oracle | 每控制 tick；0 未授权；0 oracle |
| V7.4 vs V7.3 | 旧报告声称更优 | V74 在 ST-02 显著更差；其余持平 |
| GIS | 0.1 m/54 m/3.6 km/0.42 km² | 降级为 Geographically Anchored Estimated Scenario |

所有数字来自 [`raw/runs.jsonl`](raw/runs.jsonl) 与 [`benchmark-summary.json`](benchmark-summary.json)；旧数字来自 [`../benchmark-results.json`](../benchmark-results.json) 与 V7.5.1 审计。

---

## 9. 哪些旧结论必须永久撤回？

1. **“5 个独立算法 / 750 轮五算法对比”**——实际是一个 `planEvacuation` + 5 个标签；V73=TIME_EXP 150/150；本轮只有 4 个代码路径、3 类机制、600 轮。
2. **“完成人数/100% 疏散/unserved=0”**——旧 completed 为初始人数 1.46–4.64 倍，正残差；该口径永久撤回。
3. **“V7.4 优于 V7.3”**——在修复后的仿真中 V74 在 ST-02 显著更差，其余持平；撤回。
4. **“100% 安全校验 / 绝对安全”**——旧校验是硬编码/oracle/只校验初始方案；本轮只能表述为“当前 600 次合成运行中的约束校验结果”。
5. **“ST-02/ST-04 真实压力/反压/封控”**——旧反压从未激活、ST-04 封控回调未执行；旧结论撤回；本轮 ST-02/ST-04 机制成立，但不是所有策略都触发反压。
6. **“0.1 m 精度 / 54 m 净宽 / 3.6 km / 0.42 km² / 42 通道”**——无独立证据；降级为估算场景，相关数字不得继续使用。
7. **“78.87% / 63.54% 抖动削减”**——来自合成噪声阈值计数，不是真实路径切换；撤回。
8. **“动态反应式 / 时间扩展流是独立算法”**——旧标签共享一个规划器；撤回。
9. **“100% 人员安全”**——仿真约束校验不等于现实人员安全；撤回。
10. **“内部 Agent 审计是第三方认证”**——V7.5.1/V7.5.2 均为内部审计；撤回任何“第三方认证”表述。

---

## 10. 当前版本能否支持华为 ICT 创新赛道答辩？

**有条件可以，但必须按修正后的口径。**

### 可以支持的陈述

- 仿真内核具备整数质量守恒；600/600 次运行逐 tick 残差为 0；
- 四个策略代码路径真实进入动态仿真；ST-02/ST-04 中策略差异改变完成人数/密度/切换；
- 传感器/安全边界：策略与校验不读取人群真值；0 oracle、0 未授权执行；
- 动态安全校验覆盖每个控制 tick；封控期间拒绝封闭资产路线；
- ST-02/ST-04/ST-05 的封控、改派、反压、传感器降级机制真实工作；
- 所有原始记录、哈希、复现命令齐全；负结果保留。

### 不能支持的陈述

- “真实世界 0.1 m 精度 / 54 m 净宽 / 3.6 km / 0.42 km²”；
- “100% 人员安全 / 绝对安全 / 第三方认证”；
- “V7.4 优于 V7.3”；
- “5 个独立算法 / 750 轮五算法对比”；
- “已在 AgentArts / 昇腾 / 无人机实机验证”；
- “可直接预测真实汉口江滩疏散时间”。

### 答辩建议

把本轮定位为 **“仿真完整性修复 + 合成压力下的机制验证”**，而不是“真实世界数字孪生验证”。明确说明：

> 我们修复了质量守恒、规划器闭环、传感器信任边界和动态安全校验；在当前合成场景中验证了封控/改派/反压/降级机制。几何与客流仍是估算/测试参数，真实世界外部效度尚未验证。

如果赛道要求“真实世界验证/第三方认证”，该部分应标为 **BLOCKED**，不能用仿真结果替代。

---

## 11. 验收 Gate

| Gate | 结果 | 证据 | 说明 |
| :--- | :---: | :--- | :--- |
| **A 质量守恒** | **PASS** | 600/600 run residual 0；`completed+unserved=initial+inflow`；无负队列；10/10 测试 | 聚合整数人数，不是个体轨迹；压力场景无外部流入 |
| **B 真实算法执行** | **PASS（带口径）** | 4 个代码路径；ST-02 贪心−静态 +4,685（p=0.0005）；ST-04 改派 15,570 | 3 类机制；V73/V74 共用稳定性原语；3/5 场景无行为差异 |
| **C 传感器/安全边界** | **PASS（带口径）** | 600/600 `oracle_reads=0`、`unvalidated=0`；ST-05 225 次降级/run | 权威事件状态仍输入安全校验；不是人群 oracle |
| **D 压力场景** | **PASS（带口径）** | ST-02 42/120 反压、最大 2.938；ST-04 封控/恢复；ST-05 降级/恢复 | 只有 ST-02 触发密度反压；ST-03 无策略差异 |
| **E 实验可信度** | **PARTIAL** | 600 runs、30 seeds、原始记录、bootstrap/配对检验、SHA-256 | 4/5 场景完成人数无种子方差；场景合成；无外部验证 |
| **总体** | **PARTIAL** | 核心完整性 PASS；Gate E PARTIAL | 不能判 PASS，也不能判 FAIL/BLOCKED |

---

## 12. 证据索引

- [SIMULATION_ARCHITECTURE.md](SIMULATION_ARCHITECTURE.md)
- [MASS_CONSERVATION.md](MASS_CONSERVATION.md)
- [STRATEGY_INTEGRATION.md](STRATEGY_INTEGRATION.md)
- [SENSOR_TRUST_BOUNDARY.md](SENSOR_TRUST_BOUNDARY.md)
- [SAFETY_VALIDATION.md](SAFETY_VALIDATION.md)
- [STRESS_SCENARIOS.md](STRESS_SCENARIOS.md)
- [BENCHMARK_PROTOCOL.md](BENCHMARK_PROTOCOL.md)
- [BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md)
- [REPRODUCE.md](REPRODUCE.md)
- [DATA_PROVENANCE.md](DATA_PROVENANCE.md)
- [PRESERVATION_CHECK.md](PRESERVATION_CHECK.md)
- [`raw/runs.jsonl`](raw/runs.jsonl)
- [`benchmark-summary.json`](benchmark-summary.json)
- [`run-metadata.json`](run-metadata.json)
- [`evidence/ledger-probes.json`](evidence/ledger-probes.json)
- [`evidence/test-results.txt`](evidence/test-results.txt)
- [`evidence/benchmark-console.txt`](evidence/benchmark-console.txt)
- [`decision-logs/`](decision-logs/)
- [`SHA256SUMS.txt`](SHA256SUMS.txt)（生成后）
