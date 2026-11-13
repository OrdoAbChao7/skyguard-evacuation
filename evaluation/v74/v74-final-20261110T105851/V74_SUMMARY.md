# SkyGuard V7.4 实验汇总

> 运行 ID：`v74-final-20261110T105851`。全部为合成/夹具数据；不代表真实场馆/平台/硬件效果。
> 生成时间：2026-11-10T02:59:23.514Z

## 稳定性—效率 Pareto A-F
- legacy_static：未疏散 953.0417，完成 19.625，队列 61141.8167，密度 1.9515，切换 0，振荡 0，安全违规 1.8042，门控拒绝 0，释放 0。
- mpc_standard：未疏散 16.4708，完成 9.9167，队列 20030.3625，密度 2.1453，切换 3820.7542，振荡 571.8875，安全违规 0.0542，门控拒绝 0，释放 0。
- mpc_adaptive_v73：未疏散 0，完成 10.8792，队列 23998.6083，密度 2.4409，切换 1369.0083，振荡 93.35，安全违规 0，门控拒绝 0，释放 0。
- mpc_risk_adaptive：未疏散 0，完成 10.8792，队列 23998.6083，密度 2.4409，切换 1369.0083，振荡 93.35，安全违规 0，门控拒绝 0，释放 0。
- mpc_emergency_release：未疏散 2.8667，完成 10.325，队列 20454.3083，密度 2.1462，切换 3497.9292，振荡 467.1167，安全违规 0.0083，门控拒绝 0，释放 2.6167。
- mpc_pareto_gate：未疏散 3.8125，完成 10.4917，队列 20892.2833，密度 2.1856，切换 1837.6625，振荡 136.075，安全违规 0.0125，门控拒绝 3.8958，释放 0。

## Surge/Regime 检测
- changepoint：stable 检测率 0/延迟 0；surge 检测率 1/延迟 5；regime_shift 检测率 1/延迟 7；noisy 检测率 0/延迟 0
- naive3sigma：stable 检测率 0/延迟 0；surge 检测率 0.7667/延迟 5；regime_shift 检测率 0.7333/延迟 7；noisy 检测率 0/延迟 0

## 标定质量
- 时钟同步接受 3，拒绝 1；缺失区间 1；可靠性 provider 2。
- 观测覆盖 0.125；过期 1；低置信度 0。

## Ascend/ONNX
- npu-smi=false；atc=false；ONNX executed_cpu_only；checker {"available":true,"valid":true,"error":null}；OM not_executed_missing_atc_or_npu。

## AgentArts
- 真实平台 not_configured；stub 会话头 true；幂等键复用 true。

## 生产检查
- Docker blocked；CI ok；API 3/3；负载 p95 7.319ms。

## 边界

- 合成/夹具数据；无真实场馆、平台或 NPU 证据。
- 负向/混合结果保留在各自 rows/summary/README。

