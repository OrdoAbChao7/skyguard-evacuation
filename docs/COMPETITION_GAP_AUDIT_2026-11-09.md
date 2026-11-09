# SkyGuard 国家级竞赛差距审计与研发总攻路线

> 审计基线：`main@180643c`，工作分支 `claude/dreamy-kilby-0e1dc8`
> 审计日期：2026-11-09
> 方法：逐文件阅读、全量测试/构建/演示、V6.5 十三条 P1 逐项复核、两份独立只读审计（算法链、华为/交付链）、证据清单复算、引用 URL 复核。
> 本文件是当前差距与路线的**唯一汇总入口**；技术状态仍以 `docs/PROJECT_STATUS.md`、`research/CLAIMS.md` 为准。
> **本报告不宣称任何未实机验证的平台、硬件、场馆或性能结果。**

---

## 0. 结论先行

SkyGuard 已经是一个**可运行、可复现、带独立校验与人工审批闭环的研究原型**，不是演示拼盘：
感知适配器、预测、VoI、风险图、时间扩展流规划、四态状态机、工单/预留/预算、MCP 15 工具、
统一状态恢复、公开数据集评测与冻结证据都存在真实代码与测试。

但距离“华为 ICT 创新赛全国一等奖竞争力”仍有四类硬差距：

1. **研究主张的因果强度不足**：预测区间在 surge 下严重欠覆盖；多区域“联合 VoI”实际是独立区域加权和；
   预测没有进入疏散规划；无拥堵反馈；风险传播未标定。
2. **华为技术仍是适配器/探针**：AgentArts 无真实租户与平台 Trace；昇腾无 NPU/CANN/`.om` 实机；
   两者都不能对外写成“已接入/已适配”。
3. **真实场景证据为零**：场馆测绘、摄像机标定、人流真值、工作人员用户研究均缺失。
4. **交付包不完整**：没有 PPT、演示视频、论文 PDF/LaTeX、统一 release 归档；官方赛规未核验；
   部分历史材料数字与引用曾互相矛盾（本轮已修正主要项）。

本轮已关闭 V6.5 审计的 12/13 项 P1（P1-11 只关闭透明度，模型仍失效），并额外修复证据 CRLF、
校验命令改写证据、生产占位符凭证、昇腾无业务调用点、双向容量口径、在留容量硬约束、
MCP 审计遗漏、真实数据脚本误覆盖、论文数字与 3 条错误引用。**未 commit、未 push。**

---

## 1. 审计范围与复现命令

### 1.1 实际执行

| 项目 | 结果 |
| --- | --- |
| `npm test` | 后端 **183/183**、前端 **16/16** 通过 |
| `npm run build` | 通过 |
| `npm run demo` | 安全三场景全部符合预期 |
| `npm run demo:mvp` | MVP 三场景全部通过 |
| `npm run verify:evidence --prefix backend` | **134/134**，且不再改写冻结证据 |
| `evidence-manifest.ts --verify` | 根清单 **46/46**（修复 Windows CRLF 后） |
| `npm run benchmark:v65 --prefix backend` | 新证据 `evaluation/v65/2026-11-09T04-08-42-374Z/` |
| Docker / 浏览器 E2E | **未运行**（本机 Docker daemon 未启动；仓库无 Playwright/Cypress） |

### 1.2 证据边界

- 所有实验为**合成数据**；ShanghaiTech Part A 为公开数据集 + P2PNet 官方权重，CPU，非自训练、非现场。
- 未连接真实 AgentArts 租户；未在昇腾设备执行任何推理；无真实无人机、场馆测绘或人员研究。
- 本轮未重新生成 V6.1/V6.2/V6.4 冻结证据；新 V6.5 运行目录是新增证据，旧目录保留。

---

## 2. 阻断性缺陷（P0）

> 当前代码内已无未关闭 P0。以下为“阻断竞赛交付/对外可信度”的事项，不等于软件崩溃。

