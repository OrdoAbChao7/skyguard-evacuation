# evaluation/v72 — V7.2 实验证据

> 全部为**合成/模拟数据**；不代表真实场馆效果。
> 根目录 `MANIFEST.json` 记录本次运行全部文件 SHA-256（含 `ascend/` 子目录）。
> `LATEST.txt` 指向最近一次完整运行。

## 目录结构

```text
evaluation/v72/<run-id>/
  stability_rows.json / stability_summary.json / stability_README.md / stability_MANIFEST.json
  calibration_validation.json / calibration_application.json / calibration_estimates.json
  calibration_observations.json / calibration_evidence.json / calibration_README.md / calibration_MANIFEST.json
  shadow_stress_rows.json / shadow_stress_summary.json / shadow_stress_comparisons.json
  shadow_stress_README.md / shadow_stress_MANIFEST.json
  huawei_status.json / huawei_agentarts.json / huawei_ascend.json / huawei_status_README.md / huawei_MANIFEST.json
  ascend/forecast_linear.onnx / forecast_linear_metadata.json / onnx_cpu_benchmark.json
  V72_SUMMARY.md
  MANIFEST.json
  run_metadata.json
```

- `stability_*`：30 种子 × 6 场景 × 6 策略（A-F），含运行中出口故障；
- `calibration_*`：合成场馆标定档案校验、应用、参数估计、观测适配器；
- `shadow_stress_*`：10 种子 × 4 场景 × 6 注入模式（240 次）；
- `huawei_*`：AgentArts 真实平台状态 + 本地契约 stub + Ascend/ONNX 探测与 CPU 基准。

## 复现

```bash
npm run benchmark:v72
```

单独运行：

```bash
npm run benchmark:v72 -- --only=stability
npm run benchmark:v72 -- --only=calibration
npm run benchmark:v72 -- --only=shadow
npm run benchmark:v72 -- --only=huawei
```

Ascend/ONNX 依赖：

```bash
pip install --only-binary=:all: -r backend/python/ascend/requirements-v72.txt
```

## 边界

- 预测/入流/拥堵/稳定性参数均为合成或未标定启发式；
- 承诺式求解是贪心多商品近似；双向共享容量是迭代启发式；
- 标定档案为合成；没有真实测绘/摄像机/授权数据；
- Shadow 为适配器层回放，不覆盖真实并发/持久化；
- ONNX 为 CPUExecutionProvider，不是昇腾 NPU 实机；
- 不得把本目录任何数字表述为真实场馆疏散效果、平台/硬件实机结果；
- 不得只引用有利指标；负向与混合结果在 README/summary/rows 中保留。

## 版本冻结

- 项目版本：根目录 `VERSION`（`v7.2.0-research.1`）；
- 冻结清单：`freeze_v72.json`（范围、文件 SHA-256、Git HEAD、工作树状态、运行时版本）；
- 逐文件哈希：`BASELINE_SHA256`；
- 证据运行哈希：`SHA256SUMS`；
- 校验：`npm run freeze:verify --prefix backend`。

冻结后不得改写本目录 `v72-final-*` 运行内文件；任何改动必须提升 `VERSION` 并重新生成冻结清单。
`LATEST.txt` 是可变指针，不属于冻结范围。
