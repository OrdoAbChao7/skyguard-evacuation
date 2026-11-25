"""Render frame-by-frame head-detection boxes directly into the seven replay videos.

Uses calibrated 3D head-size geometry filtering, near/far dual-model zoning
(original YOLOv8s-Head for near/mid + Model 2 for far; C2 original-only),
and zero-latency [t-1, t+1] 2-frame anti-flicker confirmation.
"""
import argparse
from pathlib import Path
import subprocess
import sys
import time
from xml.etree import ElementTree as ET

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
GROUND = HERE.parents[2]
OUTPUTS = GROUND.parent
SOURCE = OUTPUTS / "wildtrack-multiview-prep-v1"
LOCAL = OUTPUTS / "wildtrack-c1-prep-v1/source/Wildtrack_dataset"
FFMPEG = Path("D:/tools/ffmpeg/bin/ffmpeg.exe")
CAMERAS = ("CVLab1", "CVLab2", "CVLab3", "CVLab4", "IDIAP1", "IDIAP2", "IDIAP3")

sys.path.insert(0, str(SOURCE))
from align_window import cal
sys.path.insert(0, str(OUTPUTS / "citystreet-c3-sync-v1"))
from build_replay import WEIGHT, WEIGHT_HASH, load_module, read_json, sha
sys.path.insert(0, str(OUTPUTS / "wildtrack-roi-review-v1/c2-ablation"))
from compare import ORIGINAL, ORIGINAL_HASH


