#!/usr/bin/env python3
"""
SkyGuard · 汉口江滩三阳段 z18 卫星图 + 动态流动地形人流热力 演示视频导出器
=========================================================================
渲染 05:30–23:30 全天潮汐演进（每 3 分钟 1 帧，共 360 帧，12 fps = 30 秒演示视频）：
- 左侧：真实 z18 卫星底图 + 仅 28 机位可见观测生成的地形等高热力图（人越多越红 + 山体阴影 + 等高线）
        + 28 机位 FOV 扇区 + 动态人流速度矢量箭头 + 闸口标识；
- 右侧仪表盘：实时北京时间时钟、阶段标题、24h 实时人流曲线（带移动游标）、关键统计指标与地形密度色带图例。
使用 GStreamer (pngdec -> vp9enc -> webmmux) 编码输出 WebM/VP9 视频
（`sanyang_24h_sat_topo_demo.webm`），导出后校验 EBML 封装头，避免把空文件或半截文件当成成品。
"""
from __future__ import annotations

import csv
import json
import math
import shutil
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_sanyang_crowd_sim as sim
import build_sat_topo_view as topo

OUT_DIR = sim.OUT_DIR


def load_video_frames(env: dict):
    """读取 05:30-23:30 每 3 分钟（360 帧）的纯 28 机位可见观测点 + 全天 24h 总人数曲线。"""
    t0 = time.time()
    # 1) 全天 3 分钟总人数曲线（来自 region_stats_5s.csv）
    total_by_sec = defaultdict(int)
    with (OUT_DIR / "region_stats_5s.csv").open("r", encoding="utf-8-sig") as f:
        r = csv.reader(f)
        next(r)
        for row in r:
            ts = row[0][11:19]
            if ts[6:8] != "00":
                continue
            h, m = int(ts[:2]), int(ts[3:5])
            sec = h * 3600 + m * 60
            if sec % 180 == 0:
                total_by_sec[sec] += int(row[5])

    # 2) 28 机位可见观测点（含真实速度 vx, vy）
    pts_by_sec = defaultdict(list)
    with (OUT_DIR / "camera_observed_fused_24h_30s.csv").open("r", encoding="utf-8-sig") as f:
        r = csv.reader(f)
        next(r)
        for row in r:
            ts = row[0][11:19]
            if ts[6:8] != "00":
                continue
            h, m = int(ts[:2]), int(ts[3:5])
            sec = h * 3600 + m * 60
            if sec % 180 == 0 and (5 * 3600 + 30 * 60 <= sec <= 23 * 3600 + 30 * 60):
                pts_by_sec[sec].append((
                    float(row[9]), float(row[10]),
                    float(row[12]), float(row[13]),
                ))

    print(f"[Video] Loaded 360 frames & 24h curve in {time.time() - t0:.1f}s")
    return total_by_sec, pts_by_sec


def phase_label(sec: int) -> tuple[str, tuple[int, int, int]]:
    h = sec / 3600.0
    if h < 9.3:
        return ("晨练早高峰 | 江滩晨跑与健步流", (52, 211, 153))
    if h < 11.6:
        return ("上午菊展入场 | 游客陆续进园", (250, 204, 21))
    if h < 13.6:
        return ("午饭回落低谷 | 客流退潮用餐", (148, 163, 184))
    if h < 17.5:
        return ("菊花会下午大客流 | 地铁脉冲波涌入", (251, 146, 60))
    if h < 18.8:
        return ("晚饭小幅回落 | 晚间客流预热", (96, 165, 250))
    if h < 21.3:
        return ("晚饭后全天最高峰 | 江景灯光秀红潮", (248, 113, 113))
    return ("晚间集中散场 | 客流向三门外涌疏散", (192, 132, 252))


