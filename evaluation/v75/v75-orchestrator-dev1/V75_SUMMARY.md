# SkyGuard V7.5 实验汇总

> 运行 ID：`v75-orchestrator-dev1`。全部为合成/夹具数据；不代表真实场馆/平台/硬件效果。
> 生成时间：2026-11-10T08:12:34.873Z

## Track A 突增检测
- naive3sigma：召回 1，精确率 0.8276，F1 0.9057，无变化误报率 0.2778，误报/100 步 0.746。
- cusum：召回 1，精确率 0.8054，F1 0.8922，无变化误报率 0.3222，误报/100 步 3.0556。
- adaptive_cusum：召回 1，精确率 0.7947，F1 0.8856，无变化误报率 0.3444，误报/100 步 0.5079。
- sprt：召回 1，精确率 0.7792，F1 0.8759，无变化误报率 0.3778，误报/100 步 0.7143。
- reliability_dual：召回 1，精确率 1，F1 1，无变化误报率 0，误报/100 步 0。
- dual_persist1：召回 1，精确率 0.9302，F1 0.9639，无变化误报率 0.1，误报/100 步 0.1508。
- dual_no_multisensor：召回 1，精确率 0.9524，F1 0.9756，无变化误报率 0.0667，误报/100 步 0.0476。

## Track E 多传感器融合
- best_single：可用率 0.9967，MAE 12.9875，偏差 8.9764，严格条件 unsafe fuse 率 1，良性 false fail-close 率 0.005，决策准确率 0.7744。
- mean：可用率 0.9967，MAE 12.4045，偏差 8.8293，严格条件 unsafe fuse 率 1，良性 false fail-close 率 0.005，决策准确率 0.7744。
- median：可用率 0.9967，MAE 4.6768，偏差 0.7975，严格条件 unsafe fuse 率 1，良性 false fail-close 率 0.005，决策准确率 0.7744。
- reliability_weighted：可用率 0.9967，MAE 11.9886，偏差 8.8624，严格条件 unsafe fuse 率 1，良性 false fail-close 率 0.005，决策准确率 0.7744。
- pipeline：可用率 0.7497，MAE 5.538，偏差 1.9007，严格条件 unsafe fuse 率 0，良性 false fail-close 率 0.0421，决策准确率 0.9719。
- 管线诊断：冲突 fail-closed 1，时钟偏移 fail-closed 1，过期拒绝 1200，重复拒绝 3600。

## 边界

- 合成/夹具数据；无真实场馆、平台或 NPU 证据。
- 负向/混合结果保留在各自 rows/summary/README。

