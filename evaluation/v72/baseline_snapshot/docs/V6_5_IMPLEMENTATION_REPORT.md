# SkyGuard V6.5 实施与验证报告（2026-11-09）

> 基线：`feat/skyguard-mvp-e2e`，V6.4 提交 `4025ac1` / `b4c1512`。
> 本报告只陈述本轮实际修改、实际运行结果与可复现证据；未实机验证的内容单独标注。

## 1. 结论摘要

V6.5 完成了当前环境内可独立实施的 G05、G08、G01 强化、G11 实验与
“感知→观测→预测→VoI→风险”本地闭环，并完成启动恢复、损坏 fail-closed、
MCP 鉴权与错误脱敏等可靠性加固。

**仍不能宣称**：AgentArts 已实机接入、昇腾已适配、真实场馆精度、真实用户收益。
这些需要外部租户/设备/场馆/人员资源。

## 2. G05 资源预留与工单闭环

实现文件：`backend/src/services/mvp/ops.ts`、`budget.ts`、`api/v1/mvp.ts`、`tools.ts`。

- 工单创建建立 `ResourceReservation`：人员软预留、预算单位、人员分钟、TTL、
  场景版本、上下文版本；`resource_request` 缺省时仍尝试预留推荐人员，但不计调查预算。
- 审批确认预留；拒绝/取消/过期/执行失败释放；完成把“预留”结算为“已用”。
- 新增 `CANCELLED` 状态与 `POST /work-orders/:id/cancel`。
- 派发前复核：人员可用性、上下文 stale、预留状态、场景版本；失效则拒绝。
- 幂等键绑定规范化参数 SHA-256 指纹；同键同参返回同一工单，同键异参 HTTP 409。
- 并发创建同一人员：单进程同步操作 + `reserved` 状态，只有一个成功。
- 新增 `GET /work-orders/budget`、创建响应返回预算快照与预留。

测试：`backend/tests/mvp/reservations.test.ts`
（创建/预检、拒绝/取消/失败/完成、预算边界、幂等冲突、并发、过期重确认、场景版本），
`agent-budget.test.ts`，共 9 组。

**边界**：单实例；预算完成结算使用工单声明值，不是现场实际耗时；没有多实例并发锁。

## 3. G08 单实例事务状态与恢复

实现文件：`backend/src/services/state/persistent-store.ts`、`state/app-state.ts`、
`mvp/index.ts`、`safety/{decision-service,observations,incidents,audit}.ts`。

- `MVP_STATE_FILE` 一次快照覆盖：
  - 安全域：完整观测历史、事件与别名、约束版本、已发布/候选方案、校验结果、
    状态快照、推理健康、排除项；
  - 业务：工单、人员状态、幂等映射、预算已结算；
  - Agent 运行与顺序；内存审计与 Trace。
- 写入：临时文件 → `fsync` → 原文件转 backup → 原子改名；SHA-256、schema_version、
  revision 校验。
- 启动：校验 primary/backup/temp 全部候选，**按 revision 最大者恢复**（同 revision 才按
  primary > backup > temp）；全部损坏、部分写入、未来版本时 **拒绝启动**。
- 事务范围：工单完成与现场反馈写回同一事务，只提交一次统一状态；
  任一跨域步骤抛错时回滚内存状态且不持久化；`resetAll` 也合并为一次提交。
- 存储失败后进入只读：后续工单/安全写入与幂等命中均被拒绝，等待人工重启/修复。

测试：`state-persistence.test.ts`
（跨业务恢复、backup 恢复、temp 恢复、revision 冲突、未来 schema 拒绝、
幂等重放、审计/预算/预留恢复）；真实进程重启实测：创建工单后重启，
`revision=2`、工单/预留/人员状态恢复；primary+backup 同时损坏时 exit 1。

**边界**：单实例；快照是跨域近似的共同事务，不是分布式事务；内存审计视图
与 JSONL 追加文件可能短暂不一致。

## 4. G01 AgentArts 强化（本地 stub）

实现文件：`backend/src/services/mvp/agentarts.ts`、`mvp/index.ts`。

- 官方 `POST /runtimes/{runtime_name}/invocations`、Bearer、
  `x-hw-agentarts-session-id`、`query`/`inputs`、`event/data.text`。
- 有界重试：超时/网络/429/5xx（默认 1 次，指数退避）；4xx 不重试。
- SSE/流式 `data:` 响应取最后一个可解析事件；截断/部分 JSON 显式失败。
- 同一运行全部步骤共用会话头，每步 `inputs.trace_id` 独立。
- 有界多步、重复调用停止、建单后 `awaiting_approval`、文本-only 转人工、
  建单幂等键、反馈触发续接（`AGENTARTS_AUTO_CONTINUE`）。
