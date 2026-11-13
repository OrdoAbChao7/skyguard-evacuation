# SkyGuard V7.3 实验汇总

> 运行 ID：`v73-final-20261110T101711`。全部为合成数据；不代表真实场馆/平台/硬件效果。
> 生成时间：2026-11-10T02:17:34.106Z

## 自适应稳定性 A-F
- legacy_static：未疏散 953.0417，完成时间 19.625，队列 61141.8167，密度 1.9515，切换 0，振荡 0，安全违规 1.8042。
- mpc_standard：未疏散 16.4708，完成时间 9.9167，队列 20030.3625，密度 2.1453，切换 3820.7542，振荡 571.8875，安全违规 0.0542。
- mpc_hysteresis：未疏散 3.7917，完成时间 10.075，队列 22651.2958，密度 2.4408，切换 2270.7167，振荡 274.4167，安全违规 0.0125。
- mpc_switch_penalty：未疏散 0，完成时间 10.5333，队列 23610.0583，密度 2.4409，切换 1562.9958，振荡 133.35，安全违规 0。
- mpc_commitment：未疏散 0，完成时间 10.5917，队列 23714.4958，密度 2.4409，切换 1561.1375，振荡 133.35，安全违规 0。
- mpc_adaptive_v73：未疏散 0，完成时间 10.8792，队列 23998.6083，密度 2.4409，切换 1369.0083，振荡 93.35，安全违规 0。

## 场馆导入
- 场景拓扑错误 0；档案校验 true；CSV replay/live 4/4；视频 1；public/authorized 2/2。

## Shadow 运营验证
- 总回放 80；确定性不一致 0；决策 {"v7_eligible_for_review":50,"legacy_only":30}。
- historical_replay：legacy/V7 校验率 1/1；回退 {"none":10}；stale 0；冲突 0。
- sensor_failure：legacy/V7 校验率 1/1；回退 {"none":10}；stale 0；冲突 0。
- sudden_surge：legacy/V7 校验率 1/0；回退 {"v7_validation_failed":10}；stale 0；冲突 0。
- corridor_closure：legacy/V7 校验率 1/1；回退 {"none":10}；stale 0；冲突 0。
- exit_failure：legacy/V7 校验率 1/1；回退 {"none":10}；stale 0；冲突 0。
- conflicting_observations：legacy/V7 校验率 0/0；回退 {"v7_validation_failed":10}；stale 0；冲突 10。
- stale_snapshot：legacy/V7 校验率 1/0；回退 {"snapshot_stale":10}；stale 10；冲突 0。
- concurrent_events：legacy/V7 校验率 1/1；回退 {"none":10}；stale 0；冲突 0。

## Ascend/ONNX
- npu-smi=false；atc=false；ONNX executed_cpu_only；checker {"available":true,"valid":true,"error":null}；OM not_executed_missing_atc_or_npu。

## AgentArts
- 真实平台 not_configured；stub 会话头 true；重试复用幂等键 true。

## 边界

- 合成场景/观测；无真实场馆、平台或 NPU 证据。
- 负向/混合结果保留在各自 rows/summary/README。

