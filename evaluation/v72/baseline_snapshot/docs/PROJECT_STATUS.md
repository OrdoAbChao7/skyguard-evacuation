# SkyGuard 项目当前状态

> **唯一事实来源（Single Source of Truth）**：本文件描述项目当前真实状态。  
> 研发规则与长期目标见 [`AGENTS.md`](../AGENTS.md)；安全边界见 [`LIMITATIONS.md`](LIMITATIONS.md)、[`MVP_LIMITATIONS.md`](MVP_LIMITATIONS.md)；
> 技术主张等级见 [`research/CLAIMS.md`](../research/CLAIMS.md)。  
> 最后核对：2026-11-09（数据来自仓库文件与脚本，不复制旧报告）。

## 1. 项目定位

SkyGuard 是面向**大型活动散场**场景的主动感知、风险评估与可信疏散辅助决策**研究原型**。

长期目标是构建融合 AI Agent、主动感知、多区域风险协同决策、华为昇腾边缘推理与人工安全审批的完整系统，
争取达到华为 ICT 创新赛全国一等奖竞争力。

> **一等奖是研发目标，不是已取得的成绩，也不是可以保证的结果。**

当前**不是** Production Ready，不是应急指挥系统，不能替代现场指挥员判断，不能用于真实疏散指挥。

## 2. 当前研发阶段

| 阶段 | 已实现 |
| --- | --- |
| MVP | 完整业务闭环：感知 → 预测 → VoI → 人员/工单 → 审批 → 执行 → 反馈 → 重新评估 |
| V6 | 多区域风险图、联合 VoI、序贯调查、空间预测、MCP 15 工具 |
| V6.1 | 科研级审计、公平预算实验、统计纠偏、严格滚动预测、来源审计 |
| V6.2 | 30 个独立随机种子、V6.1 证据冻结、URL 来源审计、数据治理、竞赛交付；证据冻结 |
| V6.3 | 一致性审计、V6.2 基线冻结、真实公开数据集评测（ShanghaiTech Part A） |
| V6.4 | 公平 VoI 复跑（相同动作覆盖 + 观测采样）、AgentArts 官方契约与有界多步、MCP HTTP 共享状态、预算与证据生命周期加固 |
| V6.5 | 资源预留与工单闭环、统一事务状态与崩溃恢复、AgentArts 重试/SSE、V6.5 预测实验、感知→决策适配器、安全与部署加固 |
| V7.0 | 研究级预测集成（Kalman/ARIMA/Holt-Winters/在线 LSTM/regime/conformal/漂移）、时间扩展 MPC、拥堵执行反馈、联合 VoI、四个只读预览 API、30 种子实验 |
| V7.1 | 滚动重规划机理 A-G、事件触发与路线稳定性、ACI+变点预测区间、Shadow Mode（默认关闭）、出口/通道/双向压力与红队、数据集许可核验 |
| V7.2 | 路线稳定性 A-F（迟滞/切换惩罚/承诺/自适应）、承诺式求解与紧急覆盖、双向共享容量修正、场馆标定流水线、Shadow 回放压力、AgentArts 契约 stub + ONNX CPU 链路、红队加固 |

**当前定位：Research Prototype Candidate（科研原型候选版本）+ 真实数据感知评测（单一公开数据集）+ V7.2 Shadow-ready-for-review（默认关闭），不是 Production Ready。**

## 3. V6.2 实际成果（经仓库文件复核）

### 3.1 证据与可复现性

| 项 | 实际值 | 来源 |
| --- | --- | --- |
| 独立随机种子 | **30**（`20261105`–`20261134`） | `evaluation/v62/run_metadata.json` |
| 证据文件 | **46** | `evaluation/MANIFEST.json` |
| 原始体积 | **33,399,438 bytes ≈ 31.85 MiB** | 同上 |
| gzip 估算 | **1,743,583 bytes ≈ 1.66 MiB** | 同上 |
| SHA-256 完整性 | **46/46** | `manifest:evidence --verify` |
| 实验一致性 | **134/134** | `verify:evidence` |
| V6.1 冻结复跑 | **5/5 实验统计量一致** | `evaluation/v62/v61_replay_comparison.json` |
| 后端测试 | **104/104** | `evaluation/release/v62_backend_tests.log` |
| 前端测试 | **8/8** | `evaluation/release/v62_frontend_tests.log` |
| TypeScript / 构建 / Demo / MVP Demo / Benchmark | 全部通过 | `evaluation/release/test_results_v62.tsv` |

### 3.2 统计口径（必须按此引用）

多区域 VoI（30 seeds × 40 trials = **1200 配对**，目标轮换策略）：

| 指标 | 多区域 | 单区域 |
| --- | --- | --- |
| 风险降低均值 | **0.2154** [0.2106, 0.2201] | **0.0472** [0.0456, 0.0487] |
| 成本均值 | 0.5838 | 0.2528 |
| 效率（收益/成本） | 0.3785 | 0.2868 |
| 覆盖区域 | 6.74 | 1.59 |
| 最坏区域终风险 | 0.0932 | 0.1094 |

- 配对差 trial 级：**0.1682** [0.1636, 0.1728]，Cohen's d_z=**2.06**。
- 聚类 Bootstrap（按 seed）：**[0.1626, 0.1737]**。
- 效率差：**+0.0917** [0.0755, 0.1079]。
- **注意**：单区域风险降低均值是 **0.0472，不是 0**；`0` 不是本项目记录过的单区域均值。
- **设计敏感性**：V6.1 同目标策略下效率差不显著（V6.1 单区域 0.030 / 多区域 0.189）；V6.2 轮换目标后效率差为正。
  两套结果必须并列报告，不能只引用有利的一套。

序贯调查（30 seeds × 60 trials，失败率 0.3，2 次尝试预算）：

| 指标 | 实际值 |
| --- | --- |
| 任务成功率（至少一次信息性证据） | **0.9089** |
| 风险检测准确率（后验最大假设=真实假设） | **0.7767** |
| 决策准确率（后验最优决策=真实最优） | **0.9600** |
| 预算耗尽率 | **0.0911** |
| 平均尝试次数 | 2.0 |
| 平均失败次数 | 0.609 |

