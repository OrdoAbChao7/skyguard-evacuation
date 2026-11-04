#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
SkyGuard 人群感知服务（CPU 参考实现）。

职责：从视频文件中估计某个区域的人数，并给出可解释的置信度。

**方法与其真实局限（必须如实阅读）**
------------------------------------------------
本实现统计"运动前景的连通域个数"，提供三种方法：
  - `diff`（默认）：相邻采样帧差分 → 阈值 → 形态学 → 连通域。对慢速运动稳健，
    不会像背景建模那样把缓慢移动的目标吸收进背景；
  - `mog2`：OpenCV MOG2 背景建模。适合长期静止机位，但慢速物体会被背景模型吸收；
  - `hybrid`：两者掩膜取并集。

共同局限：
- 真实读取视频像素，不是随机数，也不是预设人数。
- 假设**固定机位、静止背景**；镜头移动或光照剧变会显著降低准确度。
- **无法可靠分割高密度人群**：人群相互粘连时连通域数量会显著低于真实人数，
  高密度下结果只能视为下界。
- 不区分人与其他运动物体（行李箱、车辆、飘动织物等）。
- 输出置信度只刻画"帧间检测的稳定性"，不刻画绝对准确率。
- 正确的做法是替换为专用人群计数模型；本项目通过 CrowdInferenceProvider 保留接入点。

高密度场景的正确做法是接入专用人群计数模型（如 CSRNet/Bayesian crowd counting），
本项目通过 CrowdInferenceProvider 接口保留了替换点，见 docs/skyguard/LIMITATIONS.md。

用法：
    python crowd_service.py --video <path> [--max-frames 90] [--sample-every 15] \
        [--roi x,y,w,h] [--frame-width 640]

