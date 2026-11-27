#!/usr/bin/env python3
"""
SkyGuard · 28 机位「真实摄像头观测视角」融合数据集与动态回放生成器
==================================================================
从已生成的三阳核心演示段真值轨迹与 28 机位逐人观测中，构建严格贴近真实感知的：
1. 盲区不可见（仅保留至少被 1 台在线摄像头视场 + 同高程层覆盖且未被遮挡漏检的观测点）；
2. 重叠视场去重融合（同一时刻被多台相机看到时，按最高置信度选主相机，避免重复计数）；
3. 断轨重编（行人走出盲区后超过断轨阈值才重新被观测到，就分配新的观测 track_id，保留
   person_id_gt 作评测对照）：1Hz 融合 6s、24h 融合 35s、单机位局部 track 8s，
   三处阈值统一定义在 build_sanyang_crowd_sim.TRACK_GAP_* 常量里；
4. 独立离线 HTML5 交互回放页 `sanyang_camera_observed_replay.html`：
   - 默认仅渲染摄像头真实观测到的移动点（走出 FOV 扇区立即消失！）
   - 支持点击任意单个摄像头隔离查看、开关 UAV-01 补盲、或切换「叠暗灰真值」对照盲区！
5. 对比验收图 `sanyang_camera_observed_vs_truth.png`（左：理想全图真值 vs 右：28 机位真实可见观测）。
"""
from __future__ import annotations

import base64
import csv
import io
import json
import math
import random
import sys
import time
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_sanyang_crowd_sim as sim

OUT_DIR = sim.OUT_DIR
SEED = 20261125


