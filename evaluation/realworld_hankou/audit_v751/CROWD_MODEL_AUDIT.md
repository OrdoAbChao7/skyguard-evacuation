# V7.5.1 人群物理模型与统计审计 (CROWD_MODEL_AUDIT)

**审计对象**: `scripts/crowd/differential-model.ts`、`scripts/crowd/sensitivity-analysis.ts`、`data/crowd/stress-scenarios.json`、`CROWD_EVIDENCE.md`、`DYNAMIC_MODEL.md`、`ASSUMPTIONS.md`  
**审计基准**: `feat/skyguard-mvp-e2e` @ `66eb9d5`  
**方法**: 代码逐行核对、独立重跑敏感性分析、扫描全部快照密度、核对报告与原始 JSON。

---

## 1. 模型实际结构

| 项目 | 实际值 |
| :--- | :--- |
| 区域 | **15**（5 个纵向分区 × 3 个高程台阶） |
| 区域面积合计 | **314,000 m²** |
| 通道 | **35**（24 条 flat + 11 条 stair_up） |
| 闸门 | **11**，容量合计 **8,040 人/分钟** |
| 时间步长 | `simulate()` 默认 **dt = 0.05 min**（3 s） |
| 积分器 | 真正的 RK4（k1/k2/k3/k4 + `(dt/6)(k1+2k2+2k3+k4)`） |
| 速度衰减 | `v = v0 * max(0, 1 - (rho/rho_jam)^alpha)` |
| 反压 | `Psi = 1`（rho ≤ rho_crit）；`(rho_jam-rho)/(rho_jam-rho_crit)`（rho_crit < rho < rho_jam）；`0`（rho ≥ rho_jam） |
| 参数 | v0_flat=75, v0_stair_up=36, rho_crit=2.0, rho_jam=4.5, alpha=1.0, q_flat=80, q_stair=48 |

**判定**: RK4 与方程实现 **PASS**（不是伪积分）；但“压力工况”是否真的进入压力区，见 §3。

---

## 2. 质量守恒：是求解器恒等式，不是独立验证

代码在 `differential-model.ts:620-640` 计算：

```text
expectedMass = initialTotal + totalInflowCum
actualMass   = finalPresent + evacuated
massConservationError = |actualMass - expectedMass| / expectedMass
```

- `evacuated` 与 `totalInflowCum` 都来自**同一组 RK4 阶段导数**：
  - 每条通道流量从 source 减去、向 target 加上；
  - 每个闸门流量从区域减去、加到 `dEvac`；
  - 外部流入加到区域、同时加到 `dInflow`；
- 因此 ODE 在构造上就是保守的，误差只来自浮点舍入与 `Math.max(0, ...)` 截断；
- 1e-15 是**双精度机器精度的必然结果**，不是“模型物理正确”的独立证据；
- 代码注释称“Simpson's rule consistent with RK4 continuous states”，实际是**复用 RK4 阶段权重**，没有另做 Simpson 1/3 独立积分。报告若写成“Simpson 积分验证质量守恒”，不准确。

**判定**: 质量守恒恒等式 **PASS**；作为模型正确性证据 **FAIL/PARTIAL**。

---

## 3. 五大“压力工况”实际全部处于自由流

`data/crowd/stress-scenarios.json` 的实际快照统计：

| 场景 | 初始 | 峰值在场 | 总疏散 | 终点剩余 | 峰值密度 (人/m²) | 质量误差 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| ST-01 日常 | 15,300 | 15,300 | 17,899 | 0 | **0.1667** | 4.065e-16 |
| ST-02 节假日 | 45,000 | 45,000 | 49,797 | 0 | **0.3333** | 1.315e-15 |
| ST-03 突增 | 40,000 | 40,000 | 40,000 | 0 | **0.5000** | 1.4552e-15 |
| ST-04 防汛 | 35,000 | 35,000 | 35,000 | 0 | **0.3333** | 1.871e-15 |
| ST-05 感知降级 | 30,000 | 30,000 | 31,798 | 0 | **0.2083** | 1.2585e-15 |

