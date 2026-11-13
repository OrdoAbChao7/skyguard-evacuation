# SkyGuard V6.4 实施报告（2026-11-09）

> 基线：`feat/skyguard-mvp-e2e`，HEAD `fce7b87`（PR #4 已合并）。
> 本报告只陈述本轮实际运行过、可在本机复现的结果；未实机验证的内容单独标注。

## 1. 本轮目标与结论

本轮针对 [`ICT_IMPROVEMENT_EXECUTION_PLAN.md`](ICT_IMPROVEMENT_EXECUTION_PLAN.md) 的
G01–G06、G08、G09 做代码级修复，并重新运行全部可运行测试、构建与演示。

**结论：P0 中可在无真实租户/设备前提下完成的工程问题已处理；真实 AgentArts、
昇腾实机、场馆用户研究与派发预留/共同事务仍是外部或后续阻塞。** 本轮不改变
V6.2 冻结证据，也不升级任何平台/硬件验证等级。

## 2. 代码改动

### 2.1 安全与预算

| 文件 | 改动 |
| --- | --- |
| `backend/src/services/mvp/budget.ts`（新增） | 统一预算准入：`used + reserved + candidate <= max`；区分动作数、资源、时间；NaN/无穷/负数拒绝；单候选超限不误判整体耗尽 |
| `multi-voi.ts` | 每个候选动作做预算判定并输出 `budget`；覆盖权重来自场景；`coverage_weight_source` 标注来源 |
| `investigation-session.ts` | 候选成本计入可用性；冲突窗口/混合系数来自场景；`budgetExhausted` 改为“所有候选都不可准入” |
| `agent.ts` | 本地 Agent 维护调查会话，逐轮检查预算/冷却/重试并按实际尝试结算成本 |
| `availability.ts`（新增） | 调查可用性按动作 `kind` 映射，移除 `A_CAMERA` 等硬编码 ID |

### 2.2 场景与可迁移性

| 文件 | 改动 |
| --- | --- |
| `data/scenarios/stadium-evacuation.json` | 新增 `investigation.coverage_weights`、`investigation.conflict`、`ui_demos`（推演序列/容量/事件） |
| `safety/types.ts` | 新增覆盖权重、冲突参数、`ui_demos` Schema；`ui_demos` 仍为可选，缺失时禁止回退硬编码 |
| `safety/scenario.ts` | 校验 `ui_demos` 引用的区域/通道/出口 |
| `mvp/index.ts` | 一键推演读取场景 `ui_demos`；缺失时返回明确错误；AgentArts 请求注入真实 `scenario_id` |

### 2.3 AgentArts

| 文件 | 改动 |
| --- | --- |
| `agentarts.ts` | 官方契约 `POST /runtimes/{runtime_name}/invocations`、`Authorization`、`x-hw-agentarts-session-id`、`query`/`inputs`、`event/data.text` 解析；`connectivity` 与 `business_closure` 分离；模板契约保留为测试模式 |
| `mvp/index.ts` | 有界多步（默认 4，1–10）、重复调用停止、创建工单后 `awaiting_approval`、文本-only 转人工、`AGENTARTS_AUTO_CONTINUE` 续接入口 |
| 前端 | 状态面板显示“可达性 … · 业务闭环 已验证/未验证” |

### 2.4 MCP 与持久化

| 文件 | 改动 |
| --- | --- |
| `mcp/server.ts` | 抽出 `createMcpServer`；新增 Streamable HTTP handler；stdio 仅作为独立入口 |
| `app.ts` | 挂载 `POST /mcp`，与网页 API 共用 `MvpService` 单例 |
| `mvp/index.ts` | Agent 运行记录可选 JSON 快照 `MVP_RUNS_FILE`，启动恢复、损坏不阻断并写审计 |
| `observations.ts` | 重复观测忽略（不增版本）；按观测时间插入，乱序旧观测不覆盖最新观测 |
| `decision-service.ts` | 重复观测写独立审计 `observation.duplicate_ignored`，不触发新版本 |
| `scripts/evidence-manifest.ts` | 文本证据按 LF 归一化后计算大小/SHA-256，修复 Windows `autocrlf` 下冻结清单校验失败（46/46） |

### 2.5 新增实验

`backend/scripts/voi-v2-benchmark.ts`（`npm run benchmark:voi-v2`）：

- 所有策略对同一物理动作获得相同覆盖；
- 观测从似然分布采样，不使用最大似然标签；
- 预算准入统一；
- 输出 `evaluation/voi-v2/<run-id>/`，不覆盖 `evaluation/v62/`。

## 3. 验证结果（本机，2026-11-09）

| 项目 | 结果 |
| --- | --- |
| 后端测试 | **142 / 142 通过** |
| 前端测试 | **16 / 16 通过** |
| TypeScript | `tsc --noEmit` 通过 |
| 生产构建 | `npm run build` 通过 |
| 安全演示 | `npm run demo` 三场景符合预期 |
| MVP 演示 | `npm run demo:mvp` 三场景通过 |
| 公平 VoI 复跑 | 完成，两次独立运行统计一致；证据见 `evaluation/voi-v2/2026-11-08T17-00-16-896Z/` 与 `2026-11-08T17-29-19-101Z/` |

### 3.1 新增回归测试