def fuse_1hz_peak(env: dict, key: str, label: str, start_sec: int, end_sec: int):
    """读取 camera_tracks_peak_{key}_1hz.csv，做重叠视场去重融合与断轨重编，同时抽样 1Hz 动态帧供 HTML 丝滑播放。"""
    t0 = time.time()
    frame: sim.LocalFrame = env["frame"]
    in_cam = OUT_DIR / f"camera_tracks_peak_{key}_1hz.csv"
    in_gt = OUT_DIR / f"trajectories_peak_{key}_1hz.csv"
    out_fused = OUT_DIR / f"camera_observed_fused_{key}_1hz.csv"

    # 为 HTML 丝滑回放截取前 120 秒、每 1 秒 1 帧（120 帧真 1Hz 移动！）
    # 为防止浏览器卡顿，对每帧点位按固定 person_id 哈希稳定抽样（约 1/3 的人，但同一人在连续帧里 100% 稳定出现，确保移动连续丝滑！）
    html_end_sec = start_sec + 120
    html_obs_by_sec = defaultdict(list)  # sec -> [[lx, ly, ti, primary_cam_idx, obs_tid, pid_gt, uav_only]]
    html_gt_blind_by_sec = defaultdict(list)  # sec -> [[lx, ly, ti]] 仅存盲区真值点，供用户勾选“显示盲区真值对照”

    cam_id_to_idx = {c["camera_id"]: i for i, c in enumerate(env["cameras"])}
    uav_idx = cam_id_to_idx.get("UAV-01", -1)

    # 融合断轨跟踪器：person_id_gt -> (obs_track_id, last_seen_sec)
    fused_tid_map: dict[str, tuple[int, int]] = {}
    next_fused_tid = 1

    # 逐秒流式聚合 camera_tracks（输入已按 timestamp_bj 递增排序）
    rows_out = 0
    unique_obs_pids = set()
    obs_pids_at_snap = set()
    snap_sec = start_sec + 300  # 切片第 5 分钟作为 PNG 对比快照时刻（15:35 / 19:35）
    snap_obs_pts = []  # (lx, ly, ti, primary_ci)

    def flush_sec(sec: int, ts_bj: str, bucket: dict[str, list], writer):
        nonlocal next_fused_tid, rows_out
        in_html = (start_sec <= sec < html_end_sec)
        is_snap = (sec == snap_sec)
        for pid, obs_list in bucket.items():
            # obs_list items: (ci, tid_local, x_utm, y_utm, elev, vx, vy, conf)
            # 选置信度最高者为主相机，其余记录在 seen_by_cams
            obs_list.sort(key=lambda x: x[7], reverse=True)
            best = obs_list[0]
            ci, _, ox, oy, elev, vx, vy, conf = best
            seen_cams = "|".join(env["cameras"][o[0]]["camera_id"] for o in obs_list)
            uav_only = 1 if (len(obs_list) == 1 and ci == uav_idx) else 0

            prev = fused_tid_map.get(pid)
            if prev is None or (sec - prev[1]) > sim.TRACK_GAP_FUSED_1HZ_S:
                ftid = next_fused_tid
                next_fused_tid += 1
            else:
                ftid = prev[0]
            fused_tid_map[pid] = (ftid, sec)

            lx, ly = frame.to_local(ox, oy)
            lon, lat = sim.utm50n_to_wgs84(ox, oy)
            writer.writerow([
                ts_bj, f"OBS-{ftid:06d}", pid, env["cameras"][ci]["camera_id"], seen_cams,
                round(ox, 2), round(oy, 2), round(lon, 6), round(lat, 6),
                round(lx, 2), round(ly, 2), elev, vx, vy, conf
            ])
            rows_out += 1
            unique_obs_pids.add(pid)

            if is_snap:
                obs_pids_at_snap.add(pid)
                snap_obs_pts.append((lx, ly, sim.TIER_TO_IDX.get(elev, 1), ci))

            # 稳定哈希抽样（约 40% 的人在 HTML 中以 1Hz 连续移动，保证 120 帧丝滑且文件可控）
            if in_html and (int(pid[1:]) % 5 < 2):
                html_obs_by_sec[sec].append([
                    round(lx, 1), round(ly, 1), sim.TIER_TO_IDX.get(elev, 1),
                    ci, f"T{ftid}", pid, uav_only
                ])

    with in_cam.open("r", encoding="utf-8-sig") as fin, \
         out_fused.open("w", newline="", encoding="utf-8-sig") as fout:
        r = csv.reader(fin)
        next(r)  # header
        w = csv.writer(fout)
        w.writerow([
            "timestamp_bj", "obs_track_id", "person_id_gt", "primary_camera_id", "seen_by_cams",
            "x_utm_obs", "y_utm_obs", "lon_obs", "lat_obs", "x_local_obs", "y_local_obs",
            "elevation_m", "vx_mps", "vy_mps", "confidence"
        ])

        cur_ts = ""
        cur_sec = -1
        bucket: dict[str, list] = defaultdict(list)

        for row in r:
            ts = row[0]
            if ts != cur_ts:
                if cur_ts:
                    flush_sec(cur_sec, cur_ts, bucket, w)
                    bucket.clear()
                cur_ts = ts
                h, m, s = int(ts[11:13]), int(ts[14:16]), int(ts[17:19])
                cur_sec = h * 3600 + m * 60 + s
            ci = cam_id_to_idx[row[1]]
            bucket[row[3]].append((
                ci, int(row[2]), float(row[4]), float(row[5]), float(row[6]),
                float(row[7]), float(row[8]), float(row[9])
            ))
        if cur_ts:
            flush_sec(cur_sec, cur_ts, bucket, w)

    # 读取同时间段真值，提取盲区对照点（用于 HTML 盲区切换与 PNG 对比图）
    snap_gt_pts = []
    with in_gt.open("r", encoding="utf-8-sig") as fgt:
        r = csv.reader(fgt)
        next(r)
        for row in r:
            ts = row[0]
            h, m, s = int(ts[11:13]), int(ts[14:16]), int(ts[17:19])
            sec = h * 3600 + m * 60 + s
            if sec == snap_sec:
                snap_gt_pts.append((float(row[7]), float(row[8]), sim.TIER_TO_IDX.get(float(row[9]), 1), row[1]))
            elif start_sec <= sec < html_end_sec and (int(row[1][1:]) % 5 < 2):
                # 仅记录未在当前秒被看到的点（粗筛：用 cell_cams 判断是否在盲区）
                lx, ly = float(row[7]), float(row[8])
                ti = sim.TIER_TO_IDX.get(float(row[9]), 1)
                gx, gy = sim.loc_to_grid(lx, ly)
                in_fov = False
                if 0 <= gx < sim.GRID_W and 0 <= gy < sim.GRID_H:
                    if env["cell_cams"][ti][gy * sim.GRID_W + gx]:
                        in_fov = True
                if not in_fov:
                    html_gt_blind_by_sec[sec].append([round(lx, 1), round(ly, 1), ti])

    html_frames = []
    for sec in range(start_sec, html_end_sec):
        html_frames.append({
            "t": f"{sec // 3600:02d}:{(sec % 3600) // 60:02d}:{sec % 60:02d}",
            "s": sec,
            "obs": html_obs_by_sec[sec],
            "blind": html_gt_blind_by_sec[sec],
        })

    cov_pct = (len(obs_pids_at_snap) / max(1, len(snap_gt_pts))) * 100.0
    print(
        f"[Obs-{key}] Fused {rows_out:,} rows ({len(unique_obs_pids):,} unique GT persons, "
        f"{next_fused_tid - 1:,} broken/re-acquired tracks) in {time.time() - t0:.1f}s | "
        f"Snap {snap_sec//3600:02d}:{(snap_sec%3600)//60:02d} coverage={len(obs_pids_at_snap)}/{len(snap_gt_pts)} ({cov_pct:.1f}%)"
    )
    return {
        "html_frames": html_frames,
        "snap_obs_pts": snap_obs_pts,
        "snap_gt_pts": snap_gt_pts,
        "snap_sec": snap_sec,
        "obs_count_snap": len(obs_pids_at_snap),
        "gt_count_snap": len(snap_gt_pts),
        "coverage_pct": round(cov_pct, 1),
        "fused_rows": rows_out,
        "broken_tracks": next_fused_tid - 1,
    }


