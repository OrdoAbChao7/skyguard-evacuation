# 提交包验证记录

> 生成时间：2026-11-14（Asia/Shanghai）
> 源码基线：Git `96b9abd1bc427e312caa3876c455dd987934b1e1` + 工作树未提交改动（37 项）
> 项目版本：`v7.5.0-research.1`；场景配置版本：`7.6.0`
> 验证环境：Windows 11，Node.js v24.19.0，npm 11.17.0

## 1. 测试与构建

| 命令 | 结果 |
| --- | --- |
| `npm test`（根目录） | 后端 **334/334** 通过；前端 **17/17** 通过（4 个测试文件） |
| `npm run build` | 后端 `tsc` 通过；前端 `tsc --noEmit && vite build` 通过（1821 modules，约 0.33s） |
| `npm run typecheck --prefix backend` | 通过（无输出错误） |

## 2. 证据与冻结基线

| 命令 | 结果 |
| --- | --- |
| `npm run verify:evidence --prefix backend` | **178/178 checks passed**；`git=96b9abd1` |
| `npm run freeze:verify:baseline --prefix backend` | **OK: 299 files, 11,818,437 bytes, version v7.2.0-research.1** |

说明：

- `verify:evidence` 校验的是仓库内已冻结的证据与汇总数字，不重新运行实验；
- `freeze:verify:baseline` 校验 `evaluation/v72/baseline_snapshot/` 的完整性与冻结版本；
- 提交包只保留 V7.2 基线的 `SNAPSHOT.json` 与 `VERSION` 摘要；完整 299 文件快照留在开发仓库，不随包分发（避免把开发默认凭证副本带入包内）；
- 当前工作树是 v7.6 演示层，**不应用** `freeze:verify` 去要求当前源码与 V7.2 基线逐文件一致；该命令会按设计报告差异。

## 3. 浏览器手动验证

本次在 Chrome（1920×1080）中实际走通：

1. 管理员登录 `/login`；
2. 「现场协同管理 → 系统仿真」启动 9 步仿真；
3. 第 7 步暂停，批准现场核查工单并在「执行中」自动派发；
4. `/staff` 以 `STAFF_GATE_04` 登录，接单 → 开始执行 → 提交反馈；
5. 回到 `/` 点「继续仿真」，日志出现 `补采 43 个区域基线；保留 1 个`，状态 `DEGRADED → REROUTE → NORMAL`；
6. 主大屏、仿真面板与工单列表同步刷新；无前端运行时异常。

> 浏览器验证为手动冒烟，不等同于自动化 E2E 覆盖率。仓库已有 `frontend/e2e/smoke.mjs` 冒烟脚本，可在 `npm run dev` 后单独运行。

### 3.1 自动截图复核

`frontend/e2e/capture-submission.mjs` 于同日实际跑通同一闭环并生成提交用截图：

| 截图 | 内容 | 最终状态 |
| --- | --- | --- |
| `01-command-center.png` | 指挥大屏冷启动 | `DEGRADED`（无观测，fail-closed） |
| `02-simulation-awaiting.png` | 仿真第 7 / 9 步 | `DEGRADED`，2 个待审批工单 |
| `03-staff-feedback.png` | 工作人员填写现场反馈 | 执行中 |
| `04-command-center-normal.png` | 反馈写回并恢复后的大屏 | `NORMAL`，44/44 可信，方案已校验 |
| `05-simulation-finished.png` | 仿真结束日志 | `NORMAL`，补采 0 / 保留 44 |

- 脚本要求 `SKYGUARD_ADMIN_PASSWORD` 环境变量，不把密码写入文件或截图；
- 本机同时开着其他浏览器标签时，默认 300 次/分钟读接口限流会返回 429；页面 `page_errors` 为空，截图与最终状态不受影响。单浏览器稳态实测约 87 次 GET/分钟，低于默认上限；多标签/多端同时观看时可按部署需要调整 `RATE_LIMIT_MAX`。

## 4. 本次未验证 / 不得声称

- AgentArts：无真实租户、API Key、已发布运行时或平台 Trace；仅有官方契约 stub 与本地回退；
- 昇腾：无 `npu-smi`/`atc`/CANN/`.om`；仅有 ONNX CPU 基准；
- 无人机：无真实设备，只有工单请求与模拟反馈；
- 真实场馆/摄像机/授权人流：无；场景、观测、标定均为合成/估算；
- Docker/CI：Docker daemon 未实机；CI 未在真实仓库运行；
- 第三方安全评审、消防/公共安全认证、真实演练：均无。

以上限制以 `docs/MVP_LIMITATIONS.md`、`docs/LIMITATIONS.md` 与 `research/CLAIMS.md` 为准；提交材料不得删除或弱化这些表述。

## 5. 证据版本说明

- 最新冻结实验证据为 **V7.5**（`evaluation/v75/v75-final-20261110/`，33 个根文件，生成于 2026-11-10）；
- 当前源码快照包含 v7.6 拆分、汉口江滩 MVP 与系统仿真面板；**本轮未重新生成 V7.5 原始实验**；
- 因此：代码测试与证据校验均针对当前快照通过，但实验数字仍引用 V7.5 证据及其报告，不把 v7.6 演示层写成新的实验结论。

## 6. 提交包凭证处理

- 提交包生成时对**包内副本**执行凭证脱敏：开发默认管理员口令与开发 JWT 密钥替换为显式占位值；
- 源码、测试、文档与截图脚本同步替换，包内测试仍使用同一占位值；**开发仓库本身未被修改**；
- 运行提交包前必须设置 `SKYGUARD_ADMIN_PASSWORD` 与 `SECRET_KEY`（生产模式会拒绝占位值与过短值）；
- 包内不包含 `.env`、`data/admin_config.json`、JWT、审计日志或真实用户数据。

## 7. 提交包内复现（2026-11-14）

在临时目录复制提交包，使用开发仓库依赖（junction，**不随包分发**）运行：

| 命令 | 结果 |
| --- | --- |
| `npm test --prefix backend` | **334/334** 通过 |
| `npm test --prefix frontend` | **17/17** 通过（4 个测试文件） |
| `npm run build` | 后端 `tsc` + 前端 Vite build 通过（1821 modules） |

说明：

- 这是“包内容 + 已验证依赖”的复现，不是全新机器上的 `npm ci`；干净机器复现仍列为提交前人工步骤；
- 包内保留了后端证据测试所需的 `evaluation/v65`、`evaluation/voi-v2` 最终 run，以及 `evaluation/competition`、`evaluation/real-data` 和 `data/perception/citystreet-display/PROVENANCE.json`；
- `verify:evidence` 与 `freeze:verify:baseline` 需要完整 `evaluation/` 与 V7.2 完整快照，提交包只保留摘要/最小最终 run，因此这两项以第 2 节开发仓库结果为准；
- 临时目录与依赖 junction 在测试后删除，未进入提交包。