| ID | 阻断项 | 证据 | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| B-01 | AgentArts 无真实租户、凭证、官方契约核验、平台 Trace | `backend/src/services/mvp/agentarts.ts`；`docs/AGENTARTS_INTEGRATION.md`；`research/SOURCES.jsonl` S15/S18 404 | 真实租户跑通健康/调用/人工等待/反馈续接；保存脱敏请求响应、平台 Trace、应用版本；更新 C08/H01 | 外部阻塞 |
| B-02 | 昇腾无 NPU/CANN/`.om` 实机；无精度/延迟/功耗数据 | `backend/src/services/safety/providers/ascend.ts`；`docs/ASCEND_DEPLOYMENT.md` | 记录设备型号、CANN/驱动版本、`atc` 日志、模型哈希、逐样本误差、延迟/吞吐/功耗 | 外部阻塞（本轮已补业务调用点） |
| B-03 | 官方 2026–2027 赛规、评分权重、材料格式、演示时长未核验；报名截止约 2026-11-30 | `docs/ICT_AGENTARTS_30_DAY_PLAN.md`；`docs/PROJECT_STATUS.md` | 官方页面/报名系统截图或 PDF、报名回执、指导教师/学校签字、评分表与提交清单 | 外部阻塞 |
| B-04 | 交付包无 PPT、演示视频、论文 PDF/LaTeX、统一 release 归档 | 仓库 `find` 未发现 `.pptx/.pdf/.tex/.mp4`；`docs/RELEASE_CHECKLIST.md` | 产出 `skyguard-defense.pptx`、`skyguard-demo.mp4`、论文 PDF/LaTeX、release manifest + archive | 未完成 |
| B-05 | Docker/CI 未实跑；无浏览器 E2E | `.github/workflows/ci.yml`；`docs/RELEASE_CHECKLIST.md` | `docker build` + `docker run` + `/health` + 卷重启测试；Playwright 覆盖登录→审批→反馈→续接 | 环境缺口 |
| B-06 | 公开数据集/权重许可未核验，不能合法再分发 | `evaluation/real-data/CONFIG.json`；`docs/MVP_LIMITATIONS.md` | 每项 LICENSE/条款原文与哈希；发布包只含可再分发内容 | 外部/法务 |

---

## 3. 核心研究缺口（P1）

> 编号对应算法审计结论；每条都给出代码位置、证据、影响与验收标准。

### R-01 预测区间在 surge 下失效，可靠性门槛抓不住

- **证据**：`backend/src/services/mvp/prediction.ts` 的 `assessPredictionReliability` 只用相对区间宽度；
  V6.5 新证据：surge 自适应 coverage95=0.7376、coverage90=0.6935、failure_rate=0.5172；
  分段：起点 <38 覆盖 0.6976，≥38 覆盖 0.7706（`evaluation/v65/2026-11-09T04-08-42-374Z/`）。
- **影响**：约 48% 的 surge 预测仍通过门槛；区间不能用于告警、资源预留或 VoI 证据。
- **验收**：30 个独立 seed、seed 聚类经验覆盖率下界 ≥0.93（或明确禁止进入安全路径）；
  可靠性改为基于滚动覆盖率/校准误差；报告分段覆盖率与通过门槛后的覆盖率；若达不到，保持禁用。

### R-02 预测方法选择步长与最终预测步长不一致

- **证据**：`prediction.ts` 的 `selectForecastMethod` 内部用 1 步回测，服务与 v65 最终预测 5 步；
  `backend/scripts/v65-prediction-benchmark.ts` 同样在 1 步选择、5 步评估。
- **影响**：自适应选择优化了错误目标，长 horizon 表现被系统性削弱。
- **验收**：方法选择与最终 horizon 一致；增加 2/5/10 分钟分 horizon 结果；消融“同 horizon 选择 vs 当前”。

### R-03 “多区域联合 VoI”不是联合信息价值

