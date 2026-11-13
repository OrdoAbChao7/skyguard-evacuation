# evaluation/v71 — V7.1 实验证据

> 全部为**合成/模拟数据**；不代表真实场馆效果。根目录 `MANIFEST.json` 记录本次运行全部文件 SHA-256。
> `LATEST.txt` 指向最近一次完整运行。

## 目录结构

```text
evaluation/v71/<run-id>/
  prediction_rows.json / prediction_summary.json / prediction_README.md / prediction_MANIFEST.json
  replanning_rows.json / replanning_summary.json / replanning_README.md / replanning_MANIFEST.json
  V71_SUMMARY.md
  MANIFEST.json
  run_metadata.json
```

- `prediction_*`：30 种子 × 7 机制；V7.0 静态区间 vs ACI vs ACI+变点；
- `replanning_*`：30 种子 × 5 场景 × 9 策略（A-G + H/I）；
- `*_rows.json`：逐种子/逐场景原始记录，失败案例保留；
- `*_summary.json`：聚合、配对、Bootstrap、Holm、敏感性、机制归因。

## 复现

```bash
npm run benchmark:v71
```

单独运行：

```bash
npm run benchmark:v71 -- --only=prediction
npm run benchmark:v71 -- --only=replanning
```

## 边界

- 预测：合成机制；区间非正式置信区间；ACI 改善尾部覆盖但整体覆盖无显著提升；
- 规划：合成场景/入流；BPR/服务衰减/事件阈值未标定；预测/队列反馈无显著增量；
- 不得把本目录任何数字表述为真实场馆疏散效果、预测精度或平台/硬件实机结果；
- 不得只引用有利指标；负向与混合结果在 README/summary/rows 中保留。
