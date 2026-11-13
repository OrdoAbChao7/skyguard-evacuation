# SkyGuard V7.3 实施报告

> 日期：2026-11-10。版本：`v7.3.0-research.1`。
> 最终证据：`evaluation/v73/v73-final-20261110T101711/`。
> 全部为合成/夹具数据；没有真实场馆、AgentArts 实机或昇腾 NPU 证据。

## 1. 执行摘要

V7.3 在 V7.2 冻结基线（`v7.2.0-research.1`）上完成：

1. **Phase 0**：独立复核 299 个冻结文件、篡改/恢复/CRLF/UTF-8/只读检查，创建不可变基线快照；
2. **Phase 1**：自适应切换惩罚、振荡检测、风险加权、多目标、动态容量；30 种子 × 8 场景 × 6 策略；
3. **Phase 2**：JSON/CSV/视频/公开数据/授权真实数据导入与标定流水线，方向性容量与场馆约束；
4. **Phase 3**：Shadow 历史回放、传感器/激增/封控/出口故障/冲突观测/过期快照/并发事件；
5. **Phase 4**：AgentArts 幂等键、重试复用、故障恢复；本地官方契约 stub；
6. **Phase 5**：ONNX checker、CPU 基准、OM 元数据校验、ATC 模板、设备探测；
7. **Phase 6**：红队加固（CSV 崩溃、人数无上限、冲突观测 fail-closed）；
8. **Phase 7/8**：证据链与竞赛文档；
9. **Phase 9**：最终验收与发布就绪报告。

**核心结果（合成）**

- 标准 MPC 切换 3820.8、振荡 571.9、未疏散 16.5；
- 自适应 V7.3：切换 1369.0（−64%）、振荡 93.4（−84%）、未疏散 0、容量冲突 0；
- 代价：完成时间 +0.96 分钟、队列 +3968 人·分钟、最大密度 +0.296；
- 所有差异 Holm 显著；**稳定性不是免费的**，密度上升需现场阈值/人工审查。

## 2. Phase 0：V7.2 冻结基线审计

- 工具：`scripts/v73-freeze-audit.ts`；
- 结果：299/299 文件一致；官方校验退出码 0；篡改副本校验失败、恢复后通过；原始冻结字节 0 变化；
- 快照：`evaluation/v72/baseline_snapshot/`（299 文件，约 13MB）；
- 校验：`npm run freeze:verify:baseline --prefix backend`；
- 详细：[V72_FREEZE_INDEPENDENT_AUDIT.md](V72_FREEZE_INDEPENDENT_AUDIT.md)、`evaluation/v72/freeze_audit.json`。

## 3. Phase 1：自适应稳定性与动态容量

新增 `planning/v73-stability.ts`：

- 自适应惩罚：`base × (1 + queuePressure) × (1 − riskDiscount × risk)`；
- 风险加权切换人数：`Σ persons × (1 + riskRatio)`；
- A→B→A 振荡检测与额外惩罚；
- 多目标标量化（到达、完成时间、等待代理、路径暴露、切换）；
- 动态容量因子（走廊/出口按绝对分钟）。

MPC 集成：`adaptiveStability`、`corridorCapacityFactor`、`exitCapacityFactor`；
记录 `capacity_violations`、`oscillation_events/persons`、`adaptive_penalty_avg`。
执行模型也支持动态容量，保证规划/执行/复核口径一致。

同时修复求解器：双向共享容量迭代必须复用当前 override，且动态容量下的物理容量按分钟计算。

30 种子 × 8 场景 × 6 策略；详见 [V7.3 实验报告](V7_3_EXPERIMENT_REPORT.md)。

## 4. Phase 2：真实场馆导入/标定

新增 `calibration/importers.ts`：

