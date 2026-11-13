# SkyGuard V7.4 独立审计

> 审计对象：V7.4 变更（`v74-*` 脚本、MPC 门控/Pareto、`calibration/quality.ts`、AgentArts trace、
> 生产检查、E2E）与最终证据 `evaluation/v74/v74-final-20261110T105851/`。
> 审计方式：代码走查 + 原始 JSON 复算 + 测试 + 安全不变量检查 + 证据哈希只读校验。
> 审计者：同一执行代理的对抗性复核（非第三方）。此局限必须随报告一起呈现。

## 1. 结论摘要

- **P0：0**。未发现可绕过安全内核、容量校验、四态或人工审批的缺陷。
- **P1：3 项**（风险折扣机制未被真正触发、区域选择性承诺未被公平评测、门控仅覆盖承诺路径）。其中门控回退已修复；风险折扣与区域选择性承诺**未修复**，在文档中降级为 NOT_SUPPORTED / PARTIALLY VERIFIED，不以调参制造正结果。
- **P2：4 项**（指标口径、场景覆盖、性能、平台证据）。
- 所有对外数字均能在 `*_rows.json` / `*_summary.json` 复算；未发现伪造或与原始数据不符的表述。
- Docker、AgentArts 实机、昇腾 NPU 三项保持 BLOCKED，未被包装成已验证。

## 2. 对研究主张的复核

| 主张 | 审计判定 | 复核依据 |
| --- | --- | --- |
| Pareto 门控降低切换 52% | 支持 | F 1837.66 vs B 3820.75；配对 −1983.09 [−2168.48, −1797.71]，Holm p<0.05 |
| 代价为 +0.575 分钟 / +862 人·分钟 | 支持 | 配对 CI 均不含 0 |
| 零代价稳定性 | 不支持（负结果） | 0/0 容差下门控拒绝全部候选；报告已明说 |
| 风险敏感惩罚优于 V7.3 | 不支持 | D 与 C 240/240 逐指标相同 |
| 动态容量容量违规 0 | 支持（合成） | 每步 `checkPlanCapacity` 为空；A 静态 6.43 次/场景 |
| CUSUM 检测率 100% | 支持（合成） | `surge_summary.json`；3σ 76.7%/73.3% |
| 标定质量门控 | 支持（夹具） | 90s 偏移被拒、缺失区间被报 |
| AgentArts 已接入 | **不成立** | `platform.status=not_configured`；仅 local stub |
| 昇腾 NPU 已验证 | **不成立** | `npu-smi/atc` 不可用；仅 CPUExecutionProvider |

## 3. 安全不变量检查

1. **未疏散不增加**：候选必须满足 `candidate.plan.unresolved_persons <= base.plan.unresolved_persons`
   （`mpc-planner.ts:524`）。总体 F 的未疏散 3.81 来自逐场景累计，而非单步劣化；`oscillation_stress`
   场景从标准 131.77 降至 30.5。
2. **容量**：候选先 `candidate.capacity_violations.length === 0`，最终方案仍经过既有逐分钟复核；
   240 样本容量违规 0。
3. **振荡护栏**：自适应模式下 `candidateOscillation.persons <= baseOscillation.persons`（`:551`）。
4. **目标劣化护栏**：`candidateObjective <= baseObjective*(1+maxObjectiveDegradation)+1`（`:550`）。
5. **门控回退**：门控开启时必须 `bestCandidate.switchWeighted < baseSwitchWeighted`，否则保留标准方案（`:573-574`），
   保证「门控不会增加切换」。
6. **出口不可用**：`unusableExit` 立即 `emergencyOverride`，承诺失效（`:582-585`）。
7. **高风险释放**：`releaseOnRisk` 时跳过承诺分支（`:458`），并记录释放。
8. **四态/独立校验/人工审批**：V7.4 未修改 `decision-service`、`validateSafetyPlan`、审批与派发边界；
   `git diff` 中相关文件仅 V7.2/V7.3 既有改动。Agent 仍只能创建待审批工单。

回归测试覆盖：`v74-redteam.test.ts` 4 项、`v74-calibration-quality.test.ts` 5 项、
`v73-agentarts.test.ts` V7.4 trace 1 项；后端 283/283 通过。

## 4. P1 发现

### P1-1 风险折扣在自适应模式下几乎不影响决策（机制未触发）

- 现象：D（riskDiscount 0.9）与 C（0.5）在 240 个样本上完全相同；
- 根因：`shouldUseCommitment` 在 `adaptive` 模式下，承诺窗口内或拥堵时直接返回 `use=true`
  （`route-stability.ts:165-169`），不比较惩罚后目标；只有窗口外且不拥堵才使用
  `switchPenaltyPerPerson`。基准中队列阈值 100 几乎每步都触发拥堵，故风险折扣未被咨询。
- 影响：不能声称「风险敏感惩罚有效」；已作为负结果写入实验报告；
- 处置：保留实现但标注 `NOT_SUPPORTED`，不调整阈值以制造正结果。若后续要评测，应显式设计
  「非承诺、非拥堵」场景或修改决策函数并配回归。

### P1-2 区域选择性承诺已实现但未进入 A-F 评测矩阵

- 现象：`regionSelectiveRiskThreshold` 在代码与单测中存在，但 `v74-stability-benchmark.ts`
  没有对应策略；
- 影响：目标中的「E 区域特定自适应惩罚」只完成实现，未完成公平评测；
- 处置：在本审计与实施报告中降级为 PARTIALLY VERIFIED，并在后续版本补策略 E'。

### P1-3 「执行门控」只作用于承诺决策路径

- 现象：门控比较的是「保留承诺的候选」与「标准重规划」，不改变标准 MPC 本身；
- 影响：若标准 MPC 自身在场景中振荡，门控不负责修正；Pareto 门控的 −52% 是承诺路径的收益；
- 处置：文档明确「执行感知承诺门控」，不泛化为「全局稳定性控制器」。

## 5. P2 发现

1. **指标口径**：`unserved` 是执行结束仍未疏散人数，跨场景均值受 `oscillation_stress` 主导；
   报告已给场景分层表，避免只报总体。
2. **场景覆盖**：8 个合成场景，无真实拓扑/事件；不能外推。
3. **性能**：Pareto 每步多次求解（平均 18.45 候选），p50 40.9ms；未做规划吞吐压测。
4. **平台证据**：AgentArts/Ascend/Docker 均为 BLOCKED 或适配器级，报告已分栏。

## 6. 证据完整性

- `MANIFEST.json` 覆盖 31 个文件；`verify:evidence` 166/166；
- V7.2 冻结基线快照 299 文件字节校验通过；V7.3 证据未改写；
- 最终证据目录只读复核：根清单 SHA-256 与文件一致；
- 未发现将合成结果标注为真实、或将 stub 标注为平台的字段。

## 7. 审计结论

V7.4 的实现与证据**可以支持**「执行感知承诺门控可有界降低切换」与「CUSUM 检测优于 3σ（合成）」；
**不能支持**「零代价稳定性」「风险敏感惩罚有效」「AgentArts/昇腾实机」。
剩余风险集中在机制触发条件、评测矩阵覆盖与真实数据缺失，均已在 `docs/LIMITATIONS.md` 与
`research/CLAIMS.md` 中登记。
