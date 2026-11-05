# SkyGuard 竞赛级基准报告

> 由 `npm run benchmark:competition --prefix backend` 在本机生成。
> 所有数据均为**合成/模拟**；没有真实场馆、真实人流、无人机、昇腾或 AgentArts 租户实测。
> 不得把本报告数值表述为真实场景效果或获奖保证。

## 0. 方法与环境

- 场景：滨江体育中心 · 活动散场（合成场景）（stadium-evacuation-v1 v1.0.0）
- 随机种子：20261105, 20261106, 20261107, 20261108, 20261109
- 每个种子的 VoI 试验数：200；预测序列：150/种子；规划扰动：24 组；闭环：20 次
- 环境：Node v24.19.0 / win32 / AMD Ryzen 7 7745HX with Radeon Graphics        

## 1. 实验 A · 调查策略（均值 [95% CI]）

| 策略 | 工具调用 | 风险降低 | 熵降低(bit) | 时间成本 | 资源成本 | 有效调查比例 |
| --- | --- | --- | --- | --- | --- | --- |
| voi | 1.819 [1.7951, 1.8429] | 0.0486 [0.0463, 0.0509] | 0.7099 | 1.7714 | 0.2257 | 0.7935 |
| fixed_priority | 1.997 [1.9936, 2.0004] | 0.0572 [0.0546, 0.0597] | 0.8335 | 3.5745 | 0.5159 | 0.86 |
| random | 1.993 [1.9878, 1.9982] | 0.05 [0.0476, 0.0523] | 0.73 | 2.3457 | 0.3712 | 0.7905 |
| heuristic | 1.989 [1.9825, 1.9955] | 0.0436 [0.0413, 0.0459] | 0.6503 | 0.9778 | 0.1249 | 0.756 |

### Pareto（风险降低 vs 总成本）

| 策略 | 风险降低 | 总成本（时间 + 10×资源） | 判定 |
| --- | --- | --- | --- |
| voi | 0.0486 | 4.0283 | Pareto 前沿 |
| fixed_priority | 0.0572 | 8.7338 | Pareto 前沿 |
| random | 0.05 | 6.0582 | Pareto 前沿 |
| heuristic | 0.0436 | 2.2273 | Pareto 前沿 |

### 权重敏感性

基线推荐动作：A_CAMERA。下表为单参数缩放后推荐动作与基线一致的比例：
- risk_reduction@0.5: 1
- risk_reduction@1: 1
- risk_reduction@1.5: 0.95
- information_gain@0.5: 0.75
- information_gain@1: 1
- information_gain@1.5: 0.9
- time_cost@0.5: 0.95
- time_cost@1: 1
- time_cost@1.5: 0.75
- resource_cost@0.5: 0.95
- resource_cost@1: 1
- resource_cost@1.5: 0.75
- failure@0.5: 0.95
- failure@1: 1
- failure@1.5: 1

**解读**：VoI 在模拟条件下减少了调查成本，但风险降低略低于固定/启发式策略；这是信息收益与成本权衡，
不是“全面更优”。权重敏感性暴露了推荐动作对部分权重的依赖，必须在真实场景重新标定。

## 2. 实验 B · 预测滚动验证（5 个种子）

| 窗口(分钟) | 持久化 MAE | EMA MAE | 线性 MAE | 自适应 MAE | 固定 0.5 MAE | 区间覆盖率 | 峰值误差 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 23.6467 | 39.4822 | 77.6477 | 25.1389 | 62.7453 | 0.9147 | 15.7522 |
| 5 | 58.4747 | 66.1145 | 102.7635 | 59.4802 | 96.516 | 0.8413 | 18.185 |
| 10 | 83.3973 | 78.5889 | 98.2673 | 79.7232 | 102.2213 | 0.7907 | 29.5655 |

**解读**：方法由滚动验证选择，不接触未来；区间使用所选方法的历史 h 步误差 95 分位 ×1.5。
5/10 分钟覆盖率仅约 84%/79%，**未达 95%**，说明突增场景下区间仍过度自信，不得用于安全告警阈值。
没有真实标注数据，不能声称真实 MAE/RMSE。

## 3. 实验 C · 规划鲁棒性

- 案例数：undefined
- 方案状态分布：{"feasible":44,"partial":4}
- 被独立校验器拒绝：4
- 平均未解决人数：71.5
- 平均最大出口利用率：0.7368
- 与基线路线集合的平均 Jaccard：0.7374
- 故障注入检出：5/5

| 注入故障 | 结果 | 违规码 |
| --- | --- | --- |
| route_over_capacity | 检出 | exit_capacity_exceeded, flow_conservation_violation, totals_inconsistent |
| closed_exit_route | 检出 | unknown_exit, flow_conservation_violation, totals_inconsistent |
| unknown_corridor_step | 检出 | path_broken_chain, corridor_direction_violation, step_duration_mismatch, path_does_not_reach_exit, route_arrival_mismatch, unknown_corridor_used, corridor_capacity_unknown |
| negative_route_persons | 检出 | invalid_persons, totals_inconsistent |
| duplicate_route_id | 检出 | duplicate_route_id, flow_conservation_violation, totals_inconsistent |

**解读**：这是机制鲁棒性测试，不是真实场馆安全评估。任何漏检都必须先修复再对外表述。

## 4. 实验 D · 状态机故障注入

- 用例匹配：6/6
- 错误发布：0

## 5. 实验 E · 业务闭环

- 成功率：1
- 状态流转正确：20/20
- 平均耗时：24.75 ms；P95：40 ms（进程内，不含人工）

## 6. 实验 F · 端到端延迟（本机）

| 环节 | 迭代 | mean | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- |
| planning | 30 | 0.181 | 0.174 | 0.241 | 0.241 |
| validation | 30 | 0.045 | 0.04 | 0.076 | 0.092 |
| dashboard | 20 | 0.138 | 0.09 | 0.484 | 0.531 |
| agent | 10 | 2.445 | 2.332 | 2.847 | 2.847 |

## 7. 结论边界

- 以上全部是合成数据与本机计算；没有真实平台/硬件/场地证据。
- VoI 的“更优”只在成本维度成立，风险收益略低；必须按场景重新标定。
- 预测的自适应权重改善了相对表现，但真实精度仍未知。
- 校验器/状态机的故障注入只证明机制有效，不证明现场安全。
- 原始数据见 `evaluation/competition/*.json`。
