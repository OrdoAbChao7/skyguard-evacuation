#!/usr/bin/env python3
"""
SkyGuard · 真实 z18 卫星底图 + 宏观地形图风格（人越多越红 + 等高线）28 机位人流可视化
==================================================================================
1. 精确将 z18 真实卫星图（sanyang_sat_z18.jpg）按 EPSG:3857 -> WGS84 -> EPSG:32650 -> 局部坐标
   逐块网格重投影至三阳核心演示段（零线性拉伸偏差）；
2. 仅使用 28 台虚拟摄像头真实可见观测数据，计算核密度地形场（KDE）+ 西北向山体阴影（Hillshade）
   + 经典地形图色带（低密度浅绿 -> 黄 -> 橙 -> 高密度深红）+ 清晰等密线（等高线）；
3. 导出：
   - sanyang_sat_topo_showcase.png（三时段卫星地形热力对照图：07:30 晨练 / 15:35 菊花会 / 19:35 晚饭后）
   - sanyang_sat_topo_terrain_replay.html（零依赖离线交互网页：卫星图/四级高程底图可切换 + 实时地形热力
     + 等高线 + 1Hz 观测移动点 + UAV-01 补盲开关）

前置条件：
   - 先运行 build_camera_observed_view.py，生成本脚本读取的
     `<out>/camera_observed_replay_payload.json`（1Hz 与 24h 观测帧的 JSON 中间产物）。
   - z18 卫星底图 `sanyang_sat_z18.jpg/.json` 不随仓库分发，需放到
     `<package>/map-v2/satellite/`（或由 `SKYGUARD_SAT_DIR` 指向的目录）。
     缺图时本脚本会给出明确报错，而不是直接抛给 Pillow。
"""
from __future__ import annotations

import base64
import csv
import io
import json
import math
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_sanyang_crowd_sim as sim

OUT_DIR = sim.OUT_DIR
# 卫星底图不随仓库分发（体积大且来源受限），默认从 map-v2/satellite/ 读取。
SAT_DIR = Path(os.environ.get("SKYGUARD_SAT_DIR", sim.MAP_V2_DIR / "satellite")).resolve()
SAT_JPG = SAT_DIR / "sanyang_sat_z18.jpg"
SAT_META = SAT_DIR / "sanyang_sat_z18.json"

# 上游 build_camera_observed_view.py 写出的 JSON 中间产物（本脚本不再解析它生成的 HTML）
CAM_PAYLOAD_JSON = OUT_DIR / "camera_observed_replay_payload.json"

# ---------------------------------------------------------------------------
# 1. 精确 z18 卫星图重投影（PIL Image.MESH 8x16 子网格，C 速度 + 厘米级精度）
# ---------------------------------------------------------------------------
def warp_satellite_to_local_pil(frame: sim.LocalFrame, out_w: int, out_h: int) -> Image.Image:
    missing = [p for p in (SAT_JPG, SAT_META) if not p.is_file()]
    if missing:
        raise SystemExit(
            "缺少 z18 卫星底图（不随仓库分发）：\n  " + "\n  ".join(str(p) for p in missing)
            + f"\n请把 sanyang_sat_z18.jpg / sanyang_sat_z18.json 放到 {SAT_DIR}，"
              "或用环境变量 SKYGUARD_SAT_DIR 指向包含它们的目录。"
        )
    sat_img = Image.open(str(SAT_JPG)).convert("RGB")
    meta = json.loads(SAT_META.read_text(encoding="utf-8"))
    z = meta["zoom"]
    n_tiles = 2.0 ** z
    x0_t, y0_t = meta["x0"], meta["y0"]

    def out_px_to_sat_px(ox: float, oy: float) -> tuple[float, float]:
        lx = sim.X_MIN_LOC + (ox / out_w) * (sim.X_MAX_LOC - sim.X_MIN_LOC)
        ly = sim.Y_MAX_LOC - (oy / out_h) * (sim.Y_MAX_LOC - sim.Y_MIN_LOC)
        ux, uy = frame.to_utm(lx, ly)
        lon, lat = sim.utm50n_to_wgs84(ux, uy)
        lat_rad = math.radians(lat)
        tx = (lon + 180.0) / 360.0 * n_tiles
        ty = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n_tiles
        mx = (tx - x0_t) * 256.0 - 0.5
        my = (ty - y0_t) * 256.0 - 0.5
        return (mx, my)

    nx, ny = 8, 16
    mesh = []
    for j in range(ny):
        y0 = int(round(j * out_h / ny))
        y1 = int(round((j + 1) * out_h / ny))
        for i in range(nx):
            x0 = int(round(i * out_w / nx))
            x1 = int(round((i + 1) * out_w / nx))
            # Pillow QUAD order: NW, SW, SE, NE
            nw = out_px_to_sat_px(x0, y0)
            sw = out_px_to_sat_px(x0, y1)
            se = out_px_to_sat_px(x1, y1)
            ne = out_px_to_sat_px(x1, y0)
            mesh.append(((x0, y0, x1, y1), (nw[0], nw[1], sw[0], sw[1], se[0], se[1], ne[0], ne[1])))

    return sat_img.transform((out_w, out_h), Image.MESH, mesh, resample=Image.BILINEAR)


