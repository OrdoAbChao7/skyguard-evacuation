# SkyGuard · 汉口江滩四级高程地图 V2 与三阳广场 24h 纯流动人流模拟（2026-11-25 交付）

本目录为 `gpt-6` 组于 **2026-11-25** 新增的独立交付包（与既有 `gpt-6/head-optimization/` 严格分离），面向主系统地图接入、28 机位视野仿真与下游人流预测/疏散联调。

> **完整 24 小时原始模拟大表（CSV / JSONL，约 3.5 GB 原始文本，压缩包 764 MB）统一托管在 GitHub Release**：
> <https://github.com/imsquner/skyguard-vision/releases/tag/v2026.11.25-sanyang-crowd-sim>
> 本仓库仅收录轻量化核心地图、28 机位配置、可复现脚本、字段样例、离线交互回放页及 30 秒成型演示视频（合计约 35 MB）。

> **数据性质**：本包内全部人流、机位观测与热力结果均为**合成模拟**（`seed=20261115`），不是真实摄录或实测客流；
> 底图中的 28 台摄像头是虚拟机位，其中 UAV-01 为模拟补盲机位，**未接入任何真实无人机**。
> 最低亲水层（源数据标 `16.0m`、现场未核实是否为 `23.0m`）的 provenance 见下文「最低亲水层口径」一节。

## 目录结构

| 路径 | 文件数 | 核心内容 |
| :--- | ---: | :--- |
| `map-v2/` | 10 | 汉口江滩全段四级高程 GeoJSON（`EPSG:32650` & `WGS84`，`G01–G14` 闸口对齐契约）、23m 季节性亲水步道 `RIVER_WALK`、三阳核心演示段 28 台虚拟摄像头配置 `sanyang_cameras_v1.json` 与覆盖布局图 |
| `crowd-sim/` | 12 | 5 个纯 Python 3.10 + Pillow 可复现脚本（固定种子 `20261115`）、统计汇总 `summary.json` 及 `samples/` 下 6 份 CSV/JSONL 字段样例 |
| `demos/` | 4 | 30 秒高清演示视频 `sanyang_24h_sat_topo_demo.webm`、卫星地形离线交互回放页 `sanyang_sat_topo_replay.html`、三时段卫星地形对比图及 24h 人流曲线图 |

## 关键仿真指标（金秋菊花会情景日 `2026-11-15`）

- 全天独立行人 `person_id`：**`73,005` 人**（`P000001` – `P073005`）
- 24h 潮汐规律：晨练早高峰 `1,203` 人 → 午饭低谷 `82` 人 → 菊花会下午高峰 **`4,923` 人（15:52）** → 晚饭后全天最高峰 **`8,083` 人（20:12）** → 21:30 后集中散场
- 纯流动约束：所有通道/路口严格 **0 驻留**，全天单人累计停留上限 `474.3s`（< 8 分钟）
- 28 机位**模拟**感知过滤：盲区不生成点位，重叠视场去重，走出盲区 >6s 断轨重编 `obs_track_id`（菊花会 15min 连续观测轨迹 `31,554` 条，晚饭后 15min `45,967` 条）

## 最低亲水层口径

`map-v2/river_walk_seasonal_utm50n.geojson` 与仿真中的 `Z12_RIVER_WALK_23M` 层，源数据标高为 `16.0m`，
现场尚未核实究竟是 `16.0m` 还是 `23.0m`（状态 `unverified_16m_vs_23m`）。本数据集按
`SKYGUARD_LOWEST_TIER=seasonal`（秋季低水位季节性开放）纳入，其中：

- 该层可通行面积计入 `summary.json` 的 `total_walkable_area_m2`；
- 另有 `RW-LINK-S / M / N` 三处 25.0m↔23.0m 连接，是**情景假设**而非源数据实测台阶；
- `map-v2/hankou_full_connectivity_audit.md` 的 `active_baseline` 口径下该层保持封控（0% 可达）。

需要与核验报告的保守口径对齐时，用 `SKYGUARD_LOWEST_TIER=closed` 重跑：
此时 16.0m 面不栅格化、不生成 `RW-LINK-*`、`RW_*` 锚点整体移除，`summary.json` 会同步给出
`total_walkable_area_m2_excluding_lowest_tier` 与 `lowest_tier_provenance`。

## 快速查看与联调

1. **看视频与交互页**：直接打开 `demos/sanyang_24h_sat_topo_demo.webm` 或用 Chrome/Edge 打开 `demos/sanyang_sat_topo_replay.html`。
2. **看地图对接契约**：阅读 `map-v2/队友对接说明.md` 与 `map-v2/teammate_gate_alignment.json`。
3. **看数据字段样例**：直接查看 `crowd-sim/samples/` 下的 CSV/JSONL 样例；如需全量 24h 数据，从上方 Release 地址下载，或按下节顺序重跑脚本。

## 复现（脚本顺序与环境变量）

所有路径相对本目录定位，不再依赖作者机器上的绝对目录；输出默认写到 `out/`（约 3.5 GB，不入库）。

| 顺序 | 脚本 | 依赖 | 主要产出 |
| ---: | :--- | :--- | :--- |
| 1 | `crowd-sim/build_sanyang_crowd_sim.py` | `map-v2/` 底图 | 24h 轨迹、5s 分区/机位统计、两个 1Hz 切片、`summary.json`、图与 `sanyang_crowd_replay.html` |
| 2 | `crowd-sim/build_camera_observed_view.py` | 顺序 1 | `camera_observed_fused_*`、`camera_observed_replay_payload.json`、`sanyang_camera_observed_replay.html` |
| 3 | `crowd-sim/build_sat_topo_view.py` | 顺序 2 + z18 卫星图 | `sanyang_sat_topo_showcase.png`、`sanyang_sat_topo_terrain_replay.html` |
| 4 | `crowd-sim/build_flowing_sat_topo.py` | 顺序 2 + z18 卫星图 | `sanyang_sat_topo_replay.html`（即 `demos/` 中分发的那份） |
| 5 | `crowd-sim/export_sat_topo_video.py` | 顺序 1、2 + z18 卫星图 + GStreamer | `sanyang_24h_sat_topo_demo.webm` |

| 环境变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `SKYGUARD_SIM_OUT` | `<本目录>/out` | 输出目录 |
| `SKYGUARD_LOWEST_TIER` | `seasonal` | 最低亲水层策略：`seasonal` / `closed` |
| `SKYGUARD_SAT_DIR` | `<本目录>/map-v2/satellite` | z18 卫星底图目录 |
| `SKYGUARD_FONT_CJK` / `SKYGUARD_FONT_LATIN` | 按平台探测 | 图表字体（缺失时退化为 Pillow 默认字体，中文会显示为方块） |

> **z18 卫星底图（`sanyang_sat_z18.jpg` / `sanyang_sat_z18.json`）不随仓库分发**，顺序 3/4/5 需要它；
> 缺失时脚本会直接报错并给出放置路径。顺序 1、2 不依赖卫星图。脚本间不存在隐式产物依赖：
> 顺序 3 读取的是顺序 2 写出的 `camera_observed_replay_payload.json`，而不是解析 HTML。
