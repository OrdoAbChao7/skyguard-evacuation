# V7.5 Track D 多目标实验

> 运行 ID：`v75-final-20261110`。30 种子 × 8 场景 × 6 权重配置；合成数据。
> **膝点选择使用同一实例的候选结果，属于离线分析/上界，不是在线部署算法。**

## 权重配置（总体）

| 配置 | 未疏散 | 完成 | 队列 | 切换 | 密度 | 容量冲突 |
| --- | --- | --- | --- | --- | --- | --- |
| balanced | 0 | 10.8792 | 23998.61 | 1369.01 | 2.4409 | 0 |
| efficiency | 0 | 10.5667 | 23532 | 1662.51 | 2.4409 | 0 |
| stability | 0 | 10.9667 | 24112.16 | 1319.14 | 2.4409 | 0 |
| safety | 0 | 10.95 | 24089.15 | 1326.11 | 2.4409 | 0 |
| queue | 0 | 10.8542 | 23904.83 | 1405.13 | 2.4409 | 0 |
| emergency | 0 | 10.9375 | 24086.06 | 1329.99 | 2.4409 | 0 |
| no_commitment | 16.4708 | 9.9167 | 20030.36 | 3820.75 | 2.1453 | 0 |
| global_commitment | 0 | 10.8792 | 23998.61 | 1369.01 | 2.4409 | 0 |
| region_selective | 0 | 10.975 | 23904.61 | 1623.7 | 2.4677 | 0 |
| emergency_release | 2.8667 | 10.325 | 20454.31 | 3497.93 | 2.1462 | 0 |

## 选择方法

| 方法 | 未疏散 | 完成 | 队列 | 切换 | 密度 | 配置分布 |
| --- | --- | --- | --- | --- | --- | --- |
| pareto_efficiency | 0 | 9.9625 | 20135.17 | 3704.65 | 2.161 | {"no_commitment":184,"balanced":17,"region_selective":3,"emergency_release":25,"efficiency":11} |
| pareto_stability | 0 | 10.9292 | 24182.76 | 1206.58 | 2.4395 | {"balanced":169,"region_selective":35,"stability":8,"efficiency":24,"emergency_release":3,"no_commitment":1} |
| pareto_safety | 0 | 9.9625 | 20175.39 | 3633.02 | 2.1666 | {"no_commitment":171,"emergency_release":35,"balanced":17,"efficiency":13,"region_selective":4} |
| pareto_balanced | 0 | 9.9625 | 20151.73 | 3655.46 | 2.1651 | {"no_commitment":177,"balanced":17,"efficiency":12,"region_selective":4,"emergency_release":30} |
| constrained | 0 | 9.9958 | 20544.88 | 3432.15 | 2.2047 | {"emergency_release":49,"no_commitment":139,"balanced":36,"efficiency":14,"region_selective":2} |

## Pareto 统计

- 实例数：240；平均前沿大小 8.454，最大 10；
- 存在多目标权衡（前沿 >1）的实例：238。

## 边界

- 权重配置是预先定义的，不是通过测试集反复调参得到；
- 膝点选择是离线上界，部署时必须单次规划并经过独立校验；
- 不得把离线选择结果表述为在线性能。
