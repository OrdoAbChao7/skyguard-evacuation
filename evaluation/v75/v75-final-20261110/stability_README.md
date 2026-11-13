# V7.5 稳定性—效率 Pareto 实验（A-F）

> 运行 ID：`v75-final-20261110`。**合成场景 + 合成入流**；30 种子 × 8 场景 × 6 策略。
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
| legacy_static | 953.0417 | 19.625 | 61141.8167 | 1.9515 | 0 | 0 | 0.8042 | 1.8042 | 0.5375 |
| mpc_standard | 16.4708 | 9.9167 | 20030.3625 | 2.1453 | 3820.7542 | 571.8875 | 0 | 0.0542 | 9.0208 |
| mpc_global_commitment | 0 | 10.5917 | 23714.4958 | 2.4409 | 1561.1375 | 133.35 | 0 | 0 | 16.0375 |
| mpc_adaptive_v73 | 0 | 10.8792 | 23998.6083 | 2.4409 | 1369.0083 | 93.35 | 0 | 0 | 16.0458 |
| mpc_region_selective | 0 | 10.975 | 23904.6125 | 2.4677 | 1623.6958 | 92.3375 | 0 | 0 | 16.6583 |
| mpc_risk_adaptive_commit | 2.8667 | 10.5792 | 21214.175 | 2.1577 | 3100.6583 | 345.7125 | 0 | 0.0083 | 11.1542 |
| mpc_capacity_aware | 13.7375 | 10.1125 | 20004.075 | 2.1464 | 3757.55 | 524.0708 | 0 | 0.0458 | 12.3667 |
| mpc_emergency_release | 2.8667 | 10.25 | 20383.4 | 2.1462 | 3577.6042 | 482.8667 | 0 | 0.0083 | 9.7875 |
| mpc_emergency_recovery | 0 | 10.5917 | 22820.3792 | 2.3394 | 2214.4458 | 252.875 | 0 | 0 | 13.5417 |
| mpc_pareto_gate | 3.8125 | 10.4917 | 20892.2833 | 2.1856 | 1837.6625 | 136.075 | 0 | 0.0125 | 40.9667 |

> 求解耗时为单机测量，存在 ±1–2ms 波动。

## 3. 分场景结果

### baseline_surge

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 761.0667 | 19 | 57347.0333 | 0 | 0 | 0 | 1 |
| mpc_standard | 0 | 9.2667 | 19485.7667 | 3612.6667 | 549.7333 | 0 | 0 |
| mpc_global_commitment | 0 | 9.7333 | 22881.3667 | 1274.7333 | 113.1667 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 10.3667 | 23386.9 | 914.7333 | 28.0667 | 0 | 0 |
| mpc_region_selective | 0 | 10.3333 | 23446.3333 | 1208.6 | 60.1 | 0 | 0 |
| mpc_risk_adaptive_commit | 0 | 9.8333 | 20672.3333 | 2885.1 | 364.3 | 0 | 0 |
| mpc_capacity_aware | 0 | 9.4333 | 19459.9 | 3301.4 | 395.7667 | 0 | 0 |
| mpc_emergency_release | 0 | 9.7 | 19983.5333 | 3295.5667 | 419.0667 | 0 | 0 |
| mpc_emergency_recovery | 0 | 10.0333 | 22199.1333 | 1743.3333 | 196.3333 | 0 | 0 |
| mpc_pareto_gate | 0 | 9.6 | 20380.1667 | 1377.9333 | 104.4667 | 0 | 0 |

### exit_failure

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 731.6333 | 19 | 53993.5333 | 0 | 0 | 0 | 1 |
| mpc_standard | 0 | 11.2333 | 22115.3 | 4700.8 | 965.6667 | 0 | 0 |
| mpc_global_commitment | 0 | 12.1 | 26348.1 | 2007.7667 | 121.8 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 12.2 | 26466.6667 | 1901.0667 | 121.8 | 0 | 0 |
| mpc_region_selective | 0 | 12.3667 | 26090.8333 | 2309.7667 | 125.4 | 0 | 0 |
| mpc_risk_adaptive_commit | 0 | 12.1 | 23157.3667 | 3768.5333 | 619.8333 | 0 | 0 |
| mpc_capacity_aware | 0 | 11.5 | 22058.2667 | 4594.7333 | 883.5 | 0 | 0 |
| mpc_emergency_release | 0 | 11.5333 | 22310.0333 | 4387.5 | 837.4 | 0 | 0 |
| mpc_emergency_recovery | 0 | 12.0333 | 24648.8 | 3032.4 | 346.9667 | 0 | 0 |
| mpc_pareto_gate | 0 | 12.2667 | 23234.5 | 2049 | 133.8667 | 0 | 0 |