- **证据**：`backend/src/services/mvp/multi-voi.ts` 按区域独立算期望熵/风险，再按覆盖权重加权求和；
  `backend/scripts/voi-v2-benchmark.ts` 对同一动作在每个覆盖区域独立采样 outcome，
  RNG 只用 `regionId.length`，同长度区域共享随机流；`priorBeliefsForRegions` 把风险硬映射为 `staff_check` 似然。
- **影响**：忽略跨区域相关，联合熵/互信息不成立；报告的“联合收益”主要是覆盖范围扩大。
- **验收**：定义同一动作的跨区域联合 outcome 分布并计算联合熵/互信息；同一联合采样下比较；
  修正 RNG 使用完整 region id；报告独立/相关假设差距；增加“同覆盖但无联合推断”消融。

### R-04 预测没有进入疏散规划，“感知—预测—调度”闭环不成立

- **证据**：`backend/src/services/safety/decision-service.ts` 规划需求直接取最新观测；
  预测只用于展示、VoI 证据与可用性。
- **影响**：不能声称预测改善疏散分配/吞吐/风险；论文摘要的闭环表述超出实现。
- **验收**：实现“观测需求 vs 预测需求 vs 鲁棒区间需求”三种规划输入，比较未解决人数、出口利用率、REJECT 率；
  若不做，删除所有“预测→调度”闭环表述。

### R-05 无拥堵反馈，规划是静态吞吐上界

- **证据**：`backend/src/services/safety/planning/evacuation-planner.ts` 只读静态 `capacity_per_min`；
  `docs/LIMITATIONS.md` 明确无速度衰减/拥堵/恐慌。
- **影响**：不能研究拥堵反馈、排队、瓶颈演化；不能预测疏散时间。
- **验收**：加入至少一种拥堵反馈模型（BPR/元胞自动机/社会力）并用轨迹或合理假设标定；
  报告与静态模型在出口利用率、完成时间、未解决人数上的差异；否则贡献限定为“静态吞吐上界分配”。

### R-06 风险传播未标定，参数敏感性改变排序

- **证据**：`backend/src/services/mvp/risk-graph.ts` 硬编码 damping=0.6、steps=3、边权公式；
  `evaluation/v61/experiment_d_risk_graph_sensitivity.json`：damping=0 时平均 Kendall τ 仅 0.6164（最小 -0.1429）。
- **影响**：调查优先级依赖未标定参数；不能称为真实人群传播规律。
- **验收**：用真实/公开人群流线数据标定边权；报告跨场景留出验证与敏感性区间；主结果预注册参数并消融。

### R-07 区域在留容量与双向容量语义（本轮部分修复）

- **已修复**：双向通道正反方向共享同一分钟容量，规划器与 Validator 聚合口径一致；
  规划器把在留容量改为硬约束；求解器达到 200000 次增广上限时标记 `solverTruncated`。
- **仍缺**：Validator 未独立检查区域在留容量；规划器与 Validator 共享同一个 `EffectiveNetwork`，
  网络解析错误会同时影响两侧；需求检查要求与最新观测精确相等，没有独立需求源。
- **验收**：Validator 增加在留容量硬检查；增加“同一分钟双向合计 > 容量”端到端测试；
  引入独立需求/网络快照或至少交叉校验；对 20–50 个随机小场景与 MILP/穷举比较最优性 gap。

### R-08 多区域调查轮次未强制，且未接入 Agent 主循环

- **证据**：`multi-voi.ts` 类型声明了 `max_investigations_reached` 但无分支；
  `agent.ts` 主循环仍用单区域 `decideInvestigation`；dashboard 调用未传预算用量。
- **影响**：多区域策略可能超轮次；当前是离线/展示能力，不是闭环执行能力。
- **验收**：多区域决策增加 `investigationsUsed` 与停止条件；接入 Agent→工单→审批→反馈；
  dashboard 传真实预算；端到端测试。

