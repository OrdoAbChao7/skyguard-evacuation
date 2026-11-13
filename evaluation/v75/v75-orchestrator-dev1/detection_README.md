# V7.5 Track A 检测实验

> 运行 ID：`v75-orchestrator-dev1`。30 种子 × 7 机制 × 7 检测器；合成多传感器序列。

## 聚合指标（4 个有变化机制 + 3 个无变化机制）

| 检测器 | 召回 | 精确率 | F1 | 无变化误报率 | 误报/100 步 |
| --- | --- | --- | --- | --- | --- |
| naive3sigma | 1 | 0.8276 | 0.9057 | 0.2778 | 0.746 |
| cusum | 1 | 0.8054 | 0.8922 | 0.3222 | 3.0556 |
| adaptive_cusum | 1 | 0.7947 | 0.8856 | 0.3444 | 0.5079 |
| sprt | 1 | 0.7792 | 0.8759 | 0.3778 | 0.7143 |
| reliability_dual | 1 | 1 | 1 | 0 | 0 |
| dual_persist1 | 1 | 0.9302 | 0.9639 | 0.1 | 0.1508 |
| dual_no_multisensor | 1 | 0.9524 | 0.9756 | 0.0667 | 0.0476 |

## 分机制检测率 / 延迟 / 误报

| 检测器 | 机制 | 检测率 | 中位延迟 | 误报/100 | 误报率 |
| --- | --- | --- | --- | --- | --- |
| naive3sigma | stable | 0 | 0 | 0.3889 | 0.1333 |
| naive3sigma | surge | 1 | 0 | 0.1111 | - |
| naive3sigma | regime_shift | 1 | 0 | 0.3333 | - |
| naive3sigma | noisy | 0 | 0 | 0.3333 | 0.1333 |
| naive3sigma | missing | 1 | 0 | 0.2222 | - |
| naive3sigma | delayed | 1 | 0 | 0.2222 | - |
| naive3sigma | conflicting | 0 | 0 | 3.6111 | 0.5667 |
| cusum | stable | 0 | 0 | 3.1667 | 0.2667 |
| cusum | surge | 1 | 1 | 0.1111 | - |
| cusum | regime_shift | 1 | 0 | 0.2222 | - |
| cusum | noisy | 0 | 0 | 0.8333 | 0.0667 |
| cusum | missing | 1 | 1 | 0.2222 | - |
| cusum | delayed | 1 | 1 | 0 | - |
| cusum | conflicting | 0 | 0 | 16.8333 | 0.6333 |
| adaptive_cusum | stable | 0 | 0 | 0.6111 | 0.3 |
| adaptive_cusum | surge | 1 | 1 | 0.1111 | - |
| adaptive_cusum | regime_shift | 1 | 0 | 0.2222 | - |
| adaptive_cusum | noisy | 0 | 0 | 0.1667 | 0.0667 |
| adaptive_cusum | missing | 1 | 1 | 0 | - |
| adaptive_cusum | delayed | 1 | 1 | 0 | - |
| adaptive_cusum | conflicting | 0 | 0 | 2.4444 | 0.6667 |
| sprt | stable | 0 | 0 | 0.7222 | 0.3333 |
| sprt | surge | 1 | 0 | 0.2222 | - |
| sprt | regime_shift | 1 | 0 | 0.3333 | - |
| sprt | noisy | 0 | 0 | 0.3889 | 0.1333 |
| sprt | missing | 1 | 0 | 0.2222 | - |
| sprt | delayed | 1 | 0 | 0.2222 | - |
| sprt | conflicting | 0 | 0 | 2.8889 | 0.6667 |
| reliability_dual | stable | 0 | 0 | 0 | 0 |
| reliability_dual | surge | 1 | 1 | 0 | - |
| reliability_dual | regime_shift | 1 | 1 | 0 | - |
| reliability_dual | noisy | 0 | 0 | 0 | 0 |
| reliability_dual | missing | 1 | 1 | 0 | - |
| reliability_dual | delayed | 1 | 2 | 0 | - |
| reliability_dual | conflicting | 0 | 0 | 0 | 0 |
| dual_persist1 | stable | 0 | 0 | 0.3333 | 0.1667 |
| dual_persist1 | surge | 1 | 0 | 0.1111 | - |
| dual_persist1 | regime_shift | 1 | 0 | 0.2222 | - |
| dual_persist1 | noisy | 0 | 0 | 0.0556 | 0.0333 |
| dual_persist1 | missing | 1 | 0 | 0.1111 | - |
| dual_persist1 | delayed | 1 | 0 | 0 | - |
| dual_persist1 | conflicting | 0 | 0 | 0.2222 | 0.1 |
| dual_no_multisensor | stable | 0 | 0 | 0 | 0 |
| dual_no_multisensor | surge | 1 | 2 | 0 | - |
| dual_no_multisensor | regime_shift | 1 | 1 | 0 | - |
| dual_no_multisensor | noisy | 0 | 0 | 0 | 0 |
| dual_no_multisensor | missing | 1 | 2 | 0 | - |
| dual_no_multisensor | delayed | 1 | 3 | 0 | - |
| dual_no_multisensor | conflicting | 0 | 0 | 0.3333 | 0.2 |

## 解释边界

- 序列、传感器噪声/可靠性、缺失/延迟/偏置均为合成；
- 召回与误报按“运行级”统计：一次运行内报警即计为阳性；
- 不得表述为真实人群突增预警精度。
