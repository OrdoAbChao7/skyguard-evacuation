# V7 Shadow Mode 运行说明

> 研究原型能力，**默认关闭**。Shadow Mode 只并行比较 V7 规划与 legacy 规划，
> 不发布 V7 方案、不审批、不改变四态；旧安全链路完全可恢复。

## 1. 开关

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `V7_SHADOW_MODE` | 关闭 | `1`/`true` 开启 Shadow 比较；未设置/`0` 关闭 |
| `V7_SHADOW_MAX_SOLVE_MS` | 500 | V7 求解预算（ms）；`0` 表示只记录快照、不运行 V7 |

关闭时 `recompute` 行为与 V6.5 完全一致，不产生 Shadow 记录。

## 2. 每次 recompute 发生什么

1. legacy 规划器生成方案（与原来相同）；
2. Shadow 捕获统一输入快照：
   - 场景/约束/观测版本；
   - 各区域需求（排序后）；
   - 可用通道/出口；
   - SHA-256；
3. 在**同一快照**上运行 V7 时间扩展求解器（不注入预测）；
4. 两套方案都经独立 `validateSafetyPlan` 复算；
5. 两套方案都用同一拥堵执行模型做投影（makespan、队列、未疏散）；
6. 记录比较结果与回退原因；V7 结果**不发布**；
7. 审计 trace 增加 `shadow_comparison` stage。

## 3. 回退语义

| 条件 | `fallback_reason` | 行为 |
| --- | --- | --- |
| 开关关闭 | `shadow_disabled` | 不运行 V7 |
| 预算为 0 | `solve_budget_zero` | 只记录快照 |
| 求解超过预算 | `v7_timeout_<ms>_gt_<budget>ms` | 丢弃 V7 结果 |
| V7 异常 | `v7_error:<message>` | 丢弃 V7 结果 |
| V7 校验失败 | `v7_validation_failed` | 标记 `legacy_only` |
| 正常 | `null` | 根据指标决定 `legacy_only` / `v7_eligible_for_review` |

注意：当前超时是**事后预算检查**，不是抢占式中断；生产启用前应改为 worker/子进程真超时。

## 4. 只读 API

```http
GET /api/v1/safety/v70/shadow
```

返回：

```json
{
  "enabled": true,
  "config": { "enabled": true, "strategy": "solver", "maxSolveMs": 500, "maxComparisons": 20, "source": "environment" },
  "comparisons": [
    {
      "id": "SHADOW-...",
      "snapshot": { "scenario_version": "1.0.1", "constraint_version": 0, "observation_version": 3, "hash": "..." },
      "legacy": { "plan_id": "...", "validation_valid": true, "projected_makespan_minute": 18 },
      "v7": { "plan_id": "...", "validation_valid": true, "projected_makespan_minute": 9 },
      "comparison": { "evacuated_delta": 0, "projected_makespan_delta": -9, "projected_queue_delta": -30000 },
      "decision": "v7_eligible_for_review",
      "fallback_reason": null
    }
  ]
}
```

`v7_eligible_for_review` 仅表示“值得人工评审”，**不是安全批准**，也不会发布。

## 5. 启用前验收清单

- [ ] Shadow ≥ 30 天或 ≥ 1000 次重规划，校验失败率 0 或可解释；
- [ ] V7 完成时间/队列/未疏散稳定不劣于 legacy（Holm 校正）；
- [ ] 路线切换成本与人工审批流程评估完成；
- [ ] 真超时/回滚演练完成；
- [ ] 独立安全评审签署；
- [ ] 先从建议模式开始，不直接替换默认路径。

## 6. 回滚

1. 删除/设置 `V7_SHADOW_MODE=0`；
2. 重启服务（Shadow 记录为内存态，不影响持久化安全状态）；
3. 既有 `MVP_STATE_FILE`、legacy 规划器、Validator、四态均未改变。

## 7. 限制

- Shadow 记录只在内存，重启丢失；
- 当前只比较单步时间扩展方案，不比较 MPC 执行策略；
- 没有真实场馆验证；
- 任何 V7 结果不得表述为“已验证安全方案”。

## V7.2 增补：快照一致性与回放压力（2026-11-10）

- `ShadowComparison.integrity`：legacy/V7 计划声明的总人数必须与快照需求一致；
  不一致时回退原因分别为 `legacy_snapshot_mismatch` / `v7_snapshot_mismatch`，决策强制 `legacy_only`。
- `ShadowSolver` 注入仅用于故障注入与回放，不改变生产发布语义。
- 回放压力证据：`evaluation/v72/<run>/shadow_stress_*`（10 种子 × 4 场景 × 6 模式 = 240 次）：
  确定性 0 不一致；求解器异常/校验失败/预算为零全部回退；过期观测两套均不可发布；
  快照篡改 40/40 标记；V7 从未发布。
- 仍默认关闭、未启用、不是安全批准；超时仍为事后检查而非抢占，记录仍为内存。