### R-09 证据冲突检测实现但未接入主循环

- **证据**：`investigation-session.ts` 有 `detectEvidenceConflict/applyEvidenceWithConflict`；
  `agent.ts` 直接 `applyEvidence`，生产路径无调用。
- **影响**：矛盾证据按普通贝叶斯更新，冲突折扣能力没有生效。
- **验收**：Agent 循环接入冲突检测；端到端测试“相反证据→信念混合/冲突记录/动作改变”；报告冲突率与折扣前后差异。

### R-10 v2 公平实验的动作失败/重试/冲突未真正仿真

- **证据**：`voi-v2-benchmark.ts` 执行阶段固定 `success: true, outcome: 'inconclusive'`；
  `failure_probability` 只进评分。
- **影响**：策略比较未覆盖失败传播；与真实调查闭环差距大。
- **验收**：按似然/失败概率采样 outcome，执行重试/冷却/冲突；报告失败率与预算耗尽率；保留失败样本。

### R-11 基线/消融仍不完整

- **缺**：CSRNet 及其他计数基线；ARIMA/Prophet/RNN；最优 POMDP/穷举；规划 MILP/贪心；
  risk-only / IG-only / 固定 blend / 相关 outcome 消融；正式功效分析。
- **验收**：每个主张至少一个强基线 + 消融 + seed 聚类区间 + 失败案例；论文主表统一口径。

### R-12 论文与材料数字/引用（本轮已修主要项）

- 已修：PAPER_DRAFT 的 3.4×、5 seeds、旧预测数字；FINAL_DELIVERY/RELEASE_CHECKLIST/DEMO_SCRIPT
  测试计数；COMPETITION_TECHNICAL_REPORT 的 300 次口径；S05/S06/S09 错误引用。
- 仍需：统一以 `research/CLAIMS.md` 为数字源；建立“数字一致性检查”CI；逐条核验来源作者/年份/许可。

---

## 4. 工程可靠性缺口（P1/P2）

| ID | 问题 | 证据 | 影响 | 验收 |
| --- | --- | --- | --- | --- |
| E-01 | 多实例仅防覆盖，不防陈旧读 | `persistent-store.ts` 文件锁+CAS；服务只启动时加载 | 第二个实例看不到第一个实例的新状态 | 迁移 SQLite/共享存储，或明确拒绝多实例启动；CAS 冲突已 fail closed |
| E-02 | MCP HTTP 单一进程身份，无按 token 身份映射 | `src/mcp/server.ts`、`src/app.ts` | 审计无法区分调用者；多租户不可用 | token→actor 映射；每请求审计；无 token 拒绝 |
| E-03 | 工具超时不可取消 | `tools.ts` `Promise.race` | 慢 handler 仍可能产生副作用 | 支持 AbortSignal 或明确文档化并限制副作用工具 |
| E-04 | 审计日志无轮转/保留/哈希链 | `safety/audit.ts` | 生产取证与容量风险 | 轮转、保留策略、哈希链或外部采集 |
| E-05 | 限流为进程内 | `config/security.ts` | 多实例无效 | Redis/网关限流；文档明确单实例 |
| E-06 | 无浏览器 E2E / 移动端真机 | CI 仅单测/集成 | 前端闭环无自动化证据 | Playwright 覆盖登录→审批→staff→反馈→续接 |
| E-07 | Docker 未实跑 | Dockerfile/CI | 镜像可能启动失败或卷权限错误 | CI 增加 build/run/health/卷重启 |
| E-08 | 顶层证据清单不覆盖 v65/voi-v2/real-data | `evaluation/MANIFEST.json` 46 文件 | “46/46”不代表全部证据 | **已实现** `npm run manifest:release`：`evaluation/RELEASE_MANIFEST.json` 覆盖 81 文件/60.2 MB，`--verify` 81/81；CI 增加校验 |
| E-09 | 公开数据集评测依赖仓库外数据/权重 | `evaluation/real-data/CONFIG.json` | 不能一键复现；误运行可能写 blocked | 数据/权重哈希校验；`--output` 新目录；CI blocked 路径测试 |

