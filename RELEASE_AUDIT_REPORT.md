# SkyGuard V6.1 Release Audit Report

> 历史报告：V6.2 最终交付见 `RELEASE_AUDIT_FINAL.md` 与 `evaluation/V6_2_REPORT.md`。

> 审计日期：2026-11-05  
> 范围：V6.1 科研成果、实验复现、统计方法、数据治理、来源核验、工程质量与竞赛发布准备。  
> 数据性质：全部为合成/模拟数据；AgentArts、昇腾、无人机、真实场地未实机验证。

## 1. Git 与文件变更

- 分支：`feat/skyguard-mvp-e2e`
- 当前 HEAD：`3b62fe9`（V6.1 审计提交）
- `main` 已合并 PR #1（`d75500b`）与 PR #2（`8b1cc14`）
- 工作区：**未提交 Release Audit 变更**；未 reset/stash/切换分支/提交/推送
- 受跟踪文件修改：19 个，`+216,197 / −49`
- 未跟踪文件：10 个，约 1,463 行
- 大文件：`evaluation/v61/experiment_a_fair_multi_region.json`（9.6 MiB）、`experiment_b_sequential_audit.json`（6.7 MiB）、`experiment_c_strict_prediction.json`（2.3 MiB）
- 密钥/个人信息扫描：未发现真实密钥；文档中仅占位符。扫描为模式匹配，不替代完整安全审计。

## 2. 科研实验独立复核

### 2.1 自动一致性校验

`npm run verify:evidence --prefix backend`：**82/82 检查通过**，从 raw JSON 复算：
- A：各策略收益/成本/覆盖/效率；配对差与 Cohen's d_z；
- B：成功率、检测准确率、决策准确率；
- C：per-series MAE 与 90/95% 覆盖率；
- D：baseline τ、damping=0 降低、连通性；
- E：最大匹配 TP；
- 报告文本关键数字存在性。

结果文件：`evaluation/v61/verification.json`。

### 2.2 多区域 VoI（公平预算）

- 同种子、同初始信念、同动作预算、同证据；n=600 配对样本。
- 多区域：风险降低 **0.189** [0.181, 0.198]，覆盖 5.39 区域，成本 0.57。
- 单区域：风险降低 **0.030** [0.028, 0.031]，覆盖 1 区域，成本 0.074。
- 配对差 **0.1594**，trial Bootstrap [0.1506, 0.1675]，**按 seed 聚类 Bootstrap [0.1462, 0.1730]**，d_z=1.49。
- 效率差 **−0.0098**，95% CI [−0.0375, 0.018] 含 0 → **效率不显著**。
- 复核结论：V6-A 的 0.083 vs 0.024 未做预算配对，已被 V6.1 取代；总收益支持，单位效率不支持。

### 2.3 序贯调查

- 成功定义：至少获得一次信息性证据；检测/决策准确率分别定义。
- 同为 2 次尝试预算、p=0.3、1000 次：重试与不重试均 **92.0% 成功、76.5% 检测、96.5% 决策**。
- V6-B 的 91% vs 68.6% 是 **2 次 vs 1 次尝试**，不能归因于重试。
- 重试只改变动作选择与耗时；预算耗尽率 8%，假停止 0。

### 2.4 预测

- 严格滚动：每个测试起点只用过去数据选择方法与区间；无未来信息。
- stable/decline/missing：自适应更好（5 分钟 MAE 6.20/6.86/7.21 vs 11.23/24.15/10.90）。
- surge/periodic：persistence 略优（140.22/74.44 vs 144.52/72.12）。
- 90/95% 区间覆盖率约 78%–99%，**未稳定达到名义覆盖率**，不得用于安全告警。

### 2.5 风险图

- 8 区域、11 条无向边、1 个连通分量；未知通道排除。
- Kendall τ 对 baseline：damping=0 为 0.616（最小 −0.143）；damping 0.2/0.4/0.8/0.95 为 0.918/0.950/0.924/0.878；steps 1/10 为 0.923/0.998；edge scale 0.5/1.5 为 0.930/0.892。
- 覆盖权重 0.25 与 0.5 的推荐一致率仅 69.6%；0.75 为 98.4%。
- 结论：参数敏感性显著，模型仍是**未标定启发式**。