# ---------------------------------------------------------------------------
# 2. 地形图色带（越低越绿 -> 黄 -> 橙 -> 越高越红）+ 高斯平滑 + 等高线 + 山体阴影
# ---------------------------------------------------------------------------
TOPO_STOPS = [
    (0.00, (34, 197, 94)),    # 翠绿（低密度）
    (0.22, (132, 204, 22)),   # 黄绿
    (0.42, (250, 204, 21)),   # 明黄
    (0.62, (249, 115, 22)),   # 亮橙
    (0.82, (239, 68, 68)),    # 赤红
    (1.00, (153, 27, 27)),    # 深暗红（极高密度“山峰”）
]


def topo_color(v: float) -> tuple[int, int, int]:
    v = max(0.0, min(1.0, v))
    for i in range(len(TOPO_STOPS) - 1):
        t0, c0 = TOPO_STOPS[i]
        t1, c1 = TOPO_STOPS[i + 1]
        if v <= t1:
            f = (v - t0) / max(1e-6, t1 - t0)
            return (
                int(c0[0] + (c1[0] - c0[0]) * f),
                int(c0[1] + (c1[1] - c0[1]) * f),
                int(c0[2] + (c1[2] - c0[2]) * f),
            )
    return TOPO_STOPS[-1][1]


def compute_density_field(pts: list[tuple[float, float]], gw: int, gh: int, sigma_cells: float = 3.2) -> list[list[float]]:
    """在 2m 网格上做可分离 2D 高斯核密度估计，返回 人/m²（或归一化等效密度）。"""
    grid = [[0.0] * gw for _ in range(gh)]
    cell_area = sim.CELL_M * sim.CELL_M
    for lx, ly in pts:
        gx = int((lx - sim.X_MIN_LOC) / sim.CELL_M)
        gy = int((ly - sim.Y_MIN_LOC) / sim.CELL_M)
        if 0 <= gx < gw and 0 <= gy < gh:
            # 图像 y 轴向下
            grid[gh - 1 - gy][gx] += 1.0 / cell_area

    rad = int(math.ceil(sigma_cells * 2.6))
    kern = [math.exp(-0.5 * (k / sigma_cells) ** 2) for k in range(-rad, rad + 1)]
    ksum = sum(kern)
    kern = [k / ksum for k in kern]

    # 水平卷积
    tmp = [[0.0] * gw for _ in range(gh)]
    for y in range(gh):
        row = grid[y]
        trow = tmp[y]
        for x in range(gw):
            v = row[x]
            if v == 0.0:
                continue
            for k in range(-rad, rad + 1):
                nx = x + k
                if 0 <= nx < gw:
                    trow[nx] += v * kern[k + rad]

    # 垂直卷积
    out = [[0.0] * gw for _ in range(gh)]
    for y in range(gh):
        for k in range(-rad, rad + 1):
            ny = y + k
            if 0 <= ny < gh:
                w = kern[k + rad]
                src = tmp[ny]
                dst = out[y]
                for x in range(gw):
                    if src[x] > 0.0:
                        dst[x] += src[x] * w
    return out


def render_topo_overlay(field: list[list[float]], vmax: float = 0.28, levels: tuple[float, ...] = (0.015, 0.04, 0.08, 0.14, 0.21, 0.30)) -> Image.Image:
    """将密度场渲染为 RGBA 地形图图层（含山体阴影 + 阶梯色带 + 等高线）。"""
    gh = len(field)
    gw = len(field[0])
    img = Image.new("RGBA", (gw, gh), (0, 0, 0, 0))
    px = img.load()

    # 预计算每格所处等高线层级，用于高效画清晰等高线
    lvl_map = [[0] * gw for _ in range(gh)]
    min_show = levels[0] * 0.45

    for y in range(gh):
        row = field[y]
        lrow = lvl_map[y]
        for x in range(gw):
            v = row[x]
            lv = 0
            for th in levels:
                if v >= th:
                    lv += 1
            lrow[x] = lv

    for y in range(gh):
        row = field[y]
        lrow = lvl_map[y]
        for x in range(gw):
            v = row[x]
            if v < min_show:
                continue
            # 非线性伽马映射让中低密度也有丰富绿/黄过渡，高密度直冲赤红
            norm = min(1.0, (v / vmax) ** 0.72)
            r, g, b = topo_color(norm)

            # 西北方向地形阴影（Hillshade），增强 3D 地形起伏感
            dx = (row[min(gw - 1, x + 1)] - row[max(0, x - 1)]) / vmax
            dy = (field[min(gh - 1, y + 1)][x] - field[max(0, y - 1)][x]) / vmax
            shade = max(0.76, min(1.18, 1.0 - (dx + dy) * 1.45))
            r = min(255, int(r * shade))
            g = min(255, int(g * shade))
            b = min(255, int(b * shade))

            # 等高线检测（相邻格跨越层级 -> 绘制清晰深棕/暗红等高线）
            lv = lrow[x]
            is_contour = (
                (x + 1 < gw and lrow[x + 1] != lv)
                or (y + 1 < gh and lvl_map[y + 1][x] != lv)
            )
            if is_contour and lv >= 1:
                if lv >= 4:
                    px[x, y] = (255, 245, 225, 235)  # 高密度红峰用亮米白等高线更醒目
                else:
                    px[x, y] = (45, 25, 18, 200)     # 中低密度用经典地形棕黑等高线
            else:
                alpha = int(105 + 115 * norm)  # 越密越实，低密度半透明透出卫星地物
                px[x, y] = (r, g, b, alpha)

    return img


