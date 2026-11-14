# SkyGuard 参赛提交包

> 作品：SkyGuard——面向大型活动散场与滨水空间人群疏散的可信辅助决策研究原型
> 提交快照：2026-11-14
> 源码基线：Git `96b9abd` + 工作树未提交改动（v7.6 拆分、汉口江滩 MVP、系统仿真面板）
> 项目版本：`v7.5.0-research.1`（`VERSION`）；场景配置版本：`7.6.0`

> **先说边界**：这是研究原型，不是应急指挥系统，不能替代现场指挥员判断，不能用于真实疏散指挥。
> 场景与观测均为合成/估算数据；AgentArts、昇腾 NPU、无人机与真实场馆均未实机验证。
> 对外引用必须同时引用 [`docs/MVP_LIMITATIONS.md`](docs/MVP_LIMITATIONS.md) 与 [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md)。

## 1. 作品是什么

SkyGuard 把「人群感知 → 风险评估 → 容量约束疏散规划 → 独立安全校验 → 四态状态机 → 指挥大屏 → 人工审批 → 现场反馈」串成一条可审计、可复现的闭环：

```text
回放/模拟人流 → 异常发现 → Agent 主动调查（VoI）→ 风险与预测
→ 人员推荐 → 待审批工单 → 管理员审批/派发 → 工作人员接单/执行/反馈
→ 反馈写回观测 → 重新评估与规划
```

三个可演示的要点：

1. **预测先于响应**：短时预测、滚动重规划与稳定性机制只作为决策输入，不绕过安全校验；
2. **感知先于决策**：VoI 主动调查在预算与人员约束下选择“最值得核查”的动作；
3. **智能必须受到约束**：规划器生成方案，独立 Validator 判定硬约束，四态状态机决定可发布性；Agent 只能创建待审批工单，不能审批、派发或控制无人机。

## 2. 快跑起来

前置：Node.js 24、npm 11；Windows / Linux / macOS 均可。

```bash
npm run setup       # 安装 backend 与 frontend 依赖
npm run dev         # 后端 :8010 + 前端 :5173
```

> 提交包已把开发默认口令与开发 JWT 密钥替换为占位值。启动前请设置 `SKYGUARD_ADMIN_PASSWORD` 与 `SECRET_KEY`；占位值只适合本机演示，生产模式会拒绝。

打开：

| 页面 | 地址 | 用途 |
| --- | --- | --- |
| 指挥大屏 | `http://localhost:5173/` | 态势、决策、工单、系统仿真 |
| 管理员登录 | `http://localhost:5173/login` | 运行 Agent、审批/派发工单 |
| 工作人员任务 | `http://localhost:5173/staff` | 接单、开始执行、提交反馈 |

账号：

- 管理员：`admin`，密码来自 `SKYGUARD_ADMIN_PASSWORD`（首次启动写入 `data/admin_config.json`；部署前必须改）；
- 工作人员：`STAFF_GATE_01` … `STAFF_GATE_11`，演示登录码见默认场景文件（`CODE_G01` … `CODE_G11`，仅演示用途）。

停止：`Ctrl+C`。重置：指挥大屏「现场协同管理 → 重置」，或删除运行时 `data/mvp-state.json` 后重启。

## 3. 6–8 分钟演示路径

完整分镜见 [`docs/DEMO_SCRIPT_FRONTEND.md`](docs/DEMO_SCRIPT_FRONTEND.md)。最短路径：

1. `/login` 登录管理员；回到 `/`，指认四态徽标、五联 KPI、左中右三栏。
2. 向下到「现场协同管理 → 系统仿真」，点「启动仿真」：
   - 冷启动 `DEGRADED`（没有观测，fail-closed）；
   - 写入 44 区域基线 → `NORMAL`；
   - 客流上升 → 出口关闭 `REROUTE`；
   - 低置信观测 → `DEGRADED`，禁止发布新路线；
   - Agent 调查 → 2 个待审批工单（`Agent 不审批、不派发`）。
