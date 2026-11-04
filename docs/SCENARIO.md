# 场景定义与替换指南

> 本仓库**不把场景写死在代码里**。换场景 = 新增一份 JSON（+ 可选底图），
> 疏散引擎、校验器、状态机与 API 契约都不需要修改。

## 1. 文件与选择

| 项 | 说明 |
| --- | --- |
| 目录 | `data/scenarios/` |
| 默认文件 | `venue-default.json`（合成演示场馆，仅供闭环验证） |
| 选择方式 | 环境变量 `SAFETY_SCENARIO_FILE=<文件名或绝对路径>` |
| 热切换 | 登录后 `POST /api/v1/safety/admin/reload-scenario`，body `{ "file": "xxx.json" }` |
| 候选列表 | `GET /api/v1/safety/scenarios` 返回每个文件的结构校验结果 |
| 审计目录 | `data/audit/`（JSONL 追加写，不覆盖） |

加载时会做两层检查：Zod 结构校验 + 引用完整性校验。任何悬空引用
（通道指向不存在的区域、出口不属于任何区域、演示脚本引用未知 ID）都会直接报错，
不会带着坏数据进入规划器。

## 2. 顶层结构

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `scenario_id` / `name` / `version` | 是 | 标识与版本；`version` 会进入方案指纹 |
| `description` / `notice` | 是 | `notice` 会原样显示在大屏顶部，必须写明数据性质 |
| `config` | 是 | 时间窗、观测时效、最低置信度、趋势窗口、密度阈值 |
| `regions` | 是（≥1） | 区域（感知与疏散的节点） |
| `corridors` | 是（≥1） | 通道（有方向与分钟容量） |
| `exits` | 是（≥1） | 出口（挂在区域上，有分钟接收容量） |
| `demo_scenarios` | 否 | 演示脚本（A/B/C 就是从数据里来的） |
| `map` | 否 | **只影响大屏绘制**，不参与任何安全判定 |
| `simulation_baseline` | 否 | "写入模拟观测"按钮的基线人数与置信度 |

### 2.1 区域 `regions[]`

| 字段 | 说明 |
| --- | --- |
| `id` / `name` | 唯一 ID 与显示名 |
| `area_m2` + `area_provenance` | 面积及来源（`measured` / `estimated` / …） |
| `geometry` + `geometry_provenance` | 大屏示意坐标（无量纲画布，不是地理坐标） |
| `holding_capacity_persons` | 区域在留容量（等待缓冲） |
| `thresholds` | 可选，覆盖全局密度阈值 |
| `enabled` | 停用后不参与规划 |
| `camera` | 摄像机与标定状态；**未标定的视频观测会被强制降置信度** |
| `source` / `verified` | 数据来源与是否经现场核验 |

### 2.2 通道 `corridors[]` 与出口 `exits[]`

| 字段 | 说明 |
| --- | --- |
| `from_region_id` / `to_region_id` | 通道两端 |
| `direction` | `forward` / `reverse` / `both` |
| `capacity_per_min` | 人/分钟；`null` 表示未知，**未知一律不可用** |
| `traversal_seconds` | 通过耗时，规划时向上取整到分钟 |
| `status` | `open` / `closed` / `unknown`；事件可覆盖有效状态 |
| `capacity_provenance` / `verified` | 容量来源与核验状态 |

出口额外要求 `region_id`（所属区域）与接收容量。

### 2.3 地图层 `map`（可选）

```json
"map": {
  "caption": "概念底图 · 合成场景 · 区域未空间标定",
  "backdrop": "/scenarios/<your-scenario>.png",
  "backdrop_opacity": 0.48,
  "landmarks": [
    { "name": "主入口", "x": 0.5, "y": 0.84 }
  ]
}
```

- 底图放在 `frontend/public/scenarios/`，`backdrop` 写站点绝对路径；
- 地标坐标是相对画布的归一化值（0~1）；
- 不提供底图时大屏只画几何网络，不影响功能；
- `caption` 必须如实说明"概念图 / 未空间标定"。

### 2.4 模拟基线 `simulation_baseline`（可选）

```json
"simulation_baseline": {
  "R_MAIN": { "count": 380, "confidence": 0.92 }
}
```

仅用于大屏的"写入模拟观测"按钮。缺少该字段时按钮会写入 0 人观测，
不会凭空生成人数。

### 2.5 演示脚本 `demo_scenarios[]`

```json
{
  "id": "B_exit_fire",
  "label": "场景 B · 出口突发火灾",
  "description": "确认火情 → 关闭 E_B → 重规划",
  "expected_state": "REROUTE",
  "steps": [
    { "action": "observe", "observations": { "R_MAIN": { "count": 380, "confidence": 0.9 } } },
    { "action": "incident.create", "type": "fire", "severity": "critical",
      "description": "东侧主出口附近报火情",
      "affected": { "region_ids": [], "corridor_ids": [], "exit_ids": ["E_B"] } },
    { "action": "incident.confirm" },
    { "action": "recompute" }
  ]
}
```

可用动作：`observe` / `sensor_fault` / `incident.create` / `incident.confirm` /
`incident.resolve` / `recompute`。`expected_state` 会被自动化演示与测试校验，
**不要为了提高通过率修改期望值**；应先修正场景数据或算法。

## 3. 换场景检查清单

1. [ ] 所有 `provenance` 如实标注；估算值写 `estimated`，不要伪装成 `measured`；
2. [ ] 未知容量写 `null`，未知状态写 `unknown`，不要填猜测值；
3. [ ] 至少保留一个 `unknown` 元素，用于验证"未知不当可用"的保守行为；
4. [ ] 密度阈值与来源说明一致，且 `watch < high < critical`；
5. [ ] 每个出口挂在已存在的区域上，每个通道两端都存在；
6. [ ] 演示脚本覆盖三种状态：`NORMAL` / `REROUTE` / `REJECT`（或按新场景合理裁剪）；
7. [ ] 大屏底图与地标不暗示"已空间标定"，`caption` 如实描述；
8. [ ] `GET /api/v1/safety/scenarios` 显示 `valid: true`；
9. [ ] `npm run demo` 与 `npm test` 全部通过；
10. [ ] 更新场景专属文档，并明确"合成数据 / 未现场测绘"。

## 4. 不该放进场景层的东西

- 安全判定逻辑、阈值比较顺序、状态优先级（属于代码，必须统一）；
- 前端颜色与状态映射（属于 UI 契约，所有场景一致）；
- 为了演示好看而编造的容量、面积、置信度或性能数字。