- 全部峰值密度 **0.1667–0.5**，远低于 `rho_crit=2.0`；
- 因而 `calculateBackpressure()` 在所有场景、所有快照都返回 **1.0**，反压**从未激活**；
- 速度衰减因子在 0.5 密度时仅 `1-0.5/4.5=0.889`，属于轻微衰减；
- 峰值密度出现在 t=0，之后只下降；模型没有出现“越挤越慢→反压→回溢”的非线性压力过程。

**结论**: 把 ST-01..ST-05 称为“5 大压力工况”不成立；它们是 5 个不同初始人数的**自由流排空**场景。依赖反压/拥堵的结论（“下游反压回溢”“拱圈残余排空”“高密度死锁”）没有被这些数据检验。**FAIL**（就压力覆盖而言）。

---

## 4. ST-04 防汛封控在微分模型中从未生效

`differential-model.ts:758-773` 定义：

```ts
incident_modifications: (model, t) => {
  // At t >= 5 min, flood closes all L3 stairs, and G07 gate is closed
  if (t >= 5) {
    for (const c of model.corridors) {
      if (c.source.includes('L3') || c.target.includes('L3')) c.status = 'closed';
    }
    for (const g of model.gates) {
      if (g.id === 'G07') g.status = 'closed';
    }
    model.buildDefaultRoutingWeights();
  }
}
```

但导出器 `runAndExportStressScenarios()` 只在仿真前调用一次（825-830 行）：

```ts
if (cfg.incident_modifications) {
  cfg.incident_modifications(model, 0);   // t = 0
}
const sim = model.simulate(cfg.duration_minutes, cfg.dt_minutes, 1.0);
```

`simulate()` 没有接收回调，也不会在 t≥5 时再次调用 `incident_modifications`。因此：

- `t=0` 时 `if (t >= 5)` 为假；
- 所有 L3 通道与 G07 闸门**从未关闭**；
- ST-04 的结果与“无封控、仅初始人数不同”的普通排空无法区分；
- `DYNAMIC_MODEL.md` 对 ST-04 的“防汛封控”物理解释没有代码支撑。

**判定**: ST-04 封控实现 **FAIL**。

> 基准脚本中的 ST-04 也有独立的 ID 不匹配问题：它关闭 `C_UP_L3_L2_S3`，但 15 区域夹具的通道 ID 是 `C_STAIR_S3_L3_L2`；`C_FLOOD_ESCAPE_UNKNOWN` 本来就是 unknown。实际只关闭了 G07。详见 `BENCHMARK_REPRODUCTION.md` §6。

---

## 5. 敏感性分析：报告数值与 JSON 不一致

独立重跑 `scripts/crowd/sensitivity-analysis.ts`（隔离副本）得到与 `sensitivity-results.json` **完全一致**的结果：

- baseline ST-03：T50=3.8, T90=9.2, TCT=14.0, peak density=0.5；
- 32 条 OAT 记录（8 参数 × 4 扰动）；
- 6 个参数进入排名：q_stair=1.0，其余 ≤0.1429；
- Monte Carlo 30 次：TCT mean=14.23, std=1.13, min=12.6, max=16.4，peak density 恒为 0.5。

### 5.1 ASSUMPTIONS.md 的敏感度列不可复现

| 参数 | ASSUMPTIONS.md 声称 | `sensitivity-results.json` 实际 | 判定 |
| :--- | :---: | :--- | :---: |
| q_stair | **-1.00**；“下降 10% → 耗时上升 10%” | -20% 时 -1.00；-10% 时 **-0.857**；+10% -0.714；+20% -0.643（非线性） | **PARTIAL/FAIL** |
| v0_flat | **-0.42** | 最大 |S|=**0.1429**；-20%/-10% 为 **0** | **FAIL** |
| rho_jam | **+0.88** | 最大 |S|=**0.1429**；+10%/+20% 为 **-0.1429**；-20%/-10% 为 0 | **FAIL** |
| q_flat | **0.82（高）** | 四个扰动全部 **0** | **FAIL** |
| W_gate | **0.95（极高）** | 最大 |S|=**0.1429** | **FAIL** |
| v0_stair | **0.58** | 最大 |S|=**0.1429** | **FAIL** |
| rho_crit | **0.62** | 四个扰动全部 **0** | **FAIL** |
| A_total | **0.45** | 未被扫描 | **FAIL/BLOCKED** |
| N_init | **0.74** | 未被扫描 | **FAIL/BLOCKED** |
| sigma_noise | **0.35** | 未被扫描 | **FAIL/BLOCKED** |
| phi | **0.78** | 未被扫描 | **FAIL/BLOCKED** |
| delta_hyst | **0.52** | 未被扫描 | **FAIL/BLOCKED** |
| alpha_arch | **0.18** | 未被扫描 | **FAIL/BLOCKED** |