- **90.89% 是“任务成功率”，不是“风险检测正确率”**；9.11% 是“两次尝试内未获得信息性证据”的比例。
- 相同尝试预算下，重试与不重试的成功率没有差异；V6 的 91% vs 68.6% 是 2 次 vs 1 次尝试的差异，不是重试效应。

### 3.3 V6.3 真实数据感知评测（新增）

- 数据集：ShanghaiTech Part A 官方 test split，182 图。
- 模型/权重：P2PNet 官方仓库 + 官方 SHTechA 权重，CPU。
- 结果：**MAE 57.2418 / RMSE 96.0415 / NAE 0.1319**；定位 F1 @8px 0.7405；
  平均模型前向延迟 966.786 ms，FPS 1.034。
- 复跑：182/182 张预测人数完全一致；per-image 复算 6/6 通过。
- 证据：`evaluation/real-data/`、[`docs/REAL_DATASET_EVALUATION.md`](REAL_DATASET_EVALUATION.md)。
- **边界**：公开数据集 + 官方权重，不是 SkyGuard 自训练模型，也不是真实场馆实测；
  数据集许可 UNVERIFIED，不再分发。

### 3.4 V6.3.1 感知回放展示接入（2026-11-08）

- 新增 `data/perception/citystreet-display/`：CityStreet（香港城市大学 VISAL）C3 机位
  2280–2339 帧的派生显示数据，60 帧 / 13 区域 / 4119 条逐人点位，附 `PROVENANCE.json`。
- 新增只读 API `/api/v1/perception/displays[/:id][/frames][/basemap]`，
  与 `/safety`、`/mvp` 完全隔离，不进入规划器与独立校验器。
- 新增前端「感知回放」面板（时间轴 + 热力 + 区域查询），永久标注
  `DEMO 回放 · 非实时`、`无真值标注`、`许可 UNVERIFIED`。
- 测试：后端 **116/116**（新增 12 条感知回放用例），前端 **15/15**（新增 7 条）。
  `npm run demo`、`npm run demo:mvp`、`npm run build` 均通过。
- 版本比对基线说明：`evaluation/release/v62_*` 冻结日志里的 104/8 是 V6.2 时点快照，
  不因本次新增用例而修改。
- **边界**：只证明"派生数据 → API → 前端展示"链路与 fail-closed 治理可用。
  无真值标注、配准近似（偏差约 4.4 m / 5.3 m）、时间基为推算值，
  **不得**据此报告精度，也不得表述为真实场馆实时接入；航拍底图许可未确认，未入库。

## 4. 核心研究成果与限制

### 4.1 多区域 VoI

- 总风险收益：**条件性支持**（30 种子配对，总收益更高）。
- 单位成本效率：**对调查目标选择策略敏感**。
- V6.1 同目标与 V6.2 目标轮换必须并列报告；不得宣称“多区域全面更优”。
- 覆盖权重（目标 1 / 邻居 0.5 / 全局 0.3）与风险传播系数是**未标定启发式**。

### 4.2 序贯调查

- 预算、冷却、指数退避、证据冲突机制已实现并有测试。
- **相同尝试预算下，重试没有证明能提高成功率**。
- 必须区分：任务成功率、风险检测率、决策正确率、预算耗尽率。
- 失败/负面结果保留在原始数据中。

### 4.3 预测

- 严格滚动验证（每个起点只用过去数据选择方法与区间）。
- 自适应方法在 **stable / decline / missing** 场景有优势。
- **Persistence 在 surge / periodic 场景仍有竞争力**。
- 90%/95% 区间覆盖率未稳定达到名义水平；**不得用于安全告警阈值**。

### 4.4 风险图

- 区域图、容量/距离边权、3 步传播已实现；damping/覆盖权重敏感性已测。
- 当前属于**未标定的运维启发式模型**。
- **不得描述为已验证的真实人群传播规律**。

### 4.5 感知

- 人群计数/定位评测流水线已实现（MAE/RMSE/NAE、P/R/F1），并已在 ShanghaiTech Part A test 上实际运行。
- 结果：P2PNet 官方 SHTechA 权重 MAE 57.2418 / RMSE 96.0415 / NAE 0.1319（CPU，182 图，二次复跑一致）。
- **这仍是公开数据集 + 官方权重**，不是自训练模型，也不是真实场馆精度；NWPU/UCF-QNRF/Part B 未运行。
- CPU 视频计数（MOG2）仍是运动前景计数，不是专用人群计数模型。
- 单张图人数→区域密度必须经过面积与摄像机标定；未标定输入会被压置信度并触发 DEGRADED。
- 单机位回放展示数据（CityStreet C3）已接入前端，但**只有展示链路**：60 帧、13 区域、无真值，
  不能用于精度评测，也不与场景的 zones/corridors/exits 对应。

## 5. 当前外部阻塞

| 阻塞 | 状态 |
| --- | --- |
| AgentArts 真实租户/凭证/官方 API | **未接入**；官方运行时调用契约已实现并有 stub 契约测试，无真实租户与已发布运行时 |
| 昇腾 NPU/CANN/`.om` | **未实机**；仅探针与推理契约 |
| 真实场馆测绘与标定人流 | **无**；场景为合成 |
| 公开数据集评测 | **ShanghaiTech Part A 已完成**；NWPU-Crowd/UCF-QNRF/Part B 未运行；数据集许可未核验 |
| 感知回放数据的真值标注 | **无**；CityStreet C3 派生点位无逐帧标注，不能报精度 |
| 航拍底图许可 | **未核验**；`orthophoto-z20.jpg` 不随仓库分发，需部署方自行确认许可 |
| Docker / CI 实机验证 | Docker daemon 未启动；CI 未在真实仓库运行 |
| 专业消防安全评审与真实演练 | **无** |
| AgentArts/昇腾/无人机实机结果 | **未验证**，不得对外宣称 |

来源 URL 审计：38 条中 28 条可达；S15/S18 华为页面 404，8 条 403/网络失败，详见
[`research/SOURCE_AUDIT.md`](../research/SOURCE_AUDIT.md)。

