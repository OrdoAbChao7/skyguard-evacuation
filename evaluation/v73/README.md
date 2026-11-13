# evaluation/v73 — V7.3 实验证据

> 全部为**合成/夹具数据**；不代表真实场馆、平台或硬件效果。
> 根 `MANIFEST.json` 记录本次运行全部文件 SHA-256（含 `ascend/` 子目录）。
> `LATEST.txt` 指向最近一次完整运行。

## 目录结构

```text
evaluation/v73/<run-id>/
  stability_rows.json / stability_summary.json / stability_README.md / stability_MANIFEST.json
  calibration_import*.json|md
  shadow_ops_rows.json / shadow_ops_summary.json / shadow_ops_README.md / shadow_ops_MANIFEST.json
  ascend/forecast_linear.onnx / onnx_cpu_benchmark.json / ascend_pipeline.json / om-metadata.template.json
  agentarts_status.json / agentarts_status_README.md / agentarts_MANIFEST.json
  V73_SUMMARY.md
  MANIFEST.json
  run_metadata.json
```

## 复现

```bash
npm run benchmark:v73
npm run benchmark:v73 --prefix backend -- --only=stability
```

## 边界

- 稳定性/入流/动态容量/惩罚参数为合成或未标定；
- 导入只有夹具，没有真实数据；
- Shadow 为适配器层，默认关闭；
- AgentArts 为本地 stub；Ascend 为 CPU ONNX；
- 不得只引用有利指标；负向/混合结果保留在 rows/summary/README。
