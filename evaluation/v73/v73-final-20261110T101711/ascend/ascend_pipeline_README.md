# V7.3 Ascend/ONNX/OM 部署链路证据

> 运行 ID：`v73-final-20261110T101711`。**没有 NPU 不等于可以推测 NPU；所有 NPU/OM 结论必须来自实机证据。**

## 1. 环境探测

| 项 | 状态 |
| --- | --- |
| npu-smi | 不可用 |
| atc | 不可用 |
| ASCEND_HOME_PATH/CANN_HOME | 未设置 |
| onnx | 1.23.2 |
| onnxruntime | 1.29.0 |

## 2. ONNX 链路

- 状态：executed_cpu_only
- ONNX SHA-256：3837d2523cc688c2b5a931dfa2b89830186527b11cee340047243a32cdd14baa
- ONNX checker：{"available":true,"valid":true,"error":null}
- CPU 基准：p50=0.011ms，p95=0.0165ms，max_abs_diff=0

## 3. OM/NPU

- 状态：not_executed_missing_atc_or_npu
- 模板：om-metadata.template.json
- 模板校验：invalid（errors=1）
- ATC 命令模板：`atc --model=forecast_linear.onnx --framework=5 --output=forecast_linear --soc_version=Ascend910B3（模板占位，未实机） --input_shape="history:1,12" --log=error`
- 边界：未检测到昇腾 NPU/CANN/atc；ONNX 仅 CPUExecutionProvider；OM/NPU 结果未验证。

## 4. 结论

- ONNX 导出/checker/CPU 基准是可复现的；**不是 NPU 性能**；
- 没有 OM 文件、CANN 版本、ATC 日志或 NPU 延迟/内存数据；
- 要标记 `npu_verified`，必须提供 `device_evidence.npu_smi_available=true`、设备型号/驱动/CANN 版本、
  `benchmark.executed_on="npu"`、p50/p95/内存与数值一致性；
- 本证据不构成昇腾实机验证。