## 6. 下一阶段研发方向

### P0（必须先做）

1. **修复 V6.2 数字口径问题**：任何材料引用多区域/序贯指标时，必须带上策略、预算、样本量和定义；
   单区域均值写 0.0472，不得写 0；成功率和检测率不得混用。
2. **真实公开数据集人群计数评测**：ShanghaiTech Part A 已完成；继续 NWPU-Crowd/UCF-QNRF/Part B 与 CSRNet 对照，并核验许可。
3. **AgentArts 真实接入**：租户、凭证、官方 API、工作流与 Trace。
4. **昇腾 CANN 实机推理**：模型转换、`.om`、精度/延迟/功耗。

### P1

5. 真实场地建模与参数标定（区域/通道/出口/容量/人员）。
6. 竞赛演示视频、论文定稿与答辩材料。
7. 系统部署与可靠性验证（Docker/CI、多实例、持久化、E2E）。

### P2/P3

- 交互体验、附加功能、非核心优化；不得以 UI 或代码规模牺牲安全、真实性与可复现性。

## 7. 状态维护规则

### 2026-11-06：竞赛改进设计完成，尚未实施

- 新增 [竞赛改进执行方案](ICT_IMPROVEMENT_EXECUTION_PLAN.md)，细化预算准入/预留、证据生命周期、真实 AgentArts 编排、事务与续接、公平实验和现场任务验证；保留原 30 天计划与冻结实验。
- 本轮核对基线 `200d6dd`；本次对话重新运行 `npm test`，后端 104/104、前端 8/8 通过。未重新运行全部实验、构建或实机验证。
- 代码仍存在候选动作预算预检缺口、场景/参数硬编码、平台单步调用及实验观测权限不一致问题，见新方案 G01–G11；文档完成不代表这些问题已修复。
- 已确认存在公开 AgentArts 运行时 API 与自定义 MCP 文档；上文“无公开 API 文档”的旧阻塞表述已过时。真实租户调用与完整业务闭环仍未验证，不能升级平台接入状态。
- `ops.ts` 已有可选 JSON 工单快照，`config/security.ts` 已有限流实现；旧局限文档中“纯内存/无限流”的笼统表述需要按模块修订。跨工单、预算、会话、事件的事务恢复仍是待实施设计。
- 新方案 D1 为 2026-11-06、D30 为 2026-12-05；内部首包目标 11-28，不代表赛事作品截止。研究主张等级保持不变。

### 维护约定

- 每次重要里程碑完成后更新本文件；
- 数字必须来自脚本/原始数据，不得复制过时报告；
- 保留负面结果与失败案例；
- 外部验证状态变化时，同步更新 [`research/CLAIMS.md`](../research/CLAIMS.md) 与本文件。

### 2026-11-08：前端工作台视觉优化

- 指挥中心适配 DS-Bot 中性深灰层级：文字导航、统一控件、扩大态势区、整理回放与业务面板；窄屏单列重排，数据表局部横向滚动。
- 保留 API 数据、合成/非实时标识、安全四态和权限行为；没有新增算法、平台或实机验证主张。未生成装饰性场馆图片。
- 验证：后端 116/116、前端 15/15，安全 demo、MVP demo 与构建通过；Chrome 检查桌面与窄屏布局。

### 2026-11-08：前端竞赛级视觉重构

- 建立统一设计系统：深空海军蓝底、青绿强调色、独立安全语义色（正常/关注/降级/拒绝）、等宽数字与分层面板；新增纹理底纹、状态脉冲、地图网格与路线辉光，同时保留减少动态效果的无动画回退。2026-11-09 起默认配色改为「指挥白」，深空/极夜/苔原作为可选预设。
- 重排首屏信息层级：关键指标独立为五联 KPI 带；主工作区保持“感知输入 / 态势图 / 决策”三列，在 1440 宽度仍维持三列；右列优先展示决策状态与独立校验，视频与非实时占位后置。
- 重构感知回放画布比例、业务闭环面板（Agent 待命态、摄像头/人员双栏、工单与基准结果）、登录页（品牌叙事 + 操作员表单）与工作人员移动端视觉。
- 保留全部 API 数据、合成/非实时/无真值标识、安全四态与权限行为；未新增算法、平台或实机验证主张，未生成装饰性场馆图。
- 验证：前端 15/15 测试通过、`npm run build` 通过；Chrome 检查 1680×1050、1440×900、375×812 布局与浅色主题，无控制台错误。未重跑后端测试、实验或安全 demo。

### 2026-11-09：交互与滚动回归修复

- 地图滚轮缩放改为原生非 passive 监听：缩放时阻止页面滚动，到达缩放边界后恢复页面滚动；缩放上限统一为 3×，与工具按钮一致。
- 地图拖拽补指针捕获、按钮状态判断与拖拽/点击区分，避免拖出地图后卡住、拖动结束误选区域；平移加入边界钳制，防止把场景拖出视口。
- 触屏在 1× 缩放时允许页面纵向滚动，放大后才接管平移；区域键盘 Space 选择不再连带滚动页面。
- 右侧决策列与横向数据表/导航分别使用 `overscroll-behavior(-x): contain`，避免滚到面板尽头后整页跳动；嵌套时间线保留向父级滚动的自然链条，避免多层滚动陷阱。
- 主题弹层支持点击外部与 Esc 关闭；反馈弹窗支持 Esc 关闭，且仅在提交成功时关闭，失败保留用户输入。
- 修复无效/未来时间戳显示为 `NaNh 前` 的问题；地图语义角色由 `img` 改为可包含交互区域的 `group`。
- 验证：前端 15/15 测试与构建通过；Chrome 验证滚轮事件在缩放时 `defaultPrevented=true` 且页面 `scrollY` 不变、到边界时恢复滚动、拖拽后点击被抑制而普通点击仍可选区、触屏 `touch-action` 随缩放切换。

### 2026-11-09：V6.4 工程与实验加固（G01–G06/G08/G09 实施）

本轮以实际代码与运行结果为准，未修改 V6.2 冻结实验目录。

**已实施并验证**

