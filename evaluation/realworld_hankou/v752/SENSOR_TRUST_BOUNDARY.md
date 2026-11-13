# V7.5.2 传感器信任边界 (SENSOR_TRUST_BOUNDARY)

**结论**: 人群计数的地面真值只暴露给 `SensorStream`；策略与动态安全校验只接收 `ObservedSnapshot`。600/600 次运行中 `oracle_reads = 0`，没有策略或校验代码读取 `regionQueue`。ST-05 每次运行有 225 次区域级不可信观测（30 种子 × 4 策略共 27,000 次），全部触发 fail-closed 处理，没有把真值替换进观测。

---

## 1. 边界结构

[`engine.ts`](../../../scripts/simulation/v752/engine.ts) 中：

```ts
class GroundTruthVault {           // 私有，不导出
  regionQueue: Map<string, number>;
  pipelines: Map<string, PipelineBatch[]>;
  corridorStatus: Map<string, NetworkStatus>;
  exitStatus: Map<string, NetworkStatus>;
  regionOccupancy(regionId): number; // 只由 sensor adapter 调用
}

function asSensorTruth(vault): SensorTruth {
  return {
    get minute() { return vault.minute; },
    regionOccupancy: (id) => vault.regionOccupancy(id),
    corridorStatus: (id) => vault.corridorStatusOf(id),
    exitStatus: (id) => vault.exitStatusOf(id),
  };
}
```

- `GroundTruthVault` 没有导出；
- `asSensorTruth()` 只传给 `SensorStream.observe()`；
- `computeStrategyRoutes(strategy, scenario, snapshot, memory, minute, config)` 的参数表中没有 vault；
- `validateDynamicDecisions(input)` 的输入中没有 `regionQueue`，只有 `ObservedSnapshot`、权威事件状态、候选路线和上次已验证路线。

因此，策略层在类型和运行时都无法直接读取真实人数；`oracle_reads` 是这一结构约束的验收标记（不是运行时计数器，代码中不存在可调用的真值访问入口）。

---

## 2. 观测模型

每个 tick、每个区域，`SensorStream` 固定抽取 4 个随机数：

| 抽样 | 用途 |
| :--- | :--- |
| `uDropout` | 是否缺失（`count=null`） |
| `uNoise` | 相对噪声（正态逆 CDF） |
| `uConflict` | 是否多 provider 冲突 |
| `uConflictMagnitude` | 冲突时的放大系数 |

固定抽样次数保证同一 seed 下，四个策略面对完全相同的观测扰动（common random numbers）。

观测字段：

```text
region_id, count (number|null), confidence, age_seconds, valid,
source='simulation', provider, conflict, untrusted_reasons
```

可信条件（`safety.ts`）：

```text
count != null
&& valid
&& !conflict
&& confidence >= 0.6
&& age_seconds <= 90
```

不满足任一条件 → 该区域观测不可信。

---

## 3. 降级策略

ST-05 的传感器配置：

- S01/S03/S07 前缀区域在 **5–30 min** 降级；
- 降级期间：噪声 12%、偏置 +20%、缺失率 30%、冲突率 25%、置信度 0.42、延迟 2 min；
- 30 min 后恢复标称。

安全处理：

- 不可信区域**不得发布新路线**；
- 若存在上次已验证且当前物理有效的路线 → `degraded_continue`；
- 否则 → `rejected`，活动路线删除；
- 全局 `DEGRADED` 优先于 `REJECT`（四态优先级），不会在数据不可信时下“物理不可行”的结论。

ST-05 结果（30 种子，每策略 30 次）：

| 指标 | 数值 |
| :--- | ---: |
| 不可信观测（区域 × tick） | 225 / run |
| `degraded_continue` 决策 | 225 / run |
| 最终完成 | 45,000 / 45,000 |
| 最终未服务 | 0 |
| `oracle_reads` | 0 |
| `unvalidated_executions` | 0 |
| 最终状态 | NORMAL（30 min 恢复后） |

全部 120 次 ST-05 运行均满足上述账本与安全约束。

---

## 4. 权威事件状态不是人群 oracle

安全校验读取的 `corridorStatus` / `exitStatus` 来自引擎的**权威事件状态**：已确认的封控/恢复命令。它回答“这个通道/出口是否被命令关闭”，不回答“这个区域现在有多少人”。

- 策略看到的通道/出口状态是带 `delay_minutes` 的观测状态；
- 安全校验看到的是已确认事件状态，用于硬约束判定；
- 人群计数仍然只来自 `ObservedSnapshot`；
- 因此不存在“用真值人数替换观测”的旧 V7.5 ST-05 oracle 行为。

如果评审要求“连事件状态也必须来自传感器”，则需要额外的命令确认链路与延迟模型；本轮没有声称这一点。

---

## 5. 旧 V7.5 的 oracle 问题

V7.5.1 审计 P0-2 原文：

> V74：ST-05 用 `currentPops` 真值替换观测，confidence 0.92，再重新规划/校验；校验对象是初始 plan，不是 30 分钟仿真。

V7.5.2 已删除该路径：没有 `currentPops` 注入，没有“真值替换观测”，没有“只校验初始 plan”。600 次运行中 `oracle_reads=0`、`unvalidated_executions=0`。

---

## 6. 限制

- 传感器模型是合成的：噪声/延迟/缺失/冲突参数是测试参数，不是现场标定结果；
- 没有真实摄像头、雷达、Wi-Fi 探针或运营商数据；
- 通道/出口状态延迟使用同一个 `delay_minutes`，没有按资产类型分别标定；
- `source='simulation'`，provider 为 `camera_nominal` / `camera_degraded`，不是实际设备；
- 因此只能声称“在当前合成观测模型下，策略与校验不读取真值”，不能声称“真实传感器条件下已验证”。
