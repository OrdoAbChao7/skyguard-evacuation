# V7.5.2 策略集成审计 (STRATEGY_INTEGRATION)

**结论**: 规划器已经真正进入动态仿真。四个策略代码路径都产生候选路线，候选路线经独立安全校验后写入 `activeRoutes`，再由引擎按走廊容量/出口容量执行；路线改变会改变实际人口流动、队列、完成人数和回压。静态与贪心在 ST-02 的完成人数差异为 +4,685（95% CI 4,135–5,148，p=0.0005），证明策略不是报告标签。

---

## 1. 四个代码路径

| ID | 决策规则 | 记忆 | 何时重算 | 关键代码 |
| :--- | :--- | :--- | :--- | :--- |
| `STATIC_SHORTEST_PATH` | 最短费用路线表 | `staticRoutes` | 仅首个“全部区域观测可信”的控制 tick | `strategies.ts` 静态分支 |
| `GREEDY_DYNAMIC` | 当前观测下的最小费用路线 | 无（仅提交记录） | 每个控制 tick | `computeAllRoutes` |
| `V73_STABILITY` | 候选 vs 已承诺路线，切换惩罚/迟滞 | `committedRoutes`、`lastSwitchMinute` | 每个控制 tick，但可能保留旧路线 | `shouldUseCommitment(mode='switch_penalty')` |
| `V74_COMMITMENT` | V7.3 + 承诺窗口 + 风险释放 | 同上 | 每个控制 tick，承诺窗口内保留旧路线 | `shouldUseCommitment(mode='adaptive')` + `adaptiveSwitchPenalty` |

V7.3/V7.4 没有在仿真脚本里重新实现稳定性逻辑，而是直接调用仓库现有：

- [`backend/src/services/safety/planning/route-stability.ts`](../../../backend/src/services/safety/planning/route-stability.ts) 的 `resolveStabilityConfig`、`shouldUseCommitment`；
- [`backend/src/services/safety/planning/v73-stability.ts`](../../../backend/src/services/safety/planning/v73-stability.ts) 的 `adaptiveSwitchPenalty`。

---

## 2. 决策如何进入系统状态

每个控制 tick：

1. `computeStrategyRoutes()` 生成 `Map<regionId, RouteChoice | null>`；
2. `validateDynamicDecisions()` 逐区域检查候选路线；
3. 只有 `validated` 或 `degraded_continue` 且带路线的决策进入 `activeRoutes`，同时加入 `authorizedRegions`；
4. `rejected` / `no_route` 会删除该区域的 `activeRoutes` 与授权；
5. 引擎第 6 步只让 `authorizedRegions` 中的区域按 `activeRoutes` 的 `next_hop_region_id` 进入走廊；
6. 引擎第 7 步只让“出口开放、容量可用、该区域路线指向该出口且 `next_hop=null`”的闸口区域完成；
7. `commitValidatedRoutes()` 只把已验证/延续的路线写入策略记忆，被拒绝的候选不会污染 V73/V74 的承诺状态。

因此，策略的每一个真实路线变化都会改变：哪个区域的人先进入哪条走廊、哪个出口被使用、队列在哪里积累、是否触发下游密度反压、最终完成多少人。

---

## 3. 路线切换来自真实记录

`route_switches` 只在以下条件同时成立时递增：

- 本 tick 决策为 `validated` 或 `degraded_continue`；
- 与上一次**已验证**路线相比，`exit_id` 或 `next_hop_region_id` 不同。

没有高斯噪声阈值计数，没有“抖动削减率”这类合成指标。`switched_persons` 是切换时刻该区域队列人数之和；`rerouted_persons_after_event` 只统计“旧路线被真实封控破坏、随后改用不同已验证路线”的区域，每个区域最多计一次。

---

## 4. 结果：策略是否真的不同

600 次运行（30 种子）的均值：

