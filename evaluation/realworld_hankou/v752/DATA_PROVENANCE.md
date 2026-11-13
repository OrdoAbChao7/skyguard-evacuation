# V7.5.2 数据来源与 GIS 降级 (DATA_PROVENANCE)

**分类**: **Geographically Anchored Estimated Scenario**（地理锚定的估算场景）。  
**不是**: 测绘成果、OSM 提取、官方设计图纸、现场实测客流、真实传感器标定数据。  
**结论**: 现有证据不足以支持 0.1 m 精度、54 m 净宽、3.6 km 长度、0.42 km² 面积等表述；这些表述必须永久撤回或降级为“估算/待核实”。

---

## 1. 逐字段来源

| 字段/数据 | 来源标签 | 说明 |
| :--- | :--- | :--- |
| 区域几何 `geometry` | `manual_digitization_estimated` | 继承 V7.5 估算场景；无 OSM 原始文件、下载记录、ODbL 文本或 SHA-256 |
| 区域面积 `area_m2` | `estimated` | 由估算几何导出；无测绘控制点/重复测量 |
| 区域容纳人数 `holding_capacity_persons` | `engineering_assumption` | 按面积 × 假设密度；不是现场容量评估 |
| 通道容量 `capacity_per_min` | `engineering_assumption` | 名义流量；未做现场人流观测/标定 |
| 通道通行时间 `traversal_seconds` | `engineering_assumption` | 名义步行时间；未按坡道/楼梯/拥挤速度标定 |
| 通道方向/状态 | `synthetic_test_data` | 场景配置；不是实时路况 |
| 出口容量 `capacity_per_min` | `engineering_assumption` | 名义闸口容量；未做闸机实测 |
| 出口位置/编号 | `manual_digitization_estimated` | 锚定到估算闸口位置；无官方图纸 |
| 初始人口 `initial_populations` | `synthetic_test_data` | 压力测试参数，不是实测客流 |
| 外部流入 `inflow_schedule` | `synthetic_test_data` | 当前压力场景为空；仅单元测试使用 |
| 封控/恢复事件 | `synthetic_test_data` | 演练脚本，不是历史事件 |
| 传感器噪声/延迟/缺失/冲突 | `synthetic_test_data` | 合成观测误差模型，不是设备标定 |
| 密度阈值 2.0 / 4.5 人/m² | `literature + engineering_assumption` | 参考 GB 50016-2014 / Fruin LOS E 的量级；具体取值是工程假设 |
| 基础锚点坐标 | `manual_digitization_estimated` | 继承 V7.5；无控制点、无官方测量文号 |

压力场景 JSON 的 `provenance` 字段与每个场景的 `geometry_provenance` / `capacity_provenance` / `population_provenance` / `event_provenance` / `sensor_provenance` 记录了同一分类。

---

## 2. 为什么降级

V7.5.1 审计（[`../audit_v751/GIS_PROVENANCE_AUDIT.md`](../audit_v751/GIS_PROVENANCE_AUDIT.md)）的核查：

- 仓库中没有 OSM 原始文件、下载记录、ODbL 许可文本或哈希；
- 没有水务局/规划部门的文号、图纸、控制点；
- 11 个锚点为硬编码；场景全部 `estimated`、`verified:false`；
- 投影实现正确（独立 Krüger 复算最大差异 <0.5 mm），但**投影正确不等于源坐标精度**；
- 对现有估算几何的复核值约为：锚点链 4.115 km、面积 0.7336 km²、11 门总宽 100.5 m（核心三闸 21.5 m）；
- 基础场景 JSON 的描述中出现“3.6 km / 真实地理”等历史标签，但这些标签不是独立证据，不能反过来证明几何精度；
- 旧报告中的 0.1 m 精度、54 m 净宽、3.6 km、0.42 km²、42 通道等数字与文件不一致或缺少来源。

因此本轮将场景明确降级为 **Geographically Anchored Estimated Scenario**，并在所有报告中避免把估算值写成实测值。

---

## 3. 可以怎样表述

可以：

> 本场景是以汉口江滩公开地理信息为锚点的估算拓扑，用于比较算法在合成压力下的相对行为；几何、容量、初始人口和事件均为估算或测试参数。

不可以：

> 本场景是 0.1 m 精度真实地理场景；54 m 净宽；3.6 km 实测长度；100% 真实客流；已通过官方测绘/水务部门认证。

---

## 4. 升级为可验证场景所需材料

1. **OSM 路线**：原始 `.osm.pbf` 或 XML、下载 URL、下载时间、SHA-256、ODbL 许可文本；
2. **官方测绘**：水务局/规划局文号、图纸、控制点坐标、坐标系与投影参数；
3. **现场容量**：闸口宽度/闸机数量/通行速率实测；通道坡度、楼梯、障碍物；
4. **现场客流**：分时段计数、视频/雷达标定、置信区间；
5. **事件记录**：真实封控/演练记录、时间戳、命令链路；
6. **独立复核**：第三方测绘或交通工程复核报告。

在这些材料到位前，只能使用“Geographically Anchored Estimated Scenario”，不能升级为“digital twin”或“real-world validated”。

---

## 5. 与仿真结论的关系

质量守恒、策略集成、传感器边界、动态安全校验的结论**不依赖** GIS 精度：它们检验的是仿真内核的因果闭环与账本一致性，而不是地理坐标精度。

但以下结论**依赖**场景真实性，当前不能成立：

- “该场景可预测真实汉口江滩的疏散时间”；
- “0.1 m/54 m 几何精度支持工程决策”；
- “100% 安全校验可外推到现实人群”；
- “算法排名可外推到真实客流”。

这些必须标注为 `BLOCKED` 或 `UNVERIFIED`，不得写成 `VERIFIED`。
