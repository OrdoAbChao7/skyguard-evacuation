#!/usr/bin/env python3
"""
SkyGuard · 汉口江滩三阳核心演示段（G07–G09）24 小时人流与 28 机位模拟数据生成器
================================================================================
基于 V2.1 四级高程底图（31.0m / 28.8m / 25.0m，以及源数据标 16.0m、现场尚未核实的
最低亲水层，按 23.0m RIVER_WALK 季节性开放，状态 `unverified_16m_vs_23m`）与清洗后的
28 台虚拟摄像头（27 固定 + 1 UAV-01），生成符合汉口江滩日常时间规律并叠加
「三阳广场金秋菊花会」下午大客流情景的 24 小时个体级（带全局唯一 person_id）
模拟人流数据集、5 秒区域统计、28 机位观测统计、两个 15 分钟 1Hz 高峰精细切片，
以及静态验收图与离线 HTML5 交互回放页。

纯 Python 3.10 + Pillow 实现，零第三方科学计算依赖，固定随机种子可完全复现。

运行方式（所有路径相对本文件定位，不再依赖作者机器上的绝对目录）：
    python crowd-sim/build_sanyang_crowd_sim.py
输出目录默认 `<package>/out/`，可用环境变量 `SKYGUARD_SIM_OUT` 覆盖。
"""
from __future__ import annotations

import array
import bisect
import csv
import heapq
import json
import math
import os
import random
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# 路径与全局配置
# ---------------------------------------------------------------------------
# 全部路径相对本文件定位：PACKAGE_DIR = <repo>/gpt-6/sanyang-map-and-crowd-sim
# 输入底图随仓库分发在 map-v2/；输出默认落在 out/（全量约 3.5 GB，不入库，可用环境变量覆盖）。
PACKAGE_DIR = Path(__file__).resolve().parents[1]
MAP_V2_DIR = PACKAGE_DIR / "map-v2"
OUT_DIR = Path(os.environ.get("SKYGUARD_SIM_OUT", PACKAGE_DIR / "out")).resolve()

UTM_GEOJSON = MAP_V2_DIR / "hankou_full_4tier_utm50n.geojson"
RIVERWALK_GEOJSON = MAP_V2_DIR / "river_walk_seasonal_utm50n.geojson"
CAMERAS_JSON = MAP_V2_DIR / "sanyang_cameras_v1.json"

# 中文字体按平台候选，可用 SKYGUARD_FONT_CJK / SKYGUARD_FONT_LATIN 覆盖；
# 全部缺失时退化为 Pillow 默认字体（图表不会崩，但中文会显示为方块）。
FONT_CANDIDATES = (
    os.environ.get("SKYGUARD_FONT_CJK", ""),
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "/System/Library/Fonts/PingFang.ttc",
)
FONT_PATH = next((p for p in FONT_CANDIDATES if p and Path(p).is_file()), "")
LATIN_FONT_CANDIDATES = (
    os.environ.get("SKYGUARD_FONT_LATIN", ""),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
)
LATIN_FONT_PATH = next((p for p in LATIN_FONT_CANDIDATES if p and Path(p).is_file()), "")


def check_inputs() -> None:
    """缺失输入底图时给出可执行的提示，而不是裸的 FileNotFoundError。"""
    missing = [p for p in (UTM_GEOJSON, RIVERWALK_GEOJSON, CAMERAS_JSON) if not p.is_file()]
    if missing:
        raise SystemExit(
            "缺少输入底图：\n  " + "\n  ".join(str(p) for p in missing)
            + f"\n请在仓库内运行（{PACKAGE_DIR / 'map-v2'} 应存在）。"
        )

SEED = 20261115
SIM_DATE_STR = "2026-11-15"  # 模拟日期（北京时间，金秋菊花会周末）
BJ_TZ = timezone(timedelta(hours=8))
DAY_SECONDS = 86400

# 局部网格配置（与 build_sanyang_focus_v2_riverwalk.py 完全同源）
CELL_M = 2.0
X_MIN_LOC, X_MAX_LOC = -204.0, 176.0  # 380 m -> 190 cols
Y_MIN_LOC, Y_MAX_LOC = -414.0, 376.0  # 790 m -> 395 rows
GRID_W = int(round((X_MAX_LOC - X_MIN_LOC) / CELL_M))
GRID_H = int(round((Y_MAX_LOC - Y_MIN_LOC) / CELL_M))

TIERS = (31.0, 28.8, 25.0, 23.0)
TIER_TO_IDX = {t: i for i, t in enumerate(TIERS)}

# 最低亲水层（源 GeoJSON 标 16.0m，现场尚未核实究竟是 16.0m 还是 23.0m）：
#   seasonal（默认）= 按「秋季低水位季节性开放」纳入 23.0m 滨江亲水步道，并在 summary/README 标注 unverified；
#   closed         = 与 map-v2/hankou_full_connectivity_audit.md 的 active_baseline 一致，封控不纳入可通行面。
# 该层不是已核验数据，任何引用本数据集的下游都必须保留 provenance 标注。
LOWEST_TIER_POLICY = os.environ.get("SKYGUARD_LOWEST_TIER", "seasonal").strip().lower()
if LOWEST_TIER_POLICY not in ("seasonal", "closed"):
    raise SystemExit(f"SKYGUARD_LOWEST_TIER 只接受 seasonal | closed，收到 {LOWEST_TIER_POLICY!r}")
LOWEST_TIER_ENABLED = LOWEST_TIER_POLICY == "seasonal"
LOWEST_TIER_STATUS = "unverified_16m_vs_23m"
LOWEST_TIER_SOURCE_ELEV_M = 16.0
LOWEST_TIER_DECLARED_ELEV_M = 23.0
LOWEST_TIER_LINKS = ("RW-LINK-S", "RW-LINK-M", "RW-LINK-N")

# 观测断轨阈值（秒）。三条数据流的采样间隔不同，阈值按「允许丢失的采样帧数」定义，
# 全部集中在这里，不再散落成各处魔法数字：
#   单机位局部 track_id_local（5s 采样） → 8s，允许丢 1 帧
#   1Hz 跨机位融合 track（1s 采样）      → 6s，允许丢 6 帧
#   24h 融合 track（30s 采样）           → 35s，允许丢 1 帧
TRACK_GAP_LOCAL_CAM_S = 8.0
TRACK_GAP_FUSED_1HZ_S = 6.0
TRACK_GAP_FUSED_24H_S = 35.0

# 两个 15 分钟 1Hz 精细切片（北京时间秒数）
PEAK_WINDOWS = {
    "chrysanthemum": {
        "label": "菊花会下午高峰",
        "start_s": 15 * 3600 + 30 * 60,  # 15:30:00
        "end_s": 15 * 3600 + 45 * 60,    # 15:45:00
    },
    "evening": {
        "label": "晚饭后全天最高峰",
        "start_s": 19 * 3600 + 30 * 60,  # 19:30:00
        "end_s": 19 * 3600 + 45 * 60,    # 19:45:00
    },
}

ZONES_META = [
    ("Z01_G09_GATE", "三阳门闸口区", 31.0),
    ("Z02_G08_GATE", "防洪纪念碑闸口区", 31.0),
    ("Z03_G07_GATE", "一元门闸口区", 31.0),
    ("Z04_SANYANG_ENTRY_PLAZA", "三阳门入口大道与北广场", 28.8),
    ("Z05_CHRYSANTHEMUM_MAIN", "三阳广场中心主展区(菊花会核心)", 28.8),
    ("Z06_MONUMENT_GARDEN", "防洪纪念碑林荫游园区", 28.8),
    ("Z07_YIYUAN_PLAZA", "一元门南广场", 28.8),
    ("Z08_GREENWAY_CORRIDOR", "一级平台沿江绿道主干", 28.8),
    ("Z09_TIER2_NORTH_PLAZA", "二级平台三阳亲水大平台", 25.0),
    ("Z10_TIER2_PROMENADE", "二级平台中段沿江步道", 25.0),
    ("Z11_TIER2_SOUTH_PLAZA", "二级平台一元门观景台", 25.0),
    ("Z12_RIVER_WALK_23M", "三级滨江亲水步道(RIVER_WALK)", 23.0),
]
ZONE_ID_TO_IDX = {z[0]: i for i, z in enumerate(ZONES_META)}


def fallback_zone_idx(tier_idx: int) -> int:
    """格点没有语义分区时的按层回落分区（全天统计与 1Hz 切片共用，避免两套口径）。"""
    return 3 if tier_idx == 1 else (9 if tier_idx == 2 else (11 if tier_idx == 3 else 0))