def draw_coordinates(boxes, k0, distortion, k1, remap):
    """Exact lens reprojection & <=0.5px remap check from prepare_head_wall.py."""
    if not len(boxes):
        return []
    x0, y0, x1, y1 = np.asarray(boxes).T
    x, y = (x0 + x1) / 2, (y0 + y1) / 2
    ideal = np.stack([(x0, y0), (x, y0), (x1, y0), (x1, y), (x1, y1), (x, y1), (x0, y1), (x0, y)], axis=0)
    ideal = np.ascontiguousarray(ideal.transpose(2, 0, 1).reshape(-1, 2))
    homogeneous = np.column_stack((ideal, np.ones(len(ideal))))
    raw = cv2.projectPoints(homogeneous @ np.linalg.inv(k1).T, np.zeros(3), np.zeros(3), k0, distortion)[0]
    remapped = cv2.remap(remap, ideal.astype(np.float32).reshape(-1, 1, 2), None,
                         cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    inside = ((ideal[:, 0] >= 0) & (ideal[:, 0] <= 1919) &
              (ideal[:, 1] >= 0) & (ideal[:, 1] <= 1079))
    if np.any(inside) and np.abs(remapped[inside] - raw[inside]).max() > 0.5:
        raise ValueError("Head box overlay disagrees with the detector's lens remap")
    return (raw / 3).reshape(-1, 8, 2).round(2).tolist()


def load_extrinsic(cam_name: str):
    rel = Path("calibrations/extrinsic") / f"extr_{cam_name}.xml"
    path = SOURCE / "reference/Wildtrack_dataset" / rel
    if not path.is_file():
        path = LOCAL / rel
    root = ET.parse(path)
    rvec = np.fromstring(root.findtext("rvec"), sep=" ")
    t = np.fromstring(root.findtext("tvec"), sep=" ") / 100.0
    rot = cv2.Rodrigues(rvec)[0]
    center = -rot.T @ t
    return rot, t, center


def expected_head_px(cx: float, cy: float, k1_inv: np.ndarray, f_avg: float,
                     rot: np.ndarray, center: np.ndarray, head_m: float = 0.25) -> float | None:
    d_cam = k1_inv @ np.array([cx, cy, 1.0])
    d_world = rot.T @ d_cam
    if abs(d_world[2]) < 1e-6:
        return None
    for z in (1.65, 2.8):
        s = (z - center[2]) / d_world[2]
        if s > 0.5:
            return float(f_avg * head_m / s)
    return None


def geom_filter(boxes, scores, k1_inv, f_avg, rot, center,
                min_conf: float = 0.30, min_ratio: float = 0.52, max_ratio: float = 1.85):
    kept_b, kept_s, kept_exp = [], [], []
    for box, score in zip(boxes, scores):
        if score < min_conf:
            continue
        x0, y0, x1, y1 = box
        w, h = x1 - x0, y1 - y0
        if w <= 2 or h <= 2:
            continue
        cx, cy = (x0 + x1) * 0.5, (y0 + y1) * 0.5
        d_exp = expected_head_px(cx, cy, k1_inv, f_avg, rot, center)
        if d_exp is None:
            continue
        edge_x = (x0 <= 6) or (x1 >= 1913)
        edge_y = (y0 <= 6) or (y1 >= 1073)
        size = h if (edge_x and not edge_y) else (w if (edge_y and not edge_x) else float(np.sqrt(w * h)))
        if not edge_x and not edge_y:
            ar = w / h
            if ar < 0.38 or ar > 1.9:
                continue
        ratio = size / d_exp
        if min_ratio <= ratio <= max_ratio:
            kept_b.append(box)
            kept_s.append(float(score))
            kept_exp.append(d_exp)
    return kept_b, kept_s, kept_exp


def iou_box(a, b) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    if inter <= 0.0:
        return 0.0
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return float(inter / max(ua, 1e-6))


def dedup_boxes(boxes, scores):
    if not boxes:
        return [], []
    order = np.argsort(scores)[::-1]
    out_b, out_s = [], []
    for i in order:
        bi = boxes[i]
        ci = np.array([(bi[0] + bi[2]) * 0.5, (bi[1] + bi[3]) * 0.5])
        si = float(np.sqrt((bi[2] - bi[0]) * (bi[3] - bi[1])))
        dup = False
        for bj in out_b:
            if iou_box(bi, bj) >= 0.40:
                dup = True
                break
            cj = np.array([(bj[0] + bj[2]) * 0.5, (bj[1] + bj[3]) * 0.5])
            sj = float(np.sqrt((bj[2] - bj[0]) * (bj[3] - bj[1])))
            if float(np.linalg.norm(ci - cj)) < 0.45 * min(si, sj):
                dup = True
                break
        if not dup:
            out_b.append(bi)
            out_s.append(scores[i])
    return out_b, out_s


def fuse_frame(camera: str, corrected: np.ndarray, model_orig, model_m2, predict, inf_cfg: dict,
               k1_inv, f_avg, rot, center, split_px: float = 66.0):
    bo, so = predict([corrected], model_orig, inf_cfg)[0]
    bo, so, eo = geom_filter(bo, so, k1_inv, f_avg, rot, center, min_conf=0.30)
    if camera == "C2":
        return dedup_boxes(bo, so)
    bm, sm = predict([corrected], model_m2, inf_cfg)[0]
    bm, sm, em = geom_filter(bm, sm, k1_inv, f_avg, rot, center, min_conf=0.30)
    fused_b, fused_s = [], []
    for b, s, e in zip(bo, so, eo):
        if e >= split_px or s >= 0.45:
            fused_b.append(b)
            fused_s.append(s)
    for b, s, e in zip(bm, sm, em):
        if e < split_px:
            fused_b.append(b)
            fused_s.append(s)
    return dedup_boxes(fused_b, fused_s)


def temporal_confirm(seq_boxes: list[list]) -> list[list]:
    """Zero-latency [t-1, t+1] 2-frame confirmation to remove single-frame flickers."""
    n = len(seq_boxes)
    if n <= 1:
        return seq_boxes
    out = []
    for t in range(n):
        neighbors = []
        if t > 0:
            neighbors.extend(seq_boxes[t - 1])
        if t + 1 < n:
            neighbors.extend(seq_boxes[t + 1])
        kept = []
        for b in seq_boxes[t]:
            c = np.array([(b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5])
            s = float(np.sqrt((b[2] - b[0]) * (b[3] - b[1])))
            thresh = max(24.0, 0.9 * s)
            if any(
                iou_box(b, nb) >= 0.15
                or float(np.linalg.norm(c - np.array([(nb[0] + nb[2]) * 0.5, (nb[1] + nb[3]) * 0.5]))) <= thresh
                for nb in neighbors
            ):
                kept.append(b)
        out.append(kept)
    return out


def hex_to_bgr(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (b, g, r)


def draw_head_boxes(frame: np.ndarray, polys: list, color_bgr: tuple[int, int, int], thickness: int = 2) -> np.ndarray:
    canvas = frame.copy()
    if not polys:
        return canvas
    shift = 2
    scale = 1 << shift
    small, large = [], []
    for poly in polys:
        pts = np.asarray(poly, dtype=np.float32)
        span = float(max(pts[:, 0].max() - pts[:, 0].min(), pts[:, 1].max() - pts[:, 1].min()))
        contour = np.round(pts * scale).astype(np.int32).reshape(-1, 1, 2)
        if span < 18.0:
            small.append(contour)
        else:
            large.append(contour)
    if small:
        cv2.polylines(canvas, small, isClosed=True, color=color_bgr, thickness=1,
                      lineType=cv2.LINE_AA, shift=shift)
    if large:
        cv2.polylines(canvas, large, isClosed=True, color=color_bgr, thickness=thickness,
                      lineType=cv2.LINE_AA, shift=shift)
    return canvas


def open_ffmpeg_writer(out_path: Path, width: int, height: int) -> subprocess.Popen:
    cmd = [
        str(FFMPEG),
        "-y",
        "-loglevel", "error",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-pix_fmt", "bgr24",
        "-s", f"{width}x{height}",
        "-r", "30000/1001",
        "-i", "-",
        "-an",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-g", "15",
        "-movflags", "+faststart",
        str(out_path),
    ]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)


def render_camera(camera: str, cam_name: str, color_hex: str, model_orig, model_m2,
                  predict, inf_cfg: dict, out_dir: Path, max_frames: int | None,
                  sample_dir: Path | None, thickness: int) -> tuple[int, int]:
    src = HERE / "video" / f"{camera}.mp4"
    if not src.exists():
        raise FileNotFoundError(f"Missing source video: {src}")

    k0, dist = cal("intrinsic_original", cam_name)
    k1, _ = cal("intrinsic_zero", cam_name)
    k1_inv = np.linalg.inv(k1)
    f_avg = float(0.5 * (k1[0, 0] + k1[1, 1]))
    rot, _, center = load_extrinsic(cam_name)
    remap, _ = cv2.initUndistortRectifyMap(k0, dist, None, k1, (1920, 1080), cv2.CV_32FC2)
    fixed, fraction = cv2.convertMaps(remap, None, cv2.CV_16SC2)
    color_bgr = hex_to_bgr(color_hex)

    t0 = time.perf_counter()

    # Pass 1: per-frame geometry-filtered + dual-model detection
    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        raise OSError(f"Cannot open {src}")
    seq_boxes = []
    try:
        while True:
            if max_frames is not None and len(seq_boxes) >= max_frames:
                break
            ok, frame = cap.read()
            if not ok:
                break
            if frame.shape[:2] != (360, 640):
                raise ValueError(f"{camera} frame {len(seq_boxes)} unexpected shape {frame.shape}")
            full = cv2.resize(frame, (1920, 1080), interpolation=cv2.INTER_LINEAR)
            corrected = cv2.remap(full, fixed, fraction, cv2.INTER_LINEAR)
            boxes, _ = fuse_frame(camera, corrected, model_orig, model_m2, predict, inf_cfg,
                                  k1_inv, f_avg, rot, center)
            seq_boxes.append(boxes)
    finally:
        cap.release()

    # Zero-latency 2-frame anti-flicker confirmation
    confirmed_boxes = temporal_confirm(seq_boxes)

    # Pass 2: draw confirmed reprojected polygons and encode H.264 MP4
    out_dir.mkdir(parents=True, exist_ok=True)
    final_path = out_dir / f"{camera}.mp4"
    part_path = out_dir / f"{camera}.part.mp4"

    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        raise OSError(f"Cannot reopen {src}")
    proc = open_ffmpeg_writer(part_path, 640, 360)
    frames_done = 0
    total_boxes = 0

    try:
        for boxes in confirmed_boxes:
            ok, frame = cap.read()
            if not ok:
                raise OSError(f"{camera} frame {frames_done} missing on pass 2")
            polys = draw_coordinates(boxes, k0, dist, k1, remap)
            drawn = draw_head_boxes(frame, polys, color_bgr, thickness=thickness)
            assert proc.stdin is not None
            proc.stdin.write(drawn.tobytes())
            if sample_dir is not None and frames_done in (0, 15, 30, 44, 225, 449):
                sample_dir.mkdir(parents=True, exist_ok=True)
                ok_enc, buf = cv2.imencode(".png", drawn)
                if not ok_enc:
                    raise OSError(f"Could not encode sample {camera} frame {frames_done}")
                (sample_dir / f"{camera}_f{frames_done:03d}.png").write_bytes(buf.tobytes())
            frames_done += 1
            total_boxes += len(polys)
    finally:
        cap.release()
        if proc.stdin is not None:
            proc.stdin.close()
        stderr = proc.stderr.read().decode("utf-8", errors="replace") if proc.stderr else ""
        rc = proc.wait()
        if rc != 0:
            part_path.unlink(missing_ok=True)
            raise RuntimeError(f"ffmpeg failed for {camera} (rc={rc}): {stderr}")

    part_path.replace(final_path)
    dt = time.perf_counter() - t0
    raw_total = sum(map(len, seq_boxes))
    print(f"{camera}: {frames_done} frames, {total_boxes} head boxes (pre-2F {raw_total}), {dt:.1f}s -> {final_path}",
          flush=True)
    return frames_done, total_boxes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cameras", nargs="+", default=["C1", "C2", "C3", "C4", "C5", "C6", "C7"])
    parser.add_argument("--max-frames", type=int, default=None)
    parser.add_argument("--out-dir", type=Path, default=HERE / "video-head")
    parser.add_argument("--sample-dir", type=Path, default=None)
    parser.add_argument("--thickness", type=int, default=2)
    args = parser.parse_args()

    if sha(WEIGHT) != WEIGHT_HASH:
        raise ValueError("Unexpected Model 2 checkpoint")
    if sha(ORIGINAL) != ORIGINAL_HASH:
        raise ValueError("Unexpected original YOLOv8s-Head checkpoint")

    timeline = read_json(HERE / "merged.json")
    protocol = read_json(OUTPUTS / "citystreet-c3-sync-v1/protocol.json")
    probe = load_module("probe_c_tile_dedup")
    predict = load_module("benchmark_b_paths").full_predict

    selected = set(args.cameras)
    need_m2 = bool(selected - {"C2"})

    model_orig = probe.configure_model({**protocol, "weights": str(ORIGINAL)})
    model_m2 = probe.configure_model(protocol) if need_m2 else None

    for row, cam_name in zip(timeline["cameras"], CAMERAS):
        camera = row["id"]
        if camera not in selected:
            continue
        render_camera(
            camera=camera,
            cam_name=cam_name,
            color_hex=row["color"],
            model_orig=model_orig,
            model_m2=model_m2,
            predict=predict,
            inf_cfg=protocol["inference"],
            out_dir=args.out_dir,
            max_frames=args.max_frames,
            sample_dir=args.sample_dir,
            thickness=args.thickness,
        )


if __name__ == "__main__":
    main()
