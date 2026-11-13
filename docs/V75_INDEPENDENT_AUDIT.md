# V7.5 独立审计（仓库内复核，非第三方）

> 审计对象：`v7.5.0-research.1` 工作树与 `evaluation/v75/v75-final-20261110/`。
> 审计方式：不引用报告结论，直接从原始 rows/summary、清单哈希、测试与代码重新核对。
> 审计人：仓库内独立复核流程；**不是第三方审计，也不构成安全认证**。

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| 证据完整性 | 根清单 33 文件逐字节 SHA-256 复核 0 不一致 |
| 证据一致性 | `verify:evidence` 178/178 通过（含 V7.2/V7.3/V7.4/V7.5 清单与哈希） |
| V7.2 基线 | `freeze:verify:baseline` 299 文件通过，未改写 |
| 后端测试 | 317/317 通过 |
| 前端测试/构建 | 17/17、构建通过 |
| TypeScript | `tsc --noEmit` 通过 |
| Demo | 安全三场景、MVP 三场景通过 |
| 浏览器 E2E | 登录 → 指挥中心 → 前端代理 API 通过，0 console/page error |
| Docker | **BLOCKED**（daemon 不可用） |
| AgentArts | **未接入**（`not_configured`，仅本地 stub） |
| 昇腾 NPU/OM | **未实机**（无 npu-smi/atc/CANN；ONNX 仅 CPU） |
| 最终分类 | 研究原型：**PARTIALLY VERIFIED**（合成证据完整，真实世界未验证） |

## 2. 证据复核

1. 根 `MANIFEST.json` 列出 33 个文件，覆盖五个 track、平台状态、E2E 与汇总；
2. 逐文件重算 SHA-256 与字节数：0 不一致；
3. 各 track 独立清单（detection/stability/multiobjective/fusion/agentarts/ascend）均存在；
4. `LATEST.txt` 指向最终运行，`run_metadata.json` 记录 Node/平台/CPU 与所选 track；
5. 报告中的关键数字与原始 summary 逐一对照：
   - 标准 MPC 切换 3820.7542、全局承诺 1561.1375、自适应 1369.0083；
   - 检测 reliability_dual 120 TP / 0 FP / 90 TN；
   - 融合冲突 fail-closed 1.0、unsafe fuse 0、可用率 0.7497；
   - 多目标 238/240 权衡、平均前沿 8.454；
   - E2E `passed=true`。
6. 未发现报告数字与原始数据不一致；负结果均保留在 summary/rows。

## 3. 代码审计

### 3.1 安全边界

- 四态判定、独立 Validator、人工审批、未知/不可用 fail-closed **未被修改**；
- 新增模块只输出候选/审计，不发布方案；
- 状态机 `planValidated=false` 时拒绝恢复；过期/冲突观测 `publishable=false`；
- Agent 仍只能创建待审批工单（既有 `ops.test`、`agentarts-runtime` 测试通过）。

### 3.2 本轮发现并修复

| ID | 问题 | 修复 | 回归 |
| --- | --- | --- | --- |
| P1-1 | MPC 集成状态机时把 `observationsValid` 硬编码为 `true`，过期/冲突观测无法阻止发布 | 新增 `observationsValid/sensorConflict/observationStale` 输入，逐步记录 `emergency_publishable` 与 `unpublishable_steps` | `v75-redteam`：无效/冲突观测全部不可发布；默认有效不误判 |
| P1-2 | 融合以第一条读数的 `regionId` 为准，恶意/错误首条可迫使其余读数被拒 | `FusionConfig.regionId` 可显式指定期望区域 | `v75-fusion`：显式 R2 时 R1 读数全部 `region_mismatch` |

### 3.3 未修复/需披露

