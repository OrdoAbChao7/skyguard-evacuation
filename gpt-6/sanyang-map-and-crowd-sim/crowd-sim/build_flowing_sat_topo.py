#!/usr/bin/env python3
"""
SkyGuard · 真实 z18 卫星底图 + 动态流动地形热力图（人越多越红 + 等高线 + 流动矢量流线）
====================================================================================
解决「静止 1Hz 短片段里红团看起来不流动」的问题：
1. 增加【时间演进涌流模式】：
   - 全天 24 小时流畅演进（每 3 分钟 1 帧，480 帧，看早高峰->午饭退潮->菊花会红潮涌入->晚饭后最高峰->夜间散场）；
   - 菊花会进场涌流（13:30–16:30，每 30 秒 1 帧，360 帧，清晰看到红峰从 G09 涌入扩张）；
   - 晚间散场疏散潮（20:30–22:30，每 30 秒 1 帧，240 帧，清晰看到红峰消退并向三门外流）；
2. 在 1Hz 微观模式与所有模式中，基于真实观测速度矢量 `(vx_mps, vy_mps)` 实时渲染
   **动态流动粒子流线 + 网格主方向矢量箭头**，让红区里的真实移动方向和流速肉眼可见；
3. 支持倍速调节（0.5x / 1x / 2x / 4x）、单机位隔离、UAV-01 补盲开关、热力透明度滑块。
"""
from __future__ import annotations

import base64
import csv
import io
import json
import math
import sys
import time
from collections import defaultdict
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_sanyang_crowd_sim as sim
import build_sat_topo_view as topo_base

OUT_DIR = sim.OUT_DIR


def load_24h_flowing_frames(env: dict):
    """从 camera_observed_fused_24h_30s.csv 一次流式读取，组装 3 套高流畅度动态切片（含速度矢量）。"""
    t0 = time.time()
    cam_id_to_idx = {c["camera_id"]: i for i, c in enumerate(env["cameras"])}
    uav_idx = cam_id_to_idx.get("UAV-01", -1)

    # 1) 菊花会进场涌流：13:30 - 16:30，每 30 秒 1 帧（360 帧）
    # 2) 晚间散场疏散潮：20:30 - 22:30，每 30 秒 1 帧（240 帧）
    # 3) 全天 24h 流畅演进：00:00 - 24:00，每 3 分钟 1 帧（480 帧）
    chry_surge = defaultdict(list)
    eve_disp = defaultdict(list)
    day_3min = defaultdict(list)

    s_c0, s_c1 = 13 * 3600 + 30 * 60, 16 * 3600 + 30 * 60
    s_e0, s_e1 = 20 * 3600 + 30 * 60, 22 * 3600 + 30 * 60

    with (OUT_DIR / "camera_observed_fused_24h_30s.csv").open("r", encoding="utf-8-sig") as f:
        r = csv.reader(f)
        next(r)
        for row in r:
            ts = row[0]
            h, m, s = int(ts[11:13]), int(ts[14:16]), int(ts[17:19])
            sec = h * 3600 + m * 60 + s

            in_c = (s_c0 <= sec < s_c1)
            in_e = (s_e0 <= sec < s_e1)
            in_d = (sec % 180 == 0)
            if not (in_c or in_e or in_d):
                continue

            pid_num = int(row[2][1:])
            # 稳定哈希抽样 1/5（保证每个帧里 400-600 点，浏览器 60fps 极速且红峰平滑流动！）
            if pid_num % 5 != 0:
                continue

            ci = cam_id_to_idx[row[3]]
            uav_only = 1 if (row[4] == "UAV-01") else 0
            # [lx, ly, vx, vy, ci, uav_only]
            pt = [
                round(float(row[9]), 1),
                round(float(row[10]), 1),
                round(float(row[12]), 2),
                round(float(row[13]), 2),
                ci,
                uav_only,
            ]
            if in_c:
                chry_surge[sec].append(pt)
            if in_e:
                eve_disp[sec].append(pt)
            if in_d:
                day_3min[sec].append(pt)

    def pack(d_map, secs):
        out = []
        for sec in secs:
            out.append({
                "t": f"{sec // 3600:02d}:{(sec % 3600) // 60:02d}:{sec % 60:02d}",
                "s": sec,
                "p": d_map.get(sec, []),
            })
        return out

    f_c = pack(chry_surge, range(s_c0, s_c1, 30))
    f_e = pack(eve_disp, range(s_e0, s_e1, 30))
    f_d = pack(day_3min, range(0, 86400, 180))
    print(f"[Flow] Loaded 24h(480f), chry_surge(360f), eve_disp(240f) in {time.time() - t0:.1f}s")
    return f_d, f_c, f_e