### corridor_closure

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 743.9667 | 19 | 56676.7 | 0 | 0 | 0 | 1 |
| mpc_standard | 0 | 9.1333 | 18827.3667 | 3517.9667 | 483.7333 | 0 | 0 |
| mpc_global_commitment | 0 | 9.8667 | 23828.8333 | 1012.1667 | 160.2667 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 10.1667 | 24121.0667 | 768.4333 | 71.6667 | 0 | 0 |
| mpc_region_selective | 0 | 10.4333 | 24448.4333 | 796.2667 | 52.9333 | 0 | 0 |
| mpc_risk_adaptive_commit | 0 | 9.8 | 20507.7667 | 2544.3 | 275.6 | 0 | 0 |
| mpc_capacity_aware | 0 | 9.5 | 18795.3 | 3241.7333 | 349.9667 | 0 | 0 |
| mpc_emergency_release | 0 | 9.4667 | 19254.0667 | 3153.9667 | 349 | 0 | 0 |
| mpc_emergency_recovery | 0 | 9.8667 | 22618.7333 | 1517 | 177 | 0 | 0 |
| mpc_pareto_gate | 0 | 9.5667 | 19548.0333 | 1424.3333 | 63.2 | 0 | 0 |

### bidirectional_stress

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 839.1333 | 19 | 58131.3 | 0 | 0 | 0 | 1 |
| mpc_standard | 0 | 9.1667 | 18388.4 | 3222.5667 | 451.4333 | 0 | 0 |
| mpc_global_commitment | 0 | 9.8 | 22379.5 | 649.6333 | 37.2 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 10.1667 | 22520.3333 | 634.0333 | 0 | 0 | 0 |
| mpc_region_selective | 0 | 10.3 | 22616.1667 | 860.5333 | 37.6 | 0 | 0 |
| mpc_risk_adaptive_commit | 0 | 10.1333 | 19728.3 | 2637.3667 | 234.1333 | 0 | 0 |
| mpc_capacity_aware | 0 | 9.3667 | 18392.4333 | 3209.1333 | 443.1 | 0 | 0 |
| mpc_emergency_release | 0 | 9.6333 | 18751.2 | 2906.1 | 350.3 | 0 | 0 |
| mpc_emergency_recovery | 0 | 10.1 | 22160.8333 | 1261.9667 | 149.2 | 0 | 0 |
| mpc_pareto_gate | 0 | 9.8333 | 19200.8 | 1122.1667 | 0 | 0 | 0 |

### multi_zone_surge

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 1201.1 | 19 | 66185.1667 | 0 | 0 | 0 | 1 |
| mpc_standard | 0 | 9.6333 | 20521.2 | 3802.9667 | 525.3 | 0 | 0 |
| mpc_global_commitment | 0 | 10.3 | 24582.4333 | 1075.1667 | 36.4333 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 10.7667 | 25066.3 | 783.4667 | 21.0667 | 0 | 0 |
| mpc_region_selective | 0 | 10.9 | 24769 | 1166.4333 | 4.4 | 0 | 0 |
| mpc_risk_adaptive_commit | 0 | 10.2 | 21672.8333 | 3138.9333 | 328.5 | 0 | 0 |
| mpc_capacity_aware | 0 | 9.7667 | 20497.2333 | 3834.3333 | 583.6333 | 0 | 0 |
| mpc_emergency_release | 0 | 9.8 | 20788.6667 | 3630.9333 | 471.0333 | 0 | 0 |
| mpc_emergency_recovery | 0 | 10.3333 | 23503.5 | 1784.1333 | 200.4 | 0 | 0 |
| mpc_pareto_gate | 0 | 10.2333 | 21769.3333 | 1395.1 | 117.7 | 0 | 0 |