# ---------------------------------------------------------------------------
# 3. 渲染三时段卫星+地形热力验收对比图 PNG
# ---------------------------------------------------------------------------
def build_showcase_png(env: dict, sat_panel_base: Image.Image, snaps: dict[str, tuple[str, list[tuple[float, float]]]]):
    PW, PH = 440, 860
    W = PW * 3 + 285
    H = PH + 125
    BG = (12, 18, 28)
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    f_title = sim.load_font(26)
    f_sub = sim.load_font(16)
    f_sm = sim.load_font(13)

    draw.text((28, 20), "三阳核心演示段 | 真实 z18 卫星图叠加「28 机位观测人群地形热力图」（人越多越红 + 等高线）", fill=(240, 246, 252), font=f_title)
    draw.text((28, 56), "仅由 28 台虚拟摄像头视野内观测点生成核密度地形场（盲区透明透出真实卫星底图）；绿色=稀疏  ->  黄色=中等  ->  橙红/深红=高密度高峰", fill=(160, 192, 220), font=f_sub)

    frame: sim.LocalFrame = env["frame"]
    # 稍微压暗一点卫星图（0.82 亮度）让地形热力和等高线极度通透立体
    sat_dim = ImageEnhance.Brightness(sat_panel_base).enhance(0.84)

    # 预绘制极细摄像头扇区轮廓图层
    fov_layer = Image.new("RGBA", sat_dim.size, (0, 0, 0, 0))
    fd = ImageDraw.Draw(fov_layer)
    sx_scale = sat_dim.size[0] / sim.GRID_W
    sy_scale = sat_dim.size[1] / sim.GRID_H
    for c in env["cameras"]:
        pts = []
        for p in c["fov_polygon_utm50n"]:
            lx, ly = frame.to_local(p[0], p[1])
            gx, gy = sim.loc_to_grid(lx, ly)
            pts.append((gx * sx_scale, (sim.GRID_H - 1 - gy) * sy_scale))
        if len(pts) >= 3:
            is_uav = c["camera_type"] == "uav_mobile"
            outline = (110, 231, 183, 145) if is_uav else (186, 230, 253, 105)
            fd.polygon(pts, fill=(0, 0, 0, 0), outline=outline)

    order = ["morning", "chrysanthemum", "evening"]
    for idx, key in enumerate(order):
        title, pts = snaps[key]
        field = compute_density_field(pts, sim.GRID_W, sim.GRID_H, sigma_cells=3.4)
        topo_small = render_topo_overlay(field, vmax=0.26)
        topo_big = topo_small.resize(sat_dim.size, Image.BILINEAR)

        comp = Image.alpha_composite(sat_dim.convert("RGBA"), topo_big)
        comp = Image.alpha_composite(comp, fov_layer).convert("RGB")
        cdraw = ImageDraw.Draw(comp)

        # 标出三大闸口
        for gid, glbl in (("G09", "G09 三阳门"), ("G08", "G08 防洪碑"), ("G07", "G07 一元门")):
            gx, gy = sim.loc_to_grid(*env["gates_loc"][gid])
            sx, sy = int(gx * sx_scale), int((sim.GRID_H - 1 - gy) * sy_scale)
            cdraw.rectangle([sx - 4, sy - 4, sx + 4, sy + 4], fill=(239, 68, 68), outline=(255, 255, 255))
            cdraw.rectangle([sx + 6, sy - 9, sx + 82, sy + 9], fill=(15, 23, 34))
            cdraw.text((sx + 9, sy - 8), glbl, fill=(255, 235, 235), font=f_sm)

        ox = 24 + idx * (PW + 12)
        oy = 98
        img.paste(comp, (ox + 15, oy + 36))
        draw.rectangle([ox + 15, oy + 36, ox + 15 + comp.size[0], oy + 36 + comp.size[1]], outline=(70, 95, 122), width=1)
        tcol = (251, 191, 36) if key == "chrysanthemum" else ((248, 113, 113) if key == "evening" else (110, 231, 183))
        draw.text((ox + 15, oy + 6), f"{title}（可见观测 {len(pts):,} 人）", fill=tcol, font=f_sub)

    # 右侧独立地形图色带图例（Colorbar）
    cb_x = 24 + 3 * (PW + 12) + 18
    cb_y0, cb_y1 = 190, 760
    draw.text((cb_x - 6, cb_y0 - 52), "人群地形密度", fill=(235, 242, 250), font=f_sub)
    draw.text((cb_x - 6, cb_y0 - 28), "(人越多越红)", fill=(251, 146, 60), font=f_sm)
    for y in range(cb_y0, cb_y1):
        frac = 1.0 - (y - cb_y0) / (cb_y1 - cb_y0)
        col = topo_color(frac)
        draw.line([(cb_x, y), (cb_x + 32, y)], fill=col)
    draw.rectangle([cb_x, cb_y0, cb_x + 32, cb_y1], outline=(180, 200, 220), width=1)
    ticks = [
        (1.00, "极密高峰 (≥0.30/m²)"),
        (0.75, "高密红区 (0.20/m²)"),
        (0.50, "中密橙黄 (0.12/m²)"),
        (0.25, "缓流黄绿 (0.05/m²)"),
        (0.02, "稀疏绿区 (0.01/m²)"),
    ]
    for frac, tlbl in ticks:
        yy = int(cb_y1 - frac * (cb_y1 - cb_y0))
        draw.line([(cb_x + 32, yy), (cb_x + 38, yy)], fill=(200, 215, 230))
        draw.text((cb_x + 42, yy - 8), tlbl, fill=(215, 228, 242), font=f_sm)

    draw.text((cb_x - 6, cb_y1 + 26), "白线/棕线 = 等密线", fill=(200, 215, 230), font=f_sm)
    draw.text((cb_x - 6, cb_y1 + 48), "蓝框 = 固定机位FOV", fill=(125, 211, 252), font=f_sm)
    draw.text((cb_x - 6, cb_y1 + 70), "绿圈 = UAV-01补盲", fill=(110, 231, 183), font=f_sm)

    out_p = OUT_DIR / "sanyang_sat_topo_showcase.png"
    img.save(str(out_p))
    print(f"[Viz] Saved {out_p.name}")


