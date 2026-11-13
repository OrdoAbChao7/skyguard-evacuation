# V7.3 Shadow Mode 运营验证

> 运行 ID：`v73-final-20261110T101711`。10 种子 × 8 用例；**Shadow 默认关闭，V7 永不发布**；全部为合成场景/观测。

## 1. 用例

| 用例 | 预期 |
| --- | --- |
| historical_replay | 版本化快照重复回放，确定性 |
| sensor_failure | 传感器故障区域不可信 |
| sudden_surge | 需求突增时 legacy/V7 同快照比较 |
| corridor_closure | 通道封控后规划避开 |
| exit_failure | 出口故障后规划避开 |
| conflicting_observations | 不同 provider 冲突被标记 |
| stale_snapshot | 快照过期 → `snapshot_stale` 回退 |
| concurrent_events | 多事件同时生效，版本一致 |

## 2. 结果

| 用例 | legacy 校验率 | V7 校验率 | 决策分布 | 回退原因 | 冲突数 | 切换区域/人数 | 确定性不一致 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| historical_replay | 1 | 1 | {"v7_eligible_for_review":10} | {"none":10} | 0 | 1.4/436.2 | 0 |
| sensor_failure | 1 | 1 | {"v7_eligible_for_review":10} | {"none":10} | 0 | 1.3/419.5 | 0 |
| sudden_surge | 1 | 0 | {"legacy_only":10} | {"v7_validation_failed":10} | 0 | 2/1228 | 0 |
| corridor_closure | 1 | 1 | {"v7_eligible_for_review":10} | {"none":10} | 0 | 1.5/485.4 | 0 |
| exit_failure | 1 | 1 | {"v7_eligible_for_review":10} | {"none":10} | 0 | 1/319.6 | 0 |
| conflicting_observations | 0 | 0 | {"legacy_only":10} | {"v7_validation_failed":10} | 10 | 1.4/437.9 | 0 |
| stale_snapshot | 1 | 0 | {"legacy_only":10} | {"snapshot_stale":10} | 0 | 0/0 | 0 |
| concurrent_events | 1 | 1 | {"v7_eligible_for_review":10} | {"none":10} | 0 | 1.8/570.7 | 0 |

## 3. 结论

- 确定性不一致：0；
- 过期快照：10 次被标记并回退；
- 冲突观测：10 次检测；适配器不解决冲突，只标记；
- V7 从未发布：适配器只返回比较记录，发布路径不读取 Shadow。

## 4. 边界

- 适配器层回放，不覆盖真实 HTTP 并发/持久化；
- 冲突检测只比较不同 provider 的近期观测；
- 合成场景/观测；不代表真实运营。
