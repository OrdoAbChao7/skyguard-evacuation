# evaluation/v70 — V7.0 实验证据

> 全部为**合成/模拟数据**；不代表真实场馆效果。根目录 `MANIFEST.json` 记录本运行全部文件的 SHA-256。
> `LATEST.txt` 指向最近一次完整运行。

## 目录结构（每次运行一个子目录）

```text
evaluation/v70/<run-id>/
  prediction_rows.json / prediction_summary.json / prediction_README.md / prediction_MANIFEST.json
  planning_rows.json   / planning_summary.json   / planning_README.md   / planning_MANIFEST.json
  joint_voi_rows.json  / joint_voi_summary.json  / joint_voi_README.md  / joint_voi_MANIFEST.json
  V70_SUMMARY.md
  MANIFEST.json
  run_metadata.json
```

- `*_rows.json`：逐种子/逐 trial 原始记录（失败案例保留）；
- `*_summary.json`：聚合统计、配对比较、Holm 校正、敏感性、消融、Oracle；
- `*_README.md`：人类可读报告；
- `*_MANIFEST.json`：该组证据的独立文件清单；
- `MANIFEST.json`：本次运行根清单。

## 复现

```bash
npm run benchmark:v70
```

单独运行：

```bash
npm run benchmark:v70 -- --only=prediction
npm run benchmark:v70 -- --only=planning
npm run benchmark:v70 -- --only=joint-voi
```

## 边界

- 预测：合成机制，区间非正式置信区间；surge 95% 覆盖低于名义值；
- 规划：合成入流、未标定 BPR/出口服务衰减、即时响应假设；
- 联合 VoI：合成相关性、启发式近似；
- 不得把本目录任何数字表述为真实场馆疏散效果、预测精度或平台/硬件实机结果。