def load_1hz_with_vel(env: dict, key: str, start_sec: int, duration_s: int = 120):
    """从 camera_observed_fused_{key}_1hz.csv 读取前 120 秒真 1Hz 观测点（带真实 vx, vy）。"""
    t0 = time.time()
    cam_id_to_idx = {c["camera_id"]: i for i, c in enumerate(env["cameras"])}
    end_sec = start_sec + duration_s
    by_sec = defaultdict(list)

    with (OUT_DIR / f"camera_observed_fused_{key}_1hz.csv").open("r", encoding="utf-8-sig") as f:
        r = csv.reader(f)
        next(r)
        for row in r:
            ts = row[0]
            h, m, s = int(ts[11:13]), int(ts[14:16]), int(ts[17:19])
            sec = h * 3600 + m * 60 + s
            if sec >= end_sec:
                break
            if sec < start_sec:
                continue
            if int(row[2][1:]) % 4 != 0:
                continue
            ci = cam_id_to_idx[row[3]]
            uav_only = 1 if (row[4] == "UAV-01") else 0
            by_sec[sec].append([
                round(float(row[9]), 1),
                round(float(row[10]), 1),
                round(float(row[12]), 2),
                round(float(row[13]), 2),
                ci,
                uav_only,
            ])

    frames = []
    for sec in range(start_sec, end_sec):
        frames.append({
            "t": f"{sec // 3600:02d}:{(sec % 3600) // 60:02d}:{sec % 60:02d}",
            "s": sec,
            "p": by_sec.get(sec, []),
        })
    print(f"[Flow] Loaded 1Hz '{key}' ({len(frames)}f) in {time.time() - t0:.1f}s")
    return frames


