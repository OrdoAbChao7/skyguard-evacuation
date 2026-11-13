# V6.2 一致性与完整性审计

> 只读审计；未修改任何 V6.1/V6.2 原始报告或实验数据。  
> 审计对象：V6.2 文档、统计数字、Git 状态、证据清单与冻结边界。  
> 结论标签：**VERIFIED / INCONSISTENT / UNVERIFIED**。  
> 注：本审计在 V6.2 冻结时点执行；V6.3 新增 `evaluation/real-data/` 与文档，不改变本审计的 V6.2 结论。

## 1. Git 状态审计

| 项 | 实测 | 结论 |
| --- | --- | --- |
| 分支 | `feat/skyguard-mvp-e2e` | VERIFIED |
| HEAD | `3b62fe94bd03406532398dfbdcc6812bf669544d` | VERIFIED |
| `git status` 条目 | 46 | VERIFIED |
| staged | 0 | VERIFIED |
| unstaged 受跟踪修改 | 28 | VERIFIED |
| untracked 条目 | 18（目录折叠） | VERIFIED |
| untracked 实际文件 | 31（`git ls-files --others`） | VERIFIED |

**解释“46 vs 28+31”**：`git status --porcelain` 以目录折叠显示未跟踪目录（18 个条目），
而 `git ls-files --others` 展开为 31 个实际文件。28 + 18 = 46 条目；
28 + 31 = 59 是“受跟踪文件 + 未跟踪文件”的另一个口径。两者不矛盾，**不能混用**。

- 未执行 commit / push / PR / Tag；未 reset/stash/clean。
- V6.2 未提交成果完整保留。
- 结论：**VERIFIED**（口径需在报告中注明）。

## 2. 多区域 VoI 数字审计

来自 `evaluation/v62/experiment_a_multi_region_30seeds.json`：

| 统计量 | 值 | 含义 | 结论 |
| --- | --- | --- | --- |
| 0.2154 | 多区域策略风险降低**均值**（30 seeds × 40 trials） | 多区域 final risk 相对初始的下降均值 | VERIFIED |
| 0.0472 | 单区域策略风险降低**均值** | 单区域 final risk 相对初始的下降均值 | VERIFIED |
| 0.1682 | 同一 seed/trial 下 **多区域 − 单区域** 的配对差均值 | 配对差（非两均值的近似） | VERIFIED |
| 0.2154 − 0.0472 | 0.1682（2.8e-17 浮点误差） | 与配对差一致 | VERIFIED |

- trial 级 95% CI [0.1636, 0.1728]；d_z=2.06；seed 聚类 Bootstrap [0.1626, 0.1737]；
  seed 级均值 0.1682 [0.1644, 0.1720]。
- V6.1 同目标策略：0.189 vs 0.030，d_z=1.49；效率差不显著。
- V6.2 目标轮换策略：0.2154 vs 0.0472；效率差 +0.0917 [0.0755, 0.1079]。
- **单区域均值 0 的说法是 INCONSISTENT**：仓库中没有 0 这个记录值；正确值是 0.0472。
- **设计敏感性是真实存在的**：V6.1 与 V6.2 的差异来自目标选择策略，不是随机波动；必须并列报告。
- 结论：多区域总收益 VERIFIED；效率结论 **PARTIALLY_SUPPORTED / 依策略**。

## 3. 序贯调查定义审计

来自 `evaluation/v62/experiment_b_sequential_30seeds.json`（n=1800）：

| 指标 | 值 | 定义 |
| --- | --- | --- |
| 任务成功率 | 0.9089 | 至少获得一次信息性证据（signal_normal/signal_congested） |
| 检测准确率 | 0.7767 | 后验最大假设 = 真实假设 |
| 决策准确率 | 0.9600 | 后验最优决策 = 真实假设下最优决策 |
| 预算耗尽率 | 0.0911 | 未成功且尝试次数 ≥ 2 |

**机械互补问题（INCONSISTENT 表述风险）**：
- 1800 个 trial 中 success=1636，budget_exhausted=164；both=0，neither=0；
  所有 trial attempts 都是 2，false_stop=0。
- 因此 `budget_exhausted = 1 − success` **在本次模拟中是恒等式**；
  它不是独立的预算使用指标，不能与成功率并列作为两个独立发现。
