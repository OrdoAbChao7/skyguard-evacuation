# SkyGuard V7.2 实验汇总

> 运行 ID：`v72-final-20261110T014811`。全部为合成数据；不代表真实场馆效果。
> 生成时间：2026-11-09T17:48:48.123Z

## 路线稳定性 A-F
- legacy_static：未疏散 784.8944，完成时间 19，队列人·分钟 57772.6056，最大密度 1.9628，切换人数 0，求解 0.55ms。
- mpc_standard：未疏散 0，完成时间 9.8944，队列人·分钟 19481.7389，最大密度 2.6963，切换人数 5261.8278，求解 18.6611ms。
- mpc_hysteresis：未疏散 0，完成时间 9.9444，队列人·分钟 20824.1333，最大密度 2.7694，切换人数 4268.2889，求解 38.3333ms。
- mpc_switch_penalty：未疏散 0，完成时间 10.3444，队列人·分钟 22103.1389，最大密度 2.7755，切换人数 3334.2778，求解 39.0333ms。
- mpc_commitment：未疏散 0，完成时间 10.4056，队列人·分钟 22209.1556，最大密度 2.7755，切换人数 3334.6889，求解 38.9889ms。
- mpc_adaptive：未疏散 0，完成时间 10.4056，队列人·分钟 22209.1556，最大密度 2.7755，切换人数 3334.6889，求解 38.9556ms。

## 稳定性机理（相对 mpc_standard）
- mpc_standard：切换人数差 0 [0, 0]；完成时间差 0 [0, 0]。
- mpc_hysteresis：切换人数差 -993.5389 [-1227.3662, -759.7116]；完成时间差 0.05 [0.0005, 0.0995]。
- mpc_switch_penalty：切换人数差 -1927.55 [-2193.0328, -1662.0672]；完成时间差 0.45 [0.3532, 0.5468]。
- mpc_commitment：切换人数差 -1927.1389 [-2192.1358, -1662.142]；完成时间差 0.5111 [0.4129, 0.6094]。
- mpc_adaptive：切换人数差 -1927.1389 [-2192.1358, -1662.142]；完成时间差 0.5111 [0.4129, 0.6094]。

## 场馆标定
- 数据性质：synthetic；档案校验：true（错误 0，警告 0）。
- 应用变更 0 项，阻止 0 项；场景未被原地修改：false。
- 步行速度估计：1.172 m/s（estimated）。

## Shadow 回放压力
- 总回放 240 次；确定性不一致 0；快照完整性不一致 40。
- 决策分布：{"v7_eligible_for_review":30,"legacy_only":210}。
- normal：legacy 校验通过率 1，V7 校验通过率 0.75，回退 {"none":30,"v7_validation_failed":10}。
- solver_error：legacy 校验通过率 1，V7 校验通过率 0，回退 {"v7_error:injected shadow solver failure":40}。
- validation_failure：legacy 校验通过率 1，V7 校验通过率 0，回退 {"v7_validation_failed":40}。
- budget_zero：legacy 校验通过率 1，V7 校验通过率 0，回退 {"solve_budget_zero":40}。
- stale_observation：legacy 校验通过率 0，V7 校验通过率 0，回退 {"v7_validation_failed":40}。
- snapshot_tamper：legacy 校验通过率 0，V7 校验通过率 0.75，回退 {"legacy_snapshot_mismatch":40}。

## 华为生态状态
- AgentArts：not_configured；本地契约 stub 会话头一致 true。
- Ascend：npu-smi=false，atc=false；ONNX 链路 executed_cpu_only。
- 边界：未检测到昇腾 NPU/CANN/atc；一切 NPU/OM 结果均为未验证。

## 解释边界

- 合成场景/观测与未标定参数；不得表述为真实场馆效果。
- 没有真实 AgentArts 凭证、昇腾 NPU/CANN 或真实场馆数据；相关结果仅限本地契约/CPU 链路。
- 负向与混合结果保留在各自 README、summary 与 rows 文件中。

