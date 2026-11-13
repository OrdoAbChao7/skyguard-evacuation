# SkyGuard V7.1 实验汇总

> 运行 ID：`v71-final-20261109T211702`。全部为合成数据；不代表真实场馆效果。
> 生成时间：2026-11-09T13:17:14.200Z

## 预测区间
- stable：v70_static 95% 覆盖 0.9333，aci 0.9247，aci_cp 0.928；aci_cp 宽度 60.3032，门控失败率 0.3237。
- surge：v70_static 95% 覆盖 0.7484，aci 0.814，aci_cp 0.8462；aci_cp 宽度 442.5839，门控失败率 0.8914。
- decline：v70_static 95% 覆盖 0.9828，aci 0.9624，aci_cp 0.9613；aci_cp 宽度 63.3237，门控失败率 0.3129。
- periodic：v70_static 95% 覆盖 0.9817，aci 0.8333，aci_cp 0.8333；aci_cp 宽度 368.5677，门控失败率 1。
- missing：v70_static 95% 覆盖 0.9321，aci 0.9208，aci_cp 0.9186；aci_cp 宽度 73.1584，门控失败率 0.5769。
- noisy：v70_static 95% 覆盖 0.9333，aci 0.929，aci_cp 0.9269；aci_cp 宽度 419.4871，门控失败率 1。
- regime_shift：v70_static 95% 覆盖 0.8086，aci 0.6527，aci_cp 0.9065；aci_cp 宽度 556.3215，门控失败率 0.8591。

## 滚动重规划（A-G + H/I）
- static_mcf：未疏散 682.8267，完成时间 18.9933，队列人·分钟 51585.9067，切换人数 0，重规划 0，求解 0.4933ms。
- periodic_reactive：未疏散 0，完成时间 13.88，队列人·分钟 43383.0067，切换人数 754.2，重规划 7.3267，求解 1.28ms。
- event_triggered：未疏散 0，完成时间 13.7467，队列人·分钟 42641.26，切换人数 762.72，重规划 4.7533，求解 1ms。
- mpc_no_forecast：未疏散 0，完成时间 8.8133，队列人·分钟 14373.0733，切换人数 4389.96，重规划 5.0267，求解 1.8ms。
- mpc_forecast：未疏散 0，完成时间 8.7733，队列人·分钟 14290.8467，切换人数 4731.2067，重规划 5.0467，求解 1.8933ms。
- mpc_queue：未疏散 0，完成时间 8.8333，队列人·分钟 14401.12，切换人数 4410.2，重规划 5.0467，求解 1.76ms。
- full：未疏散 0，完成时间 8.8067，队列人·分钟 14321.52，切换人数 4744.8733，重规划 5.06，求解 1.8133ms。
- full_stable：未疏散 0，完成时间 8.9667，队列人·分钟 14639.2667，切换人数 4959.5267，重规划 5.12，求解 3.1333ms。
- event_full：未疏散 0，完成时间 10.2933，队列人·分钟 23122.6533，切换人数 4701.42，重规划 5，求解 1.78ms。

## 机理问题
- rolling_gain_periodic_vs_static：unserved -682.8267 [-715.7698, -649.8835]；makespan -5.1133 [-5.2858, -4.9409]。
- forecast_gain_full_vs_queue：unserved 0 [0, 0]；makespan -0.0267 [-0.0679, 0.0146]。
- queue_gain_full_vs_forecast：unserved 0 [0, 0]；makespan 0.0333 [-0.0009, 0.0676]。
- event_vs_periodic：solve_ms -0.28 [-0.4151, -0.1449]；replans -2.5733 [-2.6866, -2.46]；unserved 0 [0, 0]。
- complex_vs_simple：mpc_no_forecast_vs_periodic_unserved 0 [0, 0]；mpc_no_forecast_vs_periodic_solve_ms 0.52 [0.308, 0.732]。

## 解释边界

- 合成机制/场景与未标定参数；不得表述为真实场馆效果。
- 负向与混合结果保留在各自 README、summary 与 rows 文件中。

