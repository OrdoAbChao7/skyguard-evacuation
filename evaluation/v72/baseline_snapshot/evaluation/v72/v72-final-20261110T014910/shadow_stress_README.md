# V7.2 Shadow Mode 回放压力与故障注入

> 运行 ID：`v72-final-20261110T014910`。适配器层回放；**Shadow 永不发布 V7**；全部为合成场景/合成观测。
> 10 种子 × 4 场景 × 6 注入模式 = 240 次比较（每次重复回放验证确定性）。

## 1. 注入模式与预期

| 模式 | 预期 |
| --- | --- |
| normal | 两套方案均校验；输出仅比较记录 |
| solver_error | V7 异常 → `v7_error:*` 回退，legacy 不受影响 |
| validation_failure | V7 校验失败 → `v7_validation_failed` 回退 |
| budget_zero | 不运行 V7 → `solve_budget_zero` |
| stale_observation | 两套校验均失败（过期观测不得发布） |
| snapshot_tamper | legacy 计划人数与快照不一致 → `legacy_snapshot_mismatch` |

## 2. 按模式汇总

| 模式 | n | legacy 校验通过率 | V7 校验通过率 | 完整性不一致 | 确定性不一致 | 决策分布 | 回退原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| normal | 40 | 1 | 0.75 | 0 | 0 | {"v7_eligible_for_review":30,"legacy_only":10} | {"none":30,"v7_validation_failed":10} |
| solver_error | 40 | 1 | 0 | 0 | 0 | {"legacy_only":40} | {"v7_error:injected shadow solver failure":40} |
| validation_failure | 40 | 1 | 0 | 0 | 0 | {"legacy_only":40} | {"v7_validation_failed":40} |
| budget_zero | 40 | 1 | 0 | 0 | 0 | {"legacy_only":40} | {"solve_budget_zero":40} |
| stale_observation | 40 | 0 | 0 | 0 | 0 | {"legacy_only":40} | {"v7_validation_failed":40} |
| snapshot_tamper | 40 | 0 | 0.75 | 40 | 0 | {"legacy_only":40} | {"legacy_snapshot_mismatch":40} |

## 3. 关键结论

- 确定性：全部重复回放一致；
- 完整性：40 次快照人数不一致（应仅出现在 snapshot_tamper）；
- 决策分布：{"v7_eligible_for_review":30,"legacy_only":210}；
- V7 从未被发布：适配器只返回比较记录，发布路径不读取 Shadow 结果。

## 4. 边界

- 适配器层回放，不包含真实 HTTP 并发、持久化中断或 AgentArts 重试；
- 过期观测在服务层会直接跳过规划（已有测试）；本实验记录适配器层校验结果；
- 合成观测与合成场景；不代表真实场馆运行。
