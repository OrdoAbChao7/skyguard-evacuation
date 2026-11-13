# V7.5 实施报告：风险自适应智能疏散

> 版本：`v7.5.0-research.1`。
> 基线：V7.4 为实验基线；V7.2/V7.3/V7.4 冻结证据按字节保留，未改写。
> 最终证据运行：`evaluation/v75/v75-final-20261110/`（33 个根文件，含 `browser_e2e.json` 与根清单）。
> 本文件只描述实现与验证方式；所有数字以原始 `rows/summary/MANIFEST` 为准。

## 1. 目标与边界

V7.5 不新增业务表面，而是把「检测—承诺—状态机—多目标—融合」五个研究问题做成
可独立复现、可被红队攻击、可被证伪的模块：

- 低误报突增检测（Track A）；
- 区域选择性承诺与承诺失效（Track B）；
- 显式紧急状态机 NORMAL → RISK_WARNING → EMERGENCY_OVERRIDE → RECOVERY（Track C）；
- 多目标统一优化与离线 Pareto 分析（Track D）；
- 多传感器不确定性融合与 fail-closed（Track E）。

不可违背：

- 安全内核（四态判定、独立 Validator、未知/不可用 fail-closed、人工审批）未被改写；
- 所有 V7.5 模块只输出候选/审计，不直接发布方案；
- 合成/夹具数据不得表述为真实场馆、真实传感器或 NPU 实测；
- 负向与混合结果保留在原始数据与报告中。

## 2. 检测（Track A）

模块：`backend/src/services/safety/detection/surge.ts`

| 检测器 | 设计 | 关键参数 |
| --- | --- | --- |
| `ThreeSigmaDetector` | 3σ 基线 | warmup 20，z≥3 |
| `CusumDetector` | 经典 CUSUM | k=0.5，h=5 |
| `AdaptiveCusumDetector` | EWMA 基线 + 自适应阈值 + 最短驻留 | α=0.02，h=4.5+min(2,score·0.1)，dwell 5 |
| `SprtDetector` | 序贯概率比 | δ=1.5σ，α=0.01，β=0.1，dwell 5 |
| `ReliabilityDualDetector` | 双阈值 + 持续性 + 多传感器可靠性加权 + 冲突抑制 | warningZ 2.5，alarmZ 4，persist 2，singleReliability 0.9，conflictZ 4 |

- 基线只在非警告状态缓慢更新，突增不被吸收进基线；
- 单传感器尖峰只进入警告，不报警；冲突时要求至少 2 个报警传感器；
- 缺失传感器被排除，剩余传感器仍可确认；
- 融合辅助函数 `fuseDetectorSensors` 冲突时退化为中位数并标记冲突。

实验：`backend/scripts/v75-detection-benchmark.ts`，30 种子 × 7 机制 × 7 检测器；
指标为运行级召回、精确率、F1、无变化误报率、误报/100 步与延迟。

## 3. 承诺与稳定性（Track B）

模块：`mpc-planner.ts`、`stable-solver.ts`、`route-stability.ts`、`v73-stability.ts`。

- 区域选择性承诺：`regionSelectiveRiskThreshold` 只对低风险区域保持承诺；
- 高风险释放：`releaseOnRiskThreshold` 触发承诺释放并记录 `commitment_releases`；
- 紧急冷却：`recommitCooldownMinutes` 在释放后禁止立即重新承诺；
- 容量感知承诺：`capacityAwareCommitment` 按出口投影需求与 headroom 放弃高风险区域承诺；
- 承诺求解仍是逐区域顺序求解 + 容量预留的贪心多商品近似，结果必须经过容量复核与独立校验。

实验：`backend/scripts/v75-commitment-benchmark.ts`，30 种子 × 8 场景 × 10 策略
（legacy、标准 MPC、迟滞、切换惩罚、承诺、自适应、风险自适应、容量感知、紧急释放、紧急恢复）。
输出包含配对差、Bootstrap 置信区间、Cohen's d_z 与 Holm 校正。

## 4. 紧急状态机（Track C）

模块：`backend/src/services/safety/emergency/emergency-state.ts`

- 状态：`NORMAL`、`RISK_WARNING`、`EMERGENCY_OVERRIDE`、`RECOVERY`；
- 进入警告需要连续 `warningPersistence` 个 tick；
- 硬触发：出口不可用、容量违规、已确认事件、风险 ≥ `emergencyRisk`；
- 紧急状态立即失效承诺、禁止重新承诺、记录审计事件；
- 恢复需要风险持续低于 `recoveryRisk`、观测有效且 `planValidated === true`；
- 过期/冲突观测一律 `publishable=false`；
- 状态机不替代四态判定、独立校验和人工审批，只管理承诺与发布门禁。