1. **预算准入（G04）**：新增 `backend/src/services/mvp/budget.ts`，统一为
   `used + reserved + candidate <= max`；修复“0.9 + 1.0 在 1.0 上限下被放行”的越界缺口。
   本地 Agent、序贯会话、多区域决策共用同一判定；新增 `budget.test.ts` 与
   `agent-budget.test.ts`（`max_actions=1` 只执行一轮）。
2. **参数来源（G05）**：多区域覆盖权重（邻居 0.5 / 全局 0.3）与证据冲突参数
   （10 分钟窗口 / 0.5 混合）移入场景 `investigation.coverage_weights` / `investigation.conflict`，
   输出标注 `coverage_weight_source` 与 `blend_source`；缺省时明确标记 `legacy_default`。
3. **场景硬编码（G09）**：AgentArts 请求的 `scenario` 改为加载场景 ID；调查可用性按动作
   `kind` 映射（`availability.ts`），不再写死 `A_CAMERA` 等 ID；控制台一键推演的
   人数序列、容量与事件移入场景 `ui_demos`，缺失时返回明确错误而不是回退硬编码。
4. **AgentArts 官方契约（G01/G02）**：实现 `POST /runtimes/{runtime_name}/invocations`、
   `Authorization`、`x-hw-agentarts-session-id`、`query`/`inputs` 与官方
   `event/data.text` 响应解析；健康成功只标记 `connectivity=reachable`，
   `business_closure.verified` 保持 false；有界多步（默认 4 步）、重复调用停止、
   创建工单后 `awaiting_approval`；`AGENTARTS_AUTO_CONTINUE` 控制反馈后续接。
   仍**无真实租户**，只完成 stub 契约测试，不得升级为平台已接入。
5. **MCP 共享状态（G03）**：新增同进程 Streamable HTTP `POST /mcp`，与网页 API
   共用 `MvpService` 单例；测试验证 MCP 创建的工单可被网页侧读取。stdio 仍保留为开发入口。
6. **持久化（G08 部分）**：Agent 运行记录支持可选 JSON 快照 `MVP_RUNS_FILE`，
   启动恢复、损坏快照不阻断并写审计；工单/人员快照沿用 `OPS_PERSIST_FILE`。
   跨工单/预算/事件的共同事务仍未实现。
7. **证据生命周期（P1）**：`ObservationStore` 忽略完全重复上报（不增加版本），
   按观测时间插入，乱序旧观测不再覆盖较新的最新观测；新增 `observations.test.ts`。
8. **公平实验（G06）**：新增 `backend/scripts/voi-v2-benchmark.ts`
   （`npm run benchmark:voi-v2`），所有策略对同一物理动作获得相同覆盖，
   观测按似然采样，预算准入统一。两次独立运行
   `evaluation/voi-v2/2026-11-08T17-00-16-896Z/` 与 `2026-11-08T17-29-19-101Z/`
   给出相同统计（配对差 0.1265），不覆盖 `evaluation/v62/`；每次运行带独立 `MANIFEST.json`。

**公平复跑结果（合成，30 种子 × 40 trial = 1200 对，目标轮换）**

| 策略 | 风险降低 [95% CI] | 成本 | 效率 | 覆盖区域 |
| --- | --- | --- | --- | --- |
| 单区域 | 0.0446 [0.0429, 0.0464] | 0.2528 | 0.2643 | 1.62 |
| 多区域 | 0.1711 [0.1655, 0.1768] | 0.5868 | 0.2971 | 6.74 |
| 随机 | 0.0909 [0.0858, 0.0961] | 0.3943 | 0.3433 | 4.26 |
| 启发式 | 0.0317 [0.0305, 0.0329] | 0.0800 | 0.3961 | 2.00 |

- 多 − 单配对差 0.1265 [0.1209, 0.1321]，d_z=1.27；效率差 0.0328 [0.0140, 0.0515]。
- **V6.2 的 0.1682 / d_z=2.06 被信息权限差异放大**；多区域总收益仍更高，
  但单位成本效率低于随机/启发式，不得宣称全面更优。两套结果必须并列报告。

**验证结果（2026-11-09 本机）**

- 后端测试 **142/142** 通过；前端测试 **16/16** 通过；
- `npm run build`、`npm run demo`（安全三场景）、`npm run demo:mvp`（MVP 三场景）通过；
- 新增证据：`evaluation/voi-v2/2026-11-08T17-00-16-896Z/` 与 `2026-11-08T17-29-19-101Z/`
  （README、raw、metadata、独立 MANIFEST）；两次运行统计一致。

**仍未完成 / 外部阻塞**

- 真实 AgentArts 租户、已发布运行时、平台 Trace 与完整业务闭环；
- 派发时的资源预留与工单/预算/事件共同事务；
- 真实场馆标定、工作人员用户研究、昇腾实机；
- V6.2 冻结清单未重新生成（历史结果保持不变）。

### 2026-11-09：V6.5 深度工程加固与端到端验证

本轮在 V6.4 基础上继续实施 G05/G08/G01/G11 与感知闭环；未改写 V6.1/V6.2/V6.4 冻结数据。

**1. G05 资源预留与工单闭环（已实现）**

- 工单创建时建立 `ResourceReservation`（人员软预留、预算单位、人员分钟、TTL、场景版本）；
- 审批确认预留；拒绝/取消/过期/失败释放；完成时把预算从“预留”结算为“已用”；
- 新增 `CANCELLED` 状态与取消接口；派发前再次校验人员、上下文与场景版本；
- 幂等键绑定规范化请求指纹：同键同参返回同一工单，同键异参返回 409；
- 并发创建同一人员只成功一个；新增 8 组边界/并发/过期/恢复测试。

**2. G08 统一事务状态与恢复（已实现单实例）**

- 新增 `MVP_STATE_FILE`：一次原子快照覆盖安全观测/事件/方案、工单/预留/预算、Agent 运行、内存审计；
- 临时文件 + fsync + backup + 原子改名；SHA-256 校验、schema 版本、revision 校验；
- 启动依次尝试 primary/backup/temp；全部损坏、部分写入或未来版本时 **拒绝启动**；
- 工单完成与现场反馈处在同一事务范围，只提交一次统一状态；
- 实测：API 创建工单 → 进程重启 → 工单/预留/人员状态恢复；主文件损坏从 backup 恢复；
  两者都损坏时进程退出码 1。跨进程并发写仍不支持。

