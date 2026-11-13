# V7.4 稳定性—效率 Pareto 实验（A-F）

> 运行 ID：`v74-stability-dev`。**合成场景 + 合成入流**；30 种子 × 8 场景 × 6 策略。
> 不得表述为真实场馆效果。

## 1. 策略

| 代号 | 策略 | 稳定性 |
| --- | --- | --- |
| A | legacy_static | 一次规划 |
| B | mpc_standard | 无 |
| C | mpc_adaptive_v73 | V7.3 自适应（无执行门控） |
| D | mpc_risk_adaptive | 风险敏感惩罚（riskDiscount 0.9） |
| E | mpc_emergency_release | 高风险自动释放承诺（阈值 0.5） |
| F | mpc_pareto_gate | 执行门控 + 承诺份额 Pareto（1min/2000人·min） |

## 2. 总体结果

| 策略 | 未疏散 | 完成时间 | 队列人·分钟 | 最大密度 | 切换人数 | 振荡人数 | 容量冲突 | 安全违规 | 求解(ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 953.0417 | 19.625 | 61141.8167 | 1.9515 | 0 | 0 | 0.8042 | 1.8042 | 0.4875 |
| mpc_standard | 16.4708 | 9.9167 | 20030.3625 | 2.1453 | 3820.7542 | 571.8875 | 0 | 0.0542 | 8.9625 |
| mpc_adaptive_v73 | 0 | 10.8792 | 23998.6083 | 2.4409 | 1369.0083 | 93.35 | 0 | 0 | 16.0917 |
| mpc_risk_adaptive | 0 | 10.8792 | 23998.6083 | 2.4409 | 1369.0083 | 93.35 | 0 | 0 | 16.0875 |
| mpc_emergency_release | 2.8667 | 10.325 | 20454.3083 | 2.1462 | 3497.9292 | 467.1167 | 0 | 0.0083 | 10.175 |
| mpc_pareto_gate | 3.8125 | 10.4917 | 20892.2833 | 2.1856 | 1837.6625 | 136.075 | 0 | 0.0125 | 41.3125 |

> 求解耗时为单机测量，存在 ±1–2ms 波动。

## 3. 分场景结果

### baseline_surge

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 761.0667 | 19 | 57347.0333 | 0 | 0 | 0 | 1 |
| mpc_standard | 0 | 9.2667 | 19485.7667 | 3612.6667 | 549.7333 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 10.3667 | 23386.9 | 914.7333 | 28.0667 | 0 | 0 |
| mpc_risk_adaptive | 0 | 10.3667 | 23386.9 | 914.7333 | 28.0667 | 0 | 0 |
| mpc_emergency_release | 0 | 9.7333 | 19983.1667 | 3289.5667 | 419.0667 | 0 | 0 |
| mpc_pareto_gate | 0 | 9.6 | 20380.1667 | 1377.9333 | 104.4667 | 0 | 0 |

### exit_failure

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 731.6333 | 19 | 53993.5333 | 0 | 0 | 0 | 1 |
| mpc_standard | 0 | 11.2333 | 22115.3 | 4700.8 | 965.6667 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 12.2 | 26466.6667 | 1901.0667 | 121.8 | 0 | 0 |
| mpc_risk_adaptive | 0 | 12.2 | 26466.6667 | 1901.0667 | 121.8 | 0 | 0 |
| mpc_emergency_release | 0 | 11.6 | 22323.0333 | 4371.3333 | 821.2333 | 0 | 0 |
| mpc_pareto_gate | 0 | 12.2667 | 23234.5 | 2049 | 133.8667 | 0 | 0 |

### corridor_closure

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 743.9667 | 19 | 56676.7 | 0 | 0 | 0 | 1 |
| mpc_standard | 0 | 9.1333 | 18827.3667 | 3517.9667 | 483.7333 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 10.1667 | 24121.0667 | 768.4333 | 71.6667 | 0 | 0 |
| mpc_risk_adaptive | 0 | 10.1667 | 24121.0667 | 768.4333 | 71.6667 | 0 | 0 |
| mpc_emergency_release | 0 | 9.6 | 19322.6333 | 3069.2667 | 324.2333 | 0 | 0 |
| mpc_pareto_gate | 0 | 9.5667 | 19548.0333 | 1424.3333 | 63.2 | 0 | 0 |

### bidirectional_stress

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 839.1333 | 19 | 58131.3 | 0 | 0 | 0 | 1 |
| mpc_standard | 0 | 9.1667 | 18388.4 | 3222.5667 | 451.4333 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 10.1667 | 22520.3333 | 634.0333 | 0 | 0 | 0 |
| mpc_risk_adaptive | 0 | 10.1667 | 22520.3333 | 634.0333 | 0 | 0 | 0 |
| mpc_emergency_release | 0 | 9.6667 | 18784 | 2901.6 | 345.8 | 0 | 0 |
| mpc_pareto_gate | 0 | 9.8333 | 19200.8 | 1122.1667 | 0 | 0 | 0 |

### multi_zone_surge

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 1201.1 | 19 | 66185.1667 | 0 | 0 | 0 | 1 |
| mpc_standard | 0 | 9.6333 | 20521.2 | 3802.9667 | 525.3 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 10.7667 | 25066.3 | 783.4667 | 21.0667 | 0 | 0 |
| mpc_risk_adaptive | 0 | 10.7667 | 25066.3 | 783.4667 | 21.0667 | 0 | 0 |
| mpc_emergency_release | 0 | 9.8333 | 20865.1 | 3600.3 | 453 | 0 | 0 |
| mpc_pareto_gate | 0 | 10.2333 | 21769.3333 | 1395.1 | 117.7 | 0 | 0 |

### midrun_exit_failure

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 759.4333 | 19 | 57151.5667 | 0 | 0 | 0 | 1 |
| mpc_standard | 0 | 10.4 | 19121.9667 | 4745.9667 | 525.8 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 11.4667 | 23280.5667 | 1724.3 | 0 | 0 | 0 |
| mpc_risk_adaptive | 0 | 11.4667 | 23280.5667 | 1724.3 | 0 | 0 | 0 |
| mpc_emergency_release | 0 | 10.7 | 19523.2667 | 4219.6333 | 461.6333 | 0 | 0 |
| mpc_pareto_gate | 0 | 11.0667 | 20124.7667 | 2334.9667 | 93.5 | 0 | 0 |

### dynamic_capacity

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 781.0333 | 24 | 63174.4667 | 0 | 0 | 6.4333 | 7.4333 |
| mpc_standard | 0 | 9.6667 | 20035.1 | 3225.9667 | 472 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 10 | 20257.4667 | 3072.9333 | 438.6333 | 0 | 0 |
| mpc_risk_adaptive | 0 | 10 | 20257.4667 | 3072.9333 | 438.6333 | 0 | 0 |
| mpc_emergency_release | 0 | 9.9667 | 20201.4333 | 3081.0333 | 438.6333 | 0 | 0 |
| mpc_pareto_gate | 0 | 9.9 | 20170.4 | 3124.3667 | 439.3 | 0 | 0 |

### oscillation_stress

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 1806.9667 | 19 | 76474.7667 | 0 | 0 | 0 | 1 |
| mpc_standard | 131.7667 | 10.8333 | 21747.8 | 3737.1333 | 601.4333 | 0 | 0.4333 |
| mpc_adaptive_v73 | 0 | 11.9 | 26889.5667 | 1153.1 | 65.5667 | 0 | 0 |
| mpc_risk_adaptive | 0 | 11.9 | 26889.5667 | 1153.1 | 65.5667 | 0 | 0 |
| mpc_emergency_release | 22.9333 | 11.5 | 22631.8333 | 3450.7 | 473.3333 | 0 | 0.0667 |
| mpc_pareto_gate | 30.5 | 11.4667 | 22710.2667 | 1873.4333 | 136.5667 | 0 | 0.1 |

## 4. 配对比较（vs B）

| 指标 | 对照 | 平均差 [95% CI] | d_z | Holm p | 显著 |
| --- | --- | --- | --- | --- | --- |
| unserved | legacy_static | 936.5708 [889.5154, 983.6262] | 2.5181 | 0 | 是 |
| unserved | mpc_adaptive_v73 | -16.4708 [-25.4272, -7.5144] | -0.2327 | 0.001252 | 是 |
| unserved | mpc_risk_adaptive | -16.4708 [-25.4272, -7.5144] | -0.2327 | 0.001252 | 是 |
| unserved | mpc_emergency_release | -13.6042 [-21.6947, -5.5137] | -0.2127 | 0.001963 | 是 |
| unserved | mpc_pareto_gate | -12.6583 [-20.5607, -4.756] | -0.2027 | 0.001963 | 是 |
| makespan | legacy_static | 9.7083 [9.454, 9.9626] | 4.83 | 0 | 是 |
| makespan | mpc_adaptive_v73 | 0.9625 [0.8697, 1.0553] | 1.3118 | 0 | 是 |
| makespan | mpc_risk_adaptive | 0.9625 [0.8697, 1.0553] | 1.3118 | 0 | 是 |
| makespan | mpc_emergency_release | 0.4083 [0.3361, 0.4806] | 0.7148 | 0 | 是 |
| makespan | mpc_pareto_gate | 0.575 [0.4866, 0.6634] | 0.823 | 0 | 是 |
| queue_person_minutes | legacy_static | 41111.4542 [40171.4939, 42051.4145] | 5.5335 | 0 | 是 |
| queue_person_minutes | mpc_adaptive_v73 | 3968.2458 [3646.0792, 4290.4124] | 1.5584 | 0 | 是 |
| queue_person_minutes | mpc_risk_adaptive | 3968.2458 [3646.0792, 4290.4124] | 1.5584 | 0 | 是 |
| queue_person_minutes | mpc_emergency_release | 423.9458 [352.1543, 495.7374] | 0.7471 | 0 | 是 |
| queue_person_minutes | mpc_pareto_gate | 861.9208 [742.3256, 981.516] | 0.9118 | 0 | 是 |
| max_density | legacy_static | -0.1938 [-0.2269, -0.1606] | -0.7388 | 0 | 是 |
| max_density | mpc_adaptive_v73 | 0.2956 [0.2476, 0.3436] | 0.7789 | 0 | 是 |
| max_density | mpc_risk_adaptive | 0.2956 [0.2476, 0.3436] | 0.7789 | 0 | 是 |
| max_density | mpc_emergency_release | 0.0009 [-0.0009, 0.0028] | 0.0645 | 0.317311 | 否 |
| max_density | mpc_pareto_gate | 0.0403 [0.0205, 0.0601] | 0.2571 | 0.000136 | 是 |
| worst_risk_ratio | legacy_static | -0.0677 [-0.0846, -0.0507] | -0.5043 | 0 | 是 |
| worst_risk_ratio | mpc_adaptive_v73 | 0.0068 [0.0017, 0.0118] | 0.1704 | 0.033191 | 是 |
| worst_risk_ratio | mpc_risk_adaptive | 0.0068 [0.0017, 0.0118] | 0.1704 | 0.033191 | 是 |
| worst_risk_ratio | mpc_emergency_release | 0 [0, 0] | 0 | 1 | 否 |
| worst_risk_ratio | mpc_pareto_gate | 0.0004 [-0.0015, 0.0022] | 0.0245 | 1 | 否 |
| switch_persons | legacy_static | -3820.7542 [-3991.8472, -3649.6612] | -2.8253 | 0 | 是 |
| switch_persons | mpc_adaptive_v73 | -2451.7458 [-2646.5709, -2256.9208] | -1.5921 | 0 | 是 |
| switch_persons | mpc_risk_adaptive | -2451.7458 [-2646.5709, -2256.9208] | -1.5921 | 0 | 是 |
| switch_persons | mpc_emergency_release | -322.825 [-379.0384, -266.6116] | -0.7266 | 0 | 是 |
| switch_persons | mpc_pareto_gate | -1983.0917 [-2168.4757, -1797.7076] | -1.3534 | 0 | 是 |
| oscillation_persons | legacy_static | -571.8875 [-643.8713, -499.9037] | -1.0051 | 0 | 是 |
| oscillation_persons | mpc_adaptive_v73 | -478.5375 [-550.2303, -406.8447] | -0.8445 | 0 | 是 |
| oscillation_persons | mpc_risk_adaptive | -478.5375 [-550.2303, -406.8447] | -0.8445 | 0 | 是 |
| oscillation_persons | mpc_emergency_release | -104.7708 [-130.6544, -78.8872] | -0.5121 | 0 | 是 |
| oscillation_persons | mpc_pareto_gate | -435.8125 [-513.8213, -357.8037] | -0.7068 | 0 | 是 |
| capacity_violations | legacy_static | 0.8042 [0.5335, 1.0748] | 0.3759 | 0 | 是 |
| capacity_violations | mpc_adaptive_v73 | 0 [0, 0] | 0 | 1 | 否 |
| capacity_violations | mpc_risk_adaptive | 0 [0, 0] | 0 | 1 | 否 |
| capacity_violations | mpc_emergency_release | 0 [0, 0] | 0 | 1 | 否 |
| capacity_violations | mpc_pareto_gate | 0 [0, 0] | 0 | 1 | 否 |
| safety_violations | legacy_static | 1.75 [1.4753, 2.0247] | 0.8059 | 0 | 是 |
| safety_violations | mpc_adaptive_v73 | -0.0542 [-0.0829, -0.0255] | -0.2388 | 0.000864 | 是 |
| safety_violations | mpc_risk_adaptive | -0.0542 [-0.0829, -0.0255] | -0.2388 | 0.000864 | 是 |
| safety_violations | mpc_emergency_release | -0.0458 [-0.0723, -0.0193] | -0.2187 | 0.001407 | 是 |
| safety_violations | mpc_pareto_gate | -0.0417 [-0.067, -0.0163] | -0.2081 | 0.001407 | 是 |
| solve_ms | legacy_static | -8.475 [-8.8052, -8.1448] | -3.2474 | 0 | 是 |
| solve_ms | mpc_adaptive_v73 | 7.1292 [6.311, 7.9473] | 1.1024 | 0 | 是 |
| solve_ms | mpc_risk_adaptive | 7.125 [6.2906, 7.9594] | 1.0803 | 0 | 是 |
| solve_ms | mpc_emergency_release | 1.2125 [0.8573, 1.5677] | 0.4318 | 0 | 是 |
| solve_ms | mpc_pareto_gate | 32.35 [30.556, 34.144] | 2.2814 | 0 | 是 |

## 5. 机理

- **自适应 F 是否降低振荡？** 相对 E 的振荡事件/人数差见 `mechanism.oscillation_gain_adaptive_vs_commitment`；
- **动态容量下是否安全？** 见 `dynamic_capacity`：容量冲突、安全违规、未疏散、完成时间；
- **运行中出口故障？** 见 `midrun_safety`：紧急覆盖、未疏散、安全违规；
- **切换代价？** 见第 4 节 switch_persons / makespan / queue 的配对差。

## 6. 边界

- 合成场景、未标定 BPR/服务衰减/动态容量因子；
- 自适应惩罚与权重是启发式，不是最优控制；
- 安全违规 = 容量冲突 + 未疏散标记，不是独立 Validator 的完整结论；
- 负向/混合结果保留在 rows/summary，不得只引用有利指标。