def main():
    t_all = time.time()
    env = sim.build_environment()
    frame: sim.LocalFrame = env["frame"]
    total_by_sec, pts_by_sec = load_video_frames(env)

    # 视频尺寸：1120 x 900（偶像素，适配所有编码器与 PPT 播放）
    VW, VH = 1120, 900
    MAP_W, MAP_H = 400, 832  # 保持 190:395 精确纵横比
    MAP_X, MAP_Y = 26, 42

    sat_base = topo.warp_satellite_to_local_pil(frame, MAP_W, MAP_H)
    sat_dim = ImageEnhance.Brightness(sat_base).enhance(0.84).convert("RGBA")

    # 预绘 28 机位 FOV 轮廓叠加层
    fov_layer = Image.new("RGBA", (MAP_W, MAP_H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fov_layer)
    sx_s = MAP_W / sim.GRID_W
    sy_s = MAP_H / sim.GRID_H
    for c in env["cameras"]:
        pts = []
        for p in c["fov_polygon_utm50n"]:
            lx, ly = frame.to_local(p[0], p[1])
            gx, gy = sim.loc_to_grid(lx, ly)
            pts.append((gx * sx_s, (sim.GRID_H - 1 - gy) * sy_s))
        if len(pts) >= 3:
            is_uav = c["camera_type"] == "uav_mobile"
            outline = (110, 231, 183, 150) if is_uav else (186, 230, 253, 105)
            fd.polygon(pts, fill=(0, 0, 0, 0), outline=outline)

    # 预绘静态右侧仪表盘背景（避免每帧重画色带与曲线框架）
    hud_bg = Image.new("RGB", (VW, VH), (12, 18, 28))
    hd = ImageDraw.Draw(hud_bg)
    f_title = sim.load_font(24)
    f_clock = sim.load_font(42)
    f_sub = sim.load_font(17)
    f_lbl = sim.load_font(15)
    f_sm = sim.load_font(13)

    rx = 456
    hd.text((rx, 36), "汉口江滩 · 三阳核心演示段", fill=(240, 246, 252), font=f_title)
    hd.text((rx, 70), "真实 z18 卫星图 + 28 机位流动地形人流热力", fill=(125, 211, 252), font=f_sub)
    hd.text((rx, 96), "规则：仅 28 机位视野内可见 | 通道 0 驻留 | 越密越红", fill=(148, 163, 184), font=f_sm)

    # 24h 曲线框
    cx0, cy0, cx1, cy1 = rx, 325, 1085, 585
    hd.rectangle([cx0, cy0, cx1, cy1], fill=(18, 27, 40), outline=(45, 64, 88))
    hd.text((cx0 + 12, cy0 + 10), "全天 24 小时人流实时曲线（早高峰 -> 午饭低谷 -> 菊花会 -> 晚饭后最高峰）", fill=(203, 213, 225), font=f_sm)

    max_tot = max(max(total_by_sec.values()), 1000)
    y_top_val = ((max_tot // 1000) + 1) * 1000
    for v in range(0, y_top_val + 1, 2000):
        yy = int(cy1 - 24 - (v / y_top_val) * (cy1 - cy0 - 58))
        hd.line([(cx0 + 44, yy), (cx1 - 12, yy)], fill=(34, 48, 66))
        hd.text((cx0 + 6, yy - 7), f"{v:4d}", fill=(140, 160, 182), font=f_sm)
    for hr in range(0, 25, 4):
        xx = int(cx0 + 44 + (hr / 24.0) * (cx1 - cx0 - 56))
        hd.line([(xx, cy0 + 34), (xx, cy1 - 24)], fill=(34, 48, 66))
        hd.text((xx - 14, cy1 - 20), f"{hr:02d}:00", fill=(140, 160, 182), font=f_sm)

    c_pts = []
    for sec in range(0, 86400, 180):
        xx = int(cx0 + 44 + (sec / 86400.0) * (cx1 - cx0 - 56))
        yy = int(cy1 - 24 - (total_by_sec[sec] / y_top_val) * (cy1 - cy0 - 58))
        c_pts.append((xx, yy))
    hd.line(c_pts, fill=(56, 189, 248), width=3)

    # 地形密度色带卡片
    by0 = 615
    hd.rectangle([rx, by0, 1085, 745], fill=(18, 27, 40), outline=(45, 64, 88))
    hd.text((rx + 14, by0 + 12), "地形图密度色带（越密越高越红 + 等密线 + 山体阴影）", fill=(252, 165, 165), font=f_lbl)
    cbx0, cbx1, cby0, cby1 = rx + 16, 1068, by0 + 46, by0 + 74
    for x in range(cbx0, cbx1):
        frac = (x - cbx0) / (cbx1 - cbx0)
        hd.line([(x, cby0), (x, cby1)], fill=topo.topo_color(frac))
    hd.rectangle([cbx0, cby0, cbx1, cby1], outline=(160, 180, 200))
    for frac, lbl in ((0.0, "稀疏(绿)"), (0.33, "温和(黄)"), (0.66, "密集(橙)"), (0.90, "极密高峰(深红)")):
        hd.text((int(cbx0 + frac * (cbx1 - cbx0 - 60)), cby1 + 8), lbl, fill=(210, 224, 238), font=f_sm)

    # 底部图例说明
    hd.rectangle([rx, 765, 1085, 874], fill=(18, 27, 40), outline=(45, 64, 88))
    hd.text((rx + 14, 778), "动态要素说明：", fill=(125, 211, 252), font=f_lbl)
    hd.text((rx + 14, 804), "• 白色箭头 = 通道与广场实时人流主方向（由真实速度矢量聚合）", fill=(210, 224, 238), font=f_sm)
    hd.text((rx + 14, 826), "• 浅蓝框 = 27 台固定机位 FOV   |   浅绿圈 = UAV-01 机载补盲无人机", fill=(210, 224, 238), font=f_sm)
    hd.text((rx + 14, 848), "• 盲区完全透明留白（不生成伪热力），仅展示摄像头真实观测到的流动人群", fill=(160, 180, 200), font=f_sm)

    # 渲染 360 帧到临时目录（05:30 -> 23:30，每 3 分钟 1 帧）
    secs_list = list(range(5 * 3600 + 30 * 60, 23 * 3600 + 30 * 60, 180))
    tmp_dir = Path(tempfile.mkdtemp(prefix="sanyang_vid_"))
    try:
        t_ren = time.time()
        # 粗网格流速箭头（16x34）
        GW_V, GH_V = 16, 34
        for fi, sec in enumerate(secs_list):
            obs = pts_by_sec.get(sec, [])
            xy_pts = [(p[0], p[1]) for p in obs]
            field = topo.compute_density_field(xy_pts, sim.GRID_W, sim.GRID_H, sigma_cells=3.3)
            topo_small = topo.render_topo_overlay(field, vmax=0.28)
            topo_big = topo_small.resize((MAP_W, MAP_H), Image.BILINEAR)

            m_comp = Image.alpha_composite(sat_dim, topo_big)
            m_comp = Image.alpha_composite(m_comp, fov_layer).convert("RGB")
            md = ImageDraw.Draw(m_comp)

            # 实时速度矢量箭头
            vx_sum = defaultdict(float)
            vy_sum = defaultdict(float)
            vcnt = defaultdict(int)
            x_span = sim.X_MAX_LOC - sim.X_MIN_LOC
            y_span = sim.Y_MAX_LOC - sim.Y_MIN_LOC
            spd_sum = 0.0
            for lx, ly, vx, vy in obs:
                spd_sum += math.hypot(vx, vy)
                gx_v = int(((lx - sim.X_MIN_LOC) / x_span) * GW_V)
                gy_v = GH_V - 1 - int(((ly - sim.Y_MIN_LOC) / y_span) * GH_V)
                if 0 <= gx_v < GW_V and 0 <= gy_v < GH_V:
                    k = (gx_v, gy_v)
                    vx_sum[k] += vx
                    vy_sum[k] += vy
                    vcnt[k] += 1

            for (gx_v, gy_v), cnt in vcnt.items():
                if cnt < 4:
                    continue
                mvx = vx_sum[(gx_v, gy_v)] / cnt
                mvy = vy_sum[(gx_v, gy_v)] / cnt
                spd = math.hypot(mvx, mvy)
                if spd < 0.14:
                    continue
                cx = ((gx_v + 0.5) / GW_V) * MAP_W
                cy = ((gy_v + 0.5) / GH_V) * MAP_H
                ang = math.atan2(-mvy, mvx)
                ln = min(16.0, 6.0 + spd * 10.0)
                ex = cx + math.cos(ang) * ln
                ey = cy + math.sin(ang) * ln
                md.line([(cx, cy), (ex, ey)], fill=(240, 249, 255), width=2)
                a1 = (ex - math.cos(ang - 0.55) * 4.5, ey - math.sin(ang - 0.55) * 4.5)
                a2 = (ex - math.cos(ang + 0.55) * 4.5, ey - math.sin(ang + 0.55) * 4.5)
                md.polygon([(ex, ey), a1, a2], fill=(240, 249, 255))

            # 三大闸口标识
            for gid in ("G09", "G08", "G07"):
                gx, gy = sim.loc_to_grid(*env["gates_loc"][gid])
                sx, sy = int(gx * sx_s), int((sim.GRID_H - 1 - gy) * sy_s)
                md.rectangle([sx - 4, sy - 4, sx + 4, sy + 4], fill=(239, 68, 68), outline=(255, 255, 255))
                md.rectangle([sx + 6, sy - 8, sx + 38, sy + 8], fill=(12, 18, 28))
                md.text((sx + 8, sy - 7), gid, fill=(255, 235, 235), font=f_sm)

            # 合成完整视频帧
            canvas = hud_bg.copy()
            canvas.paste(m_comp, (MAP_X, MAP_Y))
            cd = ImageDraw.Draw(canvas)
            cd.rectangle([MAP_X, MAP_Y, MAP_X + MAP_W, MAP_Y + MAP_H], outline=(70, 95, 122), width=1)

            # 动态时钟与阶段标题
            t_str = f"{sec // 3600:02d}:{(sec % 3600) // 60:02d}"
            plbl, pcol = phase_label(sec)
            cd.rectangle([rx, 130, 1085, 224], fill=(18, 27, 40), outline=(45, 64, 88))
            cd.text((rx + 18, 146), t_str, fill=(251, 191, 36), font=f_clock)
            cd.text((rx + 165, 146), "北京时间 2026-11-15（菊花会情景日）", fill=(155, 175, 198), font=f_sm)
            cd.text((rx + 165, 174), plbl, fill=pcol, font=f_sub)

            # 三个实时 KPI 卡
            tot_n = total_by_sec.get(sec, 0)
            obs_n = len(obs)
            m_spd = (spd_sum / obs_n) if obs_n else 0.0
            kpis = [
                ("全园真实在园人数", f"{tot_n:,} 人", (56, 189, 248)),
                ("28 机位实时可见", f"{obs_n:,} 人", (248, 113, 113)),
                ("平均移动速度", f"{m_spd:.2f} m/s", (52, 211, 153)),
            ]
            for ki, (kl, kv, kc) in enumerate(kpis):
                kx = rx + ki * 214
                cd.rectangle([kx, 238, kx + 202, 310], fill=(18, 27, 40), outline=(45, 64, 88))
                cd.text((kx + 12, 248), kl, fill=(148, 163, 184), font=f_sm)
                cd.text((kx + 12, 272), kv, fill=kc, font=f_title)

            # 曲线上的移动游标
            cur_x = int(cx0 + 44 + (sec / 86400.0) * (cx1 - cx0 - 56))
            cur_y = int(cy1 - 24 - (tot_n / y_top_val) * (cy1 - cy0 - 58))
            cd.line([(cur_x, cy0 + 34), (cur_x, cy1 - 24)], fill=(251, 191, 36), width=2)
            cd.ellipse([cur_x - 5, cur_y - 5, cur_x + 5, cur_y + 5], fill=(239, 68, 68), outline=(255, 255, 255), width=2)

            canvas.save(str(tmp_dir / f"frame_{fi:04d}.png"))

        print(f"[Video] Rendered {len(secs_list)} frames in {time.time() - t_ren:.1f}s")

        # 用 GStreamer 编码为高清 WebM (VP9 in WebM, 12 fps = 30s，Chrome/Edge/VLC/Win11 原生直播)
        out_webm = OUT_DIR / "sanyang_24h_sat_topo_demo.webm"
        cmd = [
            "gst-launch-1.0", "-q",
            "multifilesrc", f"location={tmp_dir}/frame_%04d.png", "index=0",
            "caps=image/png,framerate=12/1",
            "!", "pngdec",
            "!", "videoconvert",
            "!", "vp9enc", "deadline=1", "cpu-used=4", "target-bitrate=3500000",
            "!", "webmmux",
            "!", "filesink", f"location={out_webm}",
        ]
        subprocess.run(cmd, check=True)
        # 校验 EBML 封装头：WebM/Matroska 文件必须以 0x1A45DFA3 开头，
        # 否则说明编码被中断，产物不能当作成品分发。
        with out_webm.open("rb") as fh:
            magic = fh.read(4)
        if magic != b"\x1a\x45\xdf\xa3":
            raise RuntimeError(
                f"{out_webm.name} 不是合法的 WebM/EBML 容器（文件头 {magic.hex()}），编码可能已中断"
            )
        sz_mb = out_webm.stat().st_size / (1024 * 1024)
        print(f"[DONE] Exported {out_webm.name} ({sz_mb:.2f} MB, 30s @ 12fps) in {time.time() - t_all:.1f}s")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
