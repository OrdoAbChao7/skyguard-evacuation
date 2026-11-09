# SkyGuard V6.2 Final Release Audit

> 日期：2026-11-05  
> 范围：Competition Freeze & Final Delivery  
> 数据：全部为合成/模拟数据；平台/硬件/真实场地未验证。

## 1. V6.2 工作总结

- 冻结 V6.1 原始证据（`evaluation/v61/FREEZE.sha256` + `evaluation/v62/freeze_v61.json`），V6.1 复跑输出到临时目录并逐文件统计比对，5/5 实验完全一致。
- 新增 30 独立种子的 V6.2 统计实验（`evaluation/v62/`）：多区域 VoI、序贯调查、预测、拓扑/参数敏感性。
- 修复统计问题：增加按 seed 聚类的 Bootstrap；明确 trial 级与 seed 级结果；seed 级 d_z 因组间方差小被放大，不做效应量解释。
- 发现并报告设计敏感性：V6.1 同目标策略效率不显著；V6.2 轮换目标后效率差 +0.0917（CI 不含 0）。两者并列报告，未选择性删除。
- 来源 URL 审计：38 条中 28 条可达；S15/S18 华为 ModelArts Studio 页 404，8 条 403/网络失败，均标记未核验。
- 证据清单：46 个文件、31.85 MiB；gzip 1.66 MiB；`manifest:evidence --verify` 46/46。
- 一致性校验：`verify:evidence` 134/134（含 V6.1 冻结哈希、V6.2 统计复算、来源计数）。
- 文档：FINAL_DELIVERY、RELEASE_CHECKLIST、DATA_GOVERNANCE、SOURCE_AUDIT、V6.2 报告与论文/答辩更新。

## 2. 统计实验最终结果

### 多区域 VoI（30 seeds × 40 trials，目标轮换）

| 指标 | 多区域 | 单区域 |
| --- | --- | --- |
| 风险降低 | 0.2154 [0.2106, 0.2201] | 0.0472 [0.0456, 0.0487] |
| 成本 | 0.584 | 0.253 |
| 效率 | 0.3785 | 0.2868 |
| 覆盖区域 | 6.74 | 1.59 |
| 最坏区域终风险 | 0.0932 | 0.1094 |

- 配对差 trial 级：0.1682 [0.1636, 0.1728]，d_z=2.06；聚类 Bootstrap [0.1626, 0.1737]。
- seed 级均值：0.1682 [0.1644, 0.1720]（d_z 不作解释）。
- 效率差：+0.0917 [0.0755, 0.1079]。
- 功效分析：试点 d=1.49，α=0.0125，80%/90% 功效仅需 n≈6/7；实际 1200 对。
- **设计敏感性**：V6.1 同目标设计效率差不显著；V6.2 轮换目标后为正。总收益结论稳健，效率结论依赖目标策略。

### 序贯调查（30 seeds × 60 trials，p=0.3，2 次尝试）

- 成功率 0.9089；检测准确率 0.7767；决策准确率 0.9600；预算耗尽 0.0911。
- 平均尝试 2.0；平均失败 0.609。
- 与 V6.1 一致：同等尝试预算下重试不提高成功率；成功率 ≠ 检测/决策正确。

### 预测（30 seeds × 30 series）

- stable/decline/missing：自适应优于 persistence（例：stable h5 6.30 vs 10.86）。
- surge/periodic：persistence 略优；区间覆盖率未稳定达到 90/95%。
- 每起点只用过去数据选择方法与区间，无测试集泄漏。

### 风险图

- 拓扑：baseline 8 区域/11 边/1 分量；关闭 C_MID 后 10 边；移除东广场后 7 区域/9 边/1 分量。
- damping=0 τ=0.602；damping=0.2/0.6/0.95 τ=0.908/1.000/0.854。
- 结论：拓扑/参数改变排序；模型仍是未标定启发式。

## 3. 来源核验结果

- 38 条：28 可达，10 不可达/受限。
- S15/S18（华为 ModelArts Studio）404；S08/S10/S20/S27 请求失败；S22/S26/S29/S37 返回 403。
- 作者、年份、许可证、是否支持主张仍未全部人工核验；URL 可达 ≠ 证据成立。
- AgentArts 官方 API 文档仍缺失，未虚构接口。