### midrun_exit_failure

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 759.4333 | 19 | 57151.5667 | 0 | 0 | 0 | 1 |
| mpc_standard | 0 | 10.4 | 19121.9667 | 4745.9667 | 525.8 | 0 | 0 |
| mpc_global_commitment | 0 | 11.4333 | 23239.8333 | 1724.3 | 0 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 11.4667 | 23280.5667 | 1724.3 | 0 | 0 | 0 |
| mpc_region_selective | 0 | 11.2667 | 22958.6667 | 2134.8667 | 0 | 0 | 0 |
| mpc_risk_adaptive_commit | 0 | 10.9667 | 19984.6 | 3644.1333 | 296.3667 | 0 | 0 |
| mpc_capacity_aware | 0 | 10.5 | 19067.7667 | 4732.2667 | 510.5 | 0 | 0 |
| mpc_emergency_release | 0 | 10.4 | 19140.6333 | 4715.0333 | 524.1667 | 0 | 0 |
| mpc_emergency_recovery | 0 | 10.4 | 20491.1 | 4003.2333 | 394.3333 | 0 | 0 |
| mpc_pareto_gate | 0 | 11.0667 | 20124.7667 | 2334.9667 | 93.5 | 0 | 0 |

### dynamic_capacity

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 781.0333 | 24 | 63174.4667 | 0 | 0 | 6.4333 | 7.4333 |
| mpc_standard | 0 | 9.6667 | 20035.1 | 3225.9667 | 472 | 0 | 0 |
| mpc_global_commitment | 0 | 9.8667 | 20261.4333 | 3111.5333 | 463.2333 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 10 | 20257.4667 | 3072.9333 | 438.6333 | 0 | 0 |
| mpc_region_selective | 0 | 10 | 20257.4667 | 3072.9333 | 438.6333 | 0 | 0 |
| mpc_risk_adaptive_commit | 0 | 10 | 20257.4667 | 3072.9333 | 438.6333 | 0 | 0 |
| mpc_capacity_aware | 0 | 9.9 | 20029.1667 | 3180.9 | 448 | 0 | 0 |
| mpc_emergency_release | 0 | 9.9667 | 20207.2333 | 3081.0333 | 438.6333 | 0 | 0 |
| mpc_emergency_recovery | 0 | 10 | 20263.2667 | 3072.9333 | 438.6333 | 0 | 0 |
| mpc_pareto_gate | 0 | 9.9 | 20170.4 | 3124.3667 | 439.3 | 0 | 0 |

### oscillation_stress

| 策略 | 未疏散 | 完成时间 | 队列 | 切换 | 振荡人数 | 容量冲突 | 安全违规 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy_static | 1806.9667 | 19 | 76474.7667 | 0 | 0 | 0 | 1 |
| mpc_standard | 131.7667 | 10.8333 | 21747.8 | 3737.1333 | 601.4333 | 0 | 0.4333 |
| mpc_global_commitment | 0 | 11.6333 | 26194.4667 | 1633.8 | 134.7 | 0 | 0 |
| mpc_adaptive_v73 | 0 | 11.9 | 26889.5667 | 1153.1 | 65.5667 | 0 | 0 |
| mpc_region_selective | 0 | 12.2 | 26650 | 1440.1667 | 19.6333 | 0 | 0 |
| mpc_risk_adaptive_commit | 22.9333 | 11.6 | 23732.7333 | 3113.9667 | 208.3333 | 0 | 0.0667 |
| mpc_capacity_aware | 109.9 | 10.9333 | 21732.5333 | 3965.9 | 578.1 | 0 | 0.3667 |
| mpc_emergency_release | 22.9333 | 11.5 | 22631.8333 | 3450.7 | 473.3333 | 0 | 0.0667 |
| mpc_emergency_recovery | 0 | 11.9667 | 26677.6667 | 1300.5667 | 120.1333 | 0 | 0 |
| mpc_pareto_gate | 30.5 | 11.4667 | 22710.2667 | 1873.4333 | 136.5667 | 0 | 0.1 |

## 4. 配对比较（vs B）