---

## 5. 外部资源缺口（必须由用户/团队提供）

| # | 资源 | 具体需要 | 对应验收 |
| --- | --- | --- | --- |
| X-01 | AgentArts 租户 | 租户控制台权限、API Key/AK-SK、已发布运行时名、官方 API/鉴权文档、Trace 导出权限 | 真实租户完整链路 + 脱敏请求/响应 + 平台 Trace + 应用版本 |
| X-02 | 昇腾设备 | 具体型号（310/310P/910B 等）、CANN/驱动版本、`atc` 环境、可用 `.om`、功耗计 | 设备/版本/命令日志、模型哈希、逐样本误差、延迟/吞吐/功耗 |
| X-03 | 场馆与数据 | 测绘、区域面积、通道/出口容量、摄像机标定、真实视频/人流、时间戳 | 测绘报告、标定文件、数据授权、现场精度 |
| X-04 | 人员研究 | 工作人员/参与者、知情同意/伦理审批、任务脚本 | 8 名参与者 × 48 次交叉任务记录、耗时/完成率/错误率 |
| X-05 | 许可 | ShanghaiTech、P2PNet 权重、NWPU/UCF-QNRF、CityStreet、航拍底图 | LICENSE/条款原文 + 哈希；可再分发清单 |
| X-06 | 无人机 | 无人机、持证操作员、空域/飞行审批、场地授权、保险 | 飞行许可、操作员证、飞行日志、观察回执 |
| X-07 | 赛事 | 官方赛题页/评分细则/材料格式/演示时长、报名账号、指导教师/学校签字 | 官方截图/PDF、报名回执、评分表、提交清单 |
| X-08 | 部署 | Docker daemon/CI runner、TLS 域名、secret manager、日志采集 | build/run/health/重启日志、CI 运行记录 |
| X-09 | 专业评审 | 消防/公共安全/功能安全评审与演练授权 | 评审报告、演练记录、失效模式分析、整改闭环 |

---

## 6. 竞赛交付缺口

| 交付物 | 现状 | 缺口 | 验收 |
| --- | --- | --- | --- |
| 论文 | `docs/PAPER_DRAFT.md` Markdown 初稿 | 无 LaTeX/PDF；主结果需统一到 V6.5 30 seed；引用需逐条核验 | PDF + LaTeX 源；数字一致性检查通过；引用审计通过 |
| PPT | 无 | 需按官方评分权重组织：问题、创新、系统、华为技术、实验、边界 | 15–20 页答辩版 + 6–8 分钟演示版；数字与 CLAIMS 一致 |
| 演示视频 | 无 | 需录屏 + 现场流程（感知→调查→审批→执行→反馈） | 6–8 分钟；含失败/降级路径；标注合成/非实时 |
| 证据包 | 冻结证据 + 各目录 manifest | 无统一 release manifest/archive；不覆盖新证据 | `release/` + SHA-256 + 一键复现脚本 |
| 答辩材料 | `DEFENSE_QA.md` 40 问、`QA_BANK.md` 20 问 | 需加入本轮 P1 修复、证据 CRLF、引用修正 | 答辩追问覆盖“未验证/失败案例/统计口径” |
| 赛规 | 第三方通知 + 未核验 | 官方赛道/资格/截止/评分/格式 | 官方页面截图/PDF + 报名回执 |

---

## 7. P0/P1/P2 完整问题清单（摘要）

### P0（阻断交付）

- B-01 AgentArts 真实租户/Trace；B-02 昇腾实机；B-03 官方赛规；B-04 PPT/视频/PDF/归档；
- B-05 Docker/E2E；B-06 数据/权重许可。
- **代码内 P0：无未关闭。**

### P1（核心正确性/可信度）