| 能力 | 实现 |
| --- | --- |
| JSON 场景导入 | `SafetyScenarioSchema` + 拓扑校验（重复 ID、端点、容量、通行时间） |
| CSV 观测导入 | RFC4180 风格解析（BOM/引号/CRLF）、行号错误、replay/live 区分 |
| 视频计数接口 | 输入为视觉模型已计数帧；相机→区域映射；过期/未来/低置信度拒绝 |
| 公开数据集 | 许可必须已核验；记录 dataset/license/citation；不标记 calibrated |
| 授权真实数据 | 必须提供 reference/legal_basis/operator/verified_at；输出 `field_report` |
| 方向性容量 | `directional_capacity.forward/reverse`；双向之和不得超过物理容量 |
| 场馆约束 | min_confidence/观测有效期/最大密度/禁用通道；弱化场景安全配置直接拒绝 |
| 数据分级 | SYNTHETIC / PUBLIC_DATASET / CROSS_DATASET / REAL_WORLD_CALIBRATED |

当前只有合成档案与 CSV 测试夹具；没有真实数据。

## 5. Phase 3：Shadow 运营验证

- 快照 `age_ms/stale` 与 `maxSnapshotAgeMs`；过期快照回退 `snapshot_stale`；
- `route_switch_comparison`：legacy vs V7 出口改派区域/人数；
- `ObservationStore.conflicts`：仅不同 provider 且差异 >50% 才判定冲突；
- 决策服务对冲突观测 fail-closed（跳过规划，标记不可信）；
- 80 次运营回放（10 种子 × 8 用例）：确定性 0 不一致；过期快照 10/10 回退；冲突 10/10 标记；
- Shadow 仍默认关闭、只记录、不发布。

## 6. Phase 4：AgentArts

- 新增幂等键：显式传入或按 agent/session/trace/region 稳定生成；重试复用同一键；
- 请求头可配置 `AGENTARTS_IDEMPOTENCY_HEADER`；
- 测试覆盖：重试复用、不同 trace 不同键、显式键、重试耗尽后恢复；
- 真实平台：`not_configured`（缺 base URL/API key/runtime name）；本地 stub 验证会话头/SSE/决策；
- 多步执行、工具权限、人工审批、反馈续接由既有 AgentArts 运行时测试覆盖。

## 7. Phase 5：Ascend/ONNX/OM

- `benchmark_onnx.py` 增加 ONNX checker；
- `validate_om_metadata.py` 与 `deployment/om-metadata.ts`：声称 NPU 必须有 npu-smi/设备/驱动/CANN 与数值一致性；
- `v73-ascend-pipeline.ts`：导出、checker、CPU 基准、设备探测、OM 模板；
- 环境：无 `npu-smi`/`atc`/CANN；ONNX CPU p50≈0.015ms，`max_abs_diff=0`；
- **没有 OM 文件或 NPU 实机证据**。

## 8. Phase 6：红队修复

- CSV 非法 `received_at` 会抛异常 → 改为明确错误；
- 导入人数无上限 → CSV/视频/授权适配器拒绝 >10,000,000；
- 公开/授权适配器非法时间戳 → 返回错误而非崩溃；
- 冲突观测未 fail-closed → 决策服务跳过规划；
- 双向动态容量 override 复用错误 → 修复并回归；
- 新增 16 个 V7.3 测试（稳定性 6、导入 8、Shadow 4、AgentArts 3、Ascend 5、红队 5，含重复计数）。

## 9. 验证

- 后端 **273/273**、前端 **17/17**；
- `npm run build`、`npm run demo`、`npm run demo:mvp`；
- `npm run benchmark:v73`：5 组证据、根清单 27 文件；
- `npm run verify:evidence` **156/156**；
- V7.2 基线快照校验通过；历史证据未改写。

## 10. 外部阻塞

真实场馆几何/容量/时序、摄像机标定、授权真实数据、AgentArts 租户/Trace、
昇腾 NPU/CANN/atc、Docker/CI 实跑、第三方安全评审/演练。