| 指标 | 对照 | 平均差 [95% CI] | d_z | Holm p | 显著 |
| --- | --- | --- | --- | --- | --- |
| unserved | legacy_static | 936.5708 [889.5154, 983.6262] | 2.5181 | 0 | 是 |
| unserved | mpc_global_commitment | -16.4708 [-25.4272, -7.5144] | -0.2327 | 0.002503 | 是 |
| unserved | mpc_adaptive_v73 | -16.4708 [-25.4272, -7.5144] | -0.2327 | 0.002503 | 是 |
| unserved | mpc_region_selective | -16.4708 [-25.4272, -7.5144] | -0.2327 | 0.002503 | 是 |
| unserved | mpc_risk_adaptive_commit | -13.6042 [-21.6947, -5.5137] | -0.2127 | 0.003927 | 是 |
| unserved | mpc_capacity_aware | -2.7333 [-6.5833, 1.1166] | -0.0898 | 0.164064 | 否 |
| unserved | mpc_emergency_release | -13.6042 [-21.6947, -5.5137] | -0.2127 | 0.003927 | 是 |
| unserved | mpc_emergency_recovery | -16.4708 [-25.4272, -7.5144] | -0.2327 | 0.002503 | 是 |
| unserved | mpc_pareto_gate | -12.6583 [-20.5607, -4.756] | -0.2027 | 0.003927 | 是 |
| makespan | legacy_static | 9.7083 [9.454, 9.9626] | 4.83 | 0 | 是 |
| makespan | mpc_global_commitment | 0.675 [0.5913, 0.7587] | 1.0201 | 0 | 是 |
| makespan | mpc_adaptive_v73 | 0.9625 [0.8697, 1.0553] | 1.3118 | 0 | 是 |
| makespan | mpc_region_selective | 1.0583 [0.9577, 1.159] | 1.3307 | 0 | 是 |
| makespan | mpc_risk_adaptive_commit | 0.6625 [0.5737, 0.7513] | 0.9442 | 0 | 是 |
| makespan | mpc_capacity_aware | 0.1958 [0.1381, 0.2536] | 0.429 | 0 | 是 |
| makespan | mpc_emergency_release | 0.3333 [0.2652, 0.4015] | 0.6189 | 0 | 是 |
| makespan | mpc_emergency_recovery | 0.675 [0.5793, 0.7707] | 0.8927 | 0 | 是 |
| makespan | mpc_pareto_gate | 0.575 [0.4866, 0.6634] | 0.823 | 0 | 是 |
| queue_person_minutes | legacy_static | 41111.4542 [40171.4939, 42051.4145] | 5.5335 | 0 | 是 |
| queue_person_minutes | mpc_global_commitment | 3684.1333 [3375.2517, 3993.0149] | 1.509 | 0 | 是 |
| queue_person_minutes | mpc_adaptive_v73 | 3968.2458 [3646.0792, 4290.4124] | 1.5584 | 0 | 是 |
| queue_person_minutes | mpc_region_selective | 3874.25 [3554.1768, 4194.3232] | 1.5314 | 0 | 是 |
| queue_person_minutes | mpc_risk_adaptive_commit | 1183.8125 [1046.0662, 1321.5588] | 1.0873 | 0 | 是 |
| queue_person_minutes | mpc_capacity_aware | -26.2875 [-39.6907, -12.8843] | -0.2481 | 0.000121 | 是 |
| queue_person_minutes | mpc_emergency_release | 353.0375 [282.3208, 423.7542] | 0.6316 | 0 | 是 |
| queue_person_minutes | mpc_emergency_recovery | 2790.0167 [2456.0726, 3123.9607] | 1.057 | 0 | 是 |
| queue_person_minutes | mpc_pareto_gate | 861.9208 [742.3256, 981.516] | 0.9118 | 0 | 是 |
| max_density | legacy_static | -0.1938 [-0.2269, -0.1606] | -0.7388 | 0 | 是 |
| max_density | mpc_global_commitment | 0.2956 [0.2476, 0.3436] | 0.7789 | 0 | 是 |
| max_density | mpc_adaptive_v73 | 0.2956 [0.2476, 0.3436] | 0.7789 | 0 | 是 |
| max_density | mpc_region_selective | 0.3224 [0.2747, 0.3702] | 0.8539 | 0 | 是 |
| max_density | mpc_risk_adaptive_commit | 0.0124 [0.0026, 0.0223] | 0.1597 | 0.040012 | 是 |
| max_density | mpc_capacity_aware | 0.0011 [-0.0007, 0.0029] | 0.0756 | 0.483349 | 否 |
| max_density | mpc_emergency_release | 0.0009 [-0.0009, 0.0028] | 0.0645 | 0.483349 | 否 |
| max_density | mpc_emergency_recovery | 0.1941 [0.1503, 0.2379] | 0.5607 | 0 | 是 |
| max_density | mpc_pareto_gate | 0.0403 [0.0205, 0.0601] | 0.2571 | 0.000273 | 是 |
| worst_risk_ratio | legacy_static | -0.0677 [-0.0846, -0.0507] | -0.5043 | 0 | 是 |
| worst_risk_ratio | mpc_global_commitment | 0.0068 [0.0017, 0.0118] | 0.1704 | 0.058085 | 否 |
| worst_risk_ratio | mpc_adaptive_v73 | 0.0068 [0.0017, 0.0118] | 0.1704 | 0.058085 | 否 |
| worst_risk_ratio | mpc_region_selective | 0.0046 [0, 0.0092] | 0.1268 | 0.247408 | 否 |
| worst_risk_ratio | mpc_risk_adaptive_commit | 0 [0, 0] | -0.0645 | 1 | 否 |
| worst_risk_ratio | mpc_capacity_aware | 0 [0, 0] | 0 | 1 | 否 |
| worst_risk_ratio | mpc_emergency_release | 0 [0, 0] | 0 | 1 | 否 |
| worst_risk_ratio | mpc_emergency_recovery | 0.0062 [0.0017, 0.0106] | 0.176 | 0.051317 | 否 |
| worst_risk_ratio | mpc_pareto_gate | 0.0004 [-0.0015, 0.0022] | 0.0245 | 1 | 否 |
| switch_persons | legacy_static | -3820.7542 [-3991.8472, -3649.6612] | -2.8253 | 0 | 是 |
| switch_persons | mpc_global_commitment | -2259.6167 [-2457.4117, -2061.8216] | -1.4453 | 0 | 是 |
| switch_persons | mpc_adaptive_v73 | -2451.7458 [-2646.5709, -2256.9208] | -1.5921 | 0 | 是 |
| switch_persons | mpc_region_selective | -2197.0583 [-2390.692, -2003.4247] | -1.4355 | 0 | 是 |
| switch_persons | mpc_risk_adaptive_commit | -720.0958 [-819.4088, -620.7829] | -0.9173 | 0 | 是 |
| switch_persons | mpc_capacity_aware | -63.2042 [-132.8382, 6.4298] | -0.1148 | 0.075237 | 否 |
| switch_persons | mpc_emergency_release | -243.15 [-293.9154, -192.3846] | -0.606 | 0 | 是 |
| switch_persons | mpc_emergency_recovery | -1606.3083 [-1798.1211, -1414.4956] | -1.0595 | 0 | 是 |
| switch_persons | mpc_pareto_gate | -1983.0917 [-2168.4757, -1797.7076] | -1.3534 | 0 | 是 |
| oscillation_persons | legacy_static | -571.8875 [-643.8713, -499.9037] | -1.0051 | 0 | 是 |
| oscillation_persons | mpc_global_commitment | -438.5375 [-512.9808, -364.0942] | -0.7453 | 0 | 是 |
| oscillation_persons | mpc_adaptive_v73 | -478.5375 [-550.2303, -406.8447] | -0.8445 | 0 | 是 |
| oscillation_persons | mpc_region_selective | -479.55 [-551.1086, -407.9914] | -0.8479 | 0 | 是 |
| oscillation_persons | mpc_risk_adaptive_commit | -226.175 [-274.4269, -177.9231] | -0.593 | 0 | 是 |
| oscillation_persons | mpc_capacity_aware | -47.8167 [-79.2009, -16.4324] | -0.1928 | 0.002825 | 是 |
| oscillation_persons | mpc_emergency_release | -89.0208 [-113.9484, -64.0932] | -0.4518 | 0 | 是 |
| oscillation_persons | mpc_emergency_recovery | -319.0125 [-381.4631, -256.5619] | -0.6463 | 0 | 是 |
| oscillation_persons | mpc_pareto_gate | -435.8125 [-513.8213, -357.8037] | -0.7068 | 0 | 是 |
| capacity_violations | legacy_static | 0.8042 [0.5335, 1.0748] | 0.3759 | 0 | 是 |
| capacity_violations | mpc_global_commitment | 0 [0, 0] | 0 | 1 | 否 |
| capacity_violations | mpc_adaptive_v73 | 0 [0, 0] | 0 | 1 | 否 |
| capacity_violations | mpc_region_selective | 0 [0, 0] | 0 | 1 | 否 |
| capacity_violations | mpc_risk_adaptive_commit | 0 [0, 0] | 0 | 1 | 否 |
| capacity_violations | mpc_capacity_aware | 0 [0, 0] | 0 | 1 | 否 |
| capacity_violations | mpc_emergency_release | 0 [0, 0] | 0 | 1 | 否 |
| capacity_violations | mpc_emergency_recovery | 0 [0, 0] | 0 | 1 | 否 |
| capacity_violations | mpc_pareto_gate | 0 [0, 0] | 0 | 1 | 否 |
| safety_violations | legacy_static | 1.75 [1.4753, 2.0247] | 0.8059 | 0 | 是 |
| safety_violations | mpc_global_commitment | -0.0542 [-0.0829, -0.0255] | -0.2388 | 0.001728 | 是 |
| safety_violations | mpc_adaptive_v73 | -0.0542 [-0.0829, -0.0255] | -0.2388 | 0.001728 | 是 |
| safety_violations | mpc_region_selective | -0.0542 [-0.0829, -0.0255] | -0.2388 | 0.001728 | 是 |
| safety_violations | mpc_risk_adaptive_commit | -0.0458 [-0.0723, -0.0193] | -0.2187 | 0.002814 | 是 |
| safety_violations | mpc_capacity_aware | -0.0083 [-0.0199, 0.0032] | -0.0915 | 0.15643 | 否 |
| safety_violations | mpc_emergency_release | -0.0458 [-0.0723, -0.0193] | -0.2187 | 0.002814 | 是 |
| safety_violations | mpc_emergency_recovery | -0.0542 [-0.0829, -0.0255] | -0.2388 | 0.001728 | 是 |
| safety_violations | mpc_pareto_gate | -0.0417 [-0.067, -0.0163] | -0.2081 | 0.002814 | 是 |
| solve_ms | legacy_static | -8.4833 [-8.8051, -8.1616] | -3.3356 | 0 | 是 |
| solve_ms | mpc_global_commitment | 7.0167 [6.2078, 7.8256] | 1.0974 | 0 | 是 |
| solve_ms | mpc_adaptive_v73 | 7.025 [6.18, 7.87] | 1.0518 | 0 | 是 |
| solve_ms | mpc_region_selective | 7.6375 [6.7497, 8.5253] | 1.0885 | 0 | 是 |
| solve_ms | mpc_risk_adaptive_commit | 2.1333 [1.7417, 2.5249] | 0.6892 | 0 | 是 |
| solve_ms | mpc_capacity_aware | 3.3458 [2.8189, 3.8728] | 0.8033 | 0 | 是 |
| solve_ms | mpc_emergency_release | 0.7667 [0.4713, 1.0621] | 0.3284 | 0 | 是 |
| solve_ms | mpc_emergency_recovery | 4.5208 [3.7594, 5.2822] | 0.7512 | 0 | 是 |
| solve_ms | mpc_pareto_gate | 31.9458 [30.1918, 33.6999] | 2.3042 | 0 | 是 |
| commitment_recommits | legacy_static | 0 [0, 0] | 0 | 1 | 否 |
| commitment_recommits | mpc_global_commitment | 0 [0, 0] | 0 | 1 | 否 |
| commitment_recommits | mpc_adaptive_v73 | 0 [0, 0] | 0 | 1 | 否 |
| commitment_recommits | mpc_region_selective | 0 [0, 0] | 0 | 1 | 否 |
| commitment_recommits | mpc_risk_adaptive_commit | 1.1417 [1.0975, 1.1859] | 3.2672 | 0 | 是 |
| commitment_recommits | mpc_capacity_aware | 0 [0, 0] | 0 | 1 | 否 |
| commitment_recommits | mpc_emergency_release | 0.8292 [0.7761, 0.8822] | 1.9781 | 0 | 是 |
| commitment_recommits | mpc_emergency_recovery | 0.2625 [0.2067, 0.3183] | 0.5954 | 0 | 是 |
| commitment_recommits | mpc_pareto_gate | 0 [0, 0] | 0 | 1 | 否 |
| emergency_events | legacy_static | 0 [0, 0] | 0 | 1 | 否 |
| emergency_events | mpc_global_commitment | 0 [0, 0] | 0 | 1 | 否 |
| emergency_events | mpc_adaptive_v73 | 0 [0, 0] | 0 | 1 | 否 |
| emergency_events | mpc_region_selective | 0 [0, 0] | 0 | 1 | 否 |
| emergency_events | mpc_risk_adaptive_commit | 0 [0, 0] | 0 | 1 | 否 |
| emergency_events | mpc_capacity_aware | 0 [0, 0] | 0 | 1 | 否 |
| emergency_events | mpc_emergency_release | 0.4458 [0.3375, 0.5542] | 0.5206 | 0 | 是 |
| emergency_events | mpc_emergency_recovery | 0.4458 [0.3375, 0.5542] | 0.5206 | 0 | 是 |
| emergency_events | mpc_pareto_gate | 0 [0, 0] | 0 | 1 | 否 |

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
