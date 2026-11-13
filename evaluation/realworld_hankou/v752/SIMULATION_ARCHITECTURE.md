# V7.5.2 仿真架构 (SIMULATION_ARCHITECTURE)

**版本**: SkyGuard V7.5.2 — Simulation Integrity Remediation  
**分支**: `feat/v752-simulation-integrity`  
**基线提交**: `345f4d1660573c44de12ad26fa19136a6a5e9122`  
**日期**: 2026-11-11  
**性质**: 内部研究与证据复核，不是第三方认证。

---

## 1. 目标与非目标

本轮不是增加功能，而是修复仿真内核的有效性：

- 每个人口计数必须可对账：`completed + unserved = initial + inflow`，逐 tick 残差为 0；
- 规划器的路线决策必须真正进入运动学执行，而不是只写进报告；
- 策略和动态安全校验只能看到传感器观测，不能读取地面真值；
- 安全校验必须覆盖动态执行过程，而不只是初始方案；
- 压力场景必须真实触发封控、改派、排队或传感器降级。

非目标：不声称真实世界 0.1 m 精度、不声称 54 m 净宽、不声称 100% 人员安全、不声称已通过 AgentArts/昇腾/无人机实机验证。

---

## 2. 模块与职责

| 文件 | 职责 | 关键约束 |
| :--- | :--- | :--- |
| [`scenario.ts`](../../../scripts/simulation/v752/scenario.ts) | 读取基础几何与压力场景定义，校验区域/通道/出口引用 | 基础几何只读；压力参数单独文件 |
| [`types.ts`](../../../scripts/simulation/v752/types.ts) | 领域类型、四策略 ID、运行记录、逐 tick 账本 | `ObservedSnapshot` 与 `GroundTruthVault` 类型分离 |
| [`network.ts`](../../../scripts/simulation/v752/network.ts) | 有向图、容量、Dijkstra 最小费用路线 | `unknown` 通道不可用；双向通道共享容量 |
| [`sensors.ts`](../../../scripts/simulation/v752/sensors.ts) | 唯一读取地面真值的传感器流；噪声/延迟/缺失/冲突 | 每区域每 tick 固定 4 次随机抽样，公共随机数 |
| [`strategies.ts`](../../../scripts/simulation/v752/strategies.ts) | 四个真实路线决策代码路径 | 只接收 `ObservedSnapshot`，不接收 vault |
| [`safety.ts`](../../../scripts/simulation/v752/safety.ts) | 每控制 tick 的独立动态安全校验 | 观测可信度 + 权威事件状态 + 拓扑/容量/出口 |
| [`engine.ts`](../../../scripts/simulation/v752/engine.ts) | 整数质量守恒引擎、走廊/出口服务、账本 | 残差非 0 立即抛错；未授权路线不得移动 |
| [`generate-scenarios.ts`](../../../scripts/simulation/v752/generate-scenarios.ts) | 从基础几何生成 5 个合成压力场景 | 初始人数为测试参数，不是实测客流 |
| [`run-benchmark.ts`](../../../scripts/simulation/v752/run-benchmark.ts) | 4×5×30 = 600 次基准、统计、原始记录 | 所有 run 保留，不做挑选 |

---

## 3. 数据流

```text
data/scenarios/hankou-marshland-v752-base.json   (V7.5 几何副本, SHA-256 固定)
data/scenarios/hankou-v752-stress.json           (合成压力参数)
                    │
                    ▼
              loadScenarioSet()
                    │
                    ▼
        ┌───────────────────────────────┐
        │        runSimulation()        │
        │                               │
        │  GroundTruthVault             │
        │    regionQueue / pipelines    │
        │    corridorStatus / exitStatus│
        │            │                  │
        │            │ narrow view      │
        │            ▼                  │
        │      SensorStream             │
        │      (noise/delay/dropout)    │
        │            │                  │
        │            ▼                  │
        │      ObservedSnapshot         │
        │            │                  │
        │            ▼                  │
        │   Strategy (4 code paths)     │
        │            │ candidate routes │
        │            ▼                  │
        │   DynamicSafetyValidator      │
        │   (observed occupancy +       │
        │    authoritative incidents)   │
        │            │ validated routes │
        │            ▼                  │
        │   activeRoutes + authorized   │
        │            │                  │
        │            ▼                  │
        │   corridor movement / exits   │
        │            │                  │
        │            ▼                  │
        │   integer ledger + metrics    │
        └───────────────────────────────┘
```

关键点：`GroundTruthVault` 是 `engine.ts` 内部的私有类，不导出；唯一把它包装成 `SensorTruth` 的函数是 `asSensorTruth()`，只传给 `SensorStream.observe()`。策略函数签名只有 `(strategy, scenario, snapshot, memory, minute, config)`；安全校验输入只有 `ObservedSnapshot`、权威事件状态和候选路线，没有 `regionQueue` 访问器。

---

## 4. 控制循环顺序

每个 tick（`dt = 0.25 min`）：