> 结论：`ASSUMPTIONS.md` 的敏感度总表大部分不是来自 `sensitivity-results.json`。只有 q_stair 的极端点（-20%）与 JSON 一致；其余高敏感度数字（0.82/0.95/0.88/0.62/0.58/0.52/0.78/0.45/0.74/0.35/0.18）在仓库内没有可复现来源。

### 5.2 “Latin Hypercube”实际是普通均匀随机

`sensitivity-analysis.ts:219-260` 使用 LCG：

```ts
let seed = 42;
seed = (seed * 9301 + 49297) % 233280;
```

每个参数独立均匀采样，**不是 Latin Hypercube**。脚本头注释与报告中的“Latin-hypercube/Monte-Carlo”不准确。Monte Carlo 峰值密度恒为 0.5，说明参数扰动没有改变初始密度，也没有触发拥堵。

### 5.3 Δt 与 CFL 矛盾

| 来源 | Δt | CFL |
| :--- | :---: | :--- |
| 代码 `simulate()` 默认 | **0.05 min** | — |
| `DYNAMIC_MODEL.md:134` | **0.05 min** | `36×0.05/20 = 0.090`（Δx=20 m） |
| `ASSUMPTIONS.md:52/77` | **0.10 min** | `75×0.10/83.3 ≈ 0.090`（Δx=83.3 m） |

两处都写 0.090，但用的是不同的 Δx 与 Δt 组合。实际代码是 0.05；若按 ASSUMPTIONS 的 Δx=83.3 m，则 Co=0.045，不是 0.090。**FAIL**（数值不一致）。

### 5.4 质量误差表是陈旧的

`DYNAMIC_MODEL.md:234-238` 的表格：

| 场景 | 表中质量误差 | 当前 JSON |
| :--- | :---: | :---: |
| ST-01 | 6.05e-5 | **4.065e-16** |
| ST-02 | 5.35e-5 | **1.315e-15** |
| ST-03 | 1.46e-15 | 1.4552e-15 |
| ST-04 | 1.87e-15 | 1.871e-15 |
| ST-05 | 4.72e-5 | **1.2585e-15** |

同一文档 §3.3 又说误差已降到 1e-15；表格没有同步更新。**FAIL**（报告内部矛盾）。

---

## 6. 历史客流证据审计

### 6.1 733.57 万季度累计客流

在 `evaluation/`、`docs/`、`research/` 的 Markdown 中**未找到**“733.57 万”或等价数字。该数字无法从本仓库追溯。若它来自外部材料，必须：

- 明确是“季度累计人次”还是“瞬时在场人数”；
- 给出来源（公报/统计表/文号/URL）；
- 不得与 80,000–100,000 瞬时峰值混用。

**判定: BLOCKED/FAIL**（无仓库证据）。

### 6.2 2020 跨年 30–60 万、60 万瞬时、10 分钟撤离

- **2020 跨年 30–60 万**：未在 `CROWD_EVIDENCE.md` 中找到。报告中的跨年数据是 2023–24 瞬时 30,000–45,000（取 35,000）、2024–25 累计 200,000/瞬时 80,000–100,000。**无法核对 2020 数据**。
- **60 万瞬时**：报告用 600,000 / 84,900 = **7.067 人/m²** 证伪。该计算本身正确，但 84,900 m² 是“核心区有效站立面积”的工程估计（毛面积 192,000 m² × 扣除 55.78%）。若用毛面积 192,000，密度为 3.125 人/m²；若用 44 区域场景的 S01–S03 平台（177,000 m²）加 G01–G03 广场（10,900 m²），合计 187,900 m²，密度为 3.19 人/m²；只算平台为 3.39 人/m²。**“7.067”依赖有效面积分母，不能作为精确物理铁律。**
- **Kepler 极限 5.66**：0.9069 / 0.16 = 5.66，但 0.16 m² 小于报告自己给出的 0.17–0.20 m² 自然站立多边形面积；若用 0.196 m²（0.5 m 肩宽圆盘），极限为 **4.62 人/m²**；模型 `rho_jam=4.5`，`FINAL_REPORT.md` 又写 **5.5**。三个数字（5.5 / 5.66 / 4.5）没有统一。
- **10 分钟撤离 10 万人**：报告只用 G01–G03 三门（21.5 m）计算：1,720 人/min 理想 → 58.14 min。但全场 11 门总宽 **100.5 m**，理想容量 **8,040 人/min**，10 万人需 **12.44 min**；若只用核心三门，58 min 成立。**“10 分钟不可能”是核心三门口径，不是全场口径。** 报告没有说明这一限定。
- **“实际 89.4 min 与警方记录吻合”**：仓库中没有警方记录原文/URL/时间戳；“00:15–01:45”无法核验。