- R-01 预测区间失效；R-02 选择步长错配；R-03 联合 VoI 名不副实；R-04 预测未进规划；
  R-05 无拥堵反馈；R-06 风险传播未标定；R-07 Validator 在留容量/独立需求；R-08 多区域未强制轮次；
  R-09 冲突未接入；R-10 v2 未仿真失败；R-11 基线/消融不足；R-12 材料数字/引用；
  E-01 多实例陈旧读；E-02 MCP 身份；E-03 超时不可取消。

### P2（工程/体验）

- E-04 审计轮转；E-05 分布式限流；E-06 浏览器 E2E；E-07 Docker 实跑；E-09 数据复现硬化；
- 前端进一步可用性、移动端真机、长时运行/内存/背压、依赖漏洞扫描、CI 固定 `tsx` 版本。

**已关闭（本轮）**：V6.5 P1-1～P1-10、P1-12、P1-13；P1-11 仅透明度；
证据 CRLF/校验只读；生产占位符凭证；昇腾业务调用点；双向容量/在留容量/求解器截断；
MCP 审计/长度/身份边界；真实数据覆盖保护；主要文档数字与错误引用。

---

## 8. 按依赖排序的研发总攻路线

> 原则：先安全与真实，再研究强度，再平台/硬件，最后交付。每个工作包都有可验收产物；
> 外部资源未到位时，先完成不依赖外部资源的部分。

### 阶段 A：工程可靠性收口（1–2 周，无外部依赖）

| 包 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| A1 | Validator 增加区域在留容量硬检查；双向容量端到端测试；求解器截断进入 API 响应 | R-07 | 新测试覆盖“双向合计超容”“初始超员”；规划/校验结论一致 |
| A2 | 多区域 `max_investigations` + Agent 主循环接入；dashboard 传真实预算 | R-08 | 端到端“多区域推荐→工单→审批→反馈”；轮次/预算不超 |
| A3 | 冲突检测接入 Agent；端到端相反证据测试 | R-09 | 冲突率/折扣前后风险差异报告 |
| A4 | MCP token→actor 映射；超时 AbortSignal（或明确限制副作用工具）；审计轮转 | E-02/E-03/E-04 | 多 token 不同 actor；审计覆盖早期拒绝与轮转 |
| A5 | SQLite 迁移或多实例启动拒绝 | E-01 | 双实例陈旧读消除或拒绝启动 |
| A6 | Playwright E2E + Docker build/run/health/卷重启 | E-06/E-07 | CI 两个新 job 绿灯；截图/日志归档 |

### 阶段 B：算法研究强化（3–6 周，无外部依赖，需算力）

| 包 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| B1 | 预测区间：regime-aware/在线校准；同 horizon 方法选择；覆盖率门槛 | R-01/R-02 | surge seed 聚类覆盖率下界 ≥0.93 或明确禁用；30 seed 报告 |
| B2 | 联合 VoI：跨区域联合 outcome/联合熵；修正 v2 RNG；独立/相关消融 | R-03/R-10 | 联合采样下 multi vs single；独立/相关差距；失败仿真 |
| B3 | 预测进入规划：观测/预测/鲁棒三种需求对比 | R-04 | 未解决人数、出口利用率、REJECT 率对照；保留失败案例 |
| B4 | 拥堵反馈模型 + 标定 | R-05 | 静态 vs 拥堵模型的完成时间/利用率/未解决人数 |
| B5 | 风险传播标定/跨场景留出 | R-06 | 标定误差、留出验证、damping/权重敏感性 |
| B6 | 强基线：CSRNet、ARIMA/Prophet/RNN、MILP/穷举、POMDP 近似 | R-11 | 每个主表有强基线 + 消融 + 区间 + 失败案例 |
| B7 | 统计与功效：所有主分析 seed 聚类 + Holm/FDR；功效分析 | R-11 | 预注册主比较；CI 不因 trial 伪重复过窄 |