| ID | 问题 | 级别 | 说明 |
| --- | --- | --- | --- |
| P1-3 | `SensorObservation.delayed` 字段未被检测器使用 | P1 | 延迟读数按当前读数处理；基准通过重放旧值模拟延迟。不得声称已做延迟补偿 |
| P1-4 | 融合输出未自动接入 MPC/状态机 | P1 | 调用方必须显式传入观测有效性；本轮只提供接口与测试，未做端到端接线 |
| P2-1 | 生产检查脚本硬编码 `localhost:8010` | P2 | 生产部署需参数化 |
| P2-2 | `verify:evidence` 只检查 `LATEST.txt` 指向的运行 | P2 | 历史运行依赖各自清单，未逐一复核 |
| P2-3 | 承诺/多目标求解耗时是单机测量 | P2 | 不作为性能主张 |
| P2-4 | 区域选择性/容量感知承诺未做参数敏感性网格 | P2 | 负结果只对本参数成立 |

## 4. 统计审计

- 30 个固定种子（20261111–20261140），配对样本 n=240（8 场景）；
- 承诺实验使用 10,000 次 Bootstrap 95% CI、Cohen's d_z 与 Holm 校正；
- 检测/融合为确定性序列，重复运行结果一致（metadata 时间戳除外）；
- 未发现按测试集反复调参的痕迹：权重与阈值在实验前声明，负结果保留；
- 多目标膝点明确标注为离线分析上界，未包装为在线性能。

## 5. 红队覆盖

| 攻击面 | 覆盖 |
| --- | --- |
| 紧急状态转换/重复请求 | `v75-emergency`、`v75-redteam`：重复触发无重复事件；迟滞防抖 |
| 运行中容量/出口变化 | `v75-commitment-redteam`、`v75-redteam`：出口失效后计划不再使用；headroom 夹紧 |
| 冲突/过期/偏移观测 | `v75-fusion`、`v75-emergency`：fail-closed、不可发布 |
| 求解截断 | `v75-redteam`：`maxSteps=1` 时未疏散如实上报 |
| 无效承诺 | `v75-redteam`：承诺出口失效记录紧急覆盖 |
| 并发/重复规划 | `v75-redteam`：同输入结果确定、不修改输入 |
| 过期审批/幂等/持久化 | 既有 `reservations`、`state-persistence`、`ops` 测试通过 |
| 越权 Agent | 既有 `ops`/`agentarts-runtime` 测试通过 |

## 6. 主张审计

- C73/C74 的零误报与消融有原始 summary 支撑，且明确标注合成与延迟代价；
- C75/C76/C81 为负结果，报告与 CLAIMS 一致，未发现美化；
- C77 的 0 响应明确标注为控制步内测量；
- C79 的膝点标注为离线上界；
- C80 的可用率损失与 fail-closed 同时报告；
- C82 的 Docker/AgentArts/NPU 状态为 BLOCKED/未接入/未实机，无夸大。

## 7. 最终分类

| 类别 | 状态 | 依据 |
| --- | --- | --- |
| 代码与测试 | VERIFIED | 317/317、typecheck、build |
| 合成实验证据 | VERIFIED | 33 文件哈希 0 不一致、178/178 检查 |
| 基线保护 | VERIFIED | V7.2 299 文件、V7.3/V7.4 清单哈希通过 |
| 浏览器 E2E | VERIFIED（冒烟） | 登录/指挥中心/代理 API |
| 真实场馆/传感器 | NOT VERIFIED | 合成数据 |
| AgentArts 实机 | BLOCKED | 无租户/凭证 |
| 昇腾 NPU/OM | BLOCKED | 无设备/CANN/atc |
| Docker/容器 | BLOCKED | daemon 不可用 |
| 整体 | **PARTIALLY VERIFIED** | 研究原型，不是 Production Ready |

## 8. 审计限制

- 本审计由同一仓库会话执行，不是独立第三方；
- 未做真实并发、长时间运行、故障注入到进程级；
- 未验证真实数据许可、真实场馆标定或安全标准符合性；
- 所有结论仅适用于本仓库当前提交与运行环境。
