# evaluation/v74 — V7.4 证据

> 版本 `v7.4.0-research.1`。所有数据为**合成场景 + 夹具**；不含真实场馆、AgentArts 实机或昇腾 NPU 证据。

## 目录

- `v74-final-20261110T105851/`：最终运行（31 文件，`MANIFEST.json` 根清单）。
- `v74-stability-dev/`、`v74-surge-dev*/`、`v74-calibration-dev/`、`v74-production-dev/`：开发运行，保留但非最终引用。

## 最终运行内容

| 文件 | 内容 |
| --- | --- |
| `V74_SUMMARY.md` | 一页汇总 |
| `stability_summary.json` | A-F 总体、配对 CI、Holm、机制、场景分层 |
| `stability_rows.json` | 240×6 原始行 |
| `surge_summary.json` / `surge_rows.json` | CUSUM vs 3σ，30 种子 × 4 机制 |
| `calibration_quality.json` | 时钟同步/缺失/可靠性/动态容量 |
| `ascend/` | ONNX、CPU 基准、ATC/OM 模板 |
| `agentarts_status.json` | 真实平台状态与 stub 证据 |
| `production_checks.json` | Docker/CI/API/负载 |
| `browser_e2e.json` / `.png` | 登录→指挥中心→代理 API |
| `*_MANIFEST.json` | 分项 SHA-256 |
| `run_metadata.json` | 主机/Node/运行配置 |

## 复查

```bash
npm run verify:evidence --prefix backend
```

只读校验根清单与各分项哈希；不会重跑实验。V7.2 基线快照另由
`npm run freeze:verify:baseline --prefix backend` 校验。

## 引用规则

1. 稳定性数字必须带「合成、n=240 配对」；
2. 必须同时报告切换下降与完成时间/队列代价；
3. 零容差门控的负结果必须一并呈现；
4. 风险敏感惩罚写「NOT_SUPPORTED」；
5. Docker/AgentArts/NPU 分别写 BLOCKED / stub / CPU；
6. 不得把 `v74-*-dev` 运行当作最终证据。