输出：stdout 上一个 JSON 对象；失败时退出码非 0，stderr 给出原因。
"""
from __future__ import annotations

import argparse
import json
import math
import sys


def _fail(code: str, message: str, exit_code: int = 2) -> None:
    print(json.dumps({"ok": False, "error": code, "message": message}, ensure_ascii=False))
    sys.exit(exit_code)


def _parse_roi(value: str | None):
    if not value:
        return None
    parts = [p.strip() for p in value.split(",")]
    if len(parts) != 4:
        _fail("bad_roi", "ROI 必须是 x,y,w,h 四个归一化数值")
    try:
        x, y, w, h = (float(p) for p in parts)
    except ValueError:
        _fail("bad_roi", "ROI 数值无法解析")
    if not (0.0 <= x < 1.0 and 0.0 <= y < 1.0 and 0.0 < w <= 1.0 and 0.0 < h <= 1.0):
        _fail("bad_roi", "ROI 必须位于 0~1 的归一化坐标范围内")
    if x + w > 1.0 or y + h > 1.0:
        _fail("bad_roi", "ROI 超出画面范围")
    return (x, y, w, h)


def main() -> int:
    parser = argparse.ArgumentParser(description="SkyGuard crowd counting (CPU reference)")
    parser.add_argument("--video", required=True, help="视频文件路径")
    parser.add_argument("--max-frames", type=int, default=90, help="最多分析的帧数")
    parser.add_argument("--sample-every", type=int, default=15, help="采样间隔（每 N 帧取一帧）")
    parser.add_argument("--roi", default=None, help="归一化 ROI: x,y,w,h")
    parser.add_argument("--frame-width", type=int, default=640, help="分析时的帧宽度")
    parser.add_argument("--method", default="diff", choices=["diff", "mog2", "hybrid"], help="前景检测方法")
    parser.add_argument("--diff-threshold", type=int, default=22, help="帧差阈值（灰度）")
    parser.add_argument("--min-area-px", type=float, default=45.0, help="连通域最小面积（像素）")
    parser.add_argument("--max-area-ratio", type=float, default=0.20, help="单个连通域最大面积占画面比例")
    args = parser.parse_args()

    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except Exception as exc:  # pragma: no cover - 依赖缺失时明确报错
        _fail("missing_dependency", f"未安装 opencv-python / numpy：{exc}", exit_code=3)

    roi = _parse_roi(args.roi)
    capture = cv2.VideoCapture(args.video)
    if not capture.isOpened():
        _fail("video_unreadable", f"无法打开视频文件：{args.video}", exit_code=4)

    fps = capture.get(cv2.CAP_PROP_FPS) or 0.0
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    subtractor = cv2.createBackgroundSubtractorMOG2(history=120, varThreshold=32, detectShadows=False)
    kernel_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    kernel_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    kernel_dilate = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    previous_gray = None

    counts: list[int] = []
    mean_areas: list[float] = []
    frame_index = 0
    analyzed = 0
    warnings: list[str] = []

    while analyzed < args.max_frames:
        ok, frame = capture.read()
        if not ok:
            break
        if frame_index % max(1, args.sample_every) != 0:
            frame_index += 1
            continue
        frame_index += 1

        height, width = frame.shape[:2]
        if args.frame_width and width != args.frame_width:
            scale = args.frame_width / float(width)
            frame = cv2.resize(frame, (args.frame_width, int(round(height * scale))), interpolation=cv2.INTER_AREA)

        if roi:
            fh, fw = frame.shape[:2]
            x0 = int(roi[0] * fw)
            y0 = int(roi[1] * fh)
            x1 = int((roi[0] + roi[2]) * fw)
            y1 = int((roi[1] + roi[3]) * fh)
            frame = frame[y0:y1, x0:x1]
            if frame.size == 0:
                _fail("bad_roi", "ROI 裁剪后为空")

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)

        mask = None
        if args.method in ("diff", "hybrid") and previous_gray is not None:
            diff = cv2.absdiff(gray, previous_gray)
            _, mask = cv2.threshold(diff, args.diff_threshold, 255, cv2.THRESH_BINARY)
        if args.method in ("mog2", "hybrid"):
            bg_mask = subtractor.apply(frame)
            _, bg_mask = cv2.threshold(bg_mask, 200, 255, cv2.THRESH_BINARY)
            mask = bg_mask if mask is None else cv2.bitwise_or(mask, bg_mask)
        previous_gray = gray

        if mask is None:
            # 第一帧没有可用的运动参考，跳过计数但保留参考帧
            continue

        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel_open)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel_close)
        if args.method in ("diff", "hybrid"):
            # 帧差会把同一运动目标的前后边缘检成两块；适度膨胀让它们合并为一个目标
            mask = cv2.dilate(mask, kernel_dilate, iterations=2)

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        frame_area = float(frame.shape[0] * frame.shape[1])
        max_area = frame_area * args.max_area_ratio
        kept = 0
        areas: list[float] = []
        for contour in contours:
            area = float(cv2.contourArea(contour))
            if area < args.min_area_px:
                continue
            if area > max_area:
                # 粘连人群：计入但标注
                kept += 1
                areas.append(area)
                warnings.append("merged_blob")
                continue
            kept += 1
            areas.append(area)

        counts.append(kept)
        if areas:
            mean_areas.append(sum(areas) / len(areas))
        analyzed += 1

    capture.release()

    if analyzed == 0:
        _fail("no_frames", "视频中未能读取到任何帧", exit_code=5)

    mean_count = sum(counts) / len(counts)
    variance = sum((c - mean_count) ** 2 for c in counts) / len(counts)
    std_count = math.sqrt(variance)
    coefficient_of_variation = (std_count / mean_count) if mean_count > 0 else 0.0

    # 时间稳定性：帧间计数越稳定，说明检测越确定（不代表绝对准确）
    temporal_stability = max(0.0, min(1.0, 1.0 - coefficient_of_variation))

    if mean_count <= 0:
        confidence = 0.2
        warnings.append("no_foreground_detected")
    else:
        confidence = round(temporal_stability * 0.9, 4)

    unique_warnings = sorted(set(warnings))
    if "merged_blob" in unique_warnings:
        confidence = round(confidence * 0.8, 4)

    result = {
        "ok": True,
        "method": f"{args.method} + morphological filtering + connected components",
        "video": args.video,
        "fps": round(float(fps), 2),
        "total_frames": total_frames,
        "frames_analyzed": analyzed,
        "sample_every": args.sample_every,
        "per_frame_counts": counts,
        "mean_count": round(mean_count, 2),
        "std_count": round(std_count, 2),
        "coefficient_of_variation": round(coefficient_of_variation, 4),
        "mean_blob_area_px": round(sum(mean_areas) / len(mean_areas), 2) if mean_areas else 0.0,
        "confidence": confidence,
        "confidence_basis": "temporal stability of per-frame blob counts (not absolute accuracy)",
        "warnings": unique_warnings,
        "limitations": [
            "Fixed-camera static background assumed.",
            "Dense crowds merge into single blobs; counts are lower bounds at high density.",
            "Moving objects other than people are counted.",
            "Confidence reflects frame-to-frame stability only, not ground-truth accuracy.",
        ],
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