- `backend/tests/mvp/budget.test.ts`：越界、等值、动作数/时间/预留、NaN、单候选超限。
- `backend/tests/mvp/agent-budget.test.ts`：`max_actions=1` 时本地 Agent 只执行一轮。
- `backend/tests/mvp/mcp-http.test.ts`：HTTP MCP 创建工单后网页侧读到同一工单。
- `backend/tests/mvp/persistence.test.ts`：运行快照恢复；损坏快照不阻断并写审计。
- `backend/tests/safety/observations.test.ts`：重复、乱序、独立观测。
- `backend/tests/safety/scenario-fallback.test.ts`：显式场景缺失时失败，不静默换回默认场馆。
- `backend/tests/mvp/agentarts.test.ts`：官方路径/会话头/`query`+`inputs`/`data.text`；文本-only 不伪造工具。
- `backend/tests/mvp/agentarts-runtime.test.ts`：多步创建工单后等待审批；重复调用停止；
  人工反馈后 `AGENTARTS_AUTO_CONTINUE=true` 触发续接运行。
- 前端 `MvpPanels.test.tsx`：可达性与业务闭环分开显示。

### 3.2 公平 VoI 结果（合成，1200 对）

| 策略 | 风险降低 [95% CI] | 成本 | 效率 | 覆盖区域 |
| --- | --- | --- | --- | --- |
| 单区域 | 0.0446 [0.0429, 0.0464] | 0.2528 | 0.2643 | 1.62 |
| 多区域 | 0.1711 [0.1655, 0.1768] | 0.5868 | 0.2971 | 6.74 |
| 随机 | 0.0909 [0.0858, 0.0961] | 0.3943 | 0.3433 | 4.26 |
| 启发式 | 0.0317 [0.0305, 0.0329] | 0.0800 | 0.3961 | 2.00 |

- 多 − 单配对差 0.1265 [0.1209, 0.1321]，d_z=1.27；效率差 0.0328 [0.0140, 0.0515]。
- **不得再单独引用 V6.2 的 0.1682 / d_z=2.06 作为无保留的算法优势**；V6.2 结果受
  `single` 策略信息权限缩小影响。两套结果必须并列。
- 多区域总收益仍最高，但单位成本效率低于随机/启发式；对外表述应限定为
  “在相同动作与预算下，多区域提高总风险收益，但成本更高”。

## 4. 平台与硬件真实接入状态

| 项 | 状态 | 说明 |
| --- | --- | --- |
| AgentArts | **未实机** | 官方契约、会话头、有界多步、文本/决策解析、stub 测试已完成；无租户、凭证、已发布运行时、平台 Trace |
| MCP | 已验证（单实例） | stdio 15 工具 + HTTP `/mcp` 共享状态；无独立鉴权层 |
| CANN / 昇腾 | **未实机** | 仅环境探针与外部推理契约；无 NPU/`.om` |
| MindSpore | **未接入** | 无训练/转换代码在本轮运行 |
| 无人机 | **无真实设备** | 仅工单请求与模拟反馈 |
| 真实场馆/用户研究 | **无** | 场景与人员均为合成；无参与者任务记录 |

## 5. 仍未完成（按类型）

### 5.1 外部阻塞（需要用户/团队提供）

1. **AgentArts 租户**：已发布运行时名、API Key、租户端点、应用版本；
   完成一次真实“工具调用 → 待审批 → 人工审批/派发 → 现场反馈 → 续接”，
   保存脱敏 Trace 后再更新 `business_closure` 与 C08/C12。
2. **昇腾设备**：具体型号、CANN 版本、可用 NPU；完成模型转换、`.om`、精度/延迟对比。
3. **真实场馆与人员**：场地资料、许可、参与者授权、访谈与受控任务排期。
4. **竞赛报名/资格**：团队、指导教师、学校签字与官方系统提交，只能由用户完成。
5. **公开数据集许可**：ShanghaiTech/CityStreet 等许可核验与再分发边界。

### 5.2 可继续在代码内推进（本轮未完成）

1. **派发时资源预留与共同事务**：`budget.ts` 已支持 `reserved_*`，但工单派发尚未写入
   预留；跨工单/预算/事件的 SQLite 或等效事务未实现。
2. **预测区间覆盖率**：严格滚动验证已有，90%/95% 覆盖率仍未稳定达到名义水平；
   G11 未关闭。
3. **多实例一致性**：限流、状态、幂等均为单进程；HTTP MCP 与网页共享仅限单实例。
4. **证据台账完整生命周期**：本轮完成存储层去重/乱序；跨来源相关性、替换重建、
   过期隔离仍只部分实现。
5. **感知**：CityStreet 回放只有展示链路，无真值；NWPU/UCF-QNRF/Part B 未运行。

## 6. 参赛成熟度重新评估

| 维度 | 评估 | 依据 |
| --- | --- | --- |
| 工程完整度 | 中高 | 闭环、权限、审计、测试、构建、演示均可运行；单实例 |
| 算法证据 | 中 | 公平复跑后多区域总收益结论仍成立，但效应量缩小、效率不占优；参数未标定 |
| 真实数据 | 中低 | ShanghaiTech Part A 已完成；无真实场馆、无用户研究 |
| 华为技术 | 低–中 | AgentArts 官方契约代码完成但无租户；昇腾/MindSpore 未实机 |
| 安全可信 | 中高（原型内） | 独立校验、四态、权限、stale、MCP 同源校验；非认证 |
| 可复现性 | 高（本机） | 固定种子、原始 JSON、测试与证据目录；未在其他环境复现 |
| 竞赛材料 | 中 | 文档齐全；真实平台/现场证据与最终视频/PPT 仍需补齐 |

**综合：具备可演示、可复现的研究原型竞争力；距离“国赛一等奖”所需真实平台闭环、
现场验证与完整交付材料仍有明确差距。不得对外宣称已接入 AgentArts、已昇腾适配或
已真实场馆验证。**

## 7. 复现命令

```powershell
npm test
npm run build
npm run demo
npm run demo:mvp
npm run benchmark:voi-v2 --prefix backend
```

公平复跑结果位于 `evaluation/voi-v2/<run-id>/`；V6.2 冻结目录未修改。