3. 第 7 步停在「需要人工操作」：在「审批中心与工单 → 待审批」批准现场核查工单，切到「执行中」点「自动派发」，记下指派的工号。
4. 切到 `/staff`，用该工号登录 → 接单 → 开始执行 → 提交反馈（人数、置信度、说明）。
5. 回到 `/`，点仿真面板「继续仿真」：复核补采 → `DEGRADED → REROUTE` → 解除事件 → `NORMAL`。
6. 指认仿真日志与主大屏同步刷新；说明合成观测 90 秒后过期会重新降级，这是 fail-closed，不是故障。

> 仿真数据全部由后端以 `source=simulation`、`provider=sim-live`、`evidence.synthetic=true` 写入；
> 界面永久标注「合成数据 · 非真实」。它不能替代真实场馆数据，也不能用于精度评估。

## 4. 已验证 / 未验证

### 已验证（本机，2026-11-14）

| 项 | 结果 |
| --- | --- |
| 后端测试 | **334/334** 通过 |
| 前端测试 | **17/17** 通过 |
| TypeScript | 后端/前端 typecheck 通过 |
| 构建 | 后端 `tsc` + 前端 Vite build 通过 |
| 提交包内复现 | 后端 **334/334**、前端 **17/17**、`npm run build` 通过（临时目录 + 已验证依赖，不随包分发） |
| 浏览器 E2E | 登录 → 指挥大屏 → 前端代理 API 冒烟通过（V7.5 记录） |
| 证据治理 | V7.5 最终证据 33 文件、178/178 检查；V7.2 基线 299 文件通过（随包保留摘要/清单） |
| 安全边界 | 四态、独立校验、过期审批、幂等、越权 Agent、未知不可用均有回归测试 |

### 未验证 / 不得声称

| 项 | 状态 | 禁止表述 |
| --- | --- | --- |
| AgentArts | 适配器 + 官方运行时契约 stub；**无真实租户/Trace** | “已接入 AgentArts”“平台工作流已验证” |
| 昇腾 NPU | 无 `npu-smi`/`atc`/CANN/`.om`；仅 ONNX CPU 基准 | “已完成昇腾适配”“NPU 性能” |
| 无人机 | 只有工单请求与模拟反馈 | “已控制无人机”“真实无人机巡查” |
| 真实场馆/摄像机 | 无；场景为合成/估算 | “真实场馆验证”“实时监测” |
| 预测/计数精度 | ShanghaiTech Part A 公开数据集计数评测（MAE 57.2418），不是场馆精度 | “真实场景准确率”“已证明疏散效果” |
| Docker/CI | Docker daemon 未实机；CI 未在真实仓库运行 | “已生产部署”“已通过 CI” |
| 安全认证 | 未通过消防/公共安全/功能安全认证 | “可用于实际应急指挥” |

## 5. 包里有什么

```text
.
├─ SUBMISSION.md             # 本文件：先读我
├─ VERIFICATION.md           # 本次快照的验证命令与结果
├─ MANIFEST.json             # 包内文件清单、大小与 SHA-256
├─ SHA256SUMS.txt            # 可直接用 sha256sum 校验
├─ backend/                  # Express + Zod + 安全内核 + MVP 服务 + 测试
├─ frontend/                 # React 19 + Vite + 指挥大屏 + /staff
├─ data/                     # 合成场景、标定样例、感知回放 provenance
├─ docs/                     # 技术报告、架构、限制、演示分镜、答辩库
├─ research/                 # CLAIMS、来源审计、研究日志
├─ scripts/                  # 开发与提交打包脚本
├─ evaluation/               # 后端证据测试与界面读取所需的最小最终 run
├─ evidence/                 # 关键证据（V7.5 最终、V7.2 基线摘要、报告）
└─ screenshots/              # 指挥大屏、系统仿真、工作人员页截图
```

> 为了控制提交体积，`evaluation/` 只保留后端证据测试和界面读取所需的最终 run（V6.5 预测、V6.4 VoI、competition、real-data）；完整原始实验数据与 V7.2 完整快照保留在开发仓库中。
> 所有对外数字以 `docs/` 与 `evidence/` 中的报告为准，不从截图或记忆引用。
> `MANIFEST.json` 列出除自身与 `SHA256SUMS.txt` 之外的全部文件；后者可用 `sha256sum -c SHA256SUMS.txt` 校验。