def build_24h_camera_observed_30s(env: dict):
    """从 trajectories_24h_30s.csv 过滤出全天 24 小时仅 28 机位可见的融合观测数据集（含噪声与遮挡漏检）。"""
    t0 = time.time()
    rng = random.Random(SEED)
    frame: sim.LocalFrame = env["frame"]
    cell_cams = env["cell_cams"]
    cameras = env["cameras"]
    uav_idx = next((i for i, c in enumerate(cameras) if c["camera_id"] == "UAV-01"), -1)

    in_path = OUT_DIR / "trajectories_24h_30s.csv"
    out_path = OUT_DIR / "camera_observed_fused_24h_30s.csv"

    # 每 5 分钟抽 1 帧给 HTML 24h 模式
    html_24h = []
    cur_5min_obs = []
    cur_5min_blind = []
    cur_5min_sec = -1
    cur_5min_tot_obs = 0
    cur_5min_tot_gt = 0

    rows_in = 0
    rows_out = 0
    fused_tid_map: dict[str, tuple[int, int]] = {}
    next_tid = 1

    with in_path.open("r", encoding="utf-8-sig") as fin, \
         out_path.open("w", newline="", encoding="utf-8-sig") as fout:
        r = csv.reader(fin)
        next(r)
        w = csv.writer(fout)
        w.writerow([
            "timestamp_bj", "obs_track_id", "person_id_gt", "primary_camera_id", "seen_by_cams",
            "x_utm_obs", "y_utm_obs", "lon_obs", "lat_obs", "x_local_obs", "y_local_obs",
            "elevation_m", "vx_mps", "vy_mps", "confidence"
        ])

        for row in r:
            rows_in += 1
            ts = row[0]
            h, m, s = int(ts[11:13]), int(ts[14:16]), int(ts[17:19])
            sec = h * 3600 + m * 60 + s
            is_5min = (sec % 300 == 0)

            if is_5min and sec != cur_5min_sec:
                if cur_5min_sec >= 0:
                    html_24h.append({
                        "t": f"{cur_5min_sec // 3600:02d}:{(cur_5min_sec % 3600) // 60:02d}",
                        "s": cur_5min_sec,
                        "n_obs": cur_5min_tot_obs,
                        "n_gt": cur_5min_tot_gt,
                        "obs": cur_5min_obs,
                        "blind": cur_5min_blind,
                    })
                cur_5min_sec = sec
                cur_5min_obs = []
                cur_5min_blind = []
                cur_5min_tot_obs = 0
                cur_5min_tot_gt = 0

            if is_5min:
                cur_5min_tot_gt += 1

            pid = row[1]
            lx, ly = float(row[7]), float(row[8])
            elev = float(row[9])
            ti = sim.TIER_TO_IDX.get(elev, 1)
            gx, gy = sim.loc_to_grid(lx, ly)
            cams_here = cell_cams[ti][gy * sim.GRID_W + gx] if (0 <= gx < sim.GRID_W and 0 <= gy < sim.GRID_H) else ()

            if not cams_here:
                if is_5min and (int(pid[1:]) % 4 == 0):
                    cur_5min_blind.append([round(lx, 1), round(ly, 1), ti])
                continue

            # 约 4% 偶发遮挡漏检
            if rng.random() < 0.04:
                continue

            primary_ci = cams_here[0]
            seen_str = "|".join(cameras[ci]["camera_id"] for ci in cams_here)
            uav_only = 1 if (len(cams_here) == 1 and primary_ci == uav_idx) else 0

            prev = fused_tid_map.get(pid)
            if prev is None or (sec - prev[1]) > sim.TRACK_GAP_FUSED_24H_S:
                ftid = next_tid
                next_tid += 1
            else:
                ftid = prev[0]
            fused_tid_map[pid] = (ftid, sec)

            ox = float(row[3]) + rng.gauss(0.0, 0.22)
            oy = float(row[4]) + rng.gauss(0.0, 0.22)
            olx, oly = frame.to_local(ox, oy)
            lon, lat = sim.utm50n_to_wgs84(ox, oy)
            conf = round(min(0.99, max(0.45, rng.gauss(0.86, 0.07))), 3)

            w.writerow([
                ts, f"OBS-{ftid:06d}", pid, cameras[primary_ci]["camera_id"], seen_str,
                round(ox, 2), round(oy, 2), round(lon, 6), round(lat, 6),
                round(olx, 2), round(oly, 2), elev, row[11], row[12], conf
            ])
            rows_out += 1
            if is_5min:
                cur_5min_tot_obs += 1
                if int(pid[1:]) % 4 == 0:
                    cur_5min_obs.append([round(olx, 1), round(oly, 1), ti, primary_ci, f"T{ftid}", pid, uav_only])

        if cur_5min_sec >= 0:
            html_24h.append({
                "t": f"{cur_5min_sec // 3600:02d}:{(cur_5min_sec % 3600) // 60:02d}",
                "s": cur_5min_sec,
                "n_obs": cur_5min_tot_obs,
                "n_gt": cur_5min_tot_gt,
                "obs": cur_5min_obs,
                "blind": cur_5min_blind,
            })

    print(
        f"[Obs-24h] Filtered {rows_out:,} / {rows_in:,} ({rows_out / max(1, rows_in) * 100:.1f}%) "
        f"camera-visible rows in {time.time() - t0:.1f}s"
    )
    return html_24h, rows_out, rows_in