**3. G01 AgentArts 强化（本地 stub 验证）**

- `select` 对超时/429/5xx 有界重试；4xx 不重试；SSE/流式 `data:` 响应可解析，截断响应显式失败；
- 同一运行所有步骤共用 `x-hw-agentarts-session-id`，步骤 `trace_id` 独立；
- 平台越权工具被本地权限拒绝且无副作用；建单自动补幂等键；人工反馈可触发续接；
- **仍无真实租户/凭证/平台 Trace**，不得升级平台接入状态。

**4. G11 预测实验（evaluation/v65/，30 种子）**

- 6 种机制、5 个基线与自适应滚动选择；严格滚动起点，目标点不参与训练/选择/校准；
- 结果（详见 `evaluation/v65/<run>/README.md`）：
  - 自适应配对平均绝对误差优于 persistence/EMA/damped/blend/linear（差值 -2.4 至 -9.2）；
  - 但**不是任何单一机制的最佳方法**：stable/decline/periodic/noisy 上 linear 最佳，
    surge 上 persistence 最佳，missing 上 EMA 最佳；
  - 95% 覆盖率：stable 0.988、surge **0.738**、decline 0.994、periodic 1.000、
    missing 0.983、noisy 0.979；**surge 明显低于名义值，不得用于安全告警阈值**；
  - 可靠性门槛（区间相对宽度 > 0.5）使 periodic/noisy 的 VoI 预测动作几乎全部阻断；
  - 失败案例保留在 `rows.json` / `worst_cases`。

**5. 感知→决策本地闭环（已实现适配器）**

- 新增 `perception/adapter.ts`：图像/显示帧 → 人数 → 质量门禁 → 区域观测 → 预测 → VoI → 风险；
- 人数只有在“surveyed 标定 + 与场景区域一致面积 + 足够置信度”时才生成可信观测；
  否则写入 `valid=false` 观测并触发 DEGRADED，不伪造密度；
- CityStreet 派生帧可用米制多边形计算演示面积/密度，但无真值、许可未核验、配准近似，
  永远不进入可信安全观测；P2PNet 公开数据集结果只证明图像→人数链路；
- 新增只读 API：`/perception/displays/:id/zone_areas_m2`（在详情中）、
  `/perception/displays/:id/frames/:frameId/quality`、`/perception/real-data/summary`；
- 前端回放面板显示演示面积/密度并明确“未标定，不得用于安全判定”。

**6. 可靠性与部署**

- HTTP MCP 支持 `MCP_HTTP_TOKEN` Bearer；生产未配置 token 时禁用 `/mcp`（fail closed）；
- 生产环境 5xx 不再回显内部错误消息；启动阶段统一状态损坏即退出；
- Dockerfile 设置 `MVP_STATE_FILE`；Docker daemon 当前未运行，**未完成容器实跑**；
- CI 增加 V6.5 预测实验步骤；官方 2026–2027 赛规页面本轮无法检索/访问，**规则核验未完成**。

**验证（本机，2026-11-09）**

- 后端 **175/175**、前端 **16/16**；`npm run build`、安全三场景、MVP 三场景、Python 语法检查通过；
- 启动恢复实测：创建工单后重启，`revision=2`、工单/预留/人员恢复；
- 损坏状态实测：primary+backup 同时损坏时进程拒绝启动（exit 1）。

**仍为外部阻塞**

- AgentArts 真实租户/凭证/已发布运行时/平台 Trace；
- 昇腾 NPU/CANN 实机；
- 真实场馆测绘、工作人员用户研究与专业评审；
- 赛事官方规则/报名/资格确认（本轮检索无可用官方页面）；
- Docker daemon 与真实 CI 运行环境。

### 2026-11-09：V6.5 P0 独立审计修复

- 独立审计（[`V6.5_INDEPENDENT_AUDIT.md`](../V6.5_INDEPENDENT_AUDIT.md)）发现 6 类 P0：
  恢复丢最新状态、事务失败仍提交、只读可被幂等重试绕过、感知门禁可伪造/派生数据可入库、
  生产默认凭证、Docker 上下文含运行时状态。
- 已修复并补回归（`backend/tests/mvp/p0-hardening.test.ts`）：恢复选择最高 revision；
  事务异常整体回滚；只读后拒绝全部写入与幂等命中；感知草稿 HMAC + ingest 重新推导可信性、
  硬拒绝 display_frame；生产弱凭证启动失败；镜像非 root + 数据卷 + `.dockerignore` 排除状态文件。
- 修复后本机验证：后端 **175/175**、前端 **16/16**、构建/安全 demo/MVP demo/Python 检查通过、
  `verify:evidence` **134/134**、冻结根清单 **46/46**。
- **审计 B 节 P1 仍未修复**（改派释放原人员、失败/取消不结算预算、预算字段绕过、幂等键跨用户、
  截断 SSE、续接新会话、多实例丢更新、生产错误回显、平台重试非幂等、预测统计与 surge 覆盖、
  感知判据差异、环境示例）。V6.5 仍为研究原型，不得作为可部署版本。

### 2026-11-09：V7.0 预测、动态规划与联合 VoI（研究实现 + 30 种子实验）

本轮在 V6.5 基础上实施 V7.1/V7.2/V7.3 的可执行部分；未改写 V6.1/V6.2/V6.4/V6.5 冻结证据。

**最终证据运行：** `evaluation/v70/v70-final-20261109T195122/`
（复现：`npm run benchmark:v70`；包含 prediction / planning / joint-voi 三组 JSON、README、独立清单与根 `MANIFEST.json`）。
详细材料：[V7.0 实施报告](V7_0_IMPLEMENTATION_REPORT.md)、[V7.0 算法对照实验报告](V7_0_EXPERIMENT_REPORT.md)、
[V7.0 独立审计](../V7.0_INDEPENDENT_AUDIT.md)。

**1. V7.1 预测引擎（已实现）**