### 2.6 感知评测

- 贪心匹配改为最大基数二分匹配（Kuhn），补“贪心会漏配”的反例测试。
- MAE/RMSE/NAE、P/R/F1 边界（空 GT、空预测）已定义。
- **未运行任何真实数据集/模型**；工具测试 ≠ 视觉模型精度。

## 3. 统计方法问题及修复

| 问题 | 处理 |
| --- | --- |
| 配对样本按 seed 聚集，普通 Bootstrap 低估相关性 | 增加按 seed 重采样的聚类 Bootstrap（0.1462–0.1730） |
| 多重比较 | 主比较族 Bonferroni α=0.0125；其余标注为探索性 |
| 效应量 | 报告 Cohen's d_z=1.49（配对） |
| 样本量/功效 | **未做正式功效分析**；n 按可复现性选择 |
| 实验单位 | 独立合成 trial；同 trial 策略结果配对处理 |
| 选择性报告 | 报告效率不显著、预测场景分化、区间未达标 |

## 4. 算法数学审计

### 4.1 VoI

- 先验/似然归一化在场景加载时校验；证据全零时保持原信念。
- 动作成本只计一次；多区域收益在**最终信念**上计算，避免逐动作累加造成重复计数。
- 覆盖权重（目标 1、邻居 0.5、全局 0.3）是启发式，不是概率。
- 停止条件：VoI 阈值、预算、最大轮次、无可用动作。

### 4.2 风险图

- 同步迭代传播，3 步；循环边会在每步重复贡献，未做收敛归一化。
- 边权 = 容量因子 × 距离因子，系数未标定；不能解释为真实迁移概率。
- 极端参数（damping=0.95）排序变化明显，需现场数据标定。

### 4.3 预测

- 每个滚动起点重新选择方法，训练/验证/测试按时间隔离；未发现泄漏。
- 区间用历史 h 步误差 95 分位 ×1.5；覆盖率未达名义值，属于方法局限。

### 4.4 感知

- 最大基数二分匹配保证 TP 最大；指标实现有边界测试。
- 没有数据集/权重，无法给出真实 MAE/RMSE。

## 5. 原始数据治理

- `evaluation` 共 **33 个证据文件**，**24.73 MiB**；gzip 估算 **1.10 MiB**（约 95.5% 压缩）。
- 分层：raw（实验 JSON）/ summary（verification、performance）/ report（REPORT.md、DATA_MANIFEST.md）。
- `evaluation/MANIFEST.json`：路径、大小、gzip、SHA-256、层级、生成脚本；`manifest:evidence` 生成，`--verify` 校验（33/33 通过）。
- `evaluation/DATA_MANIFEST.md`：人类可读清单。
- `.gitignore` 排除 `data/audit`、`data/admin_config.json`、`data/ops-state.json`、临时日志；**不忽略 raw JSON**。
- `evaluation/release/` 为测试日志，不纳入证据清单（避免自引用）。
- 未删除任何原始数据。

## 6. 研究来源核验

- 38 条来源：12 条本轮检索命中（verified-search）、20 条仅规范 URL 未逐页打开、6 条经典文献未核验全文。
- `research/SOURCE_AUDIT.md` 逐条列出状态；作者字段与许可证原文**未全部人工确认**。
- 只有 verified-search 来源可用于“平台/接口事实”陈述；其余引用标注“未逐页核验”。
- AgentArts 官方 API 文档仍缺失（S34），未虚构接口。

## 7. P0/P1/P2 缺陷清单

### P0（发布阻断）
- 无未修复 P0。

### P1（已修复）
1. V6 多区域比较未做预算配对 → V6.1 同预算配对 + 报告更正。
2. 序贯重试成功率归因错误 → 同尝试预算审计，结论改为“不支持”。
3. 感知贪心匹配漏配 → 最大基数二分匹配 + 反例测试。
4. 统计 Bootstrap 未处理 seed 聚类 → 增加聚类 Bootstrap。
5. 证据清单自引用导致校验失败 → 排除 release 日志，33/33 通过。
6. V6 报告数字与 V6.1 混淆 → 增加“以 V6.1 为准”更正横幅 + 文档更新。