# ---------------------------------------------------------------------------
# 4. 交互式真实卫星底图 + 实时地形等高热力图 HTML5 回放页
# ---------------------------------------------------------------------------
def build_sat_topo_html(env: dict, sat_img_570: Image.Image):
    """复用 build_camera_observed_view.py 写出的 1Hz/24h 观测帧 JSON，渲染为卫星+地形图实时页面。

    早期版本是从 `sanyang_camera_observed_replay.html` 里按字符串标记抠 JSON，既依赖脚本执行
    顺序，又会被载荷内容里的同名标记串截断；现在改为读取独立 JSON 中间产物。
    """
    if not CAM_PAYLOAD_JSON.is_file():
        raise SystemExit(
            f"缺少 {CAM_PAYLOAD_JSON}\n"
            "请先运行 crowd-sim/build_camera_observed_view.py（它会写出 camera_observed_replay_payload.json），"
            "再运行本脚本。"
        )
    data = json.loads(CAM_PAYLOAD_JSON.read_text(encoding="utf-8"))

    # 将高清晰 z18 卫星图编码为 JPEG base64 嵌入（~140 KB，高清又轻量！）
    buf = io.BytesIO()
    sat_img_570.save(buf, format="JPEG", quality=88)
    data["sat_jpg"] = base64.b64encode(buf.getvalue()).decode("ascii")

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>SkyGuard · 真实卫星底图 + 28 机位人群地形热力图（人越多越红）</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: #0a1019; color: #e2ecf6; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; display: flex; height: 100vh; overflow: hidden; }}
  #left {{ flex: 1; display: flex; flex-direction: column; padding: 12px 16px; gap: 10px; min-width: 0; }}
  #right {{ width: 390px; background: #111b29; border-left: 1px solid #24364d; padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }}
  .header {{ display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }}
  .header h1 {{ font-size: 18px; color: #f8fafc; }}
  .badge {{ background: #7f1d1d; color: #fecaca; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }}
  .toolbar {{ display: flex; gap: 8px; flex-wrap: wrap; align-items: center; background: #111b29; padding: 8px 12px; border-radius: 8px; border: 1px solid #24364d; }}
  button, select {{ background: #1c2c42; color: #e2ecf6; border: 1px solid #334d6e; border-radius: 6px; padding: 5px 10px; font-size: 13px; cursor: pointer; }}
  button:hover {{ background: #274060; }}
  .canvas-wrap {{ flex: 1; display: flex; justify-content: center; align-items: center; background: #060a10; border: 1px solid #24364d; border-radius: 8px; overflow: hidden; position: relative; }}
  canvas {{ max-height: 100%; max-width: 100%; cursor: crosshair; }}
  .timeline {{ background: #111b29; padding: 10px 14px; border-radius: 8px; border: 1px solid #24364d; display: flex; align-items: center; gap: 10px; }}
  input[type=range] {{ accent-color: #ef4444; }}
  .card {{ background: #162233; border: 1px solid #263a52; border-radius: 8px; padding: 10px 12px; }}
  .card h3 {{ font-size: 14px; color: #fca5a5; margin-bottom: 8px; }}
  .colorbar {{ height: 14px; border-radius: 4px; background: linear-gradient(90deg, #22c55e 0%, #84cc16 22%, #facc15 45%, #f97316 68%, #ef4444 85%, #991b1b 100%); margin: 6px 0; border: 1px solid #475569; }}
  .cb-labels {{ display: flex; justify-content: space-between; font-size: 11px; color: #cbd5e1; }}
  .kpi-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }}
  .kpi {{ background: #0e1724; border-radius: 6px; padding: 8px; }}
  .kpi .v {{ font-size: 20px; font-weight: 700; color: #f87171; }}
  .kpi .l {{ font-size: 11px; color: #94a3b8; }}
  .cam-grid {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }}
  .cam-btn {{ padding: 4px 2px; font-size: 11px; text-align: center; border-radius: 4px; background: #0f1927; border: 1px solid #293d57; color: #cbd5e1; cursor: pointer; }}
  .cam-btn.active {{ background: #dc2626; border-color: #fca5a5; color: #fff; font-weight: 700; }}
  .tip {{ font-size: 12px; color: #94a3b8; line-height: 1.55; }}
</style>
</head>
<body>
<div id="left">
  <div class="header">
    <h1>SkyGuard · 汉口江滩三阳段 z18 卫星图 + 地形图风格人流热力（仅 28 机位可见）</h1>
    <span class="badge">地形热力模式：人越多越红 + 实时等高线</span>
  </div>
  <div class="toolbar">
    <button id="btnPlay">⏸ 暂停</button>
    <select id="modeSel">
      <option value="chrysanthemum">菊花会下午高峰 15:30（真 1Hz 实时移动）</option>
      <option value="evening">晚饭后最高峰 19:30（真 1Hz 实时移动）</option>
      <option value="24h">全天 24 小时宏观（每 5 分钟）</option>
    </select>
    <select id="bgSel">
      <option value="sat_dark">真实卫星图（深色通透）</option>
      <option value="sat_raw">真实卫星图（原色高清）</option>
      <option value="tier">四级高程示意图</option>
    </select>
    <label style="font-size:12px;"><input type="checkbox" id="chkTopo" checked /> 地形热力(越密越红)</label>
    <label style="font-size:12px;"><input type="checkbox" id="chkContour" checked /> 等高线</label>
    <label style="font-size:12px;"><input type="checkbox" id="chkDots" checked /> 观测移动点</label>
    <label style="font-size:12px;"><input type="checkbox" id="chkFov" checked /> 机位FOV</label>
    <label style="font-size:12px;"><input type="checkbox" id="chkUav" checked /> UAV-01补盲</label>
  </div>
  <div class="canvas-wrap">
    <canvas id="mapCanvas" width="570" height="1185"></canvas>
  </div>
  <div class="timeline">
    <strong id="timeLabel" style="font-size:18px; color:#f87171; min-width:86px;">15:30:00</strong>
    <input type="range" id="slider" min="0" max="119" value="0" style="flex:1;" />
    <span style="font-size:12px; color:#94a3b8;">热力透明度</span>
    <input type="range" id="alphaSlider" min="25" max="100" value="80" style="width:90px;" />
  </div>
</div>

<div id="right">
  <div class="card">
    <h3>地形密度色带（越密越高越红）</h3>
    <div class="colorbar"></div>
    <div class="cb-labels"><span>稀疏(绿)</span><span>温和(黄)</span><span>密集(橙)</span><span>高峰(深红)</span></div>
    <div class="kpi-grid" style="margin-top:10px;">
      <div class="kpi"><div class="v" id="kObs">0</div><div class="l">视野内可见观测点</div></div>
      <div class="kpi"><div class="v" id="kPeak" style="color:#fbbf24">0</div><div class="l">热点最高局部强度</div></div>
    </div>
  </div>
  <div class="card">
    <h3>单机位隔离查看（默认 28 机位融合）</h3>
    <div style="margin-bottom:6px;"><button id="btnAllCams" style="width:100%;">显示全部 28 台机位融合地形热力</button></div>
    <div class="cam-grid" id="camGrid"></div>
  </div>
  <div class="card">
    <h3>效果说明</h3>
    <div class="tip">
      • <b>真实卫星底图对齐</b>：叠加汉口江滩三阳段 z18 航拍卫星图，道路、绿地、广场、长江岸线一目了然。<br/>
      • <b>宏观地形等高线风格</b>：按摄像头真实观测点实时计算平滑密度场，叠加西北山体阴影与等密线——人少的地方呈浅绿半透明，人越多的聚集区“海拔越高”越鲜红。<br/>
      • <b>严格盲区留白</b>：摄像头未覆盖的盲区不生成热力，关闭 <code>UAV-01补盲</code> 可立刻对比无人机补盲前后。
    </div>
  </div>
</div>

<script>
const DATA = {json.dumps(data, ensure_ascii=False, separators=(",", ":"))};
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");

const satImg = new Image();
satImg.src = "data:image/jpeg;base64," + DATA.sat_jpg;
const tierImg = new Image();
tierImg.src = "data:image/png;base64," + DATA.bg_png;

// 地形热力离线小画布（95x198 实时 KDE + 山体阴影 + 等高线，浏览器 60fps 极速渲染）
const KW = 95, KH = 198;
const heatCanvas = document.createElement("canvas");
heatCanvas.width = KW; heatCanvas.height = KH;
const hctx = heatCanvas.getContext("2d");
const hImgData = hctx.createImageData(KW, KH);

// 预计算 256 级地形色带查找表
const STOPS = [
  [0.00, [34, 197, 94]],
  [0.22, [132, 204, 22]],
  [0.42, [250, 204, 21]],
  [0.62, [249, 115, 22]],
  [0.82, [239, 68, 68]],
  [1.00, [153, 27, 27]],
];
const LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {{
  const v = i / 255;
  let r = 153, g = 27, b = 27;
  for (let s = 0; s < STOPS.length - 1; s++) {{
    const [t0, c0] = STOPS[s], [t1, c1] = STOPS[s + 1];
    if (v <= t1) {{
      const f = (v - t0) / Math.max(1e-6, t1 - t0);
      r = c0[0] + (c1[0] - c0[0]) * f;
      g = c0[1] + (c1[1] - c0[1]) * f;
      b = c0[2] + (c1[2] - c0[2]) * f;
      break;
    }}
  }}
  LUT[i * 3] = r; LUT[i * 3 + 1] = g; LUT[i * 3 + 2] = b;
}}

// 1D 高斯核（sigma = 2.1 格 ≈ 8.4m）
const RAD = 5;
const KERN = [];
let ksum = 0;
for (let k = -RAD; k <= RAD; k++) {{ const w = Math.exp(-0.5 * (k / 2.1) ** 2); KERN.push(w); ksum += w; }}
for (let i = 0; i < KERN.length; i++) KERN[i] /= ksum;

const field = new Float32Array(KW * KH);
const tmpF = new Float32Array(KW * KH);
const lvlArr = new Uint8Array(KW * KH);

let mode = "chrysanthemum";
let fIdx = 0;
let playing = true;
let selectedCam = -1;

const camGrid = document.getElementById("camGrid");
DATA.cameras.forEach(c => {{
  const b = document.createElement("div");
  b.className = "cam-btn";
  b.textContent = c.id.replace("CAM-", "C");
  b.title = c.name;
  b.onclick = () => {{ selectedCam = (selectedCam === c.idx) ? -1 : c.idx; updateCamBtns(); render(); }};
  camGrid.appendChild(b);
}});
function updateCamBtns() {{
  Array.from(camGrid.children).forEach((el, i) => el.classList.toggle("active", i === selectedCam));
}}
document.getElementById("btnAllCams").onclick = () => {{ selectedCam = -1; updateCamBtns(); render(); }};

function locToCanvas(lx, ly) {{
  const g = DATA.grid;
  return [((lx - g.xmin) / g.cell) * 3, (g.h - 1 - ((ly - g.ymin) / g.cell)) * 3];
}}

function getFrames() {{
  if (mode === "evening") return DATA.evening_1hz;
  if (mode === "24h") return DATA.day_24h;
  return DATA.chrysanthemum_1hz;
}}

function filterObs(arr) {{
  const uavOn = document.getElementById("chkUav").checked;
  return arr.filter(p => {{
    if (!uavOn && p[6] === 1) return false;
    if (selectedCam >= 0 && p[3] !== selectedCam) return false;
    return true;
  }});
}}

function renderTopoHeat(obsPts) {{
  field.fill(0);
  tmpF.fill(0);
  const g = DATA.grid;
  const xSpan = g.w * g.cell, ySpan = g.h * g.cell;
  for (const p of obsPts) {{
    const gx = Math.floor(((p[0] - g.xmin) / xSpan) * KW);
    const gy = KH - 1 - Math.floor(((p[1] - g.ymin) / ySpan) * KH);
    if (gx >= 0 && gx < KW && gy >= 0 && gy < KH) {{
      field[gy * KW + gx] += 1.0;
    }}
  }}
  // 水平高斯
  for (let y = 0; y < KH; y++) {{
    const off = y * KW;
    for (let x = 0; x < KW; x++) {{
      const v = field[off + x];
      if (v === 0) continue;
      for (let k = -RAD; k <= RAD; k++) {{
        const nx = x + k;
        if (nx >= 0 && nx < KW) tmpF[off + nx] += v * KERN[k + RAD];
      }}
    }}
  }}
  field.fill(0);
  let maxVal = 0;
  // 垂直高斯
  for (let y = 0; y < KH; y++) {{
    const dstOff = y * KW;
    for (let k = -RAD; k <= RAD; k++) {{
      const ny = y + k;
      if (ny >= 0 && ny < KH) {{
        const w = KERN[k + RAD];
        const srcOff = ny * KW;
        for (let x = 0; x < KW; x++) {{
          const sv = tmpF[srcOff + x];
          if (sv > 0) field[dstOff + x] += sv * w;
        }}
      }}
    }}
  }}
  for (let i = 0; i < KW * KH; i++) if (field[i] > maxVal) maxVal = field[i];

  // 24h 抽样率为 1/4，1Hz 抽样率为 2/5，统一标定满红上限
  const vmax = (mode === "24h") ? 0.55 : 0.85;
  const levels = [0.04, 0.12, 0.24, 0.40, 0.58, 0.78];
  const showContour = document.getElementById("chkContour").checked;
  const alphaScale = (+document.getElementById("alphaSlider").value) / 100;

  for (let i = 0; i < KW * KH; i++) {{
    const norm = Math.min(1.0, Math.pow(field[i] / vmax, 0.72));
    let lv = 0;
    for (let l = 0; l < levels.length; l++) if (norm >= levels[l]) lv++;
    lvlArr[i] = lv;
  }}

  const d = hImgData.data;
  for (let y = 0; y < KH; y++) {{
    for (let x = 0; x < KW; x++) {{
      const idx = y * KW + x;
      const v = field[idx];
      const o = idx * 4;
      if (v < vmax * 0.012) {{ d[o + 3] = 0; continue; }}
      const norm = Math.min(1.0, Math.pow(v / vmax, 0.72));
      const li = Math.min(255, Math.floor(norm * 255)) * 3;
      const dx = (field[y * KW + Math.min(KW - 1, x + 1)] - field[y * KW + Math.max(0, x - 1)]) / vmax;
      const dy = (field[Math.min(KH - 1, y + 1) * KW + x] - field[Math.max(0, y - 1) * KW + x]) / vmax;
      const shade = Math.max(0.75, Math.min(1.18, 1.0 - (dx + dy) * 1.4));

      const lv = lvlArr[idx];
      const isC = showContour && lv >= 1 && (
        (x + 1 < KW && lvlArr[idx + 1] !== lv) || (y + 1 < KH && lvlArr[idx + KW] !== lv)
      );
      if (isC) {{
        if (lv >= 4) {{ d[o] = 255; d[o + 1] = 245; d[o + 2] = 225; d[o + 3] = Math.round(235 * alphaScale); }}
        else {{ d[o] = 45; d[o + 1] = 24; d[o + 2] = 16; d[o + 3] = Math.round(195 * alphaScale); }}
      }} else {{
        d[o] = Math.min(255, LUT[li] * shade);
        d[o + 1] = Math.min(255, LUT[li + 1] * shade);
        d[o + 2] = Math.min(255, LUT[li + 2] * shade);
        d[o + 3] = Math.round((95 + 130 * norm) * alphaScale);
      }}
    }}
  }}
  hctx.putImageData(hImgData, 0, 0);
  return maxVal;
}}

function render() {{
  const fs = getFrames();
  if (fIdx >= fs.length) fIdx = 0;
  const f = fs[fIdx];
  document.getElementById("slider").max = fs.length - 1;
  document.getElementById("slider").value = fIdx;
  document.getElementById("timeLabel").textContent = f.t;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const bgMode = document.getElementById("bgSel").value;
  ctx.imageSmoothingEnabled = (bgMode !== "tier");
  ctx.drawImage(bgMode === "tier" ? tierImg : satImg, 0, 0, canvas.width, canvas.height);
  if (bgMode === "sat_dark") {{
    ctx.fillStyle = "rgba(8, 14, 24, 0.24)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }}

  const curObs = filterObs(f.obs);

  // 地形等高热力图
  let peakVal = 0;
  if (document.getElementById("chkTopo").checked) {{
    peakVal = renderTopoHeat(curObs);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(heatCanvas, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }}

  // 28 机位 FOV 轮廓
  const uavOn = document.getElementById("chkUav").checked;
  if (document.getElementById("chkFov").checked) {{
    ctx.save();
    for (const c of DATA.cameras) {{
      if (!uavOn && c.type === "uav_mobile") continue;
      if (selectedCam >= 0 && c.idx !== selectedCam) continue;
      const isUav = c.type === "uav_mobile";
      ctx.strokeStyle = isUav ? "rgba(110, 231, 183, 0.72)" : "rgba(186, 230, 253, 0.45)";
      ctx.lineWidth = (selectedCam === c.idx) ? 2.2 : 1.0;
      ctx.beginPath();
      c.poly.forEach((p, i) => {{
        const [sx, sy] = locToCanvas(p[0], p[1]);
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }});
      ctx.closePath();
      ctx.stroke();
    }}
    ctx.restore();
  }}

  // 摄像头真实观测移动点（小亮白金点，叠在红热力上既看清人移动又不抢地形色）
  if (document.getElementById("chkDots").checked) {{
    ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
    for (const p of curObs) {{
      const [sx, sy] = locToCanvas(p[0], p[1]);
      ctx.fillRect(sx - 1.2, sy - 1.2, 2.4, 2.4);
    }}
  }}

  // 闸口标记
  for (const g of DATA.gates) {{
    const [sx, sy] = locToCanvas(g.x, g.y);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(sx - 4, sy - 4, 8, 8);
    ctx.fillStyle = "rgba(10,16,26,0.82)";
    ctx.fillRect(sx + 6, sy - 8, 34, 15);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText(g.id, sx + 9, sy + 3);
  }}

  document.getElementById("kObs").textContent = curObs.length.toLocaleString();
  document.getElementById("kPeak").textContent = peakVal.toFixed(2);
}}

document.getElementById("slider").oninput = e => {{ fIdx = +e.target.value; render(); }};
document.getElementById("alphaSlider").oninput = render;
document.getElementById("modeSel").onchange = e => {{ mode = e.target.value; fIdx = 0; render(); }};
["bgSel", "chkTopo", "chkContour", "chkDots", "chkFov", "chkUav"].forEach(id => document.getElementById(id).onchange = render);
document.getElementById("btnPlay").onclick = () => {{
  playing = !playing;
  document.getElementById("btnPlay").textContent = playing ? "⏸ 暂停" : "▶ 播放";
}};

setInterval(() => {{
  if (!playing) return;
  const fs = getFrames();
  fIdx = (fIdx + 1) % fs.length;
  render();
}}, 180);

satImg.onload = render;
</script>
</body>
</html>
"""
    # 注意：文件名与 build_flowing_sat_topo.py 的 sanyang_sat_topo_replay.html 区分开，
    # 否则后跑的脚本会静默覆盖先跑的产物。
    out_html = OUT_DIR / "sanyang_sat_topo_terrain_replay.html"
    out_html.write_text(html, encoding="utf-8")
    print(f"[Viz] Saved {out_html.name} ({out_html.stat().st_size / 1024:.0f} KB)")


def main():
    t0 = time.time()
    env = sim.build_environment()
    frame: sim.LocalFrame = env["frame"]

    # 重投影两份高清 z18 卫星图：一份 380x790 给 PNG 三联图，一份 570x1185 给 HTML 交互页
    sat_380 = warp_satellite_to_local_pil(frame, sim.GRID_W * 2, sim.GRID_H * 2)
    sat_570 = warp_satellite_to_local_pil(frame, sim.GRID_W * 3, sim.GRID_H * 3)
    print(f"[Sat] Warped z18 satellite imagery in {time.time() - t0:.2f}s")

    # 从纯摄像头融合数据集读取 3 个典型时刻的全部可见观测点（07:30 / 15:35 / 19:35）
    snaps_pts: dict[str, list[tuple[float, float]]] = {"morning": [], "chrysanthemum": [], "evening": []}

    with (OUT_DIR / "camera_observed_fused_24h_30s.csv").open("r", encoding="utf-8-sig") as f:
        r = csv.reader(f)
        next(r)
        for row in r:
            ts = row[0][11:19]
            if ts == "07:30:00":
                snaps_pts["morning"].append((float(row[9]), float(row[10])))
            elif ts == "15:35:00":
                snaps_pts["chrysanthemum"].append((float(row[9]), float(row[10])))
            elif ts == "19:35:00":
                snaps_pts["evening"].append((float(row[9]), float(row[10])))

    snaps = {
        "morning": ("07:30 晨练早高峰", snaps_pts["morning"]),
        "chrysanthemum": ("15:35 菊花会下午高峰", snaps_pts["chrysanthemum"]),
        "evening": ("19:35 晚饭后全天最高峰", snaps_pts["evening"]),
    }
    build_showcase_png(env, sat_380, snaps)
    build_sat_topo_html(env, sat_570)
    print(f"[DONE] Satellite topographic heatmap & replay built in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