- 新增 `backend/src/services/mvp/forecast-advanced.ts`：Kalman（局部线性趋势）、ARIMA(1,1,0)、
  Holt-Winters（加性趋势 + 可选季节项）、轻量在线 LSTM（隐藏单元 4、截断 BPTT）、
  regime 检测、Page-Hinkley 输入漂移 + 误差漂移、split-conformal 区间、状态感知自适应集成。
- 旧 `prediction.ts`（`adaptive-forecast-v3`）保持不变；V7 引擎通过研究 API 暴露，未替换安全主链路的默认预测。
- 30 种子 × 7 机制（stable/surge/decline/periodic/missing/noisy/regime_shift）× 11 方法，严格滚动起点。
- 结果（`prediction_summary.json`）：
  - 集成平均 MAE 显著低于 persistence/EMA/damped/blend/linear/Kalman/在线 LSTM（Holm 校正 p<0.001）；
  - 但显著高于 ARIMA、Holt-Winters 与旧 adaptive（差 +4.16 / +8.16 / +2.01 MAE）；
  - **不是任何单一机制的最佳方法**：stable/missing/noisy 最佳为在线 LSTM，surge/periodic 为 Holt-Winters，
    decline 为 linear，regime_shift 为 ARIMA；
  - 95% 覆盖率：stable 0.933、surge **0.748**、decline 0.983、periodic 0.982、missing 0.932、noisy 0.933、regime_shift 0.809；
    **surge 低于名义值，不得用于安全告警阈值**；
  - 漂移检测（Page-Hinkley + 误差比）：regime_shift 突增/下降段检测率均 1.0，stable 误报率 0.016；
  - Regime 可接受标签准确率：stable 0.891、surge 0.487、decline 0.953、periodic 0.182、missing 0.833、noisy 0.424、regime_shift 0.885；
    短窗口下周期性/突增分类不稳定，只能作为候选筛选提示。

**2. V7.1 动态规划（已实现）**

- 新增 `planning/strategies.ts`（可配置时间扩展求解器、最大流、容量盲最短路径、受限 MILP 枚举）、
  `planning/congestion.ts`（1 分钟 FIFO 队列 + BPR 行程时间放大 + 出口拥挤服务衰减）、
  `planning/mpc-planner.ts`（滚动时域 MPC）。
- 研究求解器使用 Dijkstra + 势函数；安全主链路的 SPFA 规划器保持不变（既有 199 测试全部通过）。
- 实验：30 种子、容量受压合成场景（初始需求 650–1000/区域 + 2–3 次合成入流），所有策略面对相同入流与执行模型。
- 结果（`planning_summary.json`，均值）：
  - static_mcf：未疏散 613.3、完成时间 19.0、队列人·分钟 51395、校验通过率 1.0；
  - shortest_path：未疏散 1441.6、完成时间 24.0、校验通过率 0；
  - max_flow：未疏散 613.3、完成时间 17.13；
  - milp_restricted：未疏散 613.3、完成时间 11.30、队列 18523（相对 static_mcf 显著更低）；
  - reactive_mcf：未疏散 0、完成时间 8.40、队列 13681；
  - mpc_forecast：未疏散 0、完成时间 8.30、队列 13843；
  - mpc_queue：未疏散 0、完成时间 8.33、队列 13866。
- **负向结果（保留）**：预测与队列反馈相对“仅滚动重规划”没有显著增量收益
  （mpc_queue − reactive：未疏散 0.00，Holm p=1；队列差 +185.7 [−127.0, +498.4]，Holm p=0.49）。
  本模型假设即时响应、未建模调度延迟/预留提前期，因此不能外推为“预测无用”。

**3. V7.2 联合 VoI（已实现）**

- 新增 `backend/src/services/mvp/joint-voi.ts`：区域相关性（间接信息权重）、覆盖重叠冗余折扣、
  预算内顺序选择、跨轮次已选动作记忆；参数来自场景 `investigation.joint`（correlation 0.5、redundancy_penalty 0.6）。
- 公平实验：30 种子 × 40 trial；所有策略共享动作覆盖、观测采样随机数与预算；Oracle 知道真实状态。
- 结果（`joint_voi_summary.json`）：
  - multi：风险降低 0.1655、最坏区域终风险 0.1031、检测准确率 0.7496、成本 0.5798；
  - joint：风险降低 0.1629、最坏区域终风险 0.1024、检测准确率 0.7480、成本 0.5801；
  - 配对：joint − multi benefit −0.0026 [−0.0044, −0.0008]（Holm 显著但效应量 d_z=−0.08）；
    worst-region risk −0.0007 [−0.0012, −0.0002]（同样很小）。
  - **结论：联合 VoI 未在总收益上优于现有多区域 VoI，仅最坏区域风险略低；不得宣称全面更优。**
  - Oracle 检测覆盖 1.0、成本 0.059，说明真实状态可知时仍有很大改进空间（上界，不可实现）。

**4. V7.3 集成与可信边界（已实现部分）**

- 新增只读研究 API：
  - `GET /api/v1/mvp/v70/forecast/:regionId`
  - `GET /api/v1/mvp/v70/joint-investigation?region_id=...`
  - `GET /api/v1/safety/v70/mpc-preview`
  - `GET /api/v1/safety/v70/congestion-preview`
- 观测不可信/缺失时 MPC 与预测预览 fail closed；带预测到达的 MPC 步骤标记为条件投影，
  只有对应当前观测的第一步执行独立校验。
- 新增测试：`forecast-advanced.test.ts`、`planning-v70.test.ts`、`joint-voi.test.ts`、`v70-api.test.ts`。
- 修复 Windows 检出换行符导致的证据字节不一致：`.gitattributes` 增加 `evaluation/** -text`，
  证据文件按仓库字节恢复；V6.5 证据校验测试恢复通过。
- 验证（本机，2026-11-09）：后端 **201/201**、前端 **17/17**；`npm run build`、
  `npm run demo`（安全三场景）、`npm run demo:mvp`（MVP 三场景）全部通过；
  `verify:evidence` **134/134**、冻结根清单 **46/46**（校验不再改写冻结文件）。

**仍为外部阻塞**

