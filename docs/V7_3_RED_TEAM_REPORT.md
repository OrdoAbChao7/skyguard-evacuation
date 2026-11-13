# SkyGuard V7.3 红队报告

> 日期：2026-11-10。范围：V7.3 自适应稳定性、导入/标定、Shadow 运营、AgentArts、Ascend。
> 所有问题均可复现；未修复项明确登记。不是第三方安全认证。

## 1. 攻击面矩阵

| 攻击面 | 用例 | 结果 | 证据 |
| --- | --- | --- | --- |
| 非法观测 CSV | 非法 received_at / 缺列 / 非法 source | 明确错误，不崩溃 | `v73-redteam`、`v73-calibration-import` |
| 天文数字人数 | count=1e9/1e12 | `count_out_of_range` 拒绝 | `v73-redteam` |
| 冲突观测 | 不同 provider 相差 >50% | 检测并 fail-closed（跳过规划） | `v73-shadow-ops` |
| 过期/未来时间戳 | 10 分钟前 / 未来 5 分钟 | 拒绝 | `v72` + `v73` 测试 |
| 相机离线 | camera.status=offline | 拒绝 | `v72-redteam` |
| 双向容量冲突 | 两方向同时使用 | 迭代共享 + 逐分钟复核 | `v73-redteam` |
| 动态容量 | 走廊/出口容量下降 | 规划/执行/复核同口径 | `v73-stability`、`v73-redteam` |
| 路线振荡 | A→B→A | 检测、惩罚、护栏 | `v73-stability` |
| 快照篡改 | legacy 计划人数≠快照 | `legacy_snapshot_mismatch` | `v73-redteam` |
| 过期快照 | captured_at 60s 前 | `snapshot_stale` 回退 | `v73-shadow-ops` |
| AgentArts 重试重复 | 500 后重试 | 同一幂等键，不重复工具执行 | `v73-agentarts` |
| 重试耗尽 | 503 多次 | 显式失败；后续可恢复 | `v73-agentarts` |
| 公开数据许可未核验 | license_verified=false | 拒绝导入 | `v73-calibration-import` |
| 授权缺失 | 无 reference/legal_basis | 拒绝真实数据 | `v73-calibration-import` |
| 伪造 NPU 证据 | 声称 npu 但 npu-smi=false | `invalid`，不得 npu_verified | `v73-ascend` |
| 并发工单/预算 | 既有 V6.5 用例 | 全量回归通过 | `reservations/budget/agent-budget` |
| MCP 越权/注入 | 既有用例 | 全量回归通过 | `mcp/mcp-http/security` |
| 持久化中断 | 既有用例 | 全量回归通过 | `persistence/state-persistence` |

## 2. 本轮发现与修复

### P1-1 CSV 非法 `received_at` 导致异常（已修复）

**复现**：`parseObservationCsv` 对非日期 `received_at` 调用 `.toISOString()`，抛 `RangeError`。
**修复**：先校验时间；非法则返回 `csv_invalid_timestamp`。
**回归**：`v73-redteam` 第一条。

### P1-2 导入人数无上限（已修复）

**复现**：CSV/视频计数 1e9/1e12 被接受，可能污染需求与规划。
**修复**：CSV、视频、授权适配器统一拒绝 >10,000,000；公开适配器走同一转换。
**回归**：`v73-redteam` 第二条。

### P1-3 公开/授权适配器非法时间戳崩溃（已修复）

**复现**：非法 timestamp 直接 `.toISOString()`。
**修复**：逐行校验并返回 `public_row_invalid` / `authorized_row_invalid`。
**回归**：`v73-redteam` 第三条。

### P1-4 冲突观测未 fail-closed（已修复）

**复现**：同一区域不同 provider 给出 320 vs 80，系统仍用最新观测规划。
**修复**：`ObservationStore.conflicts` 仅对不同 provider 且差异 >50% 判定冲突；
决策服务将区域标记为不可信并跳过规划。
**回归**：`v73-shadow-ops` 冲突测试。

### P0-1 动态容量下物理容量计算错误（已修复）

**复现**：双向共享迭代用名义容量而非动态容量，计划可超限。
**修复**：按分钟计算 `nominal × factor`，并复用当前 override。
**回归**：`v73-redteam` 双向动态容量 4 轮。

### P1-5 双向共享 override 被下一轮重置（已修复）

**复现**：迭代读取原始 input 而不是当前 overrides，容量限制被撤销。
**修复**：优先读取 overrides；只在必要时写回。
**回归**：V7.3 稳定性/红队容量检查。

## 3. Shadow 安全结论

- 同快照、双校验、异常/超时/校验失败/预算为零/过期快照均回退；
- 冲突观测 fail-closed；
- V7 从不发布；Shadow 默认关闭；
- 确定性 80/80 一致。

## 4. 残余风险

| 风险 | 级别 | 说明 |
| --- | --- | --- |
| 冲突阈值 50%/300s | P1 | 启发式，可能漏报/误报；需真实数据标定 |
| 动态容量因子 | P1 | 人为设定；未用真实容量数据 |
| 稳定性密度上升 | P1 | +0.296；需现场阈值与人工审查 |
| 贪心承诺/共享迭代 | P2 | 非全局最优；有容量复核兜底 |
| AgentArts 真实平台 | P0（外部） | 无租户/Trace；本地 stub 不等于实机 |
| Ascend NPU | P0（外部） | 无 NPU/CANN/OM；CPU 基准不等于 NPU |
| 真实场馆数据 | P0（外部） | 无测绘/摄像机/授权数据 |

## 5. 结论

V7.3 修复了 1 个 P0（动态容量物理容量）和 5 个 P1（CSV 崩溃、人数上限、时间戳、冲突 fail-closed、override 重置），
新增 16 个回归用例。系统在合成/夹具范围内保持 fail-closed；
真实平台、硬件与场馆仍是外部阻塞，不得用本报告替代第三方评审。
