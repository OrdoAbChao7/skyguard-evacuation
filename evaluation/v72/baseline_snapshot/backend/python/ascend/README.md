# Ascend / ONNX 部署链路（V7.2）

> **边界：当前环境没有昇腾 NPU、CANN 或 `atc`；这里只有 ONNX 导出脚本、CPU 推理基准与转换命令模板。**
> 不得把本目录任何结果表述为昇腾实机推理、吞吐或时延。

## 1. 参考模型

`export_forecast_onnx.py` 导出一个确定性的线性趋势外推模型（输入 12 分钟历史，输出未来 5 分钟），
用于验证 ONNX 导出、数值一致性与 ATC 输入契约。它是**参考模型**，不是 SkyGuard 生产预测器。

```bash
pip install --only-binary=:all: -r backend/python/ascend/requirements-v72.txt
python backend/python/ascend/export_forecast_onnx.py --out evaluation/v72/<run>/ascend
python backend/python/ascend/benchmark_onnx.py --model-dir evaluation/v72/<run>/ascend --out evaluation/v72/<run>/ascend
```

`benchmark_onnx.py` 只使用 `CPUExecutionProvider`，输出 p50/p95 延迟与 `max_abs_diff` 数值一致性；
任何 CPU 结果都不能替代 NPU 证据。

## 2. ATC 转换模板（未在当前环境执行）

在安装对应 CANN toolkit 的昇腾主机上：

```bash
atc --model=forecast_linear.onnx \
    --framework=5 \
    --output=forecast_linear \
    --soc_version=Ascend910B3 \
    --input_shape="history:1,12" \
    --log=error
```

记录并随证据提交：

- 设备型号（如 Ascend 310P/910B）与驱动版本；
- CANN toolkit 版本、`atc --version`；
- 导出 ONNX 的 SHA-256 与 `forecast_linear_metadata.json`；
- `atc` 完整命令、日志与 `.om` SHA-256；
- NPU 推理基准（`npu-smi info` 前后快照、延迟/吞吐/内存、数值一致性）。

## 3. 与生产预测器的关系

生产预测（Kalman/ARIMA/Holt-Winters/在线 LSTM/集成）在 TypeScript 服务中运行。
若未来要把在线 LSTM 迁移到 NPU，需要：

1. 固定 PyTorch/ONNX 导出脚本与权重版本；
2. 用同一批输入对 CPU 与 NPU 输出做逐元素一致性检查；
3. 记录 CANN 版本与算子支持情况；
4. 重新跑 V7.x 预测实验，确认精度与区间未被转换改变。

在这些完成前，`research/CLAIMS.md` 中的昇腾条目必须保持 UNVERIFIED。