- 真实场馆时序、标定人群速度/出口服务率、真实入流与调度延迟；
- AgentArts 真实租户/凭证/平台 Trace；
- 昇腾 NPU/CANN 实机；
- Docker daemon 与真实 CI 运行环境；
- 专业安全评审与真实演练。

**V7 当前定位：研究原型 + 可复现合成实验；不是 Production Ready，也不是真实场馆效果验证。**

### 2026-11-09：V7.1 研究验证与 Shadow Mode 工程准备

本轮在 V7.0 基础上完成滚动重规划机理、预测区间突破、事件触发/路线稳定性、Shadow Mode 与红队审计；
未改写 V6.1/V6.2/V6.4/V6.5/V7.0 冻结证据。

**最终证据运行：** `evaluation/v71/v71-final-20261109T211702/`
（复现：`npm run benchmark:v71`；包含预测区间与滚动重规划两组 JSON、README、独立清单与根 `MANIFEST.json`）。
详细材料：[V7.1 实施报告](V7_1_IMPLEMENTATION_REPORT.md)、[V7.1 算法对照实验报告](V7_1_EXPERIMENT_REPORT.md)、
[Shadow Mode 说明](V7_SHADOW_MODE.md)、[V7.1 独立审计](../V7.1_INDEPENDENT_AUDIT.md)。

**1. 滚动重规划机理（30 种子 × 5 场景 × 9 策略）**

| 策略 | 未疏散 | 完成时间 | 队列人·分钟 | 切换人数 | 重规划 | 求解(ms) |
| --- | --- | --- | --- | --- | --- | --- |
| A static_mcf | 682.8 | 18.99 | 51586 | 0 | 0 | 0.49 |
| B periodic legacy | 0 | 13.88 | 43383 | 754 | 7.33 | 1.28 |
| C event legacy | 0 | 13.75 | 42641 | 763 | 4.75 | 1.00 |
| D MPC no forecast | 0 | 8.81 | 14373 | 4390 | 5.03 | 1.80 |
| E MPC forecast | 0 | 8.77 | 14291 | 4731 | 5.05 | 1.89 |
| F MPC queue | 0 | 8.83 | 14401 | 4410 | 5.05 | 1.76 |
| G full | 0 | 8.81 | 14322 | 4745 | 5.06 | 1.81 |
| H full_stable | 0 | 8.97 | 14639 | 4960 | 5.12 | 3.13 |
| I event_full | 0 | 10.29 | 23123 | 4701 | 5.00 | 1.78 |

- **滚动重规划是主要收益来源**：B vs A 未疏散 −682.8 [−715.8, −649.9]，完成时间 −5.11 [−5.29, −4.94]；
- V7 MPC 进一步把完成时间降到 8.81，但切换人数约为 legacy 的 5.8 倍；
- 预测/队列反馈**无显著增量**：G vs F 完成时间 −0.027 [−0.068, 0.015]；G vs E +0.033 [−0.001, 0.068]；
- 事件触发对 legacy 有效（重规划 −2.57，求解 −0.28ms，完成时间 −0.13）；对 V7 有害（I 10.29 vs G 8.81）；
- 路线稳定启发式未降低切换（H 4960 vs G 4745）且增加求解成本，保留为负结果。

**2. 预测区间突破（30 种子 × 7 机制）**

| 机制 | v70 95% | ACI 95% | ACI+变点 95% | 宽度 | 门控失败率 |
| --- | --- | --- | --- | --- | --- |
| surge | 0.7484 | 0.8140 | **0.8462** | 442.58 | 0.8914 |
| regime_shift | 0.8086 | 0.6527 | **0.9065** | 556.32 | 0.8591 |
| periodic | 0.9817 | 0.8333 | 0.8333 | 368.57 | 1.0000 |

- 整体 95% 覆盖差 0.0000 [−0.0119, 0.0119]（Holm 不显著）；宽度 +7.43、门控失败率 +0.2278（显著）；
- 结论：改善最困难机制的尾部覆盖，但牺牲 periodic 覆盖与宽度，并触发更保守门控；**混合结果，不得宣称全面改善**。

**3. Shadow Mode（默认关闭）**

- 新增 `v7-adapter.ts` 与 `decision-service` 集成；
- `V7_SHADOW_MODE=1` 才启用；`V7_SHADOW_MAX_SOLVE_MS` 控制预算；
- 统一快照（版本/需求/可用网络/SHA-256）、双方案独立 Validator、执行投影、超时/异常/校验失败回退；
- V7 方案永不发布；legacy 方案与四态不受影响；审计 stage `shadow_comparison`；
- 只读 API：`GET /api/v1/safety/v70/shadow`；
- 启用前验收清单见 [`V7_SHADOW_MODE.md`](V7_SHADOW_MODE.md)；当前未启用。

**4. 红队与修复**

- 修复事件触发被人数下降误触发、空窗口强制重规划、conformal 初始方案在 surge 失效、Shadow 预算回退；
- 新增回归：`conformal.test.ts`（8）、`shadow-mode.test.ts`（4）、`v71-hardening.test.ts`（5）、Shadow API 用例；
- 退出/通道故障、双向压力、多区域突增、NaN/异常预测输入、过期观测均覆盖；
- 公开数据集许可核验见 [`DATASET_CANDIDATES_V71.md`](DATASET_CANDIDATES_V71.md)；无公开疏散决策标签。

**5. 验证（本机，2026-11-09）**

- 后端 **219/219**、前端 **17/17**；
- `npm run build`、`npm run demo`（安全三场景）、`npm run demo:mvp`（MVP 三场景）通过；
- `verify:evidence` **134/134**、冻结清单 **46/46**（默认不写回）。

**仍为外部阻塞**

真实场馆时序与标定、AgentArts 真实租户/Trace、昇腾实机、Docker/CI、专业安全评审与真实演练；
Shadow Mode 未启用，V7 方案未发布。

**V7.1 定位：Research Prototype + Reproducible Synthetic Evidence + Shadow ready-for-review (disabled)。**

### 2026-11-10：V7.2 路线稳定性、场馆标定与可信集成准备