## 4. 全量测试与部署记录

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| backend tests | 0 | 104/104 |
| frontend tests | 0 | 8/8 |
| backend tsc | 0 | 通过 |
| frontend tsc | 0 | 通过 |
| npm run build | 0 | 通过 |
| npm run demo | 0 | 通过 |
| npm run demo:mvp | 0 | 通过 |
| benchmark:competition | 0 | 通过 |
| benchmark:v6 | 0 | 通过 |
| benchmark:v62 | 0 | 通过 |
| benchmark:v61（冻结复跑） | 0 | 5/5 实验统计一致 |
| verify:evidence | 0 | 134/134 |
| manifest:evidence | 0 | 46 files |
| manifest --verify | 0 | 46/46 |

- Docker CLI 29.7.2 存在；`docker build` 因 **daemon 未启动**失败（exit 1），未伪造成功。
- GitHub Actions 配置已补充 V6/V6.1/V6.2/verify/manifest 步骤；未在真实 CI 运行（无推送权限动作）。
- 日志：`evaluation/release/v62_*.log`；汇总：`evaluation/release/test_results_v62.tsv`。

## 5. 竞赛材料清单

- `docs/FINAL_DELIVERY.md`：正式交付说明
- `docs/RELEASE_CHECKLIST.md`：发布清单
- `docs/DATA_GOVERNANCE.md`：数据治理
- `evaluation/V6_2_REPORT.md`：30 种子统计报告
- `evaluation/V6_1_REPORT.md`：历史审计（含 V6.2 冻结说明）
- `evaluation/COMPETITION_REPORT.md`：竞赛基准
- `evaluation/DATA_MANIFEST.md` / `MANIFEST.json`：证据清单
- `docs/PAPER_DRAFT.md`、`COMPETITION_TECHNICAL_REPORT.md`、`RESEARCH_CONTRIBUTIONS.md`、`DEFENSE_QA.md`（37 问）、`INNOVATION_EVIDENCE_MAP.md`、`DEMO_SCRIPT.md`
- `research/SOURCE_AUDIT.md`、`INDEX.md`、`CLAIMS.md`、`RESEARCH_GAPS.md`

## 6. Git 变更与仓库体积

- 分支：`feat/skyguard-mvp-e2e`；HEAD：`3b62fe9`
- 工作区：未提交 V6.2 变更；未 commit/push/PR/tag
- 受跟踪修改：28 个，`+216,484 / −112`
- 未跟踪：31 个，约 338,433 行
- 证据体积：46 文件、31.85 MiB；gzip 1.66 MiB；原始 JSON 保留，未删除
- 大文件：v61 A 9.6 MiB、v61 B 6.7 MiB、v62 A/B/C 等；发布归档建议 gzip

## 7. 尚未解决的外部阻塞

1. AgentArts 真实租户、凭证、官方 API 与 Trace；
2. 昇腾 NPU/CANN/`.om` 与性能实测；
3. 真实场地测绘、人流/视频、无人机；
4. 公开数据集、模型权重与真实计数/预测精度；
5. Docker daemon 与 GitHub Actions 运行；
6. 正式安全评审、消防/公共安全认证与演练。

## 8. 正式竞赛候选版本发布判定

> **历史快照**：本节仅适用于 V6.2（2026-11-05）。V6.5 独立审计另行记录了 13 项 P1
> （见 [`V6.5_INDEPENDENT_AUDIT.md`](V6.5_INDEPENDENT_AUDIT.md)），不得把本节“P1：无”套用于当前版本。

**达到 Research Prototype Candidate 发布条件；未达到生产就绪。**

- 可交付：可复现实验、冻结原始数据、SHA-256 清单、134 项一致性校验、104+8 测试、构建/演示通过、30 种子统计、来源 URL 审计。
- 不可宣称：AgentArts/昇腾实机、真实场地效果、真实精度、国家一等奖/评分、生产可用/安全认证。
- P0：无。
- P1：无未修复；V6/V6.1 统计与归因问题已更正。
- P2：预测区间覆盖、启发式参数、来源作者/许可证、Docker/CI、E2E、单实例等已知限制。

## 9. 下一阶段必须由用户提供的资源

1. 华为云 AgentArts 租户/API 凭证与官方接入文档；
2. 昇腾设备与 CANN 环境；
3. 真实场馆测绘、人员配置、视频/人流数据与无人机；
4. Docker Desktop/daemon 与可运行 CI 的仓库权限；
5. 安全/消防专业评审与演练资源。

> 本轮未自动 commit/push/PR/tag，未删除任何原始数据。
