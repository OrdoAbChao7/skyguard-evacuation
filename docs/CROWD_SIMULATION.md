# 算法人群仿真（Crowd Flow Simulation）

> 状态：**合成数据 / 启发式模型 / 未现场标定**。  
> 本文件说明 `backend/src/services/simulation/crowd-flow.ts` 的模型、命令、API、不变量与禁止表述。  
> 主张编号见 [`research/CLAIMS.md`](../research/CLAIMS.md) C86；整体局限见 [`MVP_LIMITATIONS.md`](./MVP_LIMITATIONS.md)。

## 1. 为什么需要它

汉口江滩场景 `data/scenarios/hankou-mvp.json` 没有真实人群数据：没有逐区域人数、没有真实通行能力、没有现场标定。
为了让预测、VoI、规划、四态状态机与前端演示能在**同一个场景拓扑**上联调，本项目用算法生成分钟级合成人数序列，
而不是手工写死一条人数曲线。

**它不是**经验证的人群动力学模型，**不能**用于真实疏散效果评估、容量设计或应急预案验证。

## 2. 模型

```text
场景拓扑（44 区域 / 78 通道 / 11 出口）
        ▼
初始人数 = 场景 simulation_baseline（合计 18,000）
        ▼
每一分钟：
  1. 应用事件（关/开闸口、关/开通道、注入人群、置信度下降）
  2. 通道在途人数按到达分钟进入下游区域
  3. 外部到达人数进入指定区域
  4. 从所有可用出口做反向 Dijkstra，得到每个区域的最短路与下一跳
  5. 区域流出 = min(意愿流出, 通道容量, 下游在留空间, 出口容量)
  6. 剩余人数留在原区域排队；到出口的人计入已疏散
        ▼
输出：逐分钟区域人数/密度/置信度、通道流量、出口放行、守恒总量
```

关键参数：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 时间步 | 60 秒 | 与安全内核的离散化一致 |
| 时长 | 场景 horizon（10 分钟） | CLI/API 可覆盖，API 上限 60 分钟 |
| 自由流出比例 | 0.35 / 分钟 | 每个区域每分钟最多离开当前人数的 35% |
| 路径成本 | `traversalMinutes(corridor) + queuePenalty(下游)` | 下游占用越高，越倾向绕行 |
| 拥堵反馈 | `max(0.5, 1 - (density / critical)^2)` | 启发式；不是个体行为模型 |
| 密度 | 人数 / 区域面积（场景 `area_m2`） | 面积为 `estimated` |
| 置信度 | 基础值 − 密度惩罚 + 种子噪声 | 只影响观测置信度，不影响人数轨迹 |
| 随机性 | 仅置信度噪声 | 同一 seed 完全可复现；人数轨迹是确定性的 |

硬约束：

- 通道流量 ≤ `capacity_per_min`；出口放行 ≤ `capacity_per_min`；
- 区域在留人数 ≤ 在留容量（若场景声明）；超出部分留在上游；
- 未知容量（如 `C_FLOOD_ESCAPE_UNKNOWN`）不参与路径；
- 人数取整；任意时刻 `初始 + 到达 = 场内 + 在途 + 已疏散`（守恒）。

## 3. 预设

| preset | 行为 |
| --- | --- |
| `normal` | 只疏散，不注入事件 |
| `gate_closure` | 第 3 分钟关闭 `GATE_03_G03`、`GATE_04_G04`，观察绕行与排队 |
| `surge` | 第 3 分钟向 `R_GATE_04_PLAZA` 注入 3,300 人，并把该区域置信度降到 0.35 |

预设只是**演示脚本**，不是对真实事件的预测。

## 4. CLI

```powershell
npm run simulate:crowd
npm run simulate:crowd -- --preset gate_closure --minutes 12
npm run simulate:crowd -- --preset surge --minutes 10 --seed 7
```

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--scenario` | `hankou-mvp.json` | 场景文件名或绝对路径 |
| `--preset` | `normal` | `normal` / `gate_closure` / `surge` |
| `--minutes` | `10` | 仿真分钟数 |
| `--seed` | `42` | 置信度噪声种子 |
| `--start-at` | `now - minutes` | 第一个样本时间（ISO 8601） |
| `--out` | `crowd-sim-<preset>.json` | 回放文件，写入 `data/replays/` |
| `--report` | `crowd-sim-<preset>.json` | 摘要文件，写入 `data/simulations/` |

输出：

- `data/replays/crowd-sim-<preset>.json`：`{ name, description, provenance, rows }`，
  `rows` 为 `{ timestamp, region_id, count, confidence, source: 'simulation' }`，
  可直接被 `POST /api/v1/mvp/replay/load` 加载；
- `data/simulations/crowd-sim-<preset>.json`：摘要 + 逐分钟总量 + 最忙的 5 个区域；
- 终端打印逐分钟总量、守恒、峰值密度、事件与未解决区域。

`data/replays/crowd-sim-*.json` 与 `data/simulations/` 是运行产物，已在 `.gitignore` 中排除。

## 5. API

```http
POST /api/v1/mvp/simulation/crowd-flow
Authorization: Bearer <admin 或 safety_operator JWT>
Content-Type: application/json

{ "preset": "gate_closure", "minutes": 10, "seed": 42, "ingest": true }
```

- 仅 `admin` / `safety_operator`；staff、agent 返回 403；
- `minutes` 为 1–60；未知 preset 返回 400；
- 服务层调用仿真引擎，把每个区域每分钟的人数作为 `source: 'simulation'`、
  `provider: 'crowd-flow-sim'`、`modelVersion: 'crowd-flow/1.0.0'` 的观测写入安全域；
- 写入后调用 `safety.recompute(actor, 'simulation.crowd_flow')`，由既有规划器、
  独立校验器与四态状态机给出方案与状态；仿真本身**不**做安全判定；
- 审计动作：`simulation.crowd_flow`；
- 返回 `run_id`、`summary`、`timeline`、`latest_regions`、`observations_ingested`、
  `state`、`plan_id`、`validation_valid`。

前端「算法人群仿真」面板调用同一 API，展示守恒、疏散、在途、峰值密度与逐分钟总量，
并显式标注「合成数据 · 非实测」。

## 6. 已由测试验证的不变量

`backend/tests/simulation/crowd-flow.test.ts`（8 项）：

1. 同一 seed 的输出完全一致；不同 seed 只改变置信度；
2. 每个样本都满足人数守恒；
3. 初始总人数等于场景基线（18,000）；
4. 通道与出口流量不超过容量；
5. 未知容量通道不被使用；
6. 闸口关闭后这两个出口不再放行，疏散人数低于正常；
7. 所有出口关闭时出现 `stranded` 与未解决区域；
8. 回放行结构合法、按时间排序、`source` 恒为 `simulation`。

`backend/tests/mvp/crowd-simulation-api.test.ts`（1 项）验证权限、参数校验、观测写入与状态返回。

## 7. 明确不声称

- 不声称这是经过验证的人群动力学模型；
- 不声称人数、密度、疏散时间、峰值具有真实精度；
- 不声称容量、面积、阈值已标定；
- 不声称仿真结果可以用于真实疏散指挥、容量设计或应急预案；
- 不声称仿真替代了实测、视频推理或人工研判；
- 不声称仿真可以审批、派发或控制任何现场资源。