实验集成：MPC 在每一步把风险、出口可用性、容量冲突、观测有效性与方案校验结果送入状态机，
输出的 `emergency_events` 与 `emergency_state` 随步骤记录。

## 5. 多目标（Track D）

模块：`backend/src/services/safety/planning/multi-objective.ts`

- 目标向量：未疏散、完成时间、队列人·分钟、切换人数、紧急延迟；
- 提供 `dominates`、`paretoFront`、`selectKnee`、`satisfiesConstraints`、`selectConstrained`；
- 六组预先声明的权重配置（balanced/efficiency/stability/safety/queue/emergency）；
- 实验同时报告约束选择与四种优先级膝点。

**边界**：膝点选择使用同一实例的候选结果，是离线分析/上界，不是在线可部署的选择器；
部署时必须单次规划并经过独立校验。

实验：`backend/scripts/v75-multiobjective-benchmark.ts`，30 种子 × 8 场景 × 14 候选。

## 6. 多传感器融合（Track E）

模块：`backend/src/services/safety/fusion/fusion.ts`

- 输入：`SensorReading { sensorId, regionId, value, observedAt, receivedAt, confidence, reliability, kind }`；
- 拒绝：区域不匹配、非法值、非法时间戳、未来时间戳、过期、重复、低可靠度；
- 时钟偏移超过 `maxSkewMs` 时整批拒绝并返回 `status: 'stale'`；
- 冲突检测：两读数用相对阈值，三个及以上用相对 + 稳健 σ；
- 任何无法消解的冲突返回 `status: 'conflict'`、`value: null`、`usable: false`；
- 低于 `minSensors` 返回 `insufficient`；
- 只有 `fused` 且无冲突时 `usable: true`；
- 输出完整 `audit/rejected/conflicts`，供上层调查与人工确认。

实验：`backend/scripts/v75-fusion-benchmark.ts`，30 种子 × 9 条件 × 5 方法；
条件包括干净、噪声、单传感器偏置、丢包、时延、冲突、时钟偏移、重复、过期；
故障传感器按种子在三个传感器之间轮换，避免故障总落在权重最低的传感器上。

## 7. 实验协议

- 固定种子 `20261111`–`20261140`（30 个）；
- 所有对照共享相同场景、入流、执行模型与预算；
- 配对差 + 10,000 次 Bootstrap 置信区间 + Cohen's d_z + Holm 多重比较校正；
- 原始 rows、summary、README、metadata 与 SHA-256 清单全部保留；
- 不删除不利场景，不针对测试集调参；权重与阈值在实验前声明；
- V7.2/V7.3/V7.4 证据目录不重算、不改写。

## 8. 红队与回归

新增 `backend/tests/mvp/v75-redteam.test.ts`：

1. 重复紧急请求不产生重复状态转移（幂等审计）；
2. 风险在警告阈值附近抖动不会提前退出警告（迟滞）；
3. 执行步数/时长被截断时未疏散人数如实上报；
4. 同一输入重复规划结果确定，且不修改输入场景/需求；
5. 承诺出口运行中失效时记录紧急覆盖，新计划不再使用该出口；
6. 容量感知承诺 headroom 越界被夹紧且不产生容量冲突；
7. 观测无效/冲突时状态机拒绝发布，且不可发布步数被记录。

既有覆盖：Agent 不能审批/派发（`ops.test.ts`）、过期审批与幂等（`reservations`/`state-persistence`）、
持久化恢复与损坏拒绝启动（`state-persistence.test.ts`）、冲突观测 fail-closed（`v73-shadow-ops`）、
越权工具（`agentarts-runtime.test.ts`）。

## 9. 生产与华为生态

- `v75-experiments.ts` 编排 detection/commitment/multiobjective/fusion/ascend/agentarts（production 可选）；
- `npm run benchmark:v75` 根命令可用；CI 增加 V7.5 检测 + 融合快速检查；
- Docker/CI 实跑、AgentArts 真实租户、昇腾 NPU/CANN/OM 仍为外部阻塞，未实机验证。

## 10. 复现

```bash
npm run benchmark:v75 --prefix backend
npm run benchmark:v75 --prefix backend -- --only=detection,fusion
V75_INCLUDE_PRODUCTION=1 npm run benchmark:v75 --prefix backend
```

输出：`evaluation/v75/<RUN_ID>/`，含 `V75_SUMMARY.md`、根 `MANIFEST.json`、`run_metadata.json`
与各 track 的 rows/summary/README/metadata/MANIFEST。

## 11. 不适用范围

- 不代表真实场馆、真实人群、真实摄像机或无人机测量；
- 不构成应急指挥系统或安全认证；
- 检测/融合指标不是真实预警精度；
- 多目标膝点是离线上界；
- 状态机与承诺机制不替代人工审批与独立校验。