### 阶段 C：华为技术实机（依赖 X-01/X-02，2–4 周）

| 包 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| C1 | AgentArts 真实租户：健康/调用/工具回执/审批等待/反馈续接/Trace | X-01 | 脱敏请求响应 + 平台 Trace + 应用版本；`business_closure` 有证据更新路径 |
| C2 | 昇腾：模型转换 `.om`、CANN 部署、端侧推理、精度/延迟/吞吐/功耗 | X-02 | 设备/版本/命令日志、模型哈希、逐样本误差、性能原始数据 |
| C3 | Edge-Cloud：云端预测/风险管理 + 边缘实时感知协同 | X-01/X-02 | 端到端时延/带宽/降级路径；不得用本地 stub 冒充 |

### 阶段 D：真实场景验证（依赖 X-03/X-04/X-06，4–8 周）

| 包 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| D1 | 场馆测绘/区域面积/通道/出口容量；摄像机标定 | X-03 | 测绘报告 + 标定文件 + 场景 `measured` 来源 |
| D2 | 真实视频/人流标注；现场计数精度 | X-03 | 标注协议 + 逐帧真值 + MAE/RMSE/NAE（与公开数据集分开报告） |
| D3 | 受控演练：感知→调查→审批→执行→反馈 | X-03/X-04 | 演练脚本、日志、失败案例、安全评审 |
| D4 | 工作人员用户研究 | X-04 | 知情同意、任务记录、耗时/完成率/错误率；小样本结论限定 |
| D5 | 无人机观察（可选） | X-06 | 飞行许可/操作员证/日志/回执 |

### 阶段 E：竞赛交付（与 A–D 并行，最后 2–3 周）

| 包 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| E1 | 官方赛规核验与报名 | X-07 | 官方截图/PDF、报名回执、评分表、材料清单 |
| E2 | 论文定稿（LaTeX→PDF） | A/B | 数字一致性检查、引用审计、局限章节、失败案例 |
| E3 | PPT/答辩材料 | E2 | 答辩版 + 演示版；每个技术主张有证据/边界 |
| E4 | 演示视频 | A/B | 6–8 分钟；含降级/拒绝/人工审批；标注合成/非实时 |
| E5 | release 证据包/归档 | A5 | manifest + SHA-256 + 一键复现 + 许可清单 |
| E6 | 专业评审与答辩演练 | X-09 | 评审报告、模拟问答覆盖率、整改闭环 |

---

## 9. 第一批可立即执行的代码任务（建议顺序）

1. **A1**：Validator 在留容量检查 + 双向容量端到端测试（已有规划器共享闸门实现）。
2. **A2/A3**：多区域轮次与冲突检测接入 Agent；补端到端测试。
3. **B1**：同 horizon 方法选择 + 覆盖率门槛；重跑 V6.5 并更新证据。
4. **B2**：联合 outcome 采样与 RNG 修复；重跑 v2 并并列报告。
5. **A4**：MCP token→actor、超时取消/限制、审计轮转。
6. **A5**：SQLite/多实例启动拒绝 + release 级证据清单。
7. **A6**：Playwright + Docker CI job。
8. **E1**：拿到官方赛规后锁定材料格式；并行生成 PPT 骨架与演示脚本。
9. **E2/E3**：以 `research/CLAIMS.md` 为唯一数字源重写论文主表与答辩数字。

---

## 10. 本轮实际修改清单（供 review）

### 10.1 代码