def render_comparison_png(env: dict, peak_chry: dict, peak_eve: dict):
    """左右对照图：左=理想全图真值，右=仅 28 机位真实可见观测点（含 FOV 扇区，盲区空白）。"""
    PW, PH = 420, 840
    W = PW * 4 + 70
    H = PH + 125
    BG = (14, 21, 31)
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    f_title = sim.load_font(25)
    f_sub = sim.load_font(16)
    f_sm = sim.load_font(13)

    draw.text((30, 20), "理想全图真值 vs 28 机位「真实摄像头可见观测」空间对比（盲区不生成点位）", fill=(236, 244, 252), font=f_title)
    draw.text((30, 56), "仅当行人进入 28 台虚拟摄像头对应高程层的 FOV 扇区且未被遮挡时，才产生带噪声的观测点与局部 track_id；走出视野即消失", fill=(150, 185, 215), font=f_sub)

    # 底图（放大 2 倍 -> 380x790）
    base = Image.new("RGB", (sim.GRID_W, sim.GRID_H), (18, 27, 39))
    px = base.load()
    tier_bg = [(82, 54, 42), (68, 62, 40), (30, 74, 72), (26, 70, 102)]
    walkable = env["walkable"]
    for gy in range(sim.GRID_H):
        off = gy * sim.GRID_W
        iy = sim.GRID_H - 1 - gy
        for gx in range(sim.GRID_W):
            for ti in (3, 2, 1, 0):
                if walkable[ti][off + gx]:
                    px[gx, iy] = tier_bg[ti]
                    break
    base_big = base.resize((sim.GRID_W * 2, sim.GRID_H * 2), Image.NEAREST)

    frame: sim.LocalFrame = env["frame"]

    def draw_fovs(panel_img: Image.Image):
        overlay = Image.new("RGBA", panel_img.size, (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        for c in env["cameras"]:
            pts = []
            for p in c["fov_polygon_utm50n"]:
                lx, ly = frame.to_local(p[0], p[1])
                gx, gy = sim.loc_to_grid(lx, ly)
                pts.append((gx * 2, (sim.GRID_H - 1 - gy) * 2))
            if len(pts) >= 3:
                is_uav = c["camera_type"] == "uav_mobile"
                fill = (52, 211, 153, 38) if is_uav else (56, 189, 248, 30)
                outline = (52, 211, 153, 175) if is_uav else (125, 211, 252, 150)
                od.polygon(pts, fill=fill, outline=outline)
        return Image.alpha_composite(panel_img.convert("RGBA"), overlay).convert("RGB")

    panels = [
        ("15:35 菊花会 · 理想全图真值", peak_chry["snap_gt_pts"], False, (251, 191, 36)),
        (f"15:35 菊花会 · 28机位真实可见 ({peak_chry['coverage_pct']}%)", peak_chry["snap_obs_pts"], True, (56, 189, 248)),
        ("19:35 晚饭后 · 理想全图真值", peak_eve["snap_gt_pts"], False, (244, 114, 182)),
        (f"19:35 晚饭后 · 28机位真实可见 ({peak_eve['coverage_pct']}%)", peak_eve["snap_obs_pts"], True, (52, 211, 153)),
    ]

    for idx, (ptitle, pts, is_obs, col) in enumerate(panels):
        ox = 22 + idx * (PW + 10)
        oy = 98
        panel = draw_fovs(base_big.copy()) if is_obs else base_big.copy()
        pdraw = ImageDraw.Draw(panel)
        for item in pts:
            lx, ly = item[0], item[1]
            gx, gy = sim.loc_to_grid(lx, ly)
            sx, sy = gx * 2, (sim.GRID_H - 1 - gy) * 2
            if 0 <= sx < sim.GRID_W * 2 and 0 <= sy < sim.GRID_H * 2:
                pdraw.rectangle([sx - 1, sy - 1, sx + 1, sy + 1], fill=col)

        for gid in ("G09", "G08", "G07"):
            gx, gy = sim.loc_to_grid(*env["gates_loc"][gid])
            sx, sy = gx * 2, (sim.GRID_H - 1 - gy) * 2
            pdraw.rectangle([sx - 4, sy - 4, sx + 4, sy + 4], fill=(239, 68, 68), outline=(255, 255, 255))
            pdraw.text((sx + 6, sy - 7), gid, fill=(255, 220, 220), font=f_sm)

        img.paste(panel, (ox + 18, oy + 38))
        draw.rectangle([ox + 18, oy + 38, ox + 18 + sim.GRID_W * 2, oy + 38 + sim.GRID_H * 2], outline=(62, 86, 112), width=1)
        draw.text((ox + 18, oy + 8), f"{ptitle} ({len(pts):,}点)", fill=col, font=f_sub)

    out_p = OUT_DIR / "sanyang_camera_observed_vs_truth.png"
    img.save(str(out_p))
    print(f"[Viz] Saved {out_p.name}")


def build_camera_observed_html(env: dict, html_24h: list, peak_chry: dict, peak_eve: dict):
    """生成「真实摄像头可见点移动」离线交互回放页（默认打开即播放 1Hz 菊花会实时观测移动！）。"""
    base = Image.new("RGB", (sim.GRID_W, sim.GRID_H), (16, 24, 35))
    px = base.load()
    tier_bg = [(82, 54, 42), (68, 62, 40), (28, 72, 70), (24, 68, 98)]
    walkable = env["walkable"]
    for gy in range(sim.GRID_H):
        off = gy * sim.GRID_W
        iy = sim.GRID_H - 1 - gy
        for gx in range(sim.GRID_W):
            for ti in (3, 2, 1, 0):
                if walkable[ti][off + gx]:
                    px[gx, iy] = tier_bg[ti]
                    break
    buf = io.BytesIO()
    base.save(buf, format="PNG")
    bg_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    frame: sim.LocalFrame = env["frame"]
    cams_js = []
    for i, c in enumerate(env["cameras"]):
        pts = [frame.to_local(p[0], p[1]) for p in c["fov_polygon_utm50n"]]
        cams_js.append({
            "idx": i,
            "id": c["camera_id"],
            "name": c["name"],
            "tier": c["elevation_tier_m"],
            "type": c["camera_type"],
            "x": round(c["x_local"], 1),
            "y": round(c["y_local"], 1),
            "poly": [[round(a, 1), round(b, 1)] for a, b in pts[::2]],
        })

    gates_js = [{"id": gid, "x": round(xy[0], 1), "y": round(xy[1], 1)} for gid, xy in env["gates_loc"].items()]
    payload = {
        "grid": {"w": sim.GRID_W, "h": sim.GRID_H, "cell": sim.CELL_M, "xmin": sim.X_MIN_LOC, "ymin": sim.Y_MIN_LOC},
        "bg_png": bg_b64,
        "gates": gates_js,
        "cameras": cams_js,
        "chrysanthemum_1hz": peak_chry["html_frames"],
        "evening_1hz": peak_eve["html_frames"],
        "day_24h": html_24h,
    }

    # 同一份 payload 另存为 JSON，供 build_sat_topo_view.py 等下游直接读取，
    # 避免从生成的 HTML 里按字符串标记抠 JSON（脆弱且带隐藏的执行顺序依赖）。
    payload_path = OUT_DIR / "camera_observed_replay_payload.json"
    payload_path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"[Obs] Saved {payload_path.name} ({payload_path.stat().st_size / 1024:.0f} KB)")

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>SkyGuard · 28 机位真实摄像头观测点动态回放（盲区隐藏）</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: #0b121c; color: #e2ecf6; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; display: flex; height: 100vh; overflow: hidden; }}
  #left {{ flex: 1; display: flex; flex-direction: column; padding: 12px 16px; gap: 10px; min-width: 0; }}
  #right {{ width: 390px; background: #121d2c; border-left: 1px solid #24364d; padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }}
  .header {{ display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }}
  .header h1 {{ font-size: 18px; color: #f8fafc; }}
  .badge {{ background: #065f46; color: #6ee7b7; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }}
  .toolbar {{ display: flex; gap: 8px; flex-wrap: wrap; align-items: center; background: #121d2c; padding: 8px 12px; border-radius: 8px; border: 1px solid #24364d; }}
  button, select {{ background: #1c2c42; color: #e2ecf6; border: 1px solid #334d6e; border-radius: 6px; padding: 5px 10px; font-size: 13px; cursor: pointer; }}
  button:hover {{ background: #274060; }}
  .canvas-wrap {{ flex: 1; display: flex; justify-content: center; align-items: center; background: #080d14; border: 1px solid #24364d; border-radius: 8px; overflow: hidden; }}
  canvas {{ max-height: 100%; max-width: 100%; cursor: crosshair; }}
  .timeline {{ background: #121d2c; padding: 10px 14px; border-radius: 8px; border: 1px solid #24364d; display: flex; align-items: center; gap: 10px; }}
  input[type=range] {{ flex: 1; accent-color: #38bdf8; }}
  .card {{ background: #172436; border: 1px solid #263a52; border-radius: 8px; padding: 10px 12px; }}
  .card h3 {{ font-size: 14px; color: #7dd3fc; margin-bottom: 8px; }}
  .kpi-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }}
  .kpi {{ background: #0f1926; border-radius: 6px; padding: 8px; }}
  .kpi .v {{ font-size: 20px; font-weight: 700; color: #38bdf8; }}
  .kpi .l {{ font-size: 11px; color: #94a3b8; }}
  .cam-grid {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }}
  .cam-btn {{ padding: 4px 2px; font-size: 11px; text-align: center; border-radius: 4px; background: #101b29; border: 1px solid #293d57; color: #cbd5e1; cursor: pointer; }}
  .cam-btn.active {{ background: #0284c7; border-color: #7dd3fc; color: #fff; font-weight: 700; }}
  .tip {{ font-size: 12px; color: #94a3b8; line-height: 1.5; }}
</style>
</head>
<body>
<div id="left">
  <div class="header">
    <h1>SkyGuard · 28 机位真实摄像头观测点动态回放</h1>
    <span class="badge">真实感知模式：仅显示摄像头视野内观测点（走出 FOV 即消失）</span>
  </div>
  <div class="toolbar">
    <button id="btnPlay">⏸ 暂停</button>
    <select id="modeSel">
      <option value="chrysanthemum">菊花会下午高峰 15:30（真 1Hz 实时移动）</option>
      <option value="evening">晚饭后最高峰 19:30（真 1Hz 实时移动）</option>
      <option value="24h">全天 24 小时宏观（每 5 分钟）</option>
    </select>
    <label style="font-size:12px;"><input type="checkbox" id="chkUav" checked /> 开启 UAV-01 补盲</label>
    <label style="font-size:12px;"><input type="checkbox" id="chkFov" checked /> 显示机位视野扇区</label>
    <label style="font-size:12px;"><input type="checkbox" id="chkTrail" checked /> 显示运动尾迹</label>
    <label style="font-size:12px; color:#94a3b8;"><input type="checkbox" id="chkBlind" /> 叠暗灰盲区真值（对照用）</label>
  </div>
  <div class="canvas-wrap">
    <canvas id="mapCanvas" width="570" height="1185"></canvas>
  </div>
  <div class="timeline">
    <strong id="timeLabel" style="font-size:18px; color:#38bdf8; min-width:86px;">15:30:00</strong>
    <input type="range" id="slider" min="0" max="119" value="0" />
    <span id="statLabel" style="font-size:13px; min-width:170px; text-align:right;">当前观测点：0</span>
  </div>
</div>

<div id="right">
  <div class="card">
    <h3>实时感知统计</h3>
    <div class="kpi-grid">
      <div class="kpi"><div class="v" id="kObs">0</div><div class="l">当前画面可见观测点</div></div>
      <div class="kpi"><div class="v" id="kBlind" style="color:#64748b">0</div><div class="l">盲区未观测点(隐藏)</div></div>
    </div>
    <div id="pickInfo" class="tip" style="margin-top:8px; color:#fbbf24;">点击任意移动亮点，查看其所属机位、局部 track_id 与真值 person_id。</div>
  </div>
  <div class="card">
    <h3>单机位隔离查看（点击切换，默认全部 28 机位）</h3>
    <div style="margin-bottom:6px;"><button id="btnAllCams" style="width:100%;">显示全部 28 台融合观测</button></div>
    <div class="cam-grid" id="camGrid"></div>
  </div>
  <div class="card">
    <h3>为什么看起来更真实？</h3>
    <div class="tip">
      • <b>盲区完全不可见</b>：行人走出摄像头扇区或处于不同高程层遮挡时立即消失。<br/>
      • <b>重叠视场自动融合</b>：多台相机同时拍到同一人时去重为 1 个观测点。<br/>
      • <b>断轨重编 ID</b>：人走出盲区后超过断轨阈值才重新被观测到，会获得新的 <code>track_id</code>——1Hz 融合视图为 6 秒，24h 融合视图按 30 秒采样为 35 秒，单机位局部 <code>track_id_local</code> 为 8 秒。<br/>
      • <b>定位噪声 + 偶发漏检</b>：叠加 ±0.22m 实测级定位抖动与 4% 遮挡漏检。<br/>
      • 取消勾选顶部「开启 UAV-01 补盲」，可直观对比无人机补盲前后的区别！
    </div>
  </div>
</div>

<script>
const DATA = {json.dumps(payload, ensure_ascii=False, separators=(",", ":"))};
const TIER_COL = ["#f97316", "#fbbf24", "#2dd4bf", "#38bdf8"];

const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const bgImg = new Image();
bgImg.src = "data:image/png;base64," + DATA.bg_png;

let mode = "chrysanthemum";
let fIdx = 0;
let playing = true;
let selectedCam = -1; // -1 = all
let pickedPid = "";

function locToCanvas(lx, ly) {{
  const g = DATA.grid;
  return [((lx - g.xmin) / g.cell) * 3, (g.h - 1 - ((ly - g.ymin) / g.cell)) * 3];
}}

function getFrames() {{
  if (mode === "evening") return DATA.evening_1hz;
  if (mode === "24h") return DATA.day_24h;
  return DATA.chrysanthemum_1hz;
}}

// 构建 28 机位按钮
const camGrid = document.getElementById("camGrid");
DATA.cameras.forEach(c => {{
  const b = document.createElement("div");
  b.className = "cam-btn";
  b.textContent = c.id.replace("CAM-", "C");
  b.title = c.name;
  b.onclick = () => {{
    selectedCam = (selectedCam === c.idx) ? -1 : c.idx;
    updateCamBtns();
    render();
  }};
  camGrid.appendChild(b);
}});
function updateCamBtns() {{
  Array.from(camGrid.children).forEach((el, i) => {{
    el.classList.toggle("active", i === selectedCam);
  }});
}}
document.getElementById("btnAllCams").onclick = () => {{ selectedCam = -1; updateCamBtns(); render(); }};

function filterObs(arr) {{
  const uavOn = document.getElementById("chkUav").checked;
  return arr.filter(p => {{
    if (!uavOn && p[6] === 1) return false;
    if (selectedCam >= 0 && p[3] !== selectedCam) return false;
    return true;
  }});
}}

function render() {{
  const fs = getFrames();
  if (fIdx >= fs.length) fIdx = 0;
  const f = fs[fIdx];
  document.getElementById("slider").max = fs.length - 1;
  document.getElementById("slider").value = fIdx;
  document.getElementById("timeLabel").textContent = f.t;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bgImg, 0, 0, canvas.width, canvas.height);

  // 画机位 FOV 扇区
  const uavOn = document.getElementById("chkUav").checked;
  if (document.getElementById("chkFov").checked) {{
    ctx.save();
    for (const c of DATA.cameras) {{
      if (!uavOn && c.type === "uav_mobile") continue;
      if (selectedCam >= 0 && c.idx !== selectedCam) continue;
      const isUav = c.type === "uav_mobile";
      ctx.fillStyle = isUav ? "rgba(52, 211, 153, 0.14)" : "rgba(56, 189, 248, 0.10)";
      ctx.strokeStyle = isUav ? "rgba(52, 211, 153, 0.70)" : "rgba(125, 211, 252, 0.48)";
      ctx.lineWidth = (selectedCam === c.idx) ? 2.2 : 1.0;
      ctx.beginPath();
      c.poly.forEach((p, i) => {{
        const [sx, sy] = locToCanvas(p[0], p[1]);
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }});
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    }}
    ctx.restore();
  }}

  // 可选：暗灰盲区真值（对照）
  if (document.getElementById("chkBlind").checked && f.blind) {{
    ctx.fillStyle = "rgba(148, 163, 184, 0.28)";
    for (const b of f.blind) {{
      const [sx, sy] = locToCanvas(b[0], b[1]);
      ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
    }}
  }}

  // 运动尾迹（取前 2 帧同 track_id 连线，真实呈现移动感！）
  const curObs = filterObs(f.obs);
  if (document.getElementById("chkTrail").checked && mode !== "24h" && fIdx > 0) {{
    const prevObs = filterObs(fs[fIdx - 1].obs);
    const prevMap = new Map();
    for (const p of prevObs) prevMap.set(p[4], p);
    ctx.strokeStyle = "rgba(125, 211, 252, 0.55)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (const p of curObs) {{
      const q = prevMap.get(p[4]);
      if (q) {{
        const [x1, y1] = locToCanvas(q[0], q[1]);
        const [x2, y2] = locToCanvas(p[0], p[1]);
        if (Math.hypot(x2 - x1, y2 - y1) < 24) {{
          ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        }}
      }}
    }}
    ctx.stroke();
  }}

  // 绘制摄像头真实观测到的移动点
  for (const p of curObs) {{
    const [sx, sy] = locToCanvas(p[0], p[1]);
    const isHi = pickedPid && p[5] === pickedPid;
    ctx.fillStyle = isHi ? "#ffffff" : TIER_COL[p[2]];
    ctx.beginPath();
    ctx.arc(sx, sy, isHi ? 5.5 : 2.6, 0, Math.PI * 2);
    ctx.fill();
    if (isHi) {{
      ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 2; ctx.stroke();
    }}
  }}

  // 闸口标签
  for (const g of DATA.gates) {{
    const [sx, sy] = locToCanvas(g.x, g.y);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(sx - 4, sy - 4, 8, 8);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText(g.id, sx + 7, sy + 4);
  }}

  document.getElementById("kObs").textContent = curObs.length.toLocaleString();
  document.getElementById("kBlind").textContent = (f.blind ? f.blind.length : 0).toLocaleString();
  document.getElementById("statLabel").textContent = "抽样可见观测点：" + curObs.length.toLocaleString();
}}

document.getElementById("slider").oninput = e => {{ fIdx = +e.target.value; render(); }};
document.getElementById("modeSel").onchange = e => {{ mode = e.target.value; fIdx = 0; render(); }};
["chkUav", "chkFov", "chkTrail", "chkBlind"].forEach(id => document.getElementById(id).onchange = render);
document.getElementById("btnPlay").onclick = () => {{
  playing = !playing;
  document.getElementById("btnPlay").textContent = playing ? "⏸ 暂停" : "▶ 播放";
}};

canvas.onclick = e => {{
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const my = (e.clientY - rect.top) * (canvas.height / rect.height);
  const curObs = filterObs(getFrames()[fIdx].obs);
  let best = null, bd = 16;
  for (const p of curObs) {{
    const [sx, sy] = locToCanvas(p[0], p[1]);
    const d = Math.hypot(sx - mx, sy - my);
    if (d < bd) {{ bd = d; best = p; }}
  }}
  if (best) {{
    pickedPid = best[5];
    const cam = DATA.cameras[best[3]];
    document.getElementById("pickInfo").textContent =
      `观测点 ${{best[4]}} | 所属机位：${{cam.id}} (${{cam.name}}) | 真值ID：${{best[5]}} | 坐标：(${{best[0]}}, ${{best[1]}})`;
    render();
  }}
}};

setInterval(() => {{
  if (!playing) return;
  const fs = getFrames();
  fIdx = (fIdx + 1) % fs.length;
  render();
}}, 180);

bgImg.onload = render;
</script>
</body>
</html>
"""
    out_html = OUT_DIR / "sanyang_camera_observed_replay.html"
    out_html.write_text(html, encoding="utf-8")
    print(f"[Viz] Saved {out_html.name} ({out_html.stat().st_size / 1024:.0f} KB)")


def main():
    t_all = time.time()
    env = sim.build_environment()
    peak_chry = fuse_1hz_peak(env, "chrysanthemum", "菊花会下午高峰", 15 * 3600 + 30 * 60, 15 * 3600 + 45 * 60)
    peak_eve = fuse_1hz_peak(env, "evening", "晚饭后全天最高峰", 19 * 3600 + 30 * 60, 19 * 3600 + 45 * 60)
    html_24h, obs24_out, obs24_in = build_24h_camera_observed_30s(env)
    render_comparison_png(env, peak_chry, peak_eve)
    build_camera_observed_html(env, html_24h, peak_chry, peak_eve)
    print(f"[DONE] Camera-observed view & datasets built in {time.time() - t_all:.1f}s")


if __name__ == "__main__":
    main()