截图清单：

| 文件 | 用途 |
| --- | --- |
| `screenshots/01-command-center.png` | 指挥大屏冷启动：无观测时 `DEGRADED`，不假装知道现场 |
| `screenshots/02-simulation-awaiting.png` | 仿真第 7 步：Agent 已建单，等待人工审批与现场反馈 |
| `screenshots/03-staff-feedback.png` | `/staff` 现场反馈：人数与置信度写回观测 |
| `screenshots/04-command-center-normal.png` | 反馈写回后 `NORMAL`，44/44 可信，方案通过独立校验 |
| `screenshots/05-simulation-finished.png` | 仿真结束日志：补采基线、事件解除、状态复位 |

重拍命令（需先 `npm run dev`，并临时设置 `SKYGUARD_ADMIN_PASSWORD`，不要把密码写进文件）：

```bash
node frontend/e2e/capture-submission.mjs --out submission/screenshots
```

## 6. 复现与校验

在包根目录执行：

```bash
npm run setup
npm test
npm run build
npm run demo:mvp
npm run benchmark:v75 --prefix backend     # 可选：重跑 V7.5 合成实验（会写入新证据目录）
npm run verify:evidence                    # 可选：需要完整 evaluation/ 数据，提交包只带最小最终 run
```

本包根目录的 `VERIFICATION.md` 记录了本次快照实际执行的命令与结果；`MANIFEST.json` 可用于确认文件未在传输中损坏。

## 7. 证据与主张的对应

| 主张 | 证据 | 边界 |
| --- | --- | --- |
| 安全约束下的闭环 | `backend/tests/safety/*`、`backend/tests/mvp/*`、V7.5 证据 | 合成场景；不证明现场安全 |
| 独立校验与四态 | `validator.ts`、`state-machine.ts`、状态机用例 | 不替代现场指挥员 |
| VoI 主动调查 | `voi.ts`、`multi-voi.ts`、`evaluation/voi-v2/`、V6.2/V6.4 报告 | 参数未标定；不宣称普遍优于基线 |
| 多区域风险协同 | `risk-graph.ts`、V6.2 30 种子；V6.4 公平复跑 | 效应量受信息权限影响 |
| 路线稳定性 | `v73-stability.ts`、V7.3/V7.5 证据 | 有代价；部分配置为负结果 |
| 低误报检测/融合 | `detection/surge.ts`、`fusion/fusion.ts`、V7.5 证据 | 合成机制；可用率有下降 |
| Agent 权限边界 | `ops.ts`、Agent 测试、MCP 15 工具 | AgentArts 未实机 |
| 感知回放 | `data/perception/*/PROVENANCE.json` | 非实时、无真值、许可待核 |

主张等级与负结果以 [`research/CLAIMS.md`](research/CLAIMS.md) 为准；本文只做索引。

## 8. 提交前还需要人工完成

- [ ] 填写队伍名称、学校、成员、指导教师（本包不预填个人信息）；
- [ ] 录制 6–8 分钟演示视频（分镜已就绪；系统仿真面板可直接作为主线）；
- [ ] 按组委会要求导出 PDF/PPT（本包提供 Markdown 源与截图）；
- [ ] 在干净机器上执行一次 `npm run setup && npm test && npm run build`，并设置 `SKYGUARD_ADMIN_PASSWORD` / `SECRET_KEY`；
- [ ] 确认航拍底图/第三方数据许可，不要随包分发未授权图片；
- [ ] 如取得 AgentArts 租户或昇腾实机，按 `docs/AGENTARTS_INTEGRATION.md` / `docs/ASCEND_DEPLOYMENT.md` 更新证据后再替换“未验证”表述。

## 9. 团队与联系

- 队伍：`[待填写]`
- 学校：`[待填写]`
- 成员：`[待填写]`
- 指导教师：`[待填写]`
- 仓库/视频链接：`[待填写]`

> 本包不包含真实密码、令牌、内网地址或未授权数据。`data/admin_config.json`、`.env` 与运行时审计日志均不随包分发。