- `backend/src/services/mvp/ops.ts`：P1-1/2/3/4；工单字段长度上限。
- `backend/src/services/mvp/agentarts.ts`：P1-5 SSE 完整事件校验；P1-9 稳定 `X-Request-Id`。
- `backend/src/services/mvp/index.ts`：P1-6 续接复用 session/Trace 与反馈上下文。
- `backend/src/services/state/persistent-store.ts`：P1-7 文件锁 + 磁盘 revision CAS。
- `backend/src/api/v1/errors.ts`（新增）、`safety.ts`、`perception.ts`：P1-8 生产 5xx 脱敏。
- `backend/src/services/perception/adapter.ts`：P1-12 单一 `deriveSafetyValidity`。
- `backend/src/api/v1/auth.ts`、`backend/src/index.ts`：生产占位符/旧默认管理员口令拒绝。
- `backend/src/api/v1/safety.ts`：新增 `POST /observations/ascend` 业务调用点。
- `backend/src/services/safety/providers/ascend.ts`：纠正“业务层无需改动”表述。
- `backend/src/services/safety/planning/evacuation-planner.ts`：双向共享容量、在留容量硬约束、求解器截断标记。
- `backend/src/services/mvp/tools.ts`：早期拒绝写审计；`backend/src/app.ts`：恒定时间 token、staff HTTP 默认禁用。
- `backend/python/real_data/run_p2pnet_eval.py`：默认拒绝覆盖已有结果。
- `backend/scripts/verify-evidence.ts`：默认只读；`v65-prediction-benchmark.ts`：seed Bootstrap + Holm + surge 分段 + CI 输出重定向；
- `backend/scripts/release-manifest.ts`（新增）：发布级证据清单与只读校验。
- `.gitattributes`：`evaluation/** text eol=lf`；`.github/workflows/ci.yml`：证据不可变 gate。

### 10.2 测试

新增/更新：`reservations.test.ts`（4 组）、`state-persistence.test.ts`（CAS）、
`agentarts.test.ts`（SSE 尾部截断、请求 ID）、`agentarts-runtime.test.ts`（续接会话/上下文）、
`adapter.test.ts`（判据一致）、`p0-hardening.test.ts`（占位符/旧管理员口令）、
`security.test.ts`（生产 5xx）、`safety-api.test.ts`（昇腾 503）。

### 10.3 文档/证据

- `V6.5_INDEPENDENT_AUDIT.md`：追加 P1 修复记录。
- `docs/PROJECT_STATUS.md`：追加本轮状态。
- `docs/PAPER_DRAFT.md`、`FINAL_DELIVERY.md`、`RELEASE_CHECKLIST.md`、`DEMO_SCRIPT_6_8MIN.md`、
  `COMPETITION_TECHNICAL_REPORT.md`、`research/RESEARCH_GAPS.md`、`RELEASE_AUDIT_FINAL.md`：数字/口径修正。
- `research/SOURCES.jsonl`、`SOURCE_AUDIT.md`：S05/S06/S09 引用修正。
- `evaluation/RELEASE_MANIFEST.json`：发布级证据清单（81 文件）；
- `evaluation/v65/2026-11-09T04-08-42-374Z/`：新证据（**未跟踪，必须与 `LATEST.txt` 一起提交**）；
  旧运行目录保留。
- `docs/COMPETITION_GAP_AUDIT_2026-11-09.md`：本文件。

> **Git 状态说明**：本轮未 commit/push。`evaluation/v65/LATEST.txt` 已指向新运行；
> 提交时必须同时加入新运行目录，否则 `v65-prediction-evidence.test.ts` 会失败。

---

## 11. 对外表述边界（必须保留）

- 不得说“已接入华为云 AgentArts”“已适配昇腾”“已控制无人机”“已通过安全认证”“可用于真实疏散指挥”。
- 公开数据集精度只能写“ShanghaiTech Part A / P2PNet 官方权重 / CPU / 非现场”，且许可未核验。
- 预测区间不得用于安全告警阈值；surge 覆盖率 0.74 是模型失效，不是可忽略噪声。
- 多区域 VoI 只能说“总风险降低更高”，不能说“全面更优”；效率低于随机/启发式基线。
- 规划结果是静态容量下的吞吐分配，不是疏散时间预测；无拥堵反馈。
- 一等奖是目标，不是成绩。
