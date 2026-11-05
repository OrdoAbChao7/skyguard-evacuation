# SkyGuard V6.2 基线冻结说明

> 冻结对象：V6.2 源码、配置、原始实验与报告（不含叙事文档与 V6.3 新实验）。  
> 冻结方式：内容 SHA-256 清单；**不是 Git commit**（V6.2 仍在未提交工作区）。

## 1. 冻结元数据

| 项 | 值 |
| --- | --- |
| Git HEAD | `3b62fe94bd03406532398dfbdcc6812bf669544d` |
| 分支 | `feat/skyguard-mvp-e2e` |
| 工作区 | staged 0；unstaged 28；untracked 18 条目 / 31 文件；status 46 条目 |
| 冻结文件 | **151** |
| 冻结字节 | **34,403,582** |
| 清单 | `evaluation/v62/freeze_v62.json`、`evaluation/v62/BASELINE_SHA256` |
| 冻结时间 | 2026-11-05 |

## 2. 冻结范围

- 源码：`backend/src`、`backend/scripts`、`backend/tests`、`frontend/src`
- 配置：根/后端/前端 `package.json`、TypeScript/Vite/Vitest 配置、`data/scenarios`、`data/replays`
- 实验：`evaluation/v61`、`evaluation/v62`、`evaluation/v6`、`evaluation/competition`、`evaluation/mvp`
- 报告：`evaluation/V6_2_REPORT.md`、`V6_1_REPORT.md`、`COMPETITION_REPORT.md`、`evaluation/MANIFEST.json`、`evaluation/DATA_MANIFEST.md`、`RELEASE_AUDIT_FINAL.md`、`RELEASE_AUDIT_REPORT.md`

**不在冻结范围**：`docs/` 叙事文档（允许更新）、`research/`（允许补充来源）、`evaluation/real-data/`（V6.3 新实验）、`node_modules`、`dist`、运行时数据。

## 3. 校验

```bash
cd <repo>
sha256sum -c evaluation/v62/BASELINE_SHA256 --quiet
```

- 退出码 0 表示 151 个文件全部未变。
- 已有证据清单另由 `npx tsx backend/scripts/evidence-manifest.ts --verify` 校验（46/46）。
- `verify:evidence` 对文本文件同时接受 LF 与 CRLF 归一后的哈希，适配 Windows/Linux checkout；
  `sha256sum -c` 是严格字节比较，不作为跨平台 CI 门禁。
- V6.1 独立冻结：`evaluation/v61/FREEZE.sha256`（raw 实验，不含派生 verification）。

## 4. 复现命令

```powershell
npm run test --prefix backend
npm test --prefix frontend
npm run build
npm run demo
npm run demo:mvp
npm run benchmark:competition --prefix backend
npm run benchmark:v6 --prefix backend
npm run benchmark:v62 --prefix backend
npm run verify:evidence --prefix backend
npm run manifest:evidence --prefix backend
npx tsx backend/scripts/evidence-manifest.ts --verify
```

V6.1 复跑必须设置 `V61_OUT_DIR` / `V61_REPORT_PATH` 到临时目录，避免覆盖冻结数据。

## 5. 已知限制

- 冻结是工作区内容哈希，不是可引用的 Git 提交；V6.2 仍未提交。
- 原始 JSON 约 34.4 MB；gzip 归档可显著减小，但归档不得替代原始数据。
- 合成数据，不代表真实场地；AgentArts/昇腾/真实数据集未验证。
- `/docs` 与 `research` 不在冻结内，状态变化需在 `docs/PROJECT_STATUS.md` 记录。