def _largest_component_masks(walkable: list[bytearray], vlinks) -> list[bytearray]:
    """在「同层 8 邻域 + 竖向连接」构成的导航图上求最大连通块，返回每层的 0/1 掩码。

    不能只按单层判断连通性：G09/G08/G07 闸口平台只通过竖向连接接入主区，
    单独看某一层会把整片闸口误判成孤岛。
    """
    total = GRID_W * GRID_H
    ids = []
    node_cell = []
    for ti, w in enumerate(walkable):
        arr = array.array("i", [-1]) * total
        for c in range(total):
            if w[c]:
                arr[c] = len(node_cell)
                node_cell.append((ti, c))
        ids.append(arr)

    parent = array.array("i", range(len(node_cell)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    # 8 邻域只需检查 E / SW / S / SE 四个方向，对称性覆盖全部邻接
    for ti in range(len(walkable)):
        arr = ids[ti]
        for c in range(total):
            u = arr[c]
            if u < 0:
                continue
            cy, cx = divmod(c, GRID_W)
            for dx_, dy_ in ((1, 0), (-1, 1), (0, 1), (1, 1)):
                nx, ny = cx + dx_, cy + dy_
                if 0 <= nx < GRID_W and 0 <= ny < GRID_H:
                    v = arr[ny * GRID_W + nx]
                    if v >= 0:
                        union(u, v)

    for t1, g1, t2, g2, _cost, _name in vlinks:
        u = ids[t1][g1[1] * GRID_W + g1[0]]
        v = ids[t2][g2[1] * GRID_W + g2[0]]
        if u >= 0 and v >= 0:
            union(u, v)

    sizes: dict[int, int] = defaultdict(int)
    for i in range(len(node_cell)):
        sizes[find(i)] += 1
    best_root = max(sizes, key=sizes.get)

    masks = [bytearray(total) for _ in walkable]
    for i, (ti, c) in enumerate(node_cell):
        if find(i) == best_root:
            masks[ti][c] = 1
    return masks


# ---------------------------------------------------------------------------
# 坐标转换工具（EPSG:32650 UTM 50N <-> 局部米制 <-> WGS84）
# ---------------------------------------------------------------------------
def utm50n_to_wgs84(x: float, y: float) -> tuple[float, float]:
    a = 6378137.0
    e2 = 0.00669437999014
    e1 = (1.0 - math.sqrt(1.0 - e2)) / (1.0 + math.sqrt(1.0 - e2))
    k0 = 0.9996
    lon0 = math.radians(117.0)
    x0 = x - 500000.0
    M = y / k0
    mu = M / (a * (1.0 - e2 / 4.0 - 3.0 * e2 * e2 / 64.0 - 5.0 * e2 ** 3 / 256.0))
    phi1 = (
        mu
        + (3.0 * e1 / 2.0 - 27.0 * e1 ** 3 / 32.0) * math.sin(2.0 * mu)
        + (21.0 * e1 ** 2 / 16.0 - 55.0 * e1 ** 4 / 32.0) * math.sin(4.0 * mu)
        + (151.0 * e1 ** 3 / 96.0) * math.sin(6.0 * mu)
        + (1097.0 * e1 ** 4 / 512.0) * math.sin(8.0 * mu)
    )
    ep2 = e2 / (1.0 - e2)
    sinp, cosp, tanp = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    N1 = a / math.sqrt(1.0 - e2 * sinp * sinp)
    T1 = tanp * tanp
    C1 = ep2 * cosp * cosp
    R1 = a * (1.0 - e2) / ((1.0 - e2 * sinp * sinp) ** 1.5)
    D = x0 / (N1 * k0)
    lat = phi1 - (N1 * tanp / R1) * (
        D * D / 2.0
        - (5.0 + 3.0 * T1 + 10.0 * C1 - 4.0 * C1 * C1 - 9.0 * ep2) * D ** 4 / 24.0
        + (61.0 + 90.0 * T1 + 298.0 * C1 + 45.0 * T1 * T1 - 252.0 * ep2 - 3.0 * C1 * C1) * D ** 6 / 720.0
    )
    lon = lon0 + (
        D
        - (1.0 + 2.0 * T1 + C1) * D ** 3 / 6.0
        + (5.0 - 2.0 * C1 + 28.0 * T1 - 3.0 * C1 * C1 + 8.0 * ep2 + 24.0 * T1 * T1) * D ** 5 / 120.0
    ) / cosp
    return math.degrees(lon), math.degrees(lat)


class LocalFrame:
    def __init__(self, origin: tuple[float, float], u_north: tuple[float, float], v_east: tuple[float, float]):
        self.ox, self.oy = origin
        self.ux, self.uy = u_north
        self.vx, self.vy = v_east

    def to_local(self, x: float, y: float) -> tuple[float, float]:
        dx, dy = x - self.ox, y - self.oy
        return (dx * self.vx + dy * self.vy, dx * self.ux + dy * self.uy)

    def to_utm(self, lx: float, ly: float) -> tuple[float, float]:
        return (self.ox + lx * self.vx + ly * self.ux, self.oy + lx * self.vy + ly * self.uy)


def loc_to_grid(lx: float, ly: float) -> tuple[int, int]:
    gx = int((lx - X_MIN_LOC) / CELL_M)
    gy = int((ly - Y_MIN_LOC) / CELL_M)
    return gx, gy


def grid_to_loc(gx: int, gy: int) -> tuple[float, float]:
    return (X_MIN_LOC + (gx + 0.5) * CELL_M, Y_MIN_LOC + (gy + 0.5) * CELL_M)


def format_bj_iso(sec: int) -> str:
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{SIM_DATE_STR}T{h:02d}:{m:02d}:{s:02d}+08:00"


def format_utc_iso(sec: int) -> str:
    dt_bj = datetime(2026, 11, 15, 0, 0, 0, tzinfo=BJ_TZ) + timedelta(seconds=sec)
    return dt_bj.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# 1. 加载底图、栅格化四级可通行面、构建 12 分区与 28 机位视场查找表
# ---------------------------------------------------------------------------
def rasterize_geojson_geom(draw: ImageDraw.ImageDraw, geom: dict, frame: LocalFrame, fill_val: int = 1) -> None:
    gtype = geom["type"]
    polys = [geom["coordinates"]] if gtype == "Polygon" else (geom["coordinates"] if gtype == "MultiPolygon" else [])
    for poly in polys:
        if not poly:
            continue
        ext = [loc_to_grid(*frame.to_local(c[0], c[1])) for c in poly[0]]
        if len(ext) >= 3:
            draw.polygon(ext, fill=fill_val)
        for hole in poly[1:]:
            hpts = [loc_to_grid(*frame.to_local(c[0], c[1])) for c in hole]
            if len(hpts) >= 3:
                draw.polygon(hpts, fill=0)


def build_environment():
    t0 = time.time()
    check_inputs()
    gj = json.loads(UTM_GEOJSON.read_text(encoding="utf-8"))
    feats = gj["features"]

    # 提取 G07/G08/G09 与绿道主轴，重建与底图完全一致的局部坐标系
    gates_utm = {}
    for ft in feats:
        p = ft["properties"]
        if p.get("class") == "gate_exit" and p.get("id") in ("G07", "G08", "G09"):
            gates_utm[p["id"]] = ft["geometry"]["coordinates"]

    ys = sorted(c[1] for c in gates_utm.values())
    y_min_g, y_max_g = ys[0] - 100.0, ys[-1] + 100.0
    gw_pts = []
    for ft in feats:
        p = ft["properties"]
        if p.get("class") == "flat_corridor_centerline" and p.get("kind") == "cycleway":
            g = ft["geometry"]
            lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
            for ln in lines:
                for c in ln:
                    if y_min_g <= c[1] <= y_max_g:
                        gw_pts.append(c)
    gw_pts.sort(key=lambda c: c[1])
    p_s, p_n = gw_pts[0], gw_pts[-1]
    dx, dy = p_n[0] - p_s[0], p_n[1] - p_s[1]
    norm = math.hypot(dx, dy)
    u_north = (dx / norm, dy / norm)
    v_east = (u_north[1], -u_north[0])
    origin = (0.5 * (p_s[0] + p_n[0]), 0.5 * (p_s[1] + p_n[1]))
    frame = LocalFrame(origin, u_north, v_east)

    gates_loc = {gid: frame.to_local(*c) for gid, c in gates_utm.items()}
    y_cut_s = gates_loc["G07"][1] - 110.0  # ~ -406.8
    y_cut_n = gates_loc["G09"][1] + 135.0  # ~ +363.5

    # 栅格化可通行面（31.0 / 28.8 / 25.0 / 23.0）
    # 源 GeoJSON 里最低层标 elevation_m=16.0；本数据集按 LOWEST_TIER_POLICY 决定是否
    # 以 23.0m 名义开放（seasonal）还是保持封控（closed），两种情形都保留原始高程记录。
    tier_imgs = {t: Image.new("L", (GRID_W, GRID_H), 0) for t in TIERS}
    tier_draws = {t: ImageDraw.Draw(img) for t, img in tier_imgs.items()}

    for ft in feats:
        p = ft["properties"]
        cls = p.get("class")
        if cls in ("plaza", "flat_corridor_area"):
            elev = float(p["elevation_m"])
            target_t = LOWEST_TIER_DECLARED_ELEV_M if elev == LOWEST_TIER_SOURCE_ELEV_M else elev
            if target_t == LOWEST_TIER_DECLARED_ELEV_M and not LOWEST_TIER_ENABLED:
                continue
            if target_t in tier_draws:
                rasterize_geojson_geom(tier_draws[target_t], ft["geometry"], frame, 1)

    # 叠加 23.0m 季节性滨江亲水步道 RIVER_WALK（仅在最低层开放时纳入）
    if LOWEST_TIER_ENABLED:
        rw_gj = json.loads(RIVERWALK_GEOJSON.read_text(encoding="utf-8"))
        for ft in rw_gj["features"]:
            if ft["properties"].get("geometry_role") == "walkable_strip":
                rasterize_geojson_geom(tier_draws[23.0], ft["geometry"], frame, 1)

    # 裁剪至三阳核心段 [y_cut_s, y_cut_n]
    gy_s = max(0, int((y_cut_s - Y_MIN_LOC) / CELL_M))
    gy_n = min(GRID_H - 1, int((y_cut_n - Y_MIN_LOC) / CELL_M))

    walkable = []  # walkable[t_idx][gy * GRID_W + gx] -> 0 or 1
    for t in TIERS:
        raw = bytearray(tier_imgs[t].tobytes())
        for gy in range(GRID_H):
            if gy < gy_s or gy > gy_n:
                off = gy * GRID_W
                for gx in range(GRID_W):
                    raw[off + gx] = 0
        walkable.append(raw)

    # 确保三个闸口和南北交换断面处有连通入口像素
    for gid, (lx, ly) in gates_loc.items():
        gx, gy = loc_to_grid(lx, ly)
        for ox in range(-2, 3):
            for oy in range(-2, 3):
                nx, ny = gx + ox, gy + oy
                if 0 <= nx < GRID_W and gy_s <= ny <= gy_n:
                    walkable[0][ny * GRID_W + nx] = 1

    # 提取竖向连接器（坡道与台阶）
    vertical_links = []  # list of (t1, (gx1,gy1), t2, (gx2,gy2), cost, name)
    for ft in feats:
        p = ft["properties"]
        cls = p.get("class")
        if cls in ("stairs", "ramp"):
            coords = ft["geometry"]["coordinates"]
            lpts = [frame.to_local(c[0], c[1]) for c in coords]
            if not any(y_cut_s <= lp[1] <= y_cut_n and X_MIN_LOC <= lp[0] <= X_MAX_LOC for lp in lpts):
                continue
            vid = p["id"]
            if cls == "ramp" and vid in ("RM-G07", "RM-G08", "RM-G09"):
                # 31.0m <-> 28.8m
                p0, p1 = lpts[0], lpts[-1]
                # 靠西侧（x 更小）在 31.0m，靠东侧在 28.8m
                if p0[0] > p1[0]:
                    p0, p1 = p1, p0
                vertical_links.append((0, loc_to_grid(*p0), 1, loc_to_grid(*p1), 12.0, vid))
            elif cls == "stairs" and vid in ("ST-03", "ST-04", "ST-11", "ST-12", "ST-13"):
                # 28.8m <-> 25.0m
                p0, p1 = lpts[0], lpts[-1]
                if p0[0] > p1[0]:
                    p0, p1 = p1, p0
                vertical_links.append((1, loc_to_grid(*p0), 2, loc_to_grid(*p1), 10.0, vid))

    # 25.0m <-> 23.0m 季节性低水位连接：南/中/北三处，仅在最低亲水层开放时生成。
    # 注意：这三处连接不是源 GeoJSON 里的实测台阶，是「秋季低水位可通行」情景假设，
    # 与 map-v2/hankou_full_connectivity_audit.md 中 ST-SY 保持关闭的保守口径不同，
    # 因此只在 LOWEST_TIER_POLICY=seasonal 时启用，并在 summary.json 里如实标注。
    if LOWEST_TIER_ENABLED:
        for name, ly in zip(LOWEST_TIER_LINKS, (-292.0, -125.0, 228.0)):
            # 在该 y 处寻找 25.0m 最东侧可通行格与 23.0m 最西侧可通行格
            gy = int((ly - Y_MIN_LOC) / CELL_M)
            g25 = None
            g23 = None
            for gx in range(GRID_W - 1, -1, -1):
                if walkable[2][gy * GRID_W + gx]:
                    g25 = (gx, gy)
                    break
            for gx in range(GRID_W):
                if walkable[3][gy * GRID_W + gx]:
                    g23 = (gx, gy)
                    break
            if g25 and g23:
                vertical_links.append((2, g25, 3, g23, 14.0, name))

    # 辅助：寻找指定层最近的可通行格（mask 非空时只接受掩码内的格点）
    def snap_walkable(t_idx: int, gx: int, gy: int, max_r: int = 12, mask: bytearray | None = None) -> tuple[int, int]:
        w = walkable[t_idx]

        def ok(nx: int, ny: int) -> bool:
            if not (0 <= nx < GRID_W and 0 <= ny < GRID_H):
                return False
            c = ny * GRID_W + nx
            return bool(w[c]) and (mask is None or bool(mask[c]))

        if ok(gx, gy):
            return gx, gy
        for r in range(1, max_r + 1):
            for dx_ in range(-r, r + 1):
                for dy_ in (-r, r):
                    nx, ny = gx + dx_, gy + dy_
                    if ok(nx, ny):
                        return nx, ny
            for dy_ in range(-r + 1, r):
                for dx_ in (-r, r):
                    nx, ny = gx + dx_, gy + dy_
                    if ok(nx, ny):
                        return nx, ny
        raise RuntimeError(f"Cannot snap walkable cell at tier {t_idx} ({gx},{gy})")

    snapped_vlinks = []
    for t1, g1, t2, g2, cost, name in vertical_links:
        s1 = snap_walkable(t1, g1[0], g1[1], 14)
        s2 = snap_walkable(t2, g2[0], g2[1], 14)
        snapped_vlinks.append((t1, s1, t2, s2, cost, name))

    # 为每个可通行格分配语义分区（12 分区）
    def classify_zone(t_idx: int, lx: float, ly: float) -> int:
        if t_idx == 0:  # 31.0m
            if ly > 100.0:
                return ZONE_ID_TO_IDX["Z01_G09_GATE"]
            if ly > -150.0:
                return ZONE_ID_TO_IDX["Z02_G08_GATE"]
            return ZONE_ID_TO_IDX["Z03_G07_GATE"]
        if t_idx == 1:  # 28.8m
            if ly >= 165.0 and lx <= -8.0:
                return ZONE_ID_TO_IDX["Z04_SANYANG_ENTRY_PLAZA"]
            if -235.0 <= ly <= -55.0 and lx <= -6.0:
                return ZONE_ID_TO_IDX["Z05_CHRYSANTHEMUM_MAIN"]
            if -55.0 < ly < 165.0 and lx <= -14.0:
                return ZONE_ID_TO_IDX["Z06_MONUMENT_GARDEN"]
            if ly < -235.0 and lx <= -8.0:
                return ZONE_ID_TO_IDX["Z07_YIYUAN_PLAZA"]
            return ZONE_ID_TO_IDX["Z08_GREENWAY_CORRIDOR"]
        if t_idx == 2:  # 25.0m
            if ly >= 135.0:
                return ZONE_ID_TO_IDX["Z09_TIER2_NORTH_PLAZA"]
            if ly <= -235.0:
                return ZONE_ID_TO_IDX["Z11_TIER2_SOUTH_PLAZA"]
            return ZONE_ID_TO_IDX["Z10_TIER2_PROMENADE"]
        return ZONE_ID_TO_IDX["Z12_RIVER_WALK_23M"]

    zone_grid = [bytearray(GRID_W * GRID_H) for _ in TIERS]
    zone_areas = [0.0] * len(ZONES_META)
    for t_idx in range(len(TIERS)):
        w = walkable[t_idx]
        zg = zone_grid[t_idx]
        for gy in range(GRID_H):
            ly = Y_MIN_LOC + (gy + 0.5) * CELL_M
            off = gy * GRID_W
            for gx in range(GRID_W):
                if w[off + gx]:
                    lx = X_MIN_LOC + (gx + 0.5) * CELL_M
                    zid = classify_zone(t_idx, lx, ly)
                    zg[off + gx] = zid + 1  # 1-based, 0 = non-walkable
                    zone_areas[zid] += CELL_M * CELL_M

    # 加载 28 台虚拟摄像头并栅格化其 FOV 多边形
    cam_doc = json.loads(CAMERAS_JSON.read_text(encoding="utf-8"))
    cameras = cam_doc["cameras"]
    # cell_cams[t_idx][cell_idx] -> tuple of camera indices covering this walkable cell
    cell_cams_tmp = [[[] for _ in range(GRID_W * GRID_H)] for _ in TIERS]
    cam_visible_area = [0.0] * len(cameras)

    for ci, cam in enumerate(cameras):
        fov_img = Image.new("L", (GRID_W, GRID_H), 0)
        fdraw = ImageDraw.Draw(fov_img)
        poly_pts = [loc_to_grid(*frame.to_local(p[0], p[1])) for p in cam["fov_polygon_utm50n"]]
        if len(poly_pts) >= 3:
            fdraw.polygon(poly_pts, fill=1)
        fbytes = fov_img.tobytes()

        # 确定该摄像头可见的高程层
        ctier = float(cam["elevation_tier_m"])
        ctype = cam["camera_type"]
        if ctype == "uav_mobile":
            vis_tiers = [0, 1, 2, 3]
        elif cam["camera_id"] == "CAM-05":
            vis_tiers = [2, 3]  # 25.0m 俯看 25.0m + 23.0m
        elif ctier == 31.0:
            vis_tiers = [0, 1]  # 门区枪机可看闸口 31m 及紧邻入口坡道 28.8m
        elif ctier == 28.8:
            vis_tiers = [1]
        elif ctier == 25.0:
            vis_tiers = [2]
        else:
            vis_tiers = [3]

        vis_cells = 0
        for ti in vis_tiers:
            w = walkable[ti]
            ct_list = cell_cams_tmp[ti]
            for idx in range(GRID_W * GRID_H):
                if w[idx] and fbytes[idx]:
                    ct_list[idx].append(ci)
                    vis_cells += 1
        cam_visible_area[ci] = vis_cells * CELL_M * CELL_M

    # 转为不可变 tuple 以加速查表
    cell_cams = [[tuple(x) for x in layer] for layer in cell_cams_tmp]

    lowest_tier_area = zone_areas[ZONE_ID_TO_IDX["Z12_RIVER_WALK_23M"]]
    lowest_tier_provenance = {
        "zone_id": "Z12_RIVER_WALK_23M",
        "declared_elevation_m": LOWEST_TIER_DECLARED_ELEV_M,
        "source_elevation_m": LOWEST_TIER_SOURCE_ELEV_M,
        "status": LOWEST_TIER_STATUS,
        "policy": LOWEST_TIER_POLICY,
        "included": LOWEST_TIER_ENABLED,
        "walkable_area_m2": round(lowest_tier_area, 1),
        "vertical_links": [n for n in LOWEST_TIER_LINKS
                           if any(v[5] == n for v in snapped_vlinks)],
        "note": (
            "最低亲水层现场尚未核实 16.0m/23.0m 两个标高，"
            "map-v2/hankou_full_connectivity_audit.md 的 active_baseline 中保持封控；"
            "本数据集按 seasonal 情景纳入，引用时必须保留该 provenance。"
        ),
    }

    print(
        f"[Env] Grid {GRID_W}x{GRID_H} ({CELL_M}m) built in {time.time() - t0:.2f}s | "
        f"Total walkable={sum(zone_areas):.0f} m2 | Vertical links={len(snapped_vlinks)} | "
        f"Lowest tier={LOWEST_TIER_POLICY} ({lowest_tier_area:.0f} m2, {LOWEST_TIER_STATUS})"
    )
    return {
        "frame": frame,
        "gates_loc": gates_loc,
        "y_cut_s": y_cut_s,
        "y_cut_n": y_cut_n,
        "walkable": walkable,
        "zone_grid": zone_grid,
        "zone_areas": zone_areas,
        "vlinks": snapped_vlinks,
        "cameras": cameras,
        "cell_cams": cell_cams,
        "cam_visible_area": cam_visible_area,
        "snap_walkable": snap_walkable,
        "lowest_tier": lowest_tier_provenance,
    }


# ---------------------------------------------------------------------------
# 2. 多层导航图与预计算锚点最短路
# ---------------------------------------------------------------------------
def build_navigation(env: dict):
    t0 = time.time()
    walkable = env["walkable"]
    snap = env["snap_walkable"]
    gates = env["gates_loc"]

    # 定义 5 个出入口 + 15 个场内 POI 锚点（含菊花会 5 大主题花坛/展位）
    anchors_def = {
        # 出入口
        "G09": (0, gates["G09"][0], gates["G09"][1]),
        "G08": (0, gates["G08"][0], gates["G08"][1]),
        "G07": (0, gates["G07"][0], gates["G07"][1]),
        "SEC_N": (1, -10.0, env["y_cut_n"] - 8.0),
        "SEC_S": (1, -10.0, env["y_cut_s"] + 8.0),
        # 28.8m 菊花会核心主展区（三阳中心主广场，布设 4 组展区打卡点）
        "FLOWER_CENTER": (1, -65.0, -140.0),
        "FLOWER_NORTH": (1, -50.0, -85.0),
        "FLOWER_WEST": (1, -118.0, -135.0),
        "FLOWER_SOUTH": (1, -45.0, -195.0),
        # 28.8m 三阳门入口迎宾花坛 & 防洪纪念碑林荫区 & 一元门广场 & 绿道
        "SANYANG_ENTRY": (1, -85.0, 228.0),
        "SANYANG_NORTH_GW": (1, -14.0, 230.0),
        "MONUMENT_PLAZA": (1, -100.0, 10.0),
        "MONUMENT_GARDEN": (1, -78.0, 88.0),
        "YIYUAN_PLAZA": (1, -70.0, -295.0),
        "GREENWAY_MID": (1, -12.0, -15.0),
        # 25.0m 二级平台（三阳亲水大平台、中段步道、一元门观景台）
        "T2_NORTH_PLAZA": (2, 75.0, 228.0),
        "T2_PROM_NORTH": (2, 34.0, 95.0),
        "T2_PROM_MID": (2, 34.0, -75.0),
        "T2_SOUTH_PLAZA": (2, 65.0, -292.0),
        # 23.0m 滨江亲水步道 RIVER_WALK（仅在最低亲水层开放时可用）
        "RW_NORTH": (3, 145.0, 210.0),
        "RW_MID": (3, 142.0, -50.0),
        "RW_SOUTH": (3, 140.0, -275.0),
    }
    if not LOWEST_TIER_ENABLED:
        for name in ("RW_NORTH", "RW_MID", "RW_SOUTH"):
            anchors_def.pop(name, None)

    anchors = {}
    for name, (ti, lx, ly) in anchors_def.items():
        gx, gy = snap(ti, *loc_to_grid(lx, ly), max_r=16)
        anchors[name] = (ti, gx, gy)

    # 吸附可能把锚点落到孤立的可通行小岛上（MONUMENT_PLAZA 曾落到 1 格孤岛），
    # 这会让所有进出该锚点的路径在 Dijkstra 里静默缺失、行人在 append_leg 里瞬移。
    # 这里把不在主连通块上的锚点重新吸附到同层主连通块的最近格点。
    main_comp = _largest_component_masks(walkable, env["vlinks"])
    resnapped = []
    for name, (ti, gx, gy) in list(anchors.items()):
        if main_comp[ti][gy * GRID_W + gx]:
            continue
        nx, ny = snap(ti, gx, gy, max_r=24, mask=main_comp[ti])
        resnapped.append(f"{name}({gx},{gy})->({nx},{ny})")
        anchors[name] = (ti, nx, ny)
    if resnapped:
        print(f"[Nav] 锚点落在孤立小岛，已重新吸附到主连通块: {', '.join(resnapped)}")

    # 建竖向邻接表
    vadj = defaultdict(list)
    for t1, (gx1, gy1), t2, (gx2, gy2), cost, _ in env["vlinks"]:
        k1 = (t1, gy1 * GRID_W + gx1)
        k2 = (t2, gy2 * GRID_W + gx2)
        vadj[k1].append((k2, cost))
        vadj[k2].append((k1, cost))

    # 8 邻域偏移
    DIRS = (
        (-1, 0, 2.0), (1, 0, 2.0), (0, -1, 2.0), (0, 1, 2.0),
        (-1, -1, 2.8284), (1, -1, 2.8284), (-1, 1, 2.8284), (1, 1, 2.8284),
    )

    # 预计算所有锚点对之间的最短路（按需从每个锚点跑一次 Dijkstra，共 22 次）
    anchor_names = list(anchors.keys())
    paths = {}  # paths[(a, b)] -> list of (lx, ly, t_idx)

    total_cells = GRID_W * GRID_H
    INF = 1e9

    for src_name in anchor_names:
        st, sgx, sgy = anchors[src_name]
        s_node = st * total_cells + sgy * GRID_W + sgx
        dist = array.array("d", [INF]) * (4 * total_cells)
        parent = array.array("i", [-1]) * (4 * total_cells)
        dist[s_node] = 0.0
        pq = [(0.0, s_node)]

        while pq:
            d, u = heapq.heappop(pq)
            if d > dist[u] + 1e-9:
                continue
            ut, ucell = divmod(u, total_cells)
            ugy, ugx = divmod(ucell, GRID_W)
            w_layer = walkable[ut]
            for dx_, dy_, step_c in DIRS:
                nx, ny = ugx + dx_, ugy + dy_
                if 0 <= nx < GRID_W and 0 <= ny < GRID_H:
                    ncell = ny * GRID_W + nx
                    if w_layer[ncell]:
                        v = ut * total_cells + ncell
                        nd = d + step_c
                        if nd + 1e-9 < dist[v]:
                            dist[v] = nd
                            parent[v] = u
                            heapq.heappush(pq, (nd, v))
            vk = (ut, ucell)
            if vk in vadj:
                for (vt, vcell), vc in vadj[vk]:
                    v = vt * total_cells + vcell
                    nd = d + vc
                    if nd + 1e-9 < dist[v]:
                        dist[v] = nd
                        parent[v] = u
                        heapq.heappush(pq, (nd, v))

        # 回溯到其余锚点并做等距抽稀（保留跨层转折点）
        for dst_name in anchor_names:
            if dst_name == src_name:
                continue
            dt, dgx, dgy = anchors[dst_name]
            d_node = dt * total_cells + dgy * GRID_W + dgx
            if dist[d_node] >= INF * 0.5:
                continue
            rev = []
            cur = d_node
            while cur != -1:
                ct, ccell = divmod(cur, total_cells)
                cgy, cgx = divmod(ccell, GRID_W)
                lx, ly = grid_to_loc(cgx, cgy)
                rev.append((lx, ly, ct))
                cur = parent[cur]
            rev.reverse()
            # 抽稀：每 4 格（约 8m）留一个节点，且遇到跨层点必留
            slim = [rev[0]]
            for i in range(1, len(rev) - 1):
                if rev[i][2] != rev[i - 1][2] or rev[i][2] != rev[i + 1][2] or (i % 4 == 0):
                    slim.append(rev[i])
            slim.append(rev[-1])
            paths[(src_name, dst_name)] = slim

    # 为每个 POI 预收集其周围半径 26m 内的同层可通行格，用于自然的广场/花坛散开停留
    poi_cells = {}
    for name, (ti, gx, gy) in anchors.items():
        rad = 15 if name.startswith("FLOWER_") or "PLAZA" in name else 7
        cells = []
        w = walkable[ti]
        for dy_ in range(-rad, rad + 1):
            ny = gy + dy_
            if not (0 <= ny < GRID_H):
                continue
            for dx_ in range(-rad, rad + 1):
                if dx_ * dx_ + dy_ * dy_ > rad * rad:
                    continue
                nx = gx + dx_
                if 0 <= nx < GRID_W and w[ny * GRID_W + nx]:
                    cells.append(grid_to_loc(nx, ny))
        poi_cells[name] = cells if cells else [grid_to_loc(gx, gy)]

    # 连通性自检：任何一个锚点对不可达，都会让行人在该段静默瞬移，必须显式暴露出来
    missing_pairs = [
        (a, b) for a in anchor_names for b in anchor_names
        if a != b and (a, b) not in paths
    ]
    expected = len(anchor_names) * (len(anchor_names) - 1)
    print(f"[Nav] {len(anchors)} anchors, {len(paths)}/{expected} valid paths built in {time.time() - t0:.2f}s")
    if missing_pairs:
        preview = ", ".join(f"{a}->{b}" for a, b in missing_pairs[:6])
        print(f"[Nav] WARNING: {len(missing_pairs)} 个锚点对不可达，这些路段会被跳过: {preview}{' ...' if len(missing_pairs) > 6 else ''}")
    return {"anchors": anchors, "paths": paths, "poi_cells": poi_cells, "missing_pairs": missing_pairs}


# ---------------------------------------------------------------------------
# 3. 24 小时需求曲线与个体轨迹生成（含全局唯一 person_id）
# ---------------------------------------------------------------------------
def gauss(h: float, mu: float, sigma: float) -> float:
    return math.exp(-0.5 * ((h - mu) / sigma) ** 2)


def arrival_rate_per_min(sec: int) -> dict[str, float]:
    """
    高流动连续步行版 24 小时到达率（含三阳路地铁每 4 分钟脉冲波）：
    因为所有人都以持续步行穿行为主（通道 0 驻留，广场单点最多短拍 30-90 秒，绝无人原地停超 20 分钟），
    人均在园约 16-24 分钟，因此通过更高的连续客流通量 + 地铁脉冲波，让通道和广场因「持续人流走过」而变红！
    """
    h = sec / 3600.0

    # 三阳路地铁 1/7 号线每 4.5 分钟一趟列车出站脉冲（0.45 -> 1.75 倍波动，形成肉眼可见的一波波推进红潮！）
    metro_pulse = 1.0 + 0.65 * math.sin(2.0 * math.pi * sec / 270.0) ** 3

    # 1. 晨练/快走（早上多，06:00-09:00 明显早高峰）
    r_morning = 36.0 * gauss(h, 7.1, 0.85) + 10.0 * gauss(h, 8.7, 0.55)
    if h < 5.0 or h > 10.5:
        r_morning *= 0.05

    # 2. 菊花会观展游园流（上午渐旺，中午 11:45-13:15 明显回落吃饭，14:00-17:15 下午大客流脉冲涌入！）
    lunch_dip = 1.0 - 0.80 * gauss(h, 12.25, 0.65)
    r_flower = (
        34.0 * gauss(h, 10.2, 0.90)
        + 105.0 * gauss(h, 15.35, 1.05) * metro_pulse
        + 36.0 * gauss(h, 19.2, 0.95)
    ) * max(0.10, lunch_dip)
    if h < 7.8 or h > 21.2:
        r_flower = 0.0

    # 3. 晚饭后纳凉/江景灯光秀（晚饭后人最多，18:30-21:15 全天最高脉冲洪峰，随后集中散场）
    r_evening = (132.0 * gauss(h, 19.55, 0.85) + 28.0 * gauss(h, 20.7, 0.45)) * metro_pulse
    if h < 17.5 or h > 21.6:
        r_evening = 0.0

    # 4. 日常散步/亲子游（白天温和存在，中午少，饭后缓升）
    r_stroller = (
        12.0 * gauss(h, 9.8, 1.3)
        + 22.0 * gauss(h, 15.8, 1.4)
        + 24.0 * gauss(h, 19.6, 1.2)
    ) * max(0.20, 1.0 - 0.65 * gauss(h, 12.3, 0.7))
    if h < 6.0 or h > 22.3:
        r_stroller *= 0.12

    # 5. 绿道/滨江高速过境流（SEC-N <-> SEC-S 持续穿行）
    r_pass = (
        1.2
        + 14.0 * gauss(h, 7.6, 1.1)
        + 16.0 * gauss(h, 16.0, 1.8)
        + 22.0 * gauss(h, 19.7, 1.3)
    )
    if h < 5.0 or h > 23.2:
        r_pass = 0.6

    return {
        "morning_exercise": r_morning,
        "chrysanthemum_visitor": r_flower,
        "evening_leisure": r_evening,
        "daily_stroller": r_stroller,
        "pass_through": r_pass,
    }


def weighted_choice(rng: random.Random, items: list[tuple[str, float]]) -> str:
    tot = sum(w for _, w in items)
    r = rng.random() * tot
    acc = 0.0
    for k, w in items:
        acc += w
        if r <= acc:
            return k
    return items[-1][0]


class Agent:
    __slots__ = (
        "pid", "profile", "entry_gate", "exit_gate", "main_poi",
        "t_start", "t_end", "ts", "xs", "ys", "tiers", "states"
    )

    def __init__(self, pid: str, profile: str, entry_gate: str, exit_gate: str, main_poi: str,
                 ts: list[float], xs: list[float], ys: list[float], tiers: list[int], states: list[str]):
        self.pid = pid
        self.profile = profile
        self.entry_gate = entry_gate
        self.exit_gate = exit_gate
        self.main_poi = main_poi
        self.t_start = ts[0]
        self.t_end = ts[-1]
        self.ts = ts
        self.xs = xs
        self.ys = ys
        self.tiers = tiers
        self.states = states

    def sample(self, t: float) -> tuple[float, float, int, float, float, str]:
        """返回 (lx, ly, tier_idx, vx, vy, state)"""
        ts = self.ts
        idx = bisect.bisect_right(ts, t) - 1
        if idx < 0:
            idx = 0
        if idx >= len(ts) - 1:
            return (self.xs[-1], self.ys[-1], self.tiers[-1], 0.0, 0.0, self.states[-1])
        t0, t1 = ts[idx], ts[idx + 1]
        dt = t1 - t0
        if dt <= 1e-6:
            return (self.xs[idx], self.ys[idx], self.tiers[idx], 0.0, 0.0, self.states[idx])
        frac = (t - t0) / dt
        x0, x1 = self.xs[idx], self.xs[idx + 1]
        y0, y1 = self.ys[idx], self.ys[idx + 1]
        lx = x0 + (x1 - x0) * frac
        ly = y0 + (y1 - y0) * frac
        vx = (x1 - x0) / dt
        vy = (y1 - y0) / dt
        tier = self.tiers[idx] if frac < 0.5 else self.tiers[idx + 1]
        return (lx, ly, tier, vx, vy, self.states[idx])


def generate_agents(env: dict, nav: dict) -> list[Agent]:
    t0 = time.time()
    rng = random.Random(SEED)
    walkable = env["walkable"]
    paths = nav["paths"]
    poi_cells = nav["poi_cells"]

    # 入口权重配置
    entry_weights = {
        "morning_exercise": [("G09", 0.35), ("G07", 0.25), ("G08", 0.15), ("SEC_N", 0.13), ("SEC_S", 0.12)],
        "chrysanthemum_visitor": [("G09", 0.54), ("G07", 0.24), ("G08", 0.12), ("SEC_N", 0.05), ("SEC_S", 0.05)],
        "evening_leisure": [("G09", 0.44), ("G07", 0.28), ("G08", 0.14), ("SEC_N", 0.07), ("SEC_S", 0.07)],
        "daily_stroller": [("G09", 0.40), ("G07", 0.26), ("G08", 0.14), ("SEC_N", 0.10), ("SEC_S", 0.10)],
        "pass_through": [("SEC_N", 0.50), ("SEC_S", 0.50)],
    }

    # 主目的 POI 权重配置
    poi_weights = {
        "morning_exercise": [
            ("GREENWAY_MID", 0.20), ("T2_NORTH_PLAZA", 0.18), ("FLOWER_CENTER", 0.14),
            ("T2_PROM_NORTH", 0.12), ("T2_PROM_MID", 0.10), ("RW_MID", 0.12),
            ("MONUMENT_PLAZA", 0.08), ("T2_SOUTH_PLAZA", 0.06),
        ],
        "chrysanthemum_visitor": [
            ("FLOWER_CENTER", 0.32), ("FLOWER_NORTH", 0.18), ("FLOWER_WEST", 0.15),
            ("FLOWER_SOUTH", 0.13), ("SANYANG_ENTRY", 0.10), ("MONUMENT_GARDEN", 0.05),
            ("T2_NORTH_PLAZA", 0.04), ("YIYUAN_PLAZA", 0.03),
        ],
        "evening_leisure": [
            ("FLOWER_CENTER", 0.20), ("T2_NORTH_PLAZA", 0.17), ("T2_PROM_MID", 0.12),
            ("T2_SOUTH_PLAZA", 0.12), ("RW_NORTH", 0.08), ("RW_MID", 0.09),
            ("FLOWER_NORTH", 0.08), ("SANYANG_ENTRY", 0.07), ("YIYUAN_PLAZA", 0.07),
        ],
        "daily_stroller": [
            ("FLOWER_CENTER", 0.18), ("MONUMENT_GARDEN", 0.14), ("T2_NORTH_PLAZA", 0.14),
            ("T2_PROM_MID", 0.14), ("RW_MID", 0.12), ("SANYANG_ENTRY", 0.12),
            ("YIYUAN_PLAZA", 0.08), ("T2_SOUTH_PLAZA", 0.08),
        ],
    }

    # 游园环线模板：真实江滩/菊花会游客不是“走3分钟+原地站60分钟”，而是沿多段通道+广场连续慢逛流动！
    # 每条环线包含 4-6 个串联节点，让入口大道、沿江绿道、主广场、二级亲水大道和亲水步道都真正挤满并持续流动
    tour_loops = {
        "chrysanthemum_visitor": [
            ["SANYANG_ENTRY", "SANYANG_NORTH_GW", "GREENWAY_MID", "FLOWER_NORTH", "FLOWER_CENTER", "FLOWER_WEST", "FLOWER_SOUTH"],
            ["SANYANG_ENTRY", "MONUMENT_GARDEN", "MONUMENT_PLAZA", "FLOWER_WEST", "FLOWER_CENTER", "T2_PROM_MID", "T2_NORTH_PLAZA"],
            ["YIYUAN_PLAZA", "FLOWER_SOUTH", "FLOWER_CENTER", "FLOWER_NORTH", "GREENWAY_MID", "SANYANG_NORTH_GW", "SANYANG_ENTRY"],
            ["MONUMENT_PLAZA", "FLOWER_CENTER", "FLOWER_SOUTH", "YIYUAN_PLAZA", "T2_SOUTH_PLAZA", "T2_PROM_MID", "T2_NORTH_PLAZA"],
            ["SANYANG_ENTRY", "T2_NORTH_PLAZA", "T2_PROM_NORTH", "T2_PROM_MID", "FLOWER_CENTER", "FLOWER_WEST", "MONUMENT_PLAZA"],
        ],
        "evening_leisure": [
            ["SANYANG_ENTRY", "T2_NORTH_PLAZA", "T2_PROM_NORTH", "T2_PROM_MID", "T2_SOUTH_PLAZA", "YIYUAN_PLAZA"],
            ["YIYUAN_PLAZA", "T2_SOUTH_PLAZA", "RW_SOUTH", "RW_MID", "RW_NORTH", "T2_NORTH_PLAZA", "SANYANG_ENTRY"],
            ["SANYANG_ENTRY", "SANYANG_NORTH_GW", "GREENWAY_MID", "FLOWER_CENTER", "FLOWER_SOUTH", "YIYUAN_PLAZA"],
            ["MONUMENT_PLAZA", "FLOWER_CENTER", "T2_PROM_MID", "T2_PROM_NORTH", "T2_NORTH_PLAZA", "SANYANG_ENTRY"],
            ["YIYUAN_PLAZA", "FLOWER_SOUTH", "FLOWER_CENTER", "MONUMENT_GARDEN", "SANYANG_NORTH_GW", "T2_NORTH_PLAZA"],
        ],
        "morning_exercise": [
            ["SANYANG_NORTH_GW", "GREENWAY_MID", "YIYUAN_PLAZA", "T2_SOUTH_PLAZA", "T2_PROM_MID", "T2_NORTH_PLAZA"],
            ["T2_SOUTH_PLAZA", "RW_SOUTH", "RW_MID", "RW_NORTH", "T2_NORTH_PLAZA", "SANYANG_NORTH_GW"],
            ["SANYANG_ENTRY", "MONUMENT_GARDEN", "MONUMENT_PLAZA", "FLOWER_CENTER", "GREENWAY_MID", "SANYANG_NORTH_GW"],
        ],
        "daily_stroller": [
            ["SANYANG_ENTRY", "SANYANG_NORTH_GW", "GREENWAY_MID", "FLOWER_CENTER", "T2_PROM_MID", "T2_NORTH_PLAZA"],
            ["YIYUAN_PLAZA", "FLOWER_SOUTH", "FLOWER_CENTER", "MONUMENT_PLAZA", "MONUMENT_GARDEN", "SANYANG_ENTRY"],
            ["MONUMENT_PLAZA", "T2_PROM_MID", "RW_MID", "RW_NORTH", "T2_NORTH_PLAZA"],
        ],
    }

    # 按 1 分钟桶生成泊松到达事件
    arrivals = []  # (t_enter, profile)
    for minute in range(1440):
        sec_mid = minute * 60 + 30
        rates = arrival_rate_per_min(sec_mid)
        for prof, lam in rates.items():
            if lam <= 0.0:
                continue
            if lam < 25.0:
                L = math.exp(-lam)
                k = 0
                p = 1.0
                while p > L:
                    k += 1
                    p *= rng.random()
                cnt = k - 1
            else:
                cnt = max(0, int(round(rng.gauss(lam, math.sqrt(lam)))))
            for _ in range(cnt):
                arrivals.append((minute * 60.0 + rng.random() * 60.0, prof))

    # 初始 00:00 已在园的夜间留园人员（约 25 人）
    for _ in range(25):
        arrivals.append((0.0, "pass_through" if rng.random() < 0.4 else "daily_stroller"))

    arrivals.sort(key=lambda x: x[0])

    def clamp_jitter(lx: float, ly: float, ti: int, spread_m: float) -> tuple[float, float]:
        if spread_m <= 0.1:
            return lx, ly
        w = walkable[ti]
        for _ in range(4):
            jx = lx + rng.gauss(0.0, spread_m)
            jy = ly + rng.gauss(0.0, spread_m)
            gx, gy = loc_to_grid(jx, jy)
            if 0 <= gx < GRID_W and 0 <= gy < GRID_H and w[gy * GRID_W + gx]:
                return jx, jy
        return lx, ly

    # 记录被跳过的路段：锚点对不可达时 append_leg 会整段跳过，行人会在两端之间瞬移
    skipped_legs: dict[tuple[str, str], int] = defaultdict(int)

    def append_leg(ts, xs, ys, tiers, states, src: str, dst: str, speed: float, lat_bias: float, state_label: str):
        pts = paths.get((src, dst))
        if not pts or len(pts) < 2:
            skipped_legs[(src, dst)] += 1
            return
        cur_t = ts[-1]
        for i in range(1, len(pts)):
            px, py, pti = pts[i]
            is_trans = (pts[i][2] != pts[i - 1][2]) or (i == len(pts) - 1)
            if not is_trans:
                tx, ty = px - pts[i - 1][0], py - pts[i - 1][1]
                tn = math.hypot(tx, ty)
                if tn > 1e-3:
                    nx, ny = -ty / tn, tx / tn
                    cand_x, cand_y = px + nx * lat_bias, py + ny * lat_bias
                    gx, gy = loc_to_grid(cand_x, cand_y)
                    if 0 <= gx < GRID_W and 0 <= gy < GRID_H and walkable[pti][gy * GRID_W + gx]:
                        px, py = cand_x, cand_y
            dist = math.hypot(px - xs[-1], py - ys[-1])
            seg_speed = speed * (0.62 if pts[i][2] != pts[i - 1][2] else 1.0)
            dt = max(1.0, dist / max(0.28, seg_speed))
            cur_t += dt
            ts.append(cur_t)
            xs.append(px)
            ys.append(py)
            tiers.append(pti)
            states.append(state_label)

    def append_dwell(ts, xs, ys, tiers, states, poi_name: str, dwell_s: float):
        if dwell_s <= 15.0:
            return
        ti = nav["anchors"][poi_name][0]
        cells = poi_cells[poi_name]
        cur_t = ts[-1]
        end_t = cur_t + dwell_s
        # 短暂停留拍照/赏花，保持缓慢移动而非死站不动
        n_hops = rng.randint(2, 3)
        hop_dt = dwell_s / n_hops
        for _ in range(n_hops):
            tx, ty = cells[rng.randrange(len(cells))]
            tx += rng.uniform(-0.8, 0.8)
            ty += rng.uniform(-0.8, 0.8)
            dist = math.hypot(tx - xs[-1], ty - ys[-1])
            move_t = min(hop_dt * 0.60, max(2.0, dist / 0.45))
            cur_t += move_t
            ts.append(cur_t)
            xs.append(tx)
            ys.append(ty)
            tiers.append(ti)
            states.append("viewing")
            stay_t = max(2.0, hop_dt - move_t)
            cur_t = min(end_t, cur_t + stay_t)
            ts.append(cur_t)
            xs.append(tx + rng.uniform(-0.4, 0.4))
            ys.append(ty + rng.uniform(-0.4, 0.4))
            tiers.append(ti)
            states.append("dwelling")
            if cur_t >= end_t - 1.0:
                break

    # 纯通行走廊/路口节点集合：绝对不允许原地驻留（0 秒停留），所有人必须直接走过去！
    CORRIDOR_ZERO_DWELL = {
        "SANYANG_ENTRY", "SANYANG_NORTH_GW", "GREENWAY_MID",
        "T2_PROM_NORTH", "T2_PROM_MID", "RW_NORTH", "RW_MID", "RW_SOUTH",
        "G09", "G08", "G07", "SEC_N", "SEC_S",
    }

    agents: list[Agent] = []
    max_single_dwell_s = 0.0
    max_total_dwell_s = 0.0

    for idx, (t_enter, prof) in enumerate(arrivals, start=1):
        pid = f"P{idx:06d}"
        entry = weighted_choice(rng, entry_weights[prof])
        h_enter = t_enter / 3600.0

        # 高峰时段拥堵自然减速（人流越密走得越慢，让通道因高流量持续穿行而自然变红！）
        peak_congestion = 1.0
        if 14.8 <= h_enter <= 17.0 or 19.0 <= h_enter <= 21.2:
            peak_congestion = 0.72
        elif 9.5 <= h_enter <= 11.2:
            peak_congestion = 0.85

        if prof == "pass_through":
            exit_g = "SEC_S" if entry == "SEC_N" else "SEC_N"
            mid_poi = weighted_choice(rng, [
                (k, w) for k, w in (("GREENWAY_MID", 0.45), ("T2_PROM_MID", 0.30), ("RW_MID", 0.25))
                if k in nav["anchors"]
            ])
            speed = rng.uniform(1.10, 1.50) * peak_congestion
            stops = [mid_poi]
            plaza_brief_pause_s = 0.0
        else:
            # 选一条长距离连续穿行游园环线（5-7 个串联节点，横贯三阳门大道->绿道->主广场->二级亲水平台->亲水步道->一元门）
            # 晚饭后灯光秀时段（19:15-20:10）偏好向江边二级/三级平台流动；20:10 后偏好回流出口！
            if prof == "evening_leisure" and 19.25 <= h_enter <= 20.15:
                base_loop = list(tour_loops["evening_leisure"][rng.choice([0, 1, 3])])
            else:
                base_loop = list(tour_loops[prof][rng.randrange(len(tour_loops[prof]))])
            if rng.random() < 0.50:
                base_loop.reverse()
            k_stops = rng.randint(5, min(7, len(base_loop)))
            start_i = rng.randint(0, len(base_loop) - k_stops)
            stops = base_loop[start_i:start_i + k_stops]

            last_s = stops[-1]
            if last_s in ("SANYANG_ENTRY", "SANYANG_NORTH_GW", "T2_NORTH_PLAZA", "RW_NORTH"):
                exit_g = weighted_choice(rng, [("G09", 0.65), ("SEC_N", 0.22), ("G08", 0.13)])
            elif last_s in ("YIYUAN_PLAZA", "T2_SOUTH_PLAZA", "RW_SOUTH", "FLOWER_SOUTH"):
                exit_g = weighted_choice(rng, [("G07", 0.65), ("SEC_S", 0.22), ("G08", 0.13)])
            else:
                exit_g = weighted_choice(rng, [("G09", 0.42), ("G08", 0.28), ("G07", 0.30)])

            if prof == "morning_exercise":
                speed = rng.uniform(1.05, 1.45) * peak_congestion
                plaza_brief_pause_s = 0.0  # 晨练全程不停，持续快走/慢跑
            elif prof == "chrysanthemum_visitor":
                # 全程慢走逛展，仅在广场花坛有 35% 概率短停 20-75 秒拍照（绝不长时间钉死原地！）
                speed = rng.uniform(0.68, 1.05) * peak_congestion
                plaza_brief_pause_s = rng.uniform(20.0, 75.0) if rng.random() < 0.35 else 0.0
            elif prof == "evening_leisure":
                speed = rng.uniform(0.75, 1.12) * peak_congestion
                plaza_brief_pause_s = rng.uniform(25.0, 90.0) if rng.random() < 0.35 else 0.0
            else:
                speed = rng.uniform(0.80, 1.18) * peak_congestion
                plaza_brief_pause_s = rng.uniform(15.0, 60.0) if rng.random() < 0.25 else 0.0

        # 最低亲水层封控（SKYGUARD_LOWEST_TIER=closed）时 RW_* 锚点已被移除，
        # 这里把环线里引用到的失效节点剔除；seasonal 模式下该过滤是空操作。
        stops = [s for s in stops if s in nav["anchors"]]
        if not stops or (prof != "pass_through" and len(stops) < 2):
            continue

        # 组装纯流动路径
        et, egx, egy = nav["anchors"][entry]
        elx, ely = clamp_jitter(*grid_to_loc(egx, egy), et, 2.0)
        ts = [t_enter]
        xs = [elx]
        ys = [ely]
        tiers = [et]
        states = ["entering"]

        # 宽横向铺满（±4.2m），让大道和广场自然铺开而不是排成细线
        lat_bias = rng.gauss(0.0, 4.2)
        cur_anchor = entry
        total_dwell_this = 0.0
        for stop in stops:
            append_leg(ts, xs, ys, tiers, states, cur_anchor, stop, speed, lat_bias, "walking")
            # 通道/路口严格 0 驻留；广场仅偶发 20-90 秒极短拍照停留（远低于 20 分钟上限！）
            if stop not in CORRIDOR_ZERO_DWELL and plaza_brief_pause_s > 0.0:
                d_s = plaza_brief_pause_s * rng.uniform(0.6, 1.2)
                append_dwell(ts, xs, ys, tiers, states, stop, d_s)
                total_dwell_this += d_s
                if d_s > max_single_dwell_s:
                    max_single_dwell_s = d_s
            cur_anchor = stop

        if total_dwell_this > max_total_dwell_s:
            max_total_dwell_s = total_dwell_this

        append_leg(ts, xs, ys, tiers, states, cur_anchor, exit_g, speed * 1.10, lat_bias, "exiting")
        if ts[-1] > ts[0] + 10.0:
            agents.append(Agent(pid, prof, entry, exit_g, stops[0], ts, xs, ys, tiers, states))

    assert max_total_dwell_s < 1200.0, f"Violation: agent dwell {max_total_dwell_s}s >= 20min!"
    if skipped_legs:
        pairs = sorted(skipped_legs)
        print(
            f"[Sim] WARNING: {sum(skipped_legs.values())} 段路径因锚点对不可达被跳过"
            f"（{len(pairs)} 对，如 {pairs[:6]}），这些行人在两端之间是瞬移的"
        )
    print(
        f"[Sim] Generated {len(agents):,} unique agents (person_id) in {time.time() - t0:.2f}s | "
        f"MAX single-spot pause={max_single_dwell_s:.1f}s, MAX total pause/person={max_total_dwell_s:.1f}s (< 20min OK!)"
    )
    return agents


# ---------------------------------------------------------------------------
# 4. 流式导出：5s 分区统计、28 机位统计、30s 全天轨迹、两个 15 分钟 1Hz 切片
# ---------------------------------------------------------------------------
def run_exports(env: dict, agents: list[Agent]):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    frame: LocalFrame = env["frame"]
    zone_grid = env["zone_grid"]
    zone_areas = env["zone_areas"]
    cameras = env["cameras"]
    cell_cams = env["cell_cams"]
    cam_visible_area = env["cam_visible_area"]
    n_zones = len(ZONES_META)
    n_cams = len(cameras)

    # 1) 导出行人总花名册 person_manifest.csv
    t0 = time.time()
    manifest_path = OUT_DIR / "person_manifest.csv"
    with manifest_path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["person_id", "profile", "entry_time_bj", "exit_time_bj", "duration_min", "entry_gate", "exit_gate", "main_poi"])
        for a in agents:
            t_in = int(max(0, min(DAY_SECONDS - 1, a.t_start)))
            t_out = int(max(0, min(DAY_SECONDS - 1, a.t_end)))
            w.writerow([
                a.pid, a.profile, format_bj_iso(t_in), format_bj_iso(t_out),
                round((a.t_end - a.t_start) / 60.0, 2), a.entry_gate, a.exit_gate, a.main_poi
            ])
    print(f"[Out] person_manifest.csv ({len(agents):,} rows) in {time.time() - t0:.2f}s")

    # 2) 按 5 秒步长扫描全天 24 小时（17,280 个窗口）：
    #    同时写出 region_stats_5s.csv、camera_stats_28cams_5s.csv、trajectories_24h_30s.csv
    #    并缓存绘图与 HTML 回放所需的轻量数据！
    t0 = time.time()
    rng_obs = random.Random(SEED + 999)

    # 构建活跃代理指针队列（agents 已按 t_start 排序）
    n_agents = len(agents)
    next_idx = 0
    active: list[Agent] = []

    # 4 个典型时刻空间快照（用于生成 4 联热力图 PNG）
    snapshot_secs = {
        7 * 3600 + 30 * 60: "07:30 晨练早高峰",
        12 * 3600 + 30 * 60: "12:30 午饭低谷",
        15 * 3600 + 35 * 60: "15:35 菊花会下午高峰",
        19 * 3600 + 45 * 60: "19:45 晚饭后全天最高峰",
    }
    snapshots = {}  # sec -> list of (lx, ly, tier_idx, profile)
    peak_cam_snapshot = None  # 19:45 的 28 机位统计

    # 全天每 5 分钟采样曲线（288 个点，用于画 24h 曲线图与 HTML 曲线）
    curve_5min = []
    # HTML 24h 回放帧（每 5 分钟抽 1 帧，共 288 帧，每帧保留最多 900 个代表性点位+全区精确计数，保持 HTML 体积轻量流畅）
    html_frames_24h = []

    prev_zone_of_agent: dict[str, int] = {}

    f_reg = (OUT_DIR / "region_stats_5s.csv").open("w", newline="", encoding="utf-8-sig")
    w_reg = csv.writer(f_reg)
    w_reg.writerow([
        "timestamp_bj", "timestamp_utc", "zone_id", "zone_name", "elevation_m",
        "people_count", "walkable_area_m2", "density_p_m2",
        "inflow_5s", "outflow_5s", "mean_speed_mps", "vx_mean", "vy_mean"
    ])

    f_cam = (OUT_DIR / "camera_stats_28cams_5s.csv").open("w", newline="", encoding="utf-8-sig")
    w_cam = csv.writer(f_cam)
    w_cam.writerow([
        "timestamp_bj", "timestamp_utc", "camera_id", "camera_name", "elevation_tier_m",
        "true_in_fov", "observed_count", "visible_area_m2", "density_obs_p_m2", "mean_speed_mps", "status"
    ])

    f_tr30 = (OUT_DIR / "trajectories_24h_30s.csv").open("w", newline="", encoding="utf-8-sig")
    w_tr30 = csv.writer(f_tr30)
    w_tr30.writerow([
        "timestamp_bj", "person_id", "profile",
        "x_utm", "y_utm", "lon", "lat", "x_local", "y_local",
        "elevation_m", "zone_id", "vx_mps", "vy_mps", "speed_mps", "state"
    ])

    f_batch = (OUT_DIR / "region_state_batch_5s.jsonl").open("w", encoding="utf-8")

    peak_total = 0
    peak_total_sec = 0
    peak_afternoon = 0
    peak_afternoon_sec = 0
    morning_peak = 0
    lunch_min = 999999
    tr30_rows = 0

    for sec in range(0, DAY_SECONDS, 5):
        # 推进活跃列表
        while next_idx < n_agents and agents[next_idx].t_start <= sec:
            active.append(agents[next_idx])
            next_idx += 1
        if active:
            active = [a for a in active if a.t_end >= sec]

        is_30s = (sec % 30 == 0)
        is_5min = (sec % 300 == 0)
        is_snap = (sec in snapshot_secs)

        z_cnt = [0] * n_zones
        z_in = [0] * n_zones
        z_out = [0] * n_zones
        z_spd = [0.0] * n_zones
        z_vx = [0.0] * n_zones
        z_vy = [0.0] * n_zones

        c_true = [0] * n_cams
        c_spd = [0.0] * n_cams

        prof_cnt = defaultdict(int)
        snap_pts = [] if is_snap else None
        html_pts = [] if is_5min else None

        ts_bj = format_bj_iso(sec)
        ts_utc = format_utc_iso(sec)
        curr_zone_of_agent: dict[str, int] = {}

        # 为 24h HTML 帧均匀抽样（若人数 > 850，按步长抽样以保浏览器 60fps 丝滑）。
        # 抽样必须按 person_id 稳定取模：若按当帧 active 下标取模，同一人会在相邻帧
        # 命中/不命中交替，搜索 person_id 高亮时出现闪烁。
        stride_html = max(1, len(active) // 850) if is_5min else 1

        for ai, a in enumerate(active):
            lx, ly, ti, vx, vy, st = a.sample(float(sec))
            gx, gy = loc_to_grid(lx, ly)
            if 0 <= gx < GRID_W and 0 <= gy < GRID_H:
                cidx = gy * GRID_W + gx
                zv = zone_grid[ti][cidx]
                z_idx = (zv - 1) if zv > 0 else fallback_zone_idx(ti)
                cams_here = cell_cams[ti][cidx]
            else:
                z_idx = 0
                cams_here = ()

            spd = math.hypot(vx, vy)
            z_cnt[z_idx] += 1
            z_spd[z_idx] += spd
            z_vx[z_idx] += vx
            z_vy[z_idx] += vy
            prof_cnt[a.profile] += 1

            prev_z = prev_zone_of_agent.get(a.pid, -1)
            if prev_z != z_idx:
                z_in[z_idx] += 1
                if prev_z >= 0:
                    z_out[prev_z] += 1
            curr_zone_of_agent[a.pid] = z_idx

            for ci in cams_here:
                c_true[ci] += 1
                c_spd[ci] += spd

            if is_30s:
                ux, uy = frame.to_utm(lx, ly)
                lon, lat = utm50n_to_wgs84(ux, uy)
                w_tr30.writerow([
                    ts_bj, a.pid, a.profile,
                    round(ux, 2), round(uy, 2), round(lon, 6), round(lat, 6),
                    round(lx, 2), round(ly, 2),
                    TIERS[ti], ZONES_META[z_idx][0],
                    round(vx, 3), round(vy, 3), round(spd, 3), st
                ])
                tr30_rows += 1

            if is_snap:
                snap_pts.append((lx, ly, ti, a.profile))

            if is_5min and (int(a.pid[1:]) % stride_html == 0):
                html_pts.append([round(lx, 1), round(ly, 1), ti, a.profile[0], a.pid])

        # 处理本窗口离场人员的流出计数
        for pid_old, old_z in prev_zone_of_agent.items():
            if pid_old not in curr_zone_of_agent:
                z_out[old_z] += 1
        prev_zone_of_agent = curr_zone_of_agent

        total_now = len(active)
        if total_now > peak_total:
            peak_total = total_now
            peak_total_sec = sec
        if 14 * 3600 <= sec <= 17 * 3600 + 30 * 60 and total_now > peak_afternoon:
            peak_afternoon = total_now
            peak_afternoon_sec = sec
        if 6 * 3600 <= sec <= 9 * 3600 and total_now > morning_peak:
            morning_peak = total_now
        if 11 * 3600 + 45 * 60 <= sec <= 13 * 3600 + 15 * 60 and total_now < lunch_min:
            lunch_min = total_now

        # 写入 12 分区 5s 统计 + JSONL 批次
        batch_regions = []
        for zi, (zid, zname, zelev) in enumerate(ZONES_META):
            cnt = z_cnt[zi]
            area = zone_areas[zi]
            dens = cnt / area if area > 0 else 0.0
            mspd = z_spd[zi] / cnt if cnt > 0 else 0.0
            mvx = z_vx[zi] / cnt if cnt > 0 else 0.0
            mvy = z_vy[zi] / cnt if cnt > 0 else 0.0
            w_reg.writerow([
                ts_bj, ts_utc, zid, zname, zelev,
                cnt, round(area, 1), round(dens, 5),
                z_in[zi], z_out[zi], round(mspd, 3), round(mvx, 3), round(mvy, 3)
            ])
            batch_regions.append({
                "region_id": zid,
                "walkable_area_m2": round(area, 1),
                "people_count_observed": cnt,
                "people_count_estimated": float(cnt),
                "density_persons_m2": round(dens, 5),
                "inflow_count": z_in[zi],
                "outflow_count": z_out[zi],
                "mean_speed_mps": round(mspd, 3),
                "mean_velocity_xy_mps": [round(mvx, 3), round(mvy, 3)],
                "valid_track_count": cnt,
                "observation_status": "synthetic_ground_truth",
                "quality": "ok",
            })

        f_batch.write(json.dumps({
            "schema_version": "0.1",
            "scene_id": "hankou_sanyang_chrysanthemum_24h",
            "camera_id": "FUSED_28CAMS_GT",
            "timestamp_utc": ts_utc,
            "timestamp_bj": ts_bj,
            "window_seconds": 5,
            "coordinate_frame_id": "EPSG:32650",
            "calibration_version": "sanyang_v2_riverwalk",
            "total_people": total_now,
            "regions": batch_regions,
        }, ensure_ascii=False) + "\n")

        # 写入 28 机位 5s 统计（加入随密度略增的遮挡漏检，更贴近真实视觉感知）
        cam_snap_cur = [] if sec == 19 * 3600 + 45 * 60 else None
        for ci, cam in enumerate(cameras):
            ct = c_true[ci]
            carea = cam_visible_area[ci]
            # 密度越高，轻微遮挡漏检率从 2% 升至 ~8%
            cdens_true = ct / carea if carea > 0 else 0.0
            miss_rate = min(0.10, 0.02 + 0.12 * cdens_true)
            obs_c = int(round(ct * (1.0 - miss_rate) + rng_obs.gauss(0.0, math.sqrt(max(0.0, ct * miss_rate)))))
            obs_c = max(0, min(ct, obs_c))
            dens_obs = obs_c / carea if carea > 0 else 0.0
            mspd_c = c_spd[ci] / ct if ct > 0 else 0.0
            w_cam.writerow([
                ts_bj, ts_utc, cam["camera_id"], cam["name"], cam["elevation_tier_m"],
                ct, obs_c, round(carea, 1), round(dens_obs, 5), round(mspd_c, 3), "online_synthetic"
            ])
            if cam_snap_cur is not None:
                cam_snap_cur.append((cam["camera_id"], ct, obs_c, carea, cam["elevation_tier_m"]))

        if cam_snap_cur is not None:
            peak_cam_snapshot = cam_snap_cur

        if is_snap:
            snapshots[sec] = snap_pts

        if is_5min:
            curve_5min.append({
                "sec": sec,
                "time": f"{sec // 3600:02d}:{(sec % 3600) // 60:02d}",
                "total": total_now,
                "profiles": dict(prof_cnt),
                "zones": list(z_cnt),
                "cams": [c_true[ci] for ci in range(n_cams)],
            })
            html_frames_24h.append({
                "t": f"{sec // 3600:02d}:{(sec % 3600) // 60:02d}",
                "s": sec,
                "n": total_now,
                "z": list(z_cnt),
                "c": [c_true[ci] for ci in range(n_cams)],
                "p": html_pts,
            })

    f_reg.close()
    f_cam.close()
    f_tr30.close()
    f_batch.close()

    print(
        f"[Out] 24h 5s stats & 30s trajectories ({tr30_rows:,} rows) written in {time.time() - t0:.2f}s | "
        f"Morning={morning_peak}, LunchMin={lunch_min}, Afternoon={peak_afternoon}@{peak_afternoon_sec//3600:02d}:{(peak_afternoon_sec%3600)//60:02d}, "
        f"EveningPeak={peak_total}@{peak_total_sec//3600:02d}:{(peak_total_sec%3600)//60:02d}"
    )

    # 3) 导出两个 15 分钟 1Hz 精细切片（逐人轨迹 + 28 机位逐人观测带 track_id_local & person_id）
    peak_stats = {}
    html_peak_slices = {}
    for key, cfg in PEAK_WINDOWS.items():
        t1 = time.time()
        s0, s1 = cfg["start_s"], cfg["end_s"]
        sub_agents = [a for a in agents if a.t_end >= s0 and a.t_start <= s1]

        tr_path = OUT_DIR / f"trajectories_peak_{key}_1hz.csv"
        ct_path = OUT_DIR / f"camera_tracks_peak_{key}_1hz.csv"

        # 单机位局部 track_id_local 分配器（离场重进则分配新 ID，贴近真实 ByteTrack 行为）
        next_local_id = [1] * n_cams
        cam_active_map = [{} for _ in range(n_cams)]  # pid -> (track_id_local, last_seen_sec)

        tr_rows = 0
        ct_rows = 0
        # 给 HTML 精细切片抽样保存前 120 秒（每 2 秒 1 帧，共 60 帧，展示 1Hz 丝滑轨迹）
        slice_frames = []

        with tr_path.open("w", newline="", encoding="utf-8-sig") as ft_out, \
             ct_path.open("w", newline="", encoding="utf-8-sig") as fc_out:
            wt = csv.writer(ft_out)
            wc = csv.writer(fc_out)
            wt.writerow([
                "timestamp_bj", "person_id", "profile",
                "x_utm", "y_utm", "lon", "lat", "x_local", "y_local",
                "elevation_m", "zone_id", "vx_mps", "vy_mps", "speed_mps", "state"
            ])
            wc.writerow([
                "timestamp_bj", "camera_id", "track_id_local", "person_id_gt",
                "x_utm_obs", "y_utm_obs", "elevation_m", "vx_mps", "vy_mps", "confidence"
            ])

            for sec in range(s0, s1):
                ts_bj = format_bj_iso(sec)
                save_html = (sec - s0 < 180) and ((sec - s0) % 3 == 0)
                fpts = [] if save_html else None
                stride_s = max(1, len(sub_agents) // 700) if save_html else 1
                cnt_sec = 0

                for ai, a in enumerate(sub_agents):
                    if not (a.t_start <= sec <= a.t_end):
                        continue
                    cnt_sec += 1
                    lx, ly, ti, vx, vy, st = a.sample(float(sec))
                    gx, gy = loc_to_grid(lx, ly)
                    if 0 <= gx < GRID_W and 0 <= gy < GRID_H:
                        cidx = gy * GRID_W + gx
                        zv = zone_grid[ti][cidx]
                        z_idx = (zv - 1) if zv > 0 else fallback_zone_idx(ti)
                        cams_here = cell_cams[ti][cidx]
                    else:
                        z_idx = 0
                        cams_here = ()

                    ux, uy = frame.to_utm(lx, ly)
                    lon, lat = utm50n_to_wgs84(ux, uy)
                    spd = math.hypot(vx, vy)

                    wt.writerow([
                        ts_bj, a.pid, a.profile,
                        round(ux, 2), round(uy, 2), round(lon, 6), round(lat, 6),
                        round(lx, 2), round(ly, 2),
                        TIERS[ti], ZONES_META[z_idx][0],
                        round(vx, 3), round(vy, 3), round(spd, 3), st
                    ])
                    tr_rows += 1

                    if save_html and (ai % stride_s == 0):
                        fpts.append([round(lx, 1), round(ly, 1), ti, a.profile[0], a.pid])

                    # 28 机位逐人观测（约 4% 偶发漏检 + ±0.22m 定位观测噪声）
                    for ci in cams_here:
                        if rng_obs.random() < 0.04:
                            continue
                        cmap = cam_active_map[ci]
                        prev = cmap.get(a.pid)
                        if prev is None or (sec - prev[1]) > TRACK_GAP_LOCAL_CAM_S:
                            tid = next_local_id[ci]
                            next_local_id[ci] += 1
                        else:
                            tid = prev[0]
                        cmap[a.pid] = (tid, sec)
                        ox = ux + rng_obs.gauss(0.0, 0.22)
                        oy = uy + rng_obs.gauss(0.0, 0.22)
                        conf = round(min(0.99, max(0.45, rng_obs.gauss(0.86, 0.07))), 3)
                        wc.writerow([
                            ts_bj, cameras[ci]["camera_id"], tid, a.pid,
                            round(ox, 2), round(oy, 2), TIERS[ti],
                            round(vx, 3), round(vy, 3), conf
                        ])
                        ct_rows += 1

                if save_html:
                    slice_frames.append({
                        "t": f"{sec // 3600:02d}:{(sec % 3600) // 60:02d}:{sec % 60:02d}",
                        "s": sec,
                        "n": cnt_sec,
                        "p": fpts,
                    })

        peak_stats[key] = {
            "label": cfg["label"],
            "window_bj": f"{format_bj_iso(s0)} ~ {format_bj_iso(s1)}",
            "unique_persons": len(sub_agents),
            "trajectory_rows_1hz": tr_rows,
            "camera_track_rows_1hz": ct_rows,
        }
        html_peak_slices[key] = slice_frames
        print(
            f"[Out] Peak '{key}' 1Hz: {len(sub_agents):,} unique persons, "
            f"{tr_rows:,} traj rows, {ct_rows:,} cam-track rows in {time.time() - t1:.2f}s"
        )

    return {
        "curve_5min": curve_5min,
        "snapshots": snapshots,
        "snapshot_secs": snapshot_secs,
        "peak_cam_snapshot": peak_cam_snapshot,
        "html_frames_24h": html_frames_24h,
        "html_peak_slices": html_peak_slices,
        "peak_stats": peak_stats,
        "summary_metrics": {
            "total_unique_persons": len(agents),
            "morning_peak": morning_peak,
            "lunch_valley_min": lunch_min,
            "afternoon_chrysanthemum_peak": peak_afternoon,
            "afternoon_peak_time_bj": f"{peak_afternoon_sec // 3600:02d}:{(peak_afternoon_sec % 3600) // 60:02d}",
            "evening_all_day_peak": peak_total,
            "evening_peak_time_bj": f"{peak_total_sec // 3600:02d}:{(peak_total_sec % 3600) // 60:02d}",
            "trajectories_24h_30s_rows": tr30_rows,
        },
    }


# ---------------------------------------------------------------------------
# 5. 生成高质量验收图表（纯 PIL 绘制，支持清晰中文）
# ---------------------------------------------------------------------------
_FONT_CACHE: dict[int, tuple] = {}
_ORIG_DRAW_TEXT = ImageDraw.ImageDraw.text


def _patched_draw_text(self, xy, text, fill=None, font=None, *args, **kwargs):
    sz = getattr(font, "size", 14)
    if sz not in _FONT_CACHE:
        try:
            _FONT_CACHE[sz] = (ImageFont.truetype(FONT_PATH, sz), ImageFont.truetype(LATIN_FONT_PATH, sz))
        except Exception:
            _FONT_CACHE[sz] = (ImageFont.load_default(), ImageFont.load_default())
    fc, fl = _FONT_CACHE[sz]
    x, y = xy
    s = str(text)
    i, n = 0, len(s)
    while i < n:
        is_asc = ord(s[i]) < 128
        j = i + 1
        while j < n and (ord(s[j]) < 128) == is_asc:
            j += 1
        seg = s[i:j]
        f = fl if is_asc else fc
        _ORIG_DRAW_TEXT(self, (x, y + (1 if is_asc else 0)), seg, fill=fill or (255, 255, 255), font=f)
        bbox = self.textbbox((0, 0), seg, font=f)
        x += (bbox[2] - bbox[0])
        i = j


ImageDraw.ImageDraw.text = _patched_draw_text


def load_font(size: int):
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except Exception:
        return ImageFont.load_default()


def render_24h_curve_png(res: dict):
    W, H = 1800, 1080
    BG = (15, 23, 34)
    PANEL = (22, 33, 48)
    GRID = (42, 58, 78)
    TEXT = (232, 240, 248)
    SUB = (155, 175, 198)

    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    f_title = load_font(28)
    f_sub = load_font(17)
    f_lbl = load_font(15)
    f_sm = load_font(13)

    draw.text((48, 26), "汉口江滩 · 三阳核心演示段（G07–G09）24 小时人流规律模拟（含金秋菊花会下午大客流情景）", fill=TEXT, font=f_title)
    sm = res["summary_metrics"]
    draw.text(
        (48, 66),
        f"全天累计独立 person_id：{sm['total_unique_persons']:,} 人  |  "
        f"晨练早高峰：{sm['morning_peak']:,} 人  |  午饭低谷：{sm['lunch_valley_min']:,} 人  |  "
        f"菊花会下午高峰：{sm['afternoon_chrysanthemum_peak']:,} 人（{sm['afternoon_peak_time_bj']}）  |  "
        f"晚饭后全天最高峰：{sm['evening_all_day_peak']:,} 人（{sm['evening_peak_time_bj']}）",
        fill=(125, 211, 252), font=f_sub
    )

    curve = res["curve_5min"]
    # 上图：总人数 + 5 类人群堆叠面积
    x0, y0, x1, y1 = 95, 120, 1740, 585
    draw.rectangle([x0, y0, x1, y1], fill=PANEL, outline=GRID, width=1)
    y_max = max(4500, ((sm["evening_all_day_peak"] // 500) + 1) * 500)

    def px_x(sec):
        return int(x0 + (sec / 86400.0) * (x1 - x0))

    def px_y(val):
        return int(y1 - (val / y_max) * (y1 - y0))

    # 高亮两个 1Hz 演示窗口
    for key, col in (("chrysanthemum", (245, 158, 11)), ("evening", (244, 63, 94))):
        wcfg = PEAK_WINDOWS[key]
        bx0, bx1 = px_x(wcfg["start_s"]), px_x(wcfg["end_s"])
        draw.rectangle([bx0, y0, bx1, y1], fill=(48, 42, 36) if key == "chrysanthemum" else (55, 32, 46))

    # 网格线
    for v in range(0, y_max + 1, 500):
        yy = px_y(v)
        draw.line([(x0, yy), (x1, yy)], fill=GRID, width=1)
        draw.text((x0 - 58, yy - 9), f"{v:4d}", fill=SUB, font=f_sm)
    for hr in range(0, 25, 2):
        xx = px_x(hr * 3600)
        draw.line([(xx, y0), (xx, y1)], fill=GRID, width=1)
        draw.text((xx - 16, y1 + 8), f"{hr:02d}:00", fill=SUB, font=f_sm)

    # 堆叠人群面积
    prof_order = [
        ("morning_exercise", "晨练/太极", (52, 211, 153)),
        ("chrysanthemum_visitor", "菊花会观展游客", (251, 191, 36)),
        ("evening_leisure", "晚饭后纳凉/夜游", (244, 114, 182)),
        ("daily_stroller", "日常散步/亲子", (96, 165, 250)),
        ("pass_through", "绿道过境通行", (148, 163, 184)),
    ]
    base_vals = [0] * len(curve)
    for pkey, plbl, pcol in prof_order:
        top_vals = [base_vals[i] + curve[i]["profiles"].get(pkey, 0) for i in range(len(curve))]
        poly = [(px_x(curve[i]["sec"]), px_y(top_vals[i])) for i in range(len(curve))]
        poly += [(px_x(curve[i]["sec"]), px_y(base_vals[i])) for i in range(len(curve) - 1, -1, -1)]
        # 半透明混合色（用暗化版模拟）
        fill_c = tuple(int(PANEL[k] * 0.45 + pcol[k] * 0.55) for k in range(3))
        draw.polygon(poly, fill=fill_c)
        base_vals = top_vals

    # 总人数主曲线（亮白青色）
    tot_pts = [(px_x(c["sec"]), px_y(c["total"])) for c in curve]
    draw.line(tot_pts, fill=(248, 250, 252), width=3)

    # 关键阶段标注
    annots = [
        (7.5 * 3600, sm["morning_peak"], "早高峰（晨练/太极）", (52, 211, 153)),
        (12.5 * 3600, sm["lunch_valley_min"], "午饭回落低谷", (148, 163, 184)),
        (15.6 * 3600, sm["afternoon_chrysanthemum_peak"], "菊花会下午大客流", (251, 191, 36)),
        (19.75 * 3600, sm["evening_all_day_peak"], "晚饭后全天最高峰", (244, 114, 182)),
    ]
    for asec, aval, atxt, acol in annots:
        ax, ay = px_x(asec), px_y(aval)
        draw.ellipse([ax - 5, ay - 5, ax + 5, ay + 5], fill=acol, outline=(255, 255, 255), width=2)
        draw.text((ax - 68, max(y0 + 10, ay - 30)), f"{atxt} ({aval:,})", fill=acol, font=f_lbl)

    # 上图图例
    lx = x0 + 20
    for _, plbl, pcol in prof_order:
        draw.rectangle([lx, y0 + 14, lx + 16, y0 + 28], fill=pcol)
        draw.text((lx + 22, y0 + 12), plbl, fill=TEXT, font=f_sm)
        lx += 150

    # 下图：重点分区 24h 人数对比曲线
    y2, y3 = 645, 1020
    draw.rectangle([x0, y2, x1, y3], fill=PANEL, outline=GRID, width=1)
    draw.text((x0 + 14, y2 + 10), "重点功能分区 24 小时实时人数对比（含菊花会主展区 / 二级亲水平台 / 23m 亲水步道）", fill=TEXT, font=f_lbl)

    key_zones = [
        (ZONE_ID_TO_IDX["Z05_CHRYSANTHEMUM_MAIN"], "Z05 三阳主展区(菊花会核心)", (251, 191, 36)),
        (ZONE_ID_TO_IDX["Z09_TIER2_NORTH_PLAZA"], "Z09 二级三阳亲水大平台", (45, 212, 191)),
        (ZONE_ID_TO_IDX["Z08_GREENWAY_CORRIDOR"], "Z08 一级沿江绿道主干", (96, 165, 250)),
        (ZONE_ID_TO_IDX["Z04_SANYANG_ENTRY_PLAZA"], "Z04 三阳门入口北广场", (249, 115, 22)),
        (ZONE_ID_TO_IDX["Z12_RIVER_WALK_23M"], "Z12 23m 滨江亲水步道", (56, 189, 248)),
        (ZONE_ID_TO_IDX["Z10_TIER2_PROMENADE"], "Z10 二级中段沿江步道", (167, 139, 250)),
    ]
    z_max = max(max(c["zones"][zi] for c in curve) for zi, _, _ in key_zones)
    z_max = max(500, ((z_max // 250) + 1) * 250)

    def px_yz(val):
        return int(y3 - (val / z_max) * (y3 - (y2 + 42)))

    for v in range(0, z_max + 1, max(250, z_max // 5)):
        yy = px_yz(v)
        draw.line([(x0, yy), (x1, yy)], fill=GRID, width=1)
        draw.text((x0 - 58, yy - 8), f"{v:4d}", fill=SUB, font=f_sm)
    for hr in range(0, 25, 2):
        xx = px_x(hr * 3600)
        draw.line([(xx, y2 + 38), (xx, y3)], fill=GRID, width=1)
        draw.text((xx - 16, y3 + 8), f"{hr:02d}:00", fill=SUB, font=f_sm)

    lx = x0 + 18
    for zi, zlbl, zcol in key_zones:
        pts = [(px_x(c["sec"]), px_yz(c["zones"][zi])) for c in curve]
        draw.line(pts, fill=zcol, width=3)
        draw.rectangle([lx, y2 + 38, lx + 14, y2 + 50], fill=zcol)
        draw.text((lx + 20, y2 + 35), zlbl, fill=TEXT, font=f_sm)
        lx += 245

    out_p = OUT_DIR / "sanyang_24h_crowd_curve.png"
    img.save(str(out_p))
    print(f"[Viz] Saved {out_p.name}")


def render_spatial_4periods_png(env: dict, res: dict):
    """4 联空间分布与热力对比图：07:30 / 12:30 / 15:35 菊花会 / 19:45 晚饭后最高峰"""
    PW, PH = 440, 860
    W = PW * 4 + 60
    H = PH + 120
    BG = (14, 21, 31)
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    f_title = load_font(26)
    f_sub = load_font(17)
    f_sm = load_font(13)

    draw.text((30, 20), "三阳核心演示段（G07–G09）四大典型时段空间人流分布对照（四级高程底图 + 逐人点位）", fill=(236, 244, 252), font=f_title)
    draw.text((30, 56), "颜色含义：绿色=晨练  |  金黄=菊花会观展  |  粉红=晚饭后纳凉  |  天蓝=日常散步  |  灰白=绿道过境", fill=(160, 185, 210), font=f_sub)

    # 预渲染底图小块（190x395 放大 2 倍 -> 380x790）
    base = Image.new("RGB", (GRID_W, GRID_H), (19, 28, 40))
    px = base.load()
    tier_bg = [(95, 62, 46), (82, 74, 44), (36, 86, 84), (32, 82, 118)]
    walkable = env["walkable"]
    for gy in range(GRID_H):
        off = gy * GRID_W
        # 图像 y 轴向下，地理 y 轴向上 -> 翻转 gy
        iy = GRID_H - 1 - gy
        for gx in range(GRID_W):
            for ti in (3, 2, 1, 0):
                if walkable[ti][off + gx]:
                    px[gx, iy] = tier_bg[ti]
                    break
    base_big = base.resize((GRID_W * 2, GRID_H * 2), Image.NEAREST)

    prof_rgb = {
        "morning_exercise": (52, 211, 153),
        "chrysanthemum_visitor": (251, 191, 36),
        "evening_leisure": (244, 114, 182),
        "daily_stroller": (96, 165, 250),
        "pass_through": (203, 213, 225),
    }

    ordered_secs = sorted(res["snapshot_secs"].keys())
    for idx, sec in enumerate(ordered_secs):
        ox = 20 + idx * (PW + 10)
        oy = 96
        panel = base_big.copy()
        pdraw = ImageDraw.Draw(panel)
        pts = res["snapshots"][sec]
        for lx, ly, ti, prof in pts:
            gx, gy = loc_to_grid(lx, ly)
            sx = gx * 2
            sy = (GRID_H - 1 - gy) * 2
            if 0 <= sx < GRID_W * 2 and 0 <= sy < GRID_H * 2:
                col = prof_rgb.get(prof, (255, 255, 255))
                pdraw.rectangle([sx - 1, sy - 1, sx + 1, sy + 1], fill=col)

        # 标出三大闸口
        for gid, glbl in (("G09", "G09 三阳门"), ("G08", "G08 防洪碑"), ("G07", "G07 一元门")):
            gx, gy = loc_to_grid(*env["gates_loc"][gid])
            sx, sy = gx * 2, (GRID_H - 1 - gy) * 2
            pdraw.rectangle([sx - 4, sy - 4, sx + 4, sy + 4], fill=(239, 68, 68), outline=(255, 255, 255))
            pdraw.text((sx + 7, sy - 7), glbl, fill=(255, 220, 220), font=f_sm)

        img.paste(panel, (ox + 25, oy + 42))
        draw.rectangle([ox + 25, oy + 42, ox + 25 + GRID_W * 2, oy + 42 + GRID_H * 2], outline=(60, 82, 108), width=1)
        title = res["snapshot_secs"][sec]
        draw.text((ox + 28, oy + 10), f"{title}（在园 {len(pts):,} 人）", fill=(251, 191, 36) if "菊花" in title else (232, 240, 248), font=f_sub)

    out_p = OUT_DIR / "sanyang_spatial_heatmaps_4periods.png"
    img.save(str(out_p))
    print(f"[Viz] Saved {out_p.name}")


def render_camera_bar_png(res: dict):
    """28 台虚拟摄像头在 19:45 晚饭后最高峰的视场人数柱状图"""
    snap = res["peak_cam_snapshot"]
    if not snap:
        return
    W, H = 1600, 760
    BG = (15, 23, 34)
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    f_title = load_font(24)
    f_sm = load_font(13)

    draw.text((40, 24), "28 台虚拟摄像头在晚饭后最高峰（19:45）视场真值 vs 模拟观测人数对比", fill=(236, 244, 252), font=f_title)
    draw.text((40, 58), "浅青柱 = 视场内真实人数（真值）  |  亮金柱 = 摄像头模拟观测人数（含密度相关遮挡漏检）", fill=(150, 175, 200), font=f_sm)

    x0, y0, x1, y1 = 80, 105, 1550, 660
    draw.rectangle([x0, y0, x1, y1], fill=(22, 33, 48), outline=(45, 62, 84))
    ymax = max(100, ((max(s[1] for s in snap) // 50) + 1) * 50)

    for v in range(0, ymax + 1, max(50, ymax // 6)):
        yy = int(y1 - (v / ymax) * (y1 - y0))
        draw.line([(x0, yy), (x1, yy)], fill=(42, 58, 78))
        draw.text((x0 - 46, yy - 8), f"{v:3d}", fill=(155, 175, 198), font=f_sm)

    step = (x1 - x0) / len(snap)
    for i, (cid, ct, obs_c, carea, tier) in enumerate(snap):
        bx = int(x0 + i * step + 8)
        bw = max(8, int(step * 0.36))
        h1 = int((ct / ymax) * (y1 - y0))
        h2 = int((obs_c / ymax) * (y1 - y0))
        draw.rectangle([bx, y1 - h1, bx + bw, y1], fill=(56, 189, 248))
        draw.rectangle([bx + bw + 2, y1 - h2, bx + 2 * bw + 2, y1], fill=(251, 191, 36))
        draw.text((bx - 2, y1 + 8), cid.replace("CAM-", "C"), fill=(220, 232, 245), font=f_sm)
        if ct > 0:
            draw.text((bx, y1 - h1 - 16), str(ct), fill=(180, 225, 250), font=f_sm)

    out_p = OUT_DIR / "sanyang_camera_coverage_peak.png"
    img.save(str(out_p))
    print(f"[Viz] Saved {out_p.name}")


# ---------------------------------------------------------------------------
# 6. 生成独立离线 HTML5 交互回放页（零依赖，双击即可在浏览器体验）
# ---------------------------------------------------------------------------
def build_interactive_html(env: dict, res: dict):
    # 将四级底图编码为轻量的 Canvas 绘制矩形/PNG base64
    import base64
    import io

    base = Image.new("RGB", (GRID_W, GRID_H), (18, 27, 39))
    px = base.load()
    tier_bg = [(102, 66, 48), (88, 79, 46), (34, 92, 90), (28, 86, 126)]
    walkable = env["walkable"]
    for gy in range(GRID_H):
        off = gy * GRID_W
        iy = GRID_H - 1 - gy
        for gx in range(GRID_W):
            for ti in (3, 2, 1, 0):
                if walkable[ti][off + gx]:
                    px[gx, iy] = tier_bg[ti]
                    break
    buf = io.BytesIO()
    base.save(buf, format="PNG")
    bg_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    # 28 台相机 FOV 局部坐标多边形
    frame: LocalFrame = env["frame"]
    cams_js = []
    for c in env["cameras"]:
        pts = [frame.to_local(p[0], p[1]) for p in c["fov_polygon_utm50n"]]
        cams_js.append({
            "id": c["camera_id"],
            "name": c["name"],
            "tier": c["elevation_tier_m"],
            "x": round(c["x_local"], 1),
            "y": round(c["y_local"], 1),
            "poly": [[round(a, 1), round(b, 1)] for a, b in pts[::2]],
        })

    gates_js = [
        {"id": gid, "x": round(xy[0], 1), "y": round(xy[1], 1)}
        for gid, xy in env["gates_loc"].items()
    ]
    zones_js = [
        {"id": z[0], "name": z[1], "elev": z[2], "area": round(env["zone_areas"][i], 0)}
        for i, z in enumerate(ZONES_META)
    ]

    payload = {
        "grid": {"w": GRID_W, "h": GRID_H, "cell": CELL_M, "xmin": X_MIN_LOC, "ymin": Y_MIN_LOC},
        "bg_png": bg_b64,
        "gates": gates_js,
        "zones": zones_js,
        "cameras": cams_js,
        "frames_24h": res["html_frames_24h"],
        "peak_chrysanthemum": res["html_peak_slices"]["chrysanthemum"],
        "peak_evening": res["html_peak_slices"]["evening"],
        "summary": res["summary_metrics"],
    }

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>SkyGuard · 三阳广场 24 小时人流与菊花会情景离线回放</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: #0d1520; color: #e2ecf6; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; display: flex; height: 100vh; overflow: hidden; }}
  #left {{ flex: 1; display: flex; flex-direction: column; padding: 12px 16px; gap: 10px; min-width: 0; }}
  #right {{ width: 390px; background: #131e2d; border-left: 1px solid #24364d; padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }}
  .header {{ display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }}
  .header h1 {{ font-size: 18px; color: #f8fafc; }}
  .badge {{ background: #1e3a5f; color: #7dd3fc; padding: 3px 9px; border-radius: 999px; font-size: 12px; }}
  .toolbar {{ display: flex; gap: 8px; flex-wrap: wrap; align-items: center; background: #131e2d; padding: 8px 12px; border-radius: 8px; border: 1px solid #24364d; }}
  button, select, input[type=text] {{ background: #1c2c42; color: #e2ecf6; border: 1px solid #334d6e; border-radius: 6px; padding: 5px 10px; font-size: 13px; cursor: pointer; }}
  button:hover {{ background: #274060; }}
  button.active {{ background: #d97706; border-color: #fbbf24; color: #fff; font-weight: 600; }}
  .canvas-wrap {{ flex: 1; display: flex; justify-content: center; align-items: center; background: #0a1019; border: 1px solid #24364d; border-radius: 8px; position: relative; overflow: hidden; }}
  canvas {{ max-height: 100%; max-width: 100%; cursor: crosshair; }}
  .timeline {{ background: #131e2d; padding: 10px 14px; border-radius: 8px; border: 1px solid #24364d; display: flex; flex-direction: column; gap: 6px; }}
  .tl-row {{ display: flex; align-items: center; gap: 10px; }}
  input[type=range] {{ flex: 1; accent-color: #fbbf24; }}
  .card {{ background: #182638; border: 1px solid #263a52; border-radius: 8px; padding: 10px 12px; }}
  .card h3 {{ font-size: 14px; color: #93c5fd; margin-bottom: 8px; }}
  .kpi-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }}
  .kpi {{ background: #111c2b; border-radius: 6px; padding: 8px; }}
  .kpi .v {{ font-size: 20px; font-weight: 700; color: #fbbf24; }}
  .kpi .l {{ font-size: 11px; color: #94a3b8; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 12px; }}
  th, td {{ padding: 4px 5px; border-bottom: 1px solid #223348; text-align: left; }}
  th {{ color: #94a3b8; }}
  .num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  .legend {{ display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; color: #cbd5e1; }}
  .dot {{ display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px; }}
</style>
</head>
<body>
<div id="left">
  <div class="header">
    <h1>SkyGuard · 三阳广场 24h 人流与菊花会情景回放（带 person_id）</h1>
    <span class="badge" id="modeBadge">24h 全天宏观模式（每 5 分钟）</span>
  </div>
  <div class="toolbar">
    <button id="btnPlay">▶ 播放</button>
    <select id="modeSel">
      <option value="24h">24h 全天（00:00–24:00）</option>
      <option value="chrysanthemum">菊花会下午高峰 15:30 精细片段</option>
      <option value="evening">晚饭后最高峰 19:30 精细片段</option>
    </select>
    <button onclick="jumpTime(7.5)">07:30 晨练</button>
    <button onclick="jumpTime(12.5)">12:30 午饭低谷</button>
    <button onclick="jumpTime(15.6)">15:35 菊花会</button>
    <button onclick="jumpTime(19.75)">19:45 晚饭后峰值</button>
    <label style="font-size:12px;"><input type="checkbox" id="chkHeat" checked /> 热力叠加</label>
    <label style="font-size:12px;"><input type="checkbox" id="chkCam" checked /> 28 机位 FOV</label>
    <input type="text" id="pidSearch" placeholder="搜索 person_id 如 P015000" style="width:165px;" />
  </div>
  <div class="canvas-wrap">
    <canvas id="mapCanvas" width="570" height="1185"></canvas>
  </div>
  <div class="timeline">
    <div class="tl-row">
      <strong id="timeLabel" style="font-size:18px; color:#fbbf24; min-width:82px;">00:00</strong>
      <input type="range" id="slider" min="0" max="287" value="187" />
      <span id="countLabel" style="font-size:14px; min-width:110px; text-align:right;">在园：0 人</span>
    </div>
    <canvas id="curveCanvas" width="900" height="72" style="width:100%; height:72px; border-radius:4px; background:#0d1624;"></canvas>
  </div>
</div>

<div id="right">
  <div class="card">
    <h3>全天核心指标（菊花会情景日）</h3>
    <div class="kpi-grid">
      <div class="kpi"><div class="v" id="kTotal">-</div><div class="l">全天独立 person_id</div></div>
      <div class="kpi"><div class="v" id="kNow">-</div><div class="l">当前同时在园人数</div></div>
      <div class="kpi"><div class="v" id="kAft">-</div><div class="l">菊花会下午高峰</div></div>
      <div class="kpi"><div class="v" id="kEve">-</div><div class="l">晚饭后全天最高峰</div></div>
    </div>
  </div>
  <div class="card">
    <h3>图例与点选追踪</h3>
    <div class="legend">
      <span><i class="dot" style="background:#34d399"></i>晨练</span>
      <span><i class="dot" style="background:#fbbf24"></i>菊花会观展</span>
      <span><i class="dot" style="background:#f472b6"></i>晚饭后纳凉</span>
      <span><i class="dot" style="background:#60a5fa"></i>日常散步</span>
      <span><i class="dot" style="background:#cbd5e1"></i>绿道过境</span>
    </div>
    <div id="pidInfo" style="margin-top:8px; font-size:12px; color:#7dd3fc;">点击地图上任意行人群点，或在顶部输入 person_id 高亮查看。</div>
  </div>
  <div class="card">
    <h3>12 个功能分区实时人数与密度</h3>
    <table>
      <thead><tr><th>分区</th><th class="num">人数</th><th class="num">密度(人/m²)</th></tr></thead>
      <tbody id="zoneTbody"></tbody>
    </table>
  </div>
  <div class="card">
    <h3>28 台虚拟摄像头视场实时人数（Top 10）</h3>
    <table>
      <thead><tr><th>机位</th><th>层级</th><th class="num">视场人数</th></tr></thead>
      <tbody id="camTbody"></tbody>
    </table>
  </div>
</div>

<script>
const DATA = {json.dumps(payload, ensure_ascii=False, separators=(",", ":"))};
const PROF_COLOR = {{ m: "#34d399", c: "#fbbf24", e: "#f472b6", d: "#60a5fa", p: "#cbd5e1" }};
const PROF_NAME = {{ m: "晨练/太极", c: "菊花会观展", e: "晚饭后纳凉", d: "日常散步", p: "绿道过境" }};
const TIER_M = [31.0, 28.8, 25.0, 23.0];

const mapCanvas = document.getElementById("mapCanvas");
const ctx = mapCanvas.getContext("2d");
const curveCanvas = document.getElementById("curveCanvas");
const cctx = curveCanvas.getContext("2d");

const bgImg = new Image();
bgImg.src = "data:image/png;base64," + DATA.bg_png;

let mode = "24h";
let frameIdx = 187; // 默认打开即停在 15:35 菊花会下午高峰！
let playing = false;
let timer = null;
let highlightPid = "";

document.getElementById("kTotal").textContent = DATA.summary.total_unique_persons.toLocaleString();
document.getElementById("kAft").textContent = DATA.summary.afternoon_chrysanthemum_peak.toLocaleString();
document.getElementById("kEve").textContent = DATA.summary.evening_all_day_peak.toLocaleString();

function getFrames() {{
  if (mode === "chrysanthemum") return DATA.peak_chrysanthemum;
  if (mode === "evening") return DATA.peak_evening;
  return DATA.frames_24h;
}}

function locToCanvas(lx, ly) {{
  const g = DATA.grid;
  const sx = ((lx - g.xmin) / g.cell) * 3;
  const sy = (g.h - 1 - ((ly - g.ymin) / g.cell)) * 3;
  return [sx, sy];
}}

function drawCurve() {{
  const w = curveCanvas.width, h = curveCanvas.height;
  cctx.clearRect(0, 0, w, h);
  const fs = DATA.frames_24h;
  const maxN = Math.max(...fs.map(f => f.n), 100);
  cctx.strokeStyle = "#38bdf8";
  cctx.lineWidth = 2;
  cctx.beginPath();
  fs.forEach((f, i) => {{
    const x = (i / (fs.length - 1)) * w;
    const y = h - 6 - (f.n / maxN) * (h - 14);
    if (i === 0) cctx.moveTo(x, y); else cctx.lineTo(x, y);
  }});
  cctx.stroke();

  const curF = getFrames()[frameIdx];
  const cx = (curF.s / 86400) * w;
  cctx.strokeStyle = "#fbbf24";
  cctx.lineWidth = 2;
  cctx.beginPath(); cctx.moveTo(cx, 0); cctx.lineTo(cx, h); cctx.stroke();
}}

function render() {{
  const fs = getFrames();
  if (frameIdx >= fs.length) frameIdx = 0;
  const f = fs[frameIdx];
  document.getElementById("slider").max = fs.length - 1;
  document.getElementById("slider").value = frameIdx;
  document.getElementById("timeLabel").textContent = f.t;
  document.getElementById("countLabel").textContent = "在园：" + f.n.toLocaleString() + " 人";
  document.getElementById("kNow").textContent = f.n.toLocaleString();

  ctx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bgImg, 0, 0, mapCanvas.width, mapCanvas.height);

  // 热力叠加
  if (document.getElementById("chkHeat").checked) {{
    ctx.save();
    for (const pt of f.p) {{
      const [sx, sy] = locToCanvas(pt[0], pt[1]);
      const grad = ctx.createRadialGradient(sx, sy, 1, sx, sy, 15);
      grad.addColorStop(0, "rgba(255, 120, 20, 0.24)");
      grad.addColorStop(1, "rgba(255, 120, 20, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(sx - 15, sy - 15, 30, 30);
    }}
    ctx.restore();
  }}

  // 28 机位 FOV
  if (document.getElementById("chkCam").checked) {{
    ctx.save();
    ctx.strokeStyle = "rgba(125, 211, 252, 0.35)";
    ctx.fillStyle = "rgba(56, 189, 248, 0.06)";
    ctx.lineWidth = 1;
    for (const c of DATA.cameras) {{
      ctx.beginPath();
      c.poly.forEach((p, idx) => {{
        const [sx, sy] = locToCanvas(p[0], p[1]);
        if (idx === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }});
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    }}
    ctx.restore();
  }}

  // 逐人点位
  let foundPt = null;
  for (const pt of f.p) {{
    const [sx, sy] = locToCanvas(pt[0], pt[1]);
    const isHi = highlightPid && pt[4] === highlightPid;
    ctx.fillStyle = isHi ? "#ffffff" : (PROF_COLOR[pt[3]] || "#fff");
    ctx.beginPath();
    ctx.arc(sx, sy, isHi ? 5.5 : 2.3, 0, Math.PI * 2);
    ctx.fill();
    if (isHi) {{
      ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 2; ctx.stroke();
      foundPt = pt;
    }}
  }}
  if (highlightPid) {{
    document.getElementById("pidInfo").textContent = foundPt
      ? `命中 ${{foundPt[4]}} | 类型：${{PROF_NAME[foundPt[3]]}} | 高程：${{TIER_M[foundPt[2]]}}m | 局部坐标：(${{foundPt[0]}}, ${{foundPt[1]}})`
      : `当前时刻 ${{f.t}} 未在抽样帧中命中 ${{highlightPid}}（可能已离园或未入园）`;
  }}

  // 闸口标记
  for (const g of DATA.gates) {{
    const [sx, sy] = locToCanvas(g.x, g.y);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(sx - 5, sy - 5, 10, 10);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText(g.id, sx + 8, sy + 4);
  }}

  // 更新右侧分区与相机表（24h 模式有完整 12 区与 28 机位统计）
  if (f.z) {{
    const ztb = document.getElementById("zoneTbody");
    ztb.innerHTML = DATA.zones.map((zm, i) => {{
      const cnt = f.z[i];
      const dens = zm.area > 0 ? (cnt / zm.area).toFixed(4) : "0";
      return `<tr><td>${{zm.name}}</td><td class="num">${{cnt}}</td><td class="num">${{dens}}</td></tr>`;
    }}).join("");
  }}
  if (f.c) {{
    const ranked = DATA.cameras.map((cm, i) => ({{ id: cm.id, tier: cm.tier, n: f.c[i] }}))
      .sort((a, b) => b.n - a.n).slice(0, 10);
    document.getElementById("camTbody").innerHTML = ranked.map(r =>
      `<tr><td>${{r.id}}</td><td>${{r.tier}}m</td><td class="num">${{r.n}}</td></tr>`
    ).join("");
  }}
  drawCurve();
}}

function jumpTime(hourFloat) {{
  mode = "24h";
  document.getElementById("modeSel").value = "24h";
  document.getElementById("modeBadge").textContent = "24h 全天宏观模式（每 5 分钟）";
  frameIdx = Math.min(DATA.frames_24h.length - 1, Math.round(hourFloat * 12));
  render();
}}

document.getElementById("slider").addEventListener("input", e => {{ frameIdx = +e.target.value; render(); }});
document.getElementById("modeSel").addEventListener("change", e => {{
  mode = e.target.value;
  frameIdx = 0;
  document.getElementById("modeBadge").textContent =
    mode === "24h" ? "24h 全天宏观模式（每 5 分钟）" :
    (mode === "chrysanthemum" ? "菊花会下午高峰 15:30 精细轨迹" : "晚饭后最高峰 19:30 精细轨迹");
  render();
}});
document.getElementById("chkHeat").addEventListener("change", render);
document.getElementById("chkCam").addEventListener("change", render);
document.getElementById("pidSearch").addEventListener("input", e => {{ highlightPid = e.target.value.trim().toUpperCase(); render(); }});
document.getElementById("btnPlay").addEventListener("click", () => {{
  playing = !playing;
  document.getElementById("btnPlay").textContent = playing ? "⏸ 暂停" : "▶ 播放";
  if (playing) {{
    timer = setInterval(() => {{
      const fs = getFrames();
      frameIdx = (frameIdx + 1) % fs.length;
      render();
    }}, 140);
  }} else {{
    clearInterval(timer);
  }}
}});
mapCanvas.addEventListener("click", e => {{
  const rect = mapCanvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (mapCanvas.width / rect.width);
  const my = (e.clientY - rect.top) * (mapCanvas.height / rect.height);
  const f = getFrames()[frameIdx];
  let best = null, bestD = 18;
  for (const pt of f.p) {{
    const [sx, sy] = locToCanvas(pt[0], pt[1]);
    const d = Math.hypot(sx - mx, sy - my);
    if (d < bestD) {{ bestD = d; best = pt; }}
  }}
  if (best) {{
    highlightPid = best[4];
    document.getElementById("pidSearch").value = highlightPid;
    render();
  }}
}});
bgImg.onload = render;
</script>
</body>
</html>
"""
    out_html = OUT_DIR / "sanyang_crowd_replay.html"
    out_html.write_text(html, encoding="utf-8")
    print(f"[Viz] Saved {out_html.name} ({out_html.stat().st_size / 1024:.0f} KB)")


def write_summary_and_readme(env: dict, res: dict):
    summary = {
        "scene_id": "hankou_sanyang_chrysanthemum_24h",
        "sim_date_bj": SIM_DATE_STR,
        "seed": SEED,
        "crs_metric": "EPSG:32650",
        "crs_geographic": "WGS84",
        "total_walkable_area_m2": round(sum(env["zone_areas"]), 1),
        "total_walkable_area_m2_excluding_lowest_tier": round(
            sum(env["zone_areas"]) - env["lowest_tier"]["walkable_area_m2"], 1
        ),
        "lowest_tier_provenance": env["lowest_tier"],
        "zones": [
            {"zone_id": z[0], "zone_name": z[1], "elevation_m": z[2], "walkable_area_m2": round(env["zone_areas"][i], 1)}
            for i, z in enumerate(ZONES_META)
        ],
        "cameras_count": len(env["cameras"]),
        "metrics": res["summary_metrics"],
        "peak_1hz_slices": res["peak_stats"],
    }
    (OUT_DIR / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    sm = res["summary_metrics"]
    lt = env["lowest_tier"]
    if lt["included"]:
        lowest_tier_note = (
            f"- **最低亲水层状态**：该层源数据标 `{lt['source_elevation_m']:.1f}m`、现场尚未核实究竟是 "
            f"`{lt['source_elevation_m']:.1f}m` 还是 `{lt['declared_elevation_m']:.1f}m`（`{lt['status']}`）。"
            f"本次以 `{lt['policy']}` 策略运行，纳入 `{lt['walkable_area_m2']:,.0f} m²`，并生成 "
            f"`{'/'.join(lt['vertical_links'])}` 三处季节性连接（**情景假设，非源数据实测台阶**）。"
            f"`map-v2/hankou_full_connectivity_audit.md` 的 `active_baseline` 口径下该层保持封控，"
            f"引用本数据集时必须保留此标注。"
        )
    else:
        lowest_tier_note = (
            f"- **最低亲水层状态**：该层源数据标 `{lt['source_elevation_m']:.1f}m`、现场尚未核实究竟是 "
            f"`{lt['source_elevation_m']:.1f}m` 还是 `{lt['declared_elevation_m']:.1f}m`（`{lt['status']}`）。"
            f"本次以 `{lt['policy']}` 策略运行，该层**不纳入**可通行面，与 "
            f"`map-v2/hankou_full_connectivity_audit.md` 的 `active_baseline` 一致。"
        )
    readme = f"""# 汉口江滩 · 三阳核心演示段 24 小时人流与 28 机位模拟数据集

- **情景设定**：`{SIM_DATE_STR}`（北京时间 00:00–24:00），日常汉口江滩时间规律 + **三阳广场金秋菊花会下午大客流** + **晚饭后全天最高峰**。
- **底图来源**：严格约束在 `hankou_full_4tier_utm50n.geojson` 四级高程可通行面（`31.0m` / `28.8m` / `25.0m` / `23.0m RIVER_WALK`）内，仅经合法坡道/台阶跨层。
{lowest_tier_note}
- **机位来源**：直接读取 `sanyang_cameras_v1.json` 清洗后的 28 台虚拟摄像头（27 固定 + `UAV-01`）。

## 核心统计

- 全天独立行人 `person_id`：**{sm['total_unique_persons']:,} 人**（`P000001` – `P{sm['total_unique_persons']:06d}`）
- 晨练早高峰（06:00–09:00）：**{sm['morning_peak']:,} 人**
- 午饭回落低谷（11:45–13:15）：**{sm['lunch_valley_min']:,} 人**
- 菊花会下午高峰（{sm['afternoon_peak_time_bj']}）：**{sm['afternoon_chrysanthemum_peak']:,} 人**
- 晚饭后全天最高峰（{sm['evening_peak_time_bj']}）：**{sm['evening_all_day_peak']:,} 人**

## 交付文件一览

| 文件 | 说明 |
| :--- | :--- |
| `sanyang_crowd_replay.html` | **独立离线交互回放页**（浏览器直接打开，支持 24h 时间轴、热力、28 机位 FOV、点击/搜索 `person_id`） |
| `sanyang_24h_crowd_curve.png` | 24 小时总人数曲线、5 类人群堆叠图与重点分区人数曲线 |
| `sanyang_spatial_heatmaps_4periods.png` | 07:30 / 12:30 / 15:35 菊花会 / 19:45 晚饭后四大时段空间分布四联图 |
| `sanyang_camera_coverage_peak.png` | 28 台虚拟摄像头在 19:45 最高峰的视场真值与模拟观测对比图 |
| `person_manifest.csv` | 全天所有独立 `person_id` 的入园/出园时间、门洞、画像与主逛区 |
| `region_stats_5s.csv` | 全天 24 小时、每 5 秒（17,280 窗口）× 12 分区的人数、密度、进出流量与平均速度 |
| `region_state_batch_5s.jsonl` | 5 秒全区状态批次流（每行一条记录），字段契约见 `crowd-sim/region_state_batch.schema.json` |
| `camera_stats_28cams_5s.csv` | 28 台虚拟摄像头全天 24 小时每 5 秒的视场真值与模拟观测统计 |
| `trajectories_24h_30s.csv` | 全天 24 小时每 30 秒的逐人 `person_id` 位置/高程/速度/分区快照（{sm['trajectories_24h_30s_rows']:,} 行） |
| `trajectories_peak_chrysanthemum_1hz.csv` | 菊花会下午高峰（15:30–15:45）1Hz 逐人 `person_id` 精细轨迹 |
| `camera_tracks_peak_chrysanthemum_1hz.csv` | 菊花会下午高峰（15:30–15:45）28 机位 1Hz 逐人观测（含 `track_id_local` 与 `person_id_gt`） |
| `trajectories_peak_evening_1hz.csv` | 晚饭后最高峰（19:30–19:45）1Hz 逐人 `person_id` 精细轨迹 |
| `camera_tracks_peak_evening_1hz.csv` | 晚饭后最高峰（19:30–19:45）28 机位 1Hz 逐人观测（含 `track_id_local` 与 `person_id_gt`） |
| `summary.json` | 机器可读的统计汇总与分区面积表 |
"""
    (OUT_DIR / "README.md").write_text(readme, encoding="utf-8")


def main():
    t_all = time.time()
    check_inputs()
    print(f"[Env] inputs={MAP_V2_DIR} | out={OUT_DIR} | lowest_tier={LOWEST_TIER_POLICY}")
    env = build_environment()
    nav = build_navigation(env)
    agents = generate_agents(env, nav)
    res = run_exports(env, agents)
    render_24h_curve_png(res)
    render_spatial_4periods_png(env, res)
    render_camera_bar_png(res)
    build_interactive_html(env, res)
    write_summary_and_readme(env, res)
    print(f"[DONE] All Sanyang 24h simulation artifacts built in {time.time() - t_all:.1f}s -> {OUT_DIR}")


if __name__ == "__main__":
    main()