| 场景 | 指标 | STATIC | GREEDY | V73 | V74 |
| :--- | :--- | ---: | ---: | ---: | ---: |
| ST-02 | completed | 59,300 | 63,984.9 | 63,629.7 | 53,165.0 |
| ST-02 | unserved | 60,700 | 56,015.1 | 56,370.3 | 66,835.0 |
| ST-02 | max density | 1.391 | 1.975 | 1.720 | 2.461 |
| ST-02 | backpressure | 0 | 1.9 | 0.13 | 84.2 |
| ST-02 | route switches | 0 | 510.0 | 354.3 | 75.3 |
| ST-02 | rerouted persons | 0 | 34,529.9 | 31,191 | 31,191 |
| ST-04 | completed | 59,385 | 59,385 | 49,962 | 49,962 |
| ST-04 | unserved | 615 | 615 | 10,038 | 10,038 |
| ST-04 | route switches | 0 | 17.9 | 10.2 | 3.0 |
| ST-04 | rerouted persons | 0 | 15,570 | 15,570 | 15,570 |

关键配对比较（30 个种子，配对 bootstrap 95% CI + 符号翻转置换检验）：

| 比较 | 场景 | 指标 | 均值差 | 95% CI | p |
| :--- | :--- | :--- | ---: | :--- | ---: |
| GREEDY − STATIC | ST-02 | completed | +4,684.9 | [4,135.1, 5,148.4] | 0.0005 |
| GREEDY − STATIC | ST-02 | max density | +0.583 | [0.546, 0.619] | 0.0005 |
| GREEDY − STATIC | ST-02 | route switches | +510 | [494.0, 524.8] | 0.0005 |
| V73 − GREEDY | ST-02 | completed | −355.2 | [−1,300.8, 733.3] | 0.535 |
| V73 − GREEDY | ST-02 | max density | −0.255 | [−0.330, −0.173] | 0.0005 |
| V74 − V73 | ST-02 | completed | −10,464.8 | [−11,958.0, −9,084.9] | 0.0005 |
| V73 − GREEDY | ST-04 | completed | −9,423 | [−9,423, −9,423] | 0.0005 |
| V74 − V73 | ST-04 | completed | 0 | [0, 0] | 1.0 |

解释：

- ST-02 中贪心显著优于静态，但代价是更高的峰值密度和更多切换；
- V73 与贪心完成人数无显著差异（p=0.535），但峰值密度更低、切换更少；
- V74 在 ST-02 显著差于 V73 和贪心，说明承诺窗口在强封控/高拥塞下会压住必要的改派；
- ST-04 中静态/贪心完成人数相同，但贪心实际改派了 15,570 人；V73/V74 完成更少，说明“减少切换”不等于“提高吞吐”。

---

## 5. 独立性判定

- **可执行策略代码路径：4 个**（静态、贪心、V73、V74）；
- **独立算法机制：3 类**（静态冻结、贪心重算、稳定性/承诺族）；V73 与 V74 共用 `shouldUseCommitment` 与 `adaptiveSwitchPenalty`，是同一稳定性机制的两个配置；
- **行为上可区分**：ST-02、ST-04 中四种策略的完成人数/密度/切换显著不同；ST-01、ST-03、ST-05 中四种策略结果相同或几乎相同，不能声称“任何场景下都有算法优势”。

本轮因此只跑 **4×5×30 = 600** 次，而不是旧 V7.5 的 5×5×30 = 750 次。旧 V7.5 的 5 个标签实际只有一个 `planEvacuation` 规划器，V73 与 TIME_EXP 在 150/150 对记录中逐位相同；该 750 轮对比已永久撤回。

---

## 6. 限制

- 贪心是短视的：只看当前观测的费用，没有滚动时域/MPC 的显式预测；
- V73/V74 的稳定性参数来自既有配置，未在本轮重新调参；
- 策略分配是区域级聚合，不是个体级路线分配；
- ST-01/ST-03/ST-05 没有足够的拥堵/替代路径让策略产生差异，这是负面结果，不应包装成“全面优势”；
- 所有结论仅适用于当前合成场景与当前模型，不是现实世界的算法排名。
