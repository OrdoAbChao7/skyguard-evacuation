# 证据与数据治理

> 目标：原始实验数据只读、可追溯、可复算；不为了缩小仓库而牺牲可复现性。

## 1. 分层

| 层 | 内容 | 位置 | 规则 |
| --- | --- | --- | --- |
| raw | 每次运行产生的原始 JSON（含 per-trial 记录） | `evaluation/v61/`、`evaluation/v6/`、`evaluation/competition/`、`evaluation/mvp/` | 不手工修改；只由脚本生成 |
| summary | 复算结果、校验结果、性能数据 | `evaluation/v61/verification.json`、`evaluation/performance.json` | 可由 raw 复算 |
| report | 人类可读报告 | `evaluation/*_REPORT.md`、`evaluation/DATA_MANIFEST.md` | 数字必须来自 raw/summary |

当前尚未物理移动目录；上表是逻辑分层。未来迁移时只改脚本输出路径与文档引用，不删除 raw。

## 2. 体积与压缩（2026-11-05）

- V6.2 最终：evaluation 共 **46 个证据文件，31.85 MiB** 原始大小。
- gzip 估算 **1.66 MiB**，压缩比约 94.8%。
- 最大文件：`evaluation/v61/experiment_a_fair_multi_region.json`（约 9.6 MiB）、
  `experiment_b_sequential_audit.json`（约 6.7 MiB）、`evaluation/v62/experiment_a_multi_region_30seeds.json`。
- 建议：原始 JSON 继续以明文保存以便审阅；发布归档时同时提供 `.tar.gz`；
  未来超大数据可转 JSONL/Parquet，但必须保留生成脚本与字段说明。

## 3. 清单与完整性

```powershell
npm run manifest:evidence --prefix backend          # 生成 MANIFEST.json + DATA_MANIFEST.md
npx tsx backend/scripts/evidence-manifest.ts --verify   # 校验大小与 SHA-256
npm run verify:evidence --prefix backend            # 从 raw 复算关键统计量
```

- 清单字段：路径、字节数、gzip 字节、SHA-256、层级、生成脚本。
- verify 失败会以非零退出码结束。
- 重新生成实验会改变 `generated_at`/耗时字段；统计量应保持一致，由 `verify:evidence` 检查。

## 4. 再生成命令

| 数据 | 命令 |
| --- | --- |
| 竞赛基准 | `npm run benchmark:competition --prefix backend` |
| V6 | `npm run benchmark:v6 --prefix backend` |
| V6.1 | `npm run benchmark:v61 --prefix backend` |
| 性能 | `npm run bench:safety --prefix backend` |

所有脚本使用固定种子（见各自 `run_metadata.json`），并写入 Git HEAD、Node 版本、平台与 CPU。

## 5. .gitignore 策略

- 忽略运行时数据：`data/audit/`、`data/admin_config.json`、`data/ops-state.json`；
- 忽略临时/日志：`*.log`、`*.tmp`、`evaluation/**/*.tmp`；
- **不忽略** `evaluation/**/*.json` 与报告；它们是证据。
- 大文件进入仓库前必须评估压缩比与可复现性，并在 MANIFEST 登记。

## 6. 禁止事项

- 不手工编辑 raw JSON；
- 不删除“看起来不利”的实验数据；
- 不用汇总报告替代原始数据；
- 不把模拟数据写成真实实测。
