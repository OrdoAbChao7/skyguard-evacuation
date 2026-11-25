# SkyGuard · 汉口江滩四级高程地图 V2 与三阳广场 24h 纯流动人流模拟（2026-11-25 交付）

本目录为 `gpt-6` 组于 **2026-11-25** 新增的独立交付包（与既有 `gpt-6/head-optimization/` 严格分离），面向主系统地图接入、28 机位视野仿真与下游人流预测/疏散联调。

> **完整 24 小时原始模拟大表（CSV / JSONL，约 3.5 GB 原始文本，压缩包 764 MB）统一托管在 GitHub Release**：
> <https://github.com/imsquner/skyguard-vision/releases/tag/v2026.11.25-sanyang-crowd-sim>
> 本仓库仅收录轻量化核心地图、28 机位配置、可复现脚本、字段样例、离线交互回放页及 30 秒成型演示视频（合计约 35 MB）。

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
- 28 机位真实感知过滤：盲区不生成点位，重叠视场去重，走出盲区 >6s 断轨重编 `obs_track_id`（菊花会 15min 跨镜流动轨迹 `31,554` 条，晚饭后 15min `45,967` 条）

## 快速查看与联调

1. **看视频与交互页**：直接打开 `demos/sanyang_24h_sat_topo_demo.webm` 或用 Chrome/Edge 打开 `demos/sanyang_sat_topo_replay.html`。
2. **看地图对接契约**：阅读 `map-v2/队友对接说明.md` 与 `map-v2/teammate_gate_alignment.json`。
3. **看数据字段样例**：直接查看 `crowd-sim/samples/` 下的 CSV/JSONL 样例；如需全量 24h 数据，从上方 Release 地址下载，或直接运行 `crowd-sim/` 中的脚本一键复现。