1. **管道到达**：到达 `arriveTick` 的批次进入目标区域队列；
2. **事件生效**：按 `at_minute` 关闭/恢复真实通道与出口；reopen 按资产交集释放事件；
3. **外部流入**：整数信用累积，不产生小数人；
4. **传感器观测**：每 tick 采样，历史队列支持延迟；
5. **控制 tick（每 1.0 min）**：策略 → 动态安全校验 → 授权路线 → 决策日志 → 提交稳定性记忆；
6. **走廊运动**：区域队列按首段走廊容量、方向份额、场景容量折减、下游密度反压进入管道；
7. **出口边界服务**：仅当出口开放、容量可用、该区域有已验证出口路线且 `next_hop=null` 时完成；
8. **账本与指标**：计算 `present`、`expected`、`residual`；非 0 抛错；记录逐 tick 账本。

---

## 5. 质量守恒账本

```text
present(t)  = Σ 非闸口区域队列 + Σ 闸口区域队列 + Σ 在途批次人数
expected(t) = initial + cumulative_inflow - cumulative_exit_completions
residual(t) = expected(t) - present(t)          // 必须恒为 0
```

- 所有人数均为整数；流入、走廊容量、出口容量以“信用”累积，`floor` 后才产生人；
- 只有跨过出口边界的人才计入 `completed`；排队和在途都保留在 `present`；
- 仿真结束时 `unserved = present_final`，因此 `completed + unserved = initial + inflow`；
- 600/600 次运行、每次 240 个 tick，`residual` 全部为 0；无负队列。

详见 [MASS_CONSERVATION.md](MASS_CONSERVATION.md)。

---

## 6. 四个策略代码路径

| 策略 | 决策规则 | 是否每控制 tick 重算 | 代码路径 |
| :--- | :--- | :---: | :--- |
| `STATIC_SHORTEST_PATH` | 首个“全部区域观测可信”的控制 tick 冻结路线表 | 否 | 静态分支 |
| `GREEDY_DYNAMIC` | 每个控制 tick 重算最小费用路线 | 是 | 贪心分支 |
| `V73_STABILITY` | 候选路线 + 切换惩罚/迟滞，复用 `route-stability.ts` | 是 | `shouldUseCommitment(mode='switch_penalty')` |
| `V74_COMMITMENT` | V7.3 + 承诺窗口 + 风险释放，复用 `adaptiveSwitchPenalty` | 是 | `shouldUseCommitment(mode='adaptive')` |

四个策略都调用同一个 `network.ts` 路线求解器，但决策规则、记忆和切换条件不同；`V73/V74` 共用稳定性原语，是同一机制的两个配置，不是两个完全独立的算法范式。详见 [STRATEGY_INTEGRATION.md](STRATEGY_INTEGRATION.md)。

---

## 7. 传感器与安全边界

- 观测包含：计数、置信度、年龄、是否有效、provider、冲突标记、不可信原因；
- 可信条件：`count != null && valid && !conflict && confidence >= 0.6 && age <= 90s`；
- 低可信时：该区域不得发布新路线；若存在仍物理有效且已验证的旧路线，可 `degraded_continue`；否则 `reject`；
- 全局 `REJECT` 时：已验证但仍有物理有效旧路线的区域转为 `degraded_continue`，其余拒绝；
- 安全校验使用**权威事件状态**（已确认的封控命令/事件）判断通道与出口是否关闭；这是事件/命令馈送，不是人群计数真值。策略只看到带延迟的观测状态。

详见 [SENSOR_TRUST_BOUNDARY.md](SENSOR_TRUST_BOUNDARY.md) 与 [SAFETY_VALIDATION.md](SAFETY_VALIDATION.md)。

---

## 8. 确定性与公共随机数

- `SensorStream` 用 `mulberry32((seed * 2654435761) ^ 0x9e3779b9)`；
- 每区域每 tick 固定 4 次抽样（dropout、noise、conflict、conflict magnitude），与策略无关；
- 同一场景、同一 seed 下，四个策略看到同一组观测扰动（common random numbers）；
- 路线求解与安全校验均为确定性线性扫描 Dijkstra / 固定顺序遍历；
- `decision_log_hash` 与 `tick_ledger_hash` 不包含 `solve_ms`，因此可复现性检查不受运行时抖动影响。

---

## 9. 明确不建模的内容

- 没有个体 ID 或轨迹；人口是整数聚合计数；
- 没有随机需求到达（压力场景使用固定初始人口；外部流入仅由单元测试覆盖）；
- 没有真实摄像头/雷达数据、没有真实人群标定；
- 没有 3D 楼梯/竖向步行速度模型；
- 没有与真实 AgentArts/昇腾/无人机闭环的实机数据；
- GIS 分类为 **Geographically Anchored Estimated Scenario**，不是测绘成果。

这些限制在 [FINAL_REPORT.md](FINAL_REPORT.md) 与 [DATA_PROVENANCE.md](DATA_PROVENANCE.md) 中逐项列出。
