# 评估与昇腾边云笔记

## 统计评估

- 固定随机种子、多种子（5 个）、Bootstrap 置信区间、均值/方差/分位。
- 指标：MAE/RMSE、区间覆盖率、峰值误差、风险降低、信息增益、成本、延迟 p50/p95。
- 对照：持久化/EMA/线性/damped/自适应；VoI/固定/随机/启发式。
- 结果全部来源于合成数据；不得选择性报告或把模拟写成实测。

## 昇腾/CANN（S17/S19）

- 官方文档入口：`https://www.hiascend.com/document`，含 CANN 安装、ATC 模型转换、Ascend C、ACL。
- 本仓库仅实现：
  - `AscendCrowdProvider` 环境探针（CANN toolkit、npu-smi、命令/模型环境变量）；
  - 外部推理契约（stdin JSON → stdout JSON，Zod 校验）；
  - 不可用时抛 `ProviderUnavailableError`，不伪造设备。
- 未完成：真实 NPU 推理、`.om` 模型导出/验证、CANN 版本兼容、延迟/吞吐/功耗实测。

## 边云部署路径（文档级）

1. 云端：AgentArts/ModelArts Studio 负责编排与工具调用（未实机验证）。
2. 边缘：CANN + 昇腾推理运行时，模型转为 `.om`，通过 ATC 验证算子兼容。
3. 回退：无 NPU 时使用 CPU/模拟 provider，界面明确标记来源与降级。
4. 采集：设备探测、延迟、失败率、降级次数；未实测前不得写入性能结论。

## 结论

华为技术栈目前是**适配层 + 接入文档 + 模拟契约**，不是实机部署。对外表述必须遵守 C09/C12。