def build_flowing_html(env: dict, sat_570: Image.Image, f_day, f_chry_surge, f_eve_disp, f_chry_1hz):
    frame: sim.LocalFrame = env["frame"]
    buf = io.BytesIO()
    sat_570.save(buf, format="JPEG", quality=88)
    sat_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    cams_js = []
    for i, c in enumerate(env["cameras"]):
        pts = [frame.to_local(p[0], p[1]) for p in c["fov_polygon_utm50n"]]
        cams_js.append({
            "idx": i,
            "id": c["camera_id"],
            "name": c["name"],
            "tier": c["elevation_tier_m"],
            "type": c["camera_type"],
            "poly": [[round(a, 1), round(b, 1)] for a, b in pts[::2]],
        })

    gates_js = [{"id": gid, "x": round(xy[0], 1), "y": round(xy[1], 1)} for gid, xy in env["gates_loc"].items()]
    payload = {
        "grid": {"w": sim.GRID_W, "h": sim.GRID_H, "cell": sim.CELL_M, "xmin": sim.X_MIN_LOC, "ymin": sim.Y_MIN_LOC},
        "sat_jpg": sat_b64,
        "gates": gates_js,
        "cameras": cams_js,
        "day_24h": f_day,
        "chry_surge": f_chry_surge,
        "eve_disp": f_eve_disp,
        "chry_1hz": f_chry_1hz,
    }

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>SkyGuard · 真实卫星图 + 动态流动地形人流热力（人越多越红）</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: #0a1019; color: #e2ecf6; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; display: flex; height: 100vh; overflow: hidden; }}
  #left {{ flex: 1; display: flex; flex-direction: column; padding: 12px 16px; gap: 10px; min-width: 0; }}
  #right {{ width: 385px; background: #111b29; border-left: 1px solid #24364d; padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }}
  .header {{ display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }}
  .header h1 {{ font-size: 18px; color: #f8fafc; }}
  .badge {{ background: #991b1b; color: #fecaca; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }}
  .toolbar {{ display: flex; gap: 8px; flex-wrap: wrap; align-items: center; background: #111b29; padding: 8px 12px; border-radius: 8px; border: 1px solid #24364d; }}
  button, select {{ background: #1c2c42; color: #e2ecf6; border: 1px solid #334d6e; border-radius: 6px; padding: 5px 10px; font-size: 13px; cursor: pointer; }}
  button:hover {{ background: #274060; }}
  .canvas-wrap {{ flex: 1; display: flex; justify-content: center; align-items: center; background: #060a10; border: 1px solid #24364d; border-radius: 8px; overflow: hidden; }}
  canvas {{ max-height: 100%; max-width: 100%; }}
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
    <h1>SkyGuard · 真实卫星图 + 动态流动地形人流热力（仅 28 机位可见）</h1>
    <span class="badge" id="modeBadge">动态涌流模式：红峰随潮汐生长/流动 + 实时流线</span>
  </div>
  <div class="toolbar">
    <button id="btnPlay">⏸ 暂停</button>
    <select id="modeSel">
      <option value="day_24h" selected>全天 24 小时流畅演进（00:00–24:00，看潮汐红潮涨落！）</option>
      <option value="chry_surge">菊花会进场涌流（13:30–16:30，每30秒，红峰涌入扩张）</option>
      <option value="eve_disp">晚间散场疏散潮（20:30–22:30，每30秒，红峰消退外流）</option>
      <option value="chry_1hz">菊花会高峰微观 1Hz（15:30，真实每秒流线）</option>
    </select>
    <select id="speedSel">
      <option value="220">0.5x 慢速</option>
      <option value="110" selected>1x 流畅</option>
      <option value="55">2x 快速</option>
      <option value="28">4x 极速</option>
    </select>
    <label style="font-size:12px;"><input type="checkbox" id="chkTopo" checked /> 地形热力(越密越红)</label>
    <label style="font-size:12px;"><input type="checkbox" id="chkContour" checked /> 等高线</label>
    <label style="font-size:12px;"><input type="checkbox" id="chkFlow" checked /> 动态流动矢量流线</label>
    <label style="font-size:12px;"><input type="checkbox" id="chkFov" checked /> 机位FOV</label>
    <label style="font-size:12px;"><input type="checkbox" id="chkUav" checked /> UAV-01补盲</label>
  </div>
  <div class="canvas-wrap">
    <canvas id="mapCanvas" width="570" height="1185"></canvas>
  </div>
  <div class="timeline">
    <strong id="timeLabel" style="font-size:18px; color:#f87171; min-width:86px;">06:00:00</strong>
    <input type="range" id="slider" min="0" max="479" value="120" style="flex:1;" />
    <span style="font-size:12px; color:#94a3b8;">热力透明度</span>
    <input type="range" id="alphaSlider" min="30" max="100" value="82" style="width:85px;" />
  </div>
</div>

<div id="right">
  <div class="card">
    <h3>地形密度色带（越密越高越红）</h3>
    <div class="colorbar"></div>
    <div class="cb-labels"><span>稀疏(绿)</span><span>温和(黄)</span><span>密集(橙)</span><span>高峰(深红)</span></div>
    <div class="kpi-grid" style="margin-top:10px;">
      <div class="kpi"><div class="v" id="kObs">0</div><div class="l">当前视野内估算人数</div></div>
      <div class="kpi"><div class="v" id="kSpd" style="color:#38bdf8">0.00</div><div class="l">平均移动速度 (m/s)</div></div>
    </div>
  </div>
  <div class="card">
    <h3>单机位隔离查看（默认 28 机位融合）</h3>
    <div style="margin-bottom:6px;"><button id="btnAllCams" style="width:100%;">显示全部 28 台融合流动热力</button></div>
    <div class="cam-grid" id="camGrid"></div>
  </div>
  <div class="card">
    <h3>为什么现在能清晰看到「红峰在流动」？</h3>
    <div class="tip">
      • <b>默认切到潮汐演进视角</b>：之前默认看的是 15:30 稳态高峰的 2 分钟（人在花坛原地驻留，红峰自然不动）；现在默认直接看<b>全天 24h 潮汐演进 / 进场涌流 / 晚间散场潮</b>，能清晰看到红潮从闸口涌入、在广场隆起、沿步道蔓延、再向出口退潮！<br/>
      • <b>叠加真实速度矢量流线</b>：根据每个观测点的真实 <code>(vx, vy)</code> 实时计算局部流速场，在热力上叠加<b>流动脉冲箭头/粒子线</b>，哪怕在稳态高峰也能一眼看出人流往哪边走、走得多快！
    </div>
  </div>
</div>

<script>
const DATA = {json.dumps(payload, ensure_ascii=False, separators=(",", ":"))};
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");

const satImg = new Image();
satImg.src = "data:image/jpeg;base64," + DATA.sat_jpg;

// 地形热力离线小画布 + 流速场网格
const KW = 95, KH = 198;
const heatCanvas = document.createElement("canvas");
heatCanvas.width = KW; heatCanvas.height = KH;
const hctx = heatCanvas.getContext("2d");
const hImgData = hctx.createImageData(KW, KH);

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

const RAD = 5;
const KERN = [];
let ksum = 0;
for (let k = -RAD; k <= RAD; k++) {{ const w = Math.exp(-0.5 * (k / 2.2) ** 2); KERN.push(w); ksum += w; }}
for (let i = 0; i < KERN.length; i++) KERN[i] /= ksum;

const field = new Float32Array(KW * KH);
const tmpF = new Float32Array(KW * KH);
const lvlArr = new Uint8Array(KW * KH);

// 粗网格速度场（用于画清晰不杂乱的动态流动箭头）
const VW = 24, VH = 50;
const vSumX = new Float32Array(VW * VH);
const vSumY = new Float32Array(VW * VH);
const vCnt = new Float32Array(VW * VH);

let mode = "day_24h";
let fIdx = 120; // 默认从 06:00 晨练起播，马上就能看到早高峰->午饭退潮->菊花会红潮->晚饭后最高峰！
let playing = true;
let selectedCam = -1;
let animPhase = 0;
let playTimer = null;

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
  if (mode === "chry_surge") return DATA.chry_surge;
  if (mode === "eve_disp") return DATA.eve_disp;
  if (mode === "chry_1hz") return DATA.chry_1hz;
  return DATA.day_24h;
}}

function filterObs(arr) {{
  const uavOn = document.getElementById("chkUav").checked;
  return arr.filter(p => {{
    if (!uavOn && p[5] === 1) return false;
    if (selectedCam >= 0 && p[4] !== selectedCam) return false;
    return true;
  }});
}}

function renderTopoHeat(obsPts) {{
  field.fill(0); tmpF.fill(0);
  const g = DATA.grid;
  const xSpan = g.w * g.cell, ySpan = g.h * g.cell;
  for (const p of obsPts) {{
    const gx = Math.floor(((p[0] - g.xmin) / xSpan) * KW);
    const gy = KH - 1 - Math.floor(((p[1] - g.ymin) / ySpan) * KH);
    if (gx >= 0 && gx < KW && gy >= 0 && gy < KH) field[gy * KW + gx] += 1.0;
  }}
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
  for (let y = 0; y < KH; y++) {{
    const dstOff = y * KW;
    for (let k = -RAD; k <= RAD; k++) {{
      const ny = y + k;
      if (ny >= 0 && ny < KH) {{
        const w = KERN[k + RAD], srcOff = ny * KW;
        for (let x = 0; x < KW; x++) {{
          const sv = tmpF[srcOff + x];
          if (sv > 0) field[dstOff + x] += sv * w;
        }}
      }}
    }}
  }}

  const vmax = (mode === "chry_1hz") ? 0.55 : 0.44;
  const levels = [0.05, 0.14, 0.26, 0.42, 0.60, 0.80];
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
      if (v < vmax * 0.015) {{ d[o + 3] = 0; continue; }}
      const norm = Math.min(1.0, Math.pow(v / vmax, 0.72));
      const li = Math.min(255, Math.floor(norm * 255)) * 3;
      const dx = (field[y * KW + Math.min(KW - 1, x + 1)] - field[y * KW + Math.max(0, x - 1)]) / vmax;
      const dy = (field[Math.min(KH - 1, y + 1) * KW + x] - field[Math.max(0, y - 1) * KW + x]) / vmax;
      const shade = Math.max(0.76, Math.min(1.18, 1.0 - (dx + dy) * 1.4));

      const lv = lvlArr[idx];
      const isC = showContour && lv >= 1 && (
        (x + 1 < KW && lvlArr[idx + 1] !== lv) || (y + 1 < KH && lvlArr[idx + KW] !== lv)
      );
      if (isC) {{
        if (lv >= 4) {{ d[o] = 255; d[o + 1] = 245; d[o + 2] = 225; d[o + 3] = Math.round(230 * alphaScale); }}
        else {{ d[o] = 45; d[o + 1] = 24; d[o + 2] = 16; d[o + 3] = Math.round(185 * alphaScale); }}
      }} else {{
        d[o] = Math.min(255, LUT[li] * shade);
        d[o + 1] = Math.min(255, LUT[li + 1] * shade);
        d[o + 2] = Math.min(255, LUT[li + 2] * shade);
        d[o + 3] = Math.round((95 + 130 * norm) * alphaScale);
      }}
    }}
  }}
  hctx.putImageData(hImgData, 0, 0);
}}

function drawFlowVectors(obsPts) {{
  vSumX.fill(0); vSumY.fill(0); vCnt.fill(0);
  const g = DATA.grid;
  const xSpan = g.w * g.cell, ySpan = g.h * g.cell;

  // 1. 每个移动点画短流动光尾（按真实 vx, vy 方向与脉冲相位滑动，立刻有强烈流动感！）
  ctx.save();
  ctx.lineWidth = 1.4;
  for (const p of obsPts) {{
    const spd = Math.hypot(p[2], p[3]);
    if (spd < 0.08) continue;
    const [sx, sy] = locToCanvas(p[0], p[1]);
    // 局部坐标 y 向上，Canvas y 向下 -> dy 取负
    const ux = p[2] / spd, uy = -p[3] / spd;
    const shift = ((animPhase * 4) % 8) - 4;
    const len = Math.min(12, 4 + spd * 6);
    const x1 = sx + ux * shift, y1 = sy + uy * shift;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.72)";
    ctx.beginPath();
    ctx.moveTo(x1 - ux * len * 0.5, y1 - uy * len * 0.5);
    ctx.lineTo(x1 + ux * len * 0.5, y1 + uy * len * 0.5);
    ctx.stroke();

    const vx_i = Math.floor(((p[0] - g.xmin) / xSpan) * VW);
    const vy_i = VH - 1 - Math.floor(((p[1] - g.ymin) / ySpan) * VH);
    if (vx_i >= 0 && vx_i < VW && vy_i >= 0 && vy_i < VH) {{
      const k = vy_i * VW + vx_i;
      vSumX[k] += p[2]; vSumY[k] += p[3]; vCnt[k] += 1;
    }}
  }}

  // 2. 粗网格宏观流动主方向箭头（青白高亮，一眼看清通道/广场往哪边流！）
  ctx.strokeStyle = "#e0f2fe";
  ctx.fillStyle = "#e0f2fe";
  ctx.lineWidth = 1.8;
  for (let y = 0; y < VH; y++) {{
    for (let x = 0; x < VW; x++) {{
      const k = y * VW + x;
      if (vCnt[k] < 2) continue;
      const mvx = vSumX[k] / vCnt[k], mvy = vSumY[k] / vCnt[k];
      const spd = Math.hypot(mvx, mvy);
      if (spd < 0.14) continue;
      const cx = ((x + 0.5) / VW) * canvas.width;
      const cy = ((y + 0.5) / VH) * canvas.height;
      const ang = Math.atan2(-mvy, mvx);
      const len = Math.min(18, 7 + spd * 10);
      const ex = cx + Math.cos(ang) * len;
      const ey = cy + Math.sin(ang) * len;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - Math.cos(ang - 0.5) * 5, ey - Math.sin(ang - 0.5) * 5);
      ctx.lineTo(ex - Math.cos(ang + 0.5) * 5, ey - Math.sin(ang + 0.5) * 5);
      ctx.closePath(); ctx.fill();
    }}
  }}
  ctx.restore();
}}

function render() {{
  const fs = getFrames();
  if (fIdx >= fs.length) fIdx = 0;
  const f = fs[fIdx];
  document.getElementById("slider").max = fs.length - 1;
  document.getElementById("slider").value = fIdx;
  document.getElementById("timeLabel").textContent = f.t;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(satImg, 0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(8, 14, 24, 0.24)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const curObs = filterObs(f.p);

  if (document.getElementById("chkTopo").checked) {{
    renderTopoHeat(curObs);
    ctx.drawImage(heatCanvas, 0, 0, canvas.width, canvas.height);
  }}

  const uavOn = document.getElementById("chkUav").checked;
  if (document.getElementById("chkFov").checked) {{
    ctx.save();
    for (const c of DATA.cameras) {{
      if (!uavOn && c.type === "uav_mobile") continue;
      if (selectedCam >= 0 && c.idx !== selectedCam) continue;
      const isUav = c.type === "uav_mobile";
      ctx.strokeStyle = isUav ? "rgba(110, 231, 183, 0.70)" : "rgba(186, 230, 253, 0.42)";
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

  if (document.getElementById("chkFlow").checked) {{
    drawFlowVectors(curObs);
  }}

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

  const scaleFactor = (mode === "chry_1hz") ? 4 : 5;
  let spdSum = 0;
  for (const p of curObs) spdSum += Math.hypot(p[2], p[3]);
  document.getElementById("kObs").textContent = (curObs.length * scaleFactor).toLocaleString();
  document.getElementById("kSpd").textContent = curObs.length ? (spdSum / curObs.length).toFixed(2) : "0.00";
}}

function startTimer() {{
  if (playTimer) clearInterval(playTimer);
  const ms = +document.getElementById("speedSel").value;
  playTimer = setInterval(() => {{
    if (!playing) return;
    animPhase += 1;
    const fs = getFrames();
    fIdx = (fIdx + 1) % fs.length;
    render();
  }}, ms);
}}

document.getElementById("slider").oninput = e => {{ fIdx = +e.target.value; render(); }};
document.getElementById("alphaSlider").oninput = render;
document.getElementById("speedSel").onchange = startTimer;
document.getElementById("modeSel").onchange = e => {{
  mode = e.target.value;
  fIdx = (mode === "day_24h") ? 120 : 0;
  render();
}};
["chkTopo", "chkContour", "chkFlow", "chkFov", "chkUav"].forEach(id => document.getElementById(id).onchange = render);
document.getElementById("btnPlay").onclick = () => {{
  playing = !playing;
  document.getElementById("btnPlay").textContent = playing ? "⏸ 暂停" : "▶ 播放";
}};

satImg.onload = () => {{ render(); startTimer(); }};
</script>
</body>
</html>
"""
    out_html = OUT_DIR / "sanyang_sat_topo_replay.html"
    out_html.write_text(html, encoding="utf-8")
    print(f"[Viz] Upgraded flowing {out_html.name} ({out_html.stat().st_size / 1024:.0f} KB)")


def main():
    t0 = time.time()
    env = sim.build_environment()
    sat_570 = topo_base.warp_satellite_to_local_pil(env["frame"], sim.GRID_W * 3, sim.GRID_H * 3)
    f_day, f_chry_surge, f_eve_disp = load_24h_flowing_frames(env)
    f_chry_1hz = load_1hz_with_vel(env, "chrysanthemum", 15 * 3600 + 30 * 60, 120)
    build_flowing_html(env, sat_570, f_day, f_chry_surge, f_eve_disp, f_chry_1hz)
    print(f"[DONE] Flowing satellite topo replay built in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