- 平台越权工具被本地注册表拒绝，无副作用。

测试：`agentarts.test.ts`、`agentarts-runtime.test.ts`。
**仍无真实租户、凭证、已发布运行时与平台 Trace，未实机验证。**

## 5. G11 预测与风险模型实验

实现文件：`backend/scripts/v65-prediction-benchmark.ts`、
`backend/src/services/mvp/prediction.ts`、`availability.ts`、`agent.ts`。

- 30 种子 × 6 机制（stable/surge/decline/periodic/missing/noisy）；
- 5 基线 + 自适应滚动选择；严格滚动起点，目标点不参与训练/选择/区间校准；
- MAE/RMSE/NAE、90%/95% 覆盖率、平均宽度、失效检测、敏感性、消融、失败案例；
- 预测新增 `reliability`；区间相对宽度超场景阈值/数据不足时 `failed`，
  VoI 预测动作不可用。

结果（`evaluation/v65/<run>/`）：

| 机制 | 最佳方法（MAE） | 自适应 MAE | 自适应 95% 覆盖 |
| --- | --- | --- | --- |
| stable | linear 10.16 | 11.47 | 0.988 |
| surge | persistence 93.46 | 93.55 | **0.738** |
| decline | linear 8.43 | 13.10 | 0.994 |
| periodic | linear 81.86 | 95.68 | 1.000 |
| missing | EMA 12.40 | 13.78 | 0.983 |
| noisy | linear 70.73 | 78.35 | 0.979 |

自适应配对平均优于全部基线（绝对误差差 -2.4 至 -9.2），但不是任何单一机制最佳；
**surge 95% 覆盖率明显低于名义值**；periodic/noisy 的预测动作几乎全部被可靠性门槛阻断。
不得把预测区间用于安全告警阈值，不得宣称自适应全面最优。

## 6. 感知→决策本地闭环

实现文件：`backend/src/services/perception/adapter.ts`、`api/v1/perception.ts`、
前端 `PerceptionReplayPanel.tsx` / `perceptionApi.ts`。

- 图像/显示帧 → 人数 → 质量门禁 → 区域观测 → 预测 → VoI → 风险。
- 只有 surveyed 标定、与场景区域一致面积、置信度足够时生成可信观测；
  否则写 `valid=false` 观测并进入 DEGRADED，不伪造密度。
- 草稿携带进程内 HMAC 证明；`ingestPerceptionDraft` 重新推导可信性，拒绝未签名/篡改草稿、
  `display_frame` 来源、未标定来源与面积不一致的草稿，不信任调用方自报的 `valid_for_safety`。
- CityStreet 派生帧用米制多边形鞋带面积计算演示密度；无真值、许可未核验、
  配准近似，永不进入可信安全观测。
- 新增 `zone_areas_m2`、帧质量 API、真实数据结果摘要 API；
  前端显示演示面积/密度与“未标定，不得用于安全判定”。

测试：`backend/tests/perception/adapter.test.ts`（面积、图像/显示帧、标定门禁、
面积不符、低置信度、端到端链路），前端回放测试更新。

**边界**：P2PNet 结果来自已有 `evaluation/real-data/RESULTS.json`
（ShanghaiTech Part A，MAE 57.24 / RMSE 96.04 / NAE 0.1319，182 图，CPU），
只证明公开数据集图像→人数；CityStreet 无真值；两者都不代表现场精度。

## 7. 可靠性与部署

- HTTP MCP 支持 `MCP_HTTP_TOKEN` Bearer；生产未配置 token 时 `/mcp` 503。
- 生产环境 5xx 不再回显内部错误消息。
- 启动阶段统一状态损坏即退出，不等首请求。
- Dockerfile 设置 `MVP_STATE_FILE`；**Docker daemon 未运行，未完成容器实跑**。
- CI 增加 `benchmark:v65` 步骤；未在真实 CI 运行。
- 官方 2026–2027 赛规检索/抓取未获得可用页面，**规则核验未完成**。

## 8. 验证结果

| 项目 | 结果 |
| --- | --- |
| 后端测试 | **175 / 175 通过** |
| 前端测试 | **16 / 16 通过** |
| TypeScript / 构建 | 通过 |
| 安全演示 A/B/C | 三场景符合预期 |
| MVP 演示 | 三场景通过 |
| Python 语法检查 | 通过 |
| V6.4 效率复算 | `voi-v2-evidence.test.ts` 从原始数据复算 benefit/cost/效率，通过 |
| 启动恢复 | 创建工单→重启→`revision=2`、工单/预留/人员恢复 |
| 损坏 fail closed | primary+backup 损坏时进程 exit 1 |
| V6.5 预测实验 | 30 种子 × 6 机制；结果见 `evaluation/v65/<run>/` |