### P2（已知限制，未修复）
1. 预测区间覆盖率未达 90/95%，不得用于安全保证。
2. 风险传播/覆盖权重/人员评分仍是未标定启发式。
3. 来源作者/许可证未逐条核验。
4. Docker CLI 存在但 daemon 未启动，镜像构建未验证；CI 未在真实仓库运行。
5. 无浏览器 E2E、无多实例/数据库事务。
6. 前端/后端类型为手工维护，无 OpenAPI/代码生成。
7. 原始 JSON 约 24.7 MiB，gzip 可压到 1.1 MiB；发布归档建议提供压缩包。

## 8. 全量测试与构建结果（真实退出码）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run test --prefix backend` | 0 | 104/104 |
| `npm test --prefix frontend` | 0 | 8/8 |
| `tsc --noEmit --project backend` | 0 | 通过 |
| `tsc --noEmit --project frontend` | 0 | 通过 |
| `npm run build` | 0 | 通过 |
| `npm run demo` | 0 | 三场景通过 |
| `npm run demo:mvp` | 0 | 三场景通过 |
| `npm run benchmark:competition --prefix backend` | 0 | 报告生成 |
| `npm run benchmark:v6 --prefix backend` | 0 | 报告生成 |
| `npm run benchmark:v61 --prefix backend` | 0 | 报告生成 |
| `npm run verify:evidence --prefix backend` | 0 | 82/82 |
| `npm run manifest:evidence --prefix backend` | 0 | 33 files |
| `evidence-manifest --verify` | 0 | 33/33 |

原始日志：`evaluation/release/*.log`；汇总：`evaluation/release/test_results.json`。

Docker：`docker --version` 可用（29.7.2），但 `docker build` 因 **Docker daemon 未启动**失败（exit 1），属于环境阻塞，未标记为已验证。

## 9. 论文与答辩材料完成度

| 材料 | 状态 |
| --- | --- |
| `docs/RESEARCH_CONTRIBUTIONS.md` | 已更新 V6.1 修正 |
| `docs/COMPETITION_TECHNICAL_REPORT.md` | 已更新证据等级与更正数字 |
| `docs/PAPER_DRAFT.md` | 已加入证据等级与重试更正 |
| `docs/DEFENSE_QA.md` | 37 问（含 7 个尖锐问题） |
| `docs/INNOVATION_EVIDENCE_MAP.md` | 已更新多区域/重试状态 |
| `docs/DATA_GOVERNANCE.md` | 新增 |
| `docs/RELEASE_CHECKLIST.md` | 新增 |
| `evaluation/V6_1_REPORT.md` | 已生成/更正 |
| `research/SOURCE_AUDIT.md` | 新增 |

## 10. 未解决的外部阻塞

1. AgentArts 真实租户、凭证、官方 API 文档；
2. 昇腾 NPU/CANN/`.om` 与实机性能；
3. 真实场地测绘、人流/视频、无人机；
4. 公开数据集、模型权重与真实计数精度；
5. Docker daemon/CI 运行环境；
6. 正式安全评审、消防/公共安全认证与演练。

## 11. 发布判定

**结论：达到“科研原型候选版本（Research Prototype Candidate）”发布条件，未达到生产就绪。**

可发布：
- 可复现实验、原始数据、SHA-256 清单、82 项一致性校验；
- 104 后端 + 8 前端测试、构建与三场景演示全部通过；
- 明确标注哪些结论 VERIFIED / PARTIALLY_SUPPORTED / HEURISTIC / UNVERIFIED。

不可宣称：
- AgentArts/昇腾已实机接入；
- 真实场景安全效果或计数/预测精度；
- 国家一等奖或任何评分结果；
- 生产可用、通过安全认证。

发布前建议：
1. 用真实租户完成 AgentArts 健康探测与一次工作流调用；
2. 用 CANN 设备完成 `.om` 转换与延迟/精度实测；
3. 在真实/公开数据上重跑预测与计数评测；
4. 启动 Docker daemon 与 CI，完成镜像/流水线实跑；
5. 逐条核验 38 条来源的作者、年份、URL 与许可证。
