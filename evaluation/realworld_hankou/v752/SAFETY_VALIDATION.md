# V7.5.2 动态安全校验 (SAFETY_VALIDATION)

**结论**: 安全校验已从“初始方案一次性校验/硬编码/oracle”改为“每个控制 tick、每个区域、候选路线进入执行前的独立校验”。600/600 次运行中：`unvalidated_executions = 0`、`unknown_corridor_entries = 0`、`dangerous_route_publications = 0`、`oracle_reads = 0`。这不等于现实人员安全保证；它只说明当前合成样本中的约束校验结果。

---

## 1. 四态优先级

使用仓库现有 [`state-machine.ts`](../../../backend/src/services/safety/state-machine.ts)：

```text
DEGRADED > REJECT > REROUTE > NORMAL
```

- **DEGRADED**：感知不可信（缺失、冲突、低置信、过期、推理不健康）；
- **REJECT**：存在非过期硬违规；
- **REROUTE**：存在已确认事件，或方案版本失效但仍有可行替代；
- **NORMAL**：无事件、无违规、观测可信。

V7.5.2 不重写状态机，只把动态校验结果接入 `decideSafetyState()`。

---

## 2. 每个控制 tick 的检查

[`safety.ts`](../../../scripts/simulation/v752/safety.ts) 对每个区域：

1. **观测可信度**：`count != null && valid && !conflict && confidence >= 0.6 && age <= 90s`；
2. **通道存在性**：路线引用的通道必须存在；
3. **通道状态**：`closed` → 硬违规；`unknown` 或容量 `null/<=0` → 硬违规；
4. **出口存在性/状态/容量**：同上；
5. **危险目的地密度**：路线经过区域的观测密度 `>= rhoJam * 1.5`（6.75 人/m²）→ 硬违规；
6. **路径可信度**：路线经过任何不可信区域 → 拒绝新路线；
7. **状态机**：汇总违规、事件、观测可信度，得到全局四态。

### 失败关闭规则

| 情况 | 决策 |
| :--- | :--- |
| 观测不可信，且有物理有效的上次已验证路线 | `degraded_continue`（继续旧路线，不发布新路线） |
| 观测不可信，且无有效旧路线 | `rejected`（路线置空） |
| 候选路线硬违规 | `rejected`（路线置空） |
| 全局 `REJECT`，区域有物理有效旧路线 | `degraded_continue` |
| 全局 `REJECT`，区域无有效旧路线 | `rejected` |
| 候选路线无，且旧路线物理有效 | `degraded_continue` |
| 候选路线无，且旧路线物理无效 | `no_route` |

关键点：`degraded_continue` 只允许“上次已验证且当前物理有效”的路线；不是“随便保留一条旧路线”。

---

## 3. 执行层强制

引擎不接受“策略说可以”作为执行依据：

- `activeRoutes` 只在 `validated` / `degraded_continue` 且带路线时写入；
- `authorizedRegions` 是运动与出口服务的硬门；
- `rejected` / `no_route` 立即删除 `activeRoutes` 与授权；
- 走廊运动检查真实 `vault.corridorStatus`；封闭通道不进入；
- 出口服务检查真实 `vault.exitStatus` 与容量；
- 若存在活动路线但区域未授权，`unvalidated_executions += 1` 并拒绝移动。

因此“安全校验通过”不是报告字段，而是执行的必要条件。

---

## 4. 600 次运行结果

| 检查项 | 结果 |
| :--- | :--- |
| 运行数 | 600 |
| `unvalidated_executions = 0` | 600/600 |
| `unknown_corridor_entries = 0` | 600/600 |
| `dangerous_route_publications = 0` | 600/600 |
| `oracle_reads = 0` | 600/600 |
| `mass_balance_ok` | 600/600 |
| 负区域/出口队列 | 0 |

### ST-04（真实封控）

| 策略 | 封闭通道尝试 | 封闭出口尝试 | 拒绝决策 | 物理层非法进入 |
| :--- | ---: | ---: | ---: | ---: |
| STATIC | 165 | 60 | 210 | 0 |
| GREEDY | 11 | 4 | 14 | 0 |
| V73 | 11 | 4 | 14 | 0 |
| V74 | 11 | 4 | 14 | 0 |

静态策略的冻结路线在 t=5 封控后仍指向封闭的 11 条 L3→L2 通道和 G07，安全校验连续 15 个控制 tick 拒绝；贪心在 1 个 tick 的观测延迟后改派。`physical_closure_blocks = 0` 并不表示“没有人想走封闭通道”，而是表示**没有任何非法路线被授权进入物理层**；尝试被阻止在发布/授权阶段。这一点必须按“发布层阻断”表述，不能写成“物理层拦住了多少人”。

### ST-05（传感器降级）

| 指标 | 数值 |
| :--- | ---: |
| 不可信观测 | 225 / run |
| `degraded_continue` 决策 | 225 / run |
| `rejected` 决策 | 0 |
| 最终完成 | 45,000 / 45,000 |
| `unvalidated_executions` | 0 |

ST-05 中降级区域在 5 min 前已有已验证路线，因此 5–30 min 全部走 `degraded_continue`；没有新路线被发布。这是 fail-closed 的“继续最后已验证路线”，不是“用坏数据重新规划”。

### ST-02（出口封控）

| 策略 | 封闭出口尝试 | 拒绝决策 | 改派人数 |
| :--- | ---: | ---: | ---: |
| STATIC | 1,540 | 1,540 | 0 |
| GREEDY | 28 | 32 | 32,679 |
| V73 | 28 | 28 | 31,191 |
| V74 | 28 | 28 | 31,191 |

静态策略在 t=5 关闭 7 个辅助闸口后，28 个区域的冻结路线持续指向封闭出口，55 个控制 tick 共 1,540 次发布层拒绝；贪心在 1 个 tick 的观测延迟后改派。这里 `closed_corridor_attempts = 0`、`closed_exit_attempts > 0`，口径已拆分，不再把出口尝试误记为通道尝试。

---

## 5. 与旧 V7.5 的区别

V7.5.1 审计 P0-2 结论：

- STATIC：`validatorPassed = scenario_id === 'ST-01'`；
- DYNAMIC：`ST-01 || ST-02`；
- TIME_EXP/V73：`!is_sensor_degraded && baseValResult.valid`；
- V74：ST-05 用 `currentPops` 真值替换观测；
- 校验对象是初始 plan，不是 30 分钟仿真。

V7.5.2 已不存在这些分支：没有硬编码 `validatorPassed`，没有 `currentPops` 注入，没有只校验初始方案；每个控制 tick 都重新校验，执行层强制授权。

---

## 6. 限制与禁止表述

- 这是**仿真内的约束校验**，不是现实世界的安全认证；
- 没有冗余传感器、独立硬件通道、人工复核延迟、通信中断等真实安全链；
- 没有真实人群行为、跌倒、逆行、恐慌等模型；
- 不能写“100% 人员安全”“绝对安全”“已通过第三方安全认证”；
- 只能写“在当前 600 次合成运行中，所有被执行的路线均通过当前约束校验，未发现未授权执行/未知通道进入/危险路线发布”。