- 正确表述：成功率 90.89%；剩余 9.11% 是“两次尝试内未获得信息性证据”，
  而不是“预算被额外耗尽”的独立度量。
- 结论：成功率/检测/决策定义 VERIFIED；预算耗尽作为独立指标 **INCONSISTENT**。

## 4. 预测审计

- 代码审计：`selectForecastMethod` / `selectIntervalQuantile` 在滚动起点只使用该起点之前的数据；
  每个测试起点重新选择方法，未使用未来数据。
- 数字：stable/decline/missing 自适应更好；surge/periodic persistence 略优；覆盖率未稳定达名义值。
- **报告格式问题（INCONSISTENT）**：`evaluation/V6_2_REPORT.md` 第 3 节预测表缺少表头与分隔行，
  Markdown 渲染会失败；数字本身与 JSON 一致。
- 结论：无数据泄漏 **VERIFIED**；报告表格格式 **INCONSISTENT**；区间可信度 **PARTIALLY_SUPPORTED**。

## 5. 风险图与感知

- 风险图：damping/拓扑/覆盖权重敏感性已测；系数未标定。
  结论：**HEURISTIC**，不得解释为真实人群迁移概率。
- 感知：评测流水线与最大基数匹配已实现并有测试；无真实数据集/权重/精度。
  结论：管线 **VERIFIED**；真实精度 **UNVERIFIED**。

## 6. 文档与链接一致性

- `README.md`、`CLAUDE.md`、`AGENTS.md`、`docs/PROJECT_STATUS.md` 的本地 Markdown 链接：
  **0 个失效链接**（相对路径检查）。
- README 已修正默认场景为 `stadium-evacuation.json`、预测为 `adaptive-forecast-v3`；
  `venue-default.json` 仅作为旧版合成场馆保留。
- CLAUDE 必读顺序包含 `AGENTS.md`、`PROJECT_STATUS.md`、`LIMITATIONS`、`CLAIMS`。
- AGENTS 原有 1–6 节保留，新增 7.1–7.7。
- 结论：文档一致性 **VERIFIED**（V6.2 报告预测表格式除外）。

## 7. 证据冻结与完整性

| 项 | 结果 | 结论 |
| --- | --- | --- |
| V6.1 raw freeze | `evaluation/v61/FREEZE.sha256`（6 文件） | VERIFIED |
| V6.1 复跑 | 5/5 实验统计一致 | VERIFIED |
| V6.2 证据清单 | `MANIFEST.json` 46 文件，46/46 | VERIFIED |
| V6.2 基线 | 151 文件、34,403,582 bytes；`BASELINE_SHA256` 校验 exit 0 | VERIFIED |
| V6.2 报告数字 vs raw | `verify:evidence` 134/134 | VERIFIED |

- V6.2 基线为工作区内容哈希，不是 Git 提交；V6.2 仍未提交。
- 冻结范围不含 `docs/`、`research/` 与 `evaluation/real-data/`。
- 基线文件：`evaluation/v62/freeze_v62.json`、`evaluation/v62/BASELINE_SHA256`、
  `docs/V6_2_BASELINE.md`。

## 8. 问题清单

| 级别 | 问题 | 状态 | 处理 |
| --- | --- | --- | --- |
| P1 | 单区域均值被误写为 0 | INCONSISTENT | 以 0.0472 为准；本审计记录 |
| P1 | 预算耗尽率与成功率机械互补 | INCONSISTENT | 不作为独立指标；改写表述 |
| P2 | V6.2 预测表缺 Markdown 表头 | INCONSISTENT | 记录；不改原始报告，后续材料引用 JSON |
| P2 | V6.1/V6.2 效率结论依赖目标策略 | VERIFIED（敏感） | 必须并列报告 |
| P2 | 风险图参数未标定 | HEURISTIC | 不得声称真实迁移规律 |
| P2 | 感知无真实数据/权重 | UNVERIFIED | 不报精度 |
| P2 | 来源作者/许可证未全部核验 | UNVERIFIED | 引用前人工确认 |

## 9. 审计结论

- V6.2 原始数据与报告未被修改；基线已冻结并可校验。
- 多区域/序贯/预测的主要数字可由 raw JSON 复算；已发现并记录 2 个 P1 表述问题。
- V6.2 可作为 Research Prototype Candidate 基线；不可作为生产或真实场景证据。