## 9. Git 状态

- 分支：`feat/skyguard-mvp-e2e`；基线提交 `4025ac1`、`b4c1512`。
- 本轮改动未提交（按要求不自动 commit/push）。
- 新证据：`evaluation/v65/<run>/`（独立 `MANIFEST.json`，不覆盖 V6.2 根清单）。

## 10. 外部阻塞与需要用户提供的资源

1. **AgentArts**：租户端点、API Key、已发布运行时名、应用版本；
   完成真实“工具调用→审批→反馈→续接”并保存脱敏 Trace，才能更新 C08/C12。
2. **昇腾**：设备型号、CANN 版本、可用 NPU；模型转换/`.om`/精度/延迟对比。
3. **真实场馆**：场地资料、测绘/标定、许可；真实工作人员参与与用户研究协议/授权。
4. **竞赛**：2026–2027 官方赛道/赛题/截止/资格；团队与指导教师签字、学校报名。
5. **数据许可**：ShanghaiTech/CityStreet 等许可核验与再分发边界。
6. **运行环境**：Docker daemon 或可用的 CI/部署环境，用于容器与端到端部署验证。

## 11. 参赛成熟度重新评估

| 维度 | 评估 |
| --- | --- |
| 工程完整度 | 中高：闭环、预留、事务状态、测试、演示可运行；单实例 |
| 算法证据 | 中：公平复跑后多区域总收益仍成立但效应缩小、效率不占优；预测有明确失效场景 |
| 真实数据 | 中低：公开数据集评测已完成；无真实场馆/标定/用户研究 |
| 华为技术 | 低–中：官方契约与本地异常测试完成；无租户/设备 |
| 安全可信 | 中高（原型）：独立校验、四态、权限、预留、fail-closed；非认证 |
| 可复现性 | 高（本机）：固定种子、原始数据、独立清单；未跨环境复现 |
| 竞赛材料 | 中：技术报告/答辩/演示脚本已更新；缺真实平台 Trace、现场证据、视频/PPT |

**结论**：V6.5 是可演示、可复现的研究原型，工程与证据比 V6.4 更完整；
真实平台闭环、现场验证与正式提交材料仍是决定性差距。

## 12. P0 独立审计修复（2026-11-09）

独立审计见 [`V6.5_INDEPENDENT_AUDIT.md`](../V6.5_INDEPENDENT_AUDIT.md)；原发现保留不改写。
本节只记录修复与回归。

| ID | 修复内容 |
| --- | --- |
| P0-1 | 恢复改为校验全部候选并选 revision 最大者（同 revision: primary>backup>temp）；未来 schema 直接拒绝启动 |
| P0-2 | `withTransaction` 深度 0 快照安全/工单状态，异常或持久化失败时整体回滚并记录 `system.transaction_rolled_back`；只有成功路径提交 |
| P0-3 | 统一状态只读后，工单创建/迁移/幂等命中与安全域写入全部拒绝，不再返回未持久化对象 |
| P0-4 | 感知草稿增加 HMAC 证明；ingest 重新推导可信性，硬拒绝 `display_frame`、未标定/面积不符/未签名草稿 |
| P0-5 | 生产缺少或使用默认 `SECRET_KEY`/管理员口令时启动失败；`.env` 在 auth 模块读取前加载 |
| P0-6 | `.dockerignore` 排除运行时状态文件；镜像非 root、`VOLUME /app/data`、数据目录 chown |

回归测试：`backend/tests/mvp/p0-hardening.test.ts`（5 组）；原感知正向用例仍通过。

修复后验证（本机，2026-11-09）：后端 **175/175**、前端 **16/16**、`npm run build`、
安全 demo、MVP demo、Python 语法检查、`verify:evidence` **134/134**、
冻结根清单 **46/46** 全部通过；未修改 V6.1/V6.2/V6.4 冻结证据。

**仍未修复（审计 P1）**：改派失败释放原人员、失败/取消不结算预算、缺 `resource_request`
绕过预算、幂等键跨用户、截断 SSE、续接新建会话、多实例丢失更新、生产错误回显、
平台重试非幂等、预测聚类统计、surge 区间欠覆盖、感知显示与 ingest 判据差异、环境示例。
因此本轮仍不改变“不要将 V6.5 当作可部署版本”的结论。