本轮在 V7.1 基础上完成路线稳定性机制、承诺式求解、双向容量修正、场馆标定流水线、
Shadow 回放压力与华为生态状态核验；未改写 V6.1/V6.2/V6.4/V6.5/V7.0/V7.1 冻结证据。

**最终证据运行：** `evaluation/v72/v72-final-20261110T014910/`
（复现：`npm run benchmark:v72`；包含 stability/calibration/shadow/huawei 四组证据、根 `MANIFEST.json` 与 `V72_SUMMARY.md`）。
详细材料：[V7.2 实施报告](V7_2_IMPLEMENTATION_REPORT.md)、[V7.2 算法对照实验报告](V7_2_EXPERIMENT_REPORT.md)、
[V7.2 红队报告](V7_2_RED_TEAM_REPORT.md)、[V7.2 独立审计](../V7.2_INDEPENDENT_AUDIT.md)、
[场馆标定说明](VENUE_CALIBRATION_V72.md)。

**1. 路线稳定性 A-F（30 种子 × 6 场景 × 6 策略）**

| 策略 | 未疏散 | 完成时间 | 队列人·分钟 | 最大密度 | 切换人数 | 求解(ms) |
| --- | --- | --- | --- | --- | --- | --- |
| A legacy_static | 784.9 | 19.00 | 57772.6 | 1.963 | 0 | 0.6 |
| B mpc_standard | 0 | 9.89 | 19481.7 | 2.696 | 5261.8 | 19.2 |
| C mpc_hysteresis | 0 | 9.94 | 20824.1 | 2.769 | 4268.3 | 39.7 |
| D mpc_switch_penalty | 0 | 10.34 | 22103.1 | 2.776 | 3334.3 | 40.3 |
| E mpc_commitment | 0 | 10.41 | 22209.2 | 2.776 | 3334.7 | 40.3 |
| F mpc_adaptive | 0 | 10.41 | 22209.2 | 2.776 | 3334.7 | 40.0 |

> 求解耗时为单机测量，存在 ±1–2ms 波动；切换/完成时间/队列为确定性仿真指标。

- C vs B：切换 −993.5 [−1227.4, −759.7]，完成时间 +0.05 [0.0005, 0.0995]；
- D/E/F vs B：切换约 −1927 [−2193, −1662]，完成时间 +0.45–0.51；
- **稳定性不是免费的**：队列 +1.3k–2.7k 人·分钟，最大密度 +0.07–0.08；求解耗时约翻倍；
- 惩罚与承诺在当前参数下结果几乎相同，不能宣称两者独立优于对方；自适应未体现混合优势（负结果保留）。

**2. 运行中故障与紧急覆盖**

- `midrun_exit_failure`：legacy 静态方案平均 1.13 条路线在故障后仍使用故障出口；
- 所有 MPC 策略故障后使用故障出口路线为 0；承诺策略记录紧急覆盖并立即改派；
- 未疏散保持 0。

**3. 双向容量修正（P0）**

- 求解器原先让双向通道两方向各得全额容量，与执行/校验口径不一致；
- 改为按需求比例共享并计入已承诺流量（最多 8 轮），最终逐分钟容量复核；
- V7.1 冻结证据不重算、不回写；V7.2 绝对数字更保守。

**4. 场馆标定流水线**

- `VenueProfile` + 校验 + 应用变更清单 + 版本追踪；
- 合成档案不得冒充实测/标定；`calibrated` 需 ≥5 样本与 CI；
- 参数估计（服务率/步行速度）在样本不足时降级为 `estimated`；
- 相机计数适配器拒绝离线/过期/未来时间戳/低置信度；
- 当前只有合成档案与合成样本，未做真实标定。

**5. Shadow 回放压力（240 次）**

- normal：30/40 `v7_eligible_for_review`，10/40 `v7_validation_failed`；
- solver_error/validation_failure/budget_zero：全部回退 legacy；
- stale_observation：两套校验均失败，不发布；
- snapshot_tamper：40/40 `legacy_snapshot_mismatch`；
- 确定性 0 不一致；V7 从未发布；Shadow 默认关闭、未启用。

**6. 华为生态**

- AgentArts：未配置真实租户/凭证；本地官方契约 stub 验证会话头一致、trace 区分、SSE 决策解析；
- Ascend：无 `npu-smi`/`atc`；新增 ONNX 参考模型导出与 CPU 基准（p50≈0.015ms，数值一致），
  给出 ATC 模板；**无 NPU/OM 实机证据**。

**7. 红队与修复**

- 修复双向容量超限、承诺候选超容量、预测 NaN/Infinity、相机离线/未来时间戳；
- 新增 `v72-stability`（6）、`v72-calibration`（8）、`v72-shadow-stress`（4）、`v72-redteam`（5）测试；
- 全量后端 **242/242**、前端 **17/17**。

**8. 验证（本机，2026-11-10）**

- `npm run build`、`npm run demo`、`npm run demo:mvp` 通过；
- `npm run benchmark:v72` 四组证据、根清单；
- `verify:evidence` 含 V7.2 根清单哈希/文件数/类别检查；
- 冻结证据默认不写回。

**仍为外部阻塞**

真实场馆几何/容量/时序与摄像机标定、AgentArts 真实租户/Trace、昇腾 NPU/CANN/atc、
Docker/CI 实跑、专业安全评审与真实演练；Shadow Mode 未启用，V7 方案未发布。

**V7.2 定位：Research Prototype + Reproducible Synthetic Evidence + Shadow ready-for-review (disabled)。**

**版本冻结（2026-11-10）：** 项目版本 `v7.2.0-research.1`（根目录 `VERSION`）；
冻结清单 `evaluation/v72/freeze_v72.json`，逐文件哈希 `evaluation/v72/BASELINE_SHA256`，
证据哈希 `evaluation/v72/SHA256SUMS`；校验：`npm run freeze:verify --prefix backend`。
冻结范围为源码/测试/脚本/依赖锁/场景与场馆数据/V7.1 与 V7.2 最终证据/核心文档/CI；不含 `LATEST` 指针与冻结产物自身。
冻结后任何改动必须提升版本号并重新生成清单，不得改写冻结运行目录。