**判定**:

| 主张 | 判定 |
| :--- | :---: |
| 2024–25 累计 200,000 / 瞬时 80,000–100,000 | **PARTIAL**（有二手叙述，无文号/URL） |
| 2023–24 约 35,000 | **PARTIAL**（二手） |
| 2020 跨年 30–60 万 | **BLOCKED**（未找到） |
| 733.57 万季度累计 | **BLOCKED/FAIL**（未找到） |
| 60 万 → 7.067 人/m² | **PARTIAL**（依赖 84,900 m² 有效面积估计） |
| Kepler 5.66 人/m² | **FAIL**（0.16 m² 与自述 0.17–0.20 不一致） |
| 10 分钟撤离 10 万“物理不可能” | **PARTIAL/FAIL**（仅核心三门口径；全场理想 12.44 min） |
| 实际 89.4 min 与警方记录吻合 | **BLOCKED**（无原始记录） |

---

## 7. 判定汇总

| 审计项 | 判定 | 依据 |
| :--- | :---: | :--- |
| 15 区域/35 通道/11 门结构 | **PASS** | 代码实际计数 |
| RK4 实现 | **PASS** | 真实四阶阶段 |
| 质量守恒恒等式 | **PASS** | 构造性守恒 |
| 质量守恒作为模型正确性证据 | **FAIL/PARTIAL** | 恒等式，非独立验证 |
| 反压/拥堵被压力场景检验 | **FAIL** | 峰值密度 0.17–0.5 < rho_crit=2.0 |
| ST-04 封控生效 | **FAIL** | 回调只在 t=0 调用，`t>=5` 永不成立 |
| 敏感性报告数值可复现 | **FAIL** | 多数敏感度列与 JSON 不符 |
| Monte Carlo 为 Latin Hypercube | **FAIL** | 实际为普通均匀随机 |
| Δt/CFL 一致 | **FAIL** | 0.05 vs 0.10；Co 口径混用 |
| 报告质量误差表与 JSON 一致 | **FAIL** | ST-01/02/05 仍为 6e-5 量级 |
| 733.57 万季度累计可追溯 | **BLOCKED/FAIL** | 仓库无此数 |
| 60 万/7.067 人/m² 证伪 | **PARTIAL** | 依赖有效面积估计 |
| Kepler 5.66 人/m² | **FAIL** | 0.16 m² 与自述面积不一致；三套极限值 |
| 10 分钟/10 万人不可能 | **PARTIAL/FAIL** | 仅核心三门口径；全场理想 12.44 min |
| 历史客流“Verified”标签 | **PARTIAL** | 无文号/URL/原始统计表；最多 Secondary |

---

## 8. 复审所需的外部证据（BLOCKED）

1. 733.57 万季度累计客流的原始统计表/公报/文号；
2. 2020 跨年 30–60 万的原始报道或公安通报；
3. 2024–25 跨年 200,000 累计与 80,000–100,000 瞬时的官方统计表/视频计数报告；
4. 核心区 84,900 m² 有效面积的测绘底图与扣除依据；
5. 10 分钟撤离说法的原始出处与口径（核心三门 vs 全场 11 门）；
6. 人体投影面积/极限密度的统一取值与文献页码；
7. 现场实测的楼梯比流量、闸门通行能力、速度-密度曲线，用于替换 48/80 与 rho_jam=4.5 的假设。
