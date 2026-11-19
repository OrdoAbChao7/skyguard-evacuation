#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
SkyGuard 人群感知服务（CPU 参考实现）。

职责：从视频文件或实时视频流中估计某个区域的人数，并给出可解释的置信度。

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

实时流模式（`--stream`）：
- 通过 OpenCV 的 FFmpeg 后端打开 RTSP/RTMP/HTTP(S) 视频流；
- 只读取一小段窗口（默认 20 秒 / 30 个分析帧），不做长期后台拉流；
- 断流时按 `--reconnect-attempts` 重连，仍失败则明确报错，不返回 0 人冒充安全；
- 输出中只保留脱敏后的流地址（去掉用户名、密码和 query），避免凭据进入日志/审计；
- 需要固定机位和已标定 ROI；未标定摄像机的置信度仍会被上层强制压低。

用法：
    python crowd_service.py --video <path> [--max-frames 90] [--sample-every 15] \
        [--roi x,y,w,h] [--frame-width 640]
    python crowd_service.py --stream <rtsp/rtmp/http url> [--max-frames 30] \
        [--sample-every 5] [--max-seconds 20] [--reconnect-attempts 2]

输出：stdout 上一个 JSON 对象；失败时退出码非 0，stderr 给出原因。
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from urllib.parse import urlsplit, urlunsplit

STREAM_SCHEMES = ("rtsp", "rtsps", "rtmp", "rtmps", "http", "https")

# Windows 下管道默认使用 GBK；Node 以 UTF-8 读取，中文错误信息会变成乱码。
# 显式把标准输出/错误切到 UTF-8，保证 JSON 契约在跨进程调用时稳定。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def _fail(code: str, message: str, exit_code: int = 2) -> None:
    print(json.dumps({"ok": False, "error": code, "message": message}, ensure_ascii=False))
    sys.exit(exit_code)


def _redact_url(raw: str) -> str:
    """去掉 URL 中的用户名、密码、query 和 fragment；保留 scheme/host/path 便于排障。"""
    try:
        parts = urlsplit(raw)
        if not parts.scheme:
            return raw
        netloc = parts.netloc.rsplit("@", 1)[-1]
        return urlunsplit((parts.scheme, netloc, parts.path, "", ""))
    except Exception:
        return "[unparseable-url]"


def _validate_stream_url(raw: str) -> str:
    if not re.match(r"^(%s)://" % "|".join(STREAM_SCHEMES), raw, re.IGNORECASE):
        _fail(
            "bad_stream_url",
            "实时流只接受 rtsp/rtsps/rtmp/rtmps/http/https URL；不接受本地文件或其它协议",
        )
    try:
        parts = urlsplit(raw)
    except ValueError:
        _fail("bad_stream_url", "实时流 URL 无法解析")
    if not parts.hostname:
        _fail("bad_stream_url", "实时流 URL 缺少主机名")
    return _redact_url(raw)


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
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--video", help="视频文件路径")
    source.add_argument("--stream", help="实时视频流 URL（rtsp/rtsps/rtmp/rtmps/http/https）")
    parser.add_argument("--max-frames", type=int, default=None, help="最多分析的帧数（文件默认 90，流默认 30）")
    parser.add_argument("--sample-every", type=int, default=None, help="采样间隔（文件默认 15，流默认 5）")
    parser.add_argument("--max-seconds", type=float, default=None, help="墙钟时间上限（文件默认不限，流默认 20 秒）")
    parser.add_argument("--open-timeout-ms", type=int, default=5000, help="流打开超时（毫秒）")
    parser.add_argument("--read-timeout-ms", type=int, default=5000, help="流读取超时（毫秒）")
    parser.add_argument("--reconnect-attempts", type=int, default=2, help="断流重连次数（仅流模式）")
    parser.add_argument("--reconnect-delay", type=float, default=1.0, help="重连前等待秒数")
    parser.add_argument("--roi", default=None, help="归一化 ROI: x,y,w,h")
    parser.add_argument("--frame-width", type=int, default=640, help="分析时的帧宽度")
    parser.add_argument("--method", default="diff", choices=["diff", "mog2", "hybrid"], help="前景检测方法")
    parser.add_argument("--diff-threshold", type=int, default=22, help="帧差阈值（灰度）")
    parser.add_argument("--min-area-px", type=float, default=45.0, help="连通域最小面积（像素）")
    parser.add_argument("--max-area-ratio", type=float, default=0.20, help="单个连通域最大面积占画面比例")
    args = parser.parse_args()

    is_stream = args.stream is not None
    source_value = args.stream if is_stream else args.video
    redacted_source = _validate_stream_url(source_value) if is_stream else source_value

    max_frames = args.max_frames if args.max_frames is not None else (30 if is_stream else 90)
    sample_every = args.sample_every if args.sample_every is not None else (5 if is_stream else 15)
    max_seconds = args.max_seconds if args.max_seconds is not None else (20.0 if is_stream else 0.0)
    if max_frames <= 0:
        _fail("bad_args", "--max-frames 必须大于 0")
    if sample_every <= 0:
        _fail("bad_args", "--sample-every 必须大于 0")
    if max_seconds < 0:
        _fail("bad_args", "--max-seconds 不能为负数")
    if args.open_timeout_ms < 100 or args.read_timeout_ms < 100:
        _fail("bad_args", "流超时至少 100 毫秒")
    if args.reconnect_attempts < 0:
        _fail("bad_args", "--reconnect-attempts 不能为负数")

    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except Exception as exc:  # pragma: no cover - 依赖缺失时明确报错
        _fail("missing_dependency", f"未安装 opencv-python / numpy：{exc}", exit_code=3)

    roi = _parse_roi(args.roi)

    def open_capture():
        if not is_stream:
            return cv2.VideoCapture(source_value)
        params = [
            cv2.CAP_PROP_OPEN_TIMEOUT_MSEC,
            args.open_timeout_ms,
            cv2.CAP_PROP_READ_TIMEOUT_MSEC,
            args.read_timeout_ms,
        ]
        try:
            capture = cv2.VideoCapture(source_value, cv2.CAP_FFMPEG, params)
        except TypeError:
            # 老版本 OpenCV 不支持构造参数；仍可打开，但超时由上层进程超时兜底。
            capture = cv2.VideoCapture(source_value, cv2.CAP_FFMPEG)
        try:
            capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        return capture

    capture = open_capture()
    if not capture.isOpened():
        if is_stream:
            _fail("stream_unreadable", f"无法打开视频流：{redacted_source}", exit_code=4)
        _fail("video_unreadable", f"无法打开视频文件：{source_value}", exit_code=4)

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
    reconnects = 0
    warnings: list[str] = []
    started_at = time.monotonic()

    try:
        while analyzed < max_frames:
            if max_seconds > 0 and (time.monotonic() - started_at) >= max_seconds:
                warnings.append("time_window_reached")
                break

            ok, frame = capture.read()
            if not ok:
                if is_stream and reconnects < args.reconnect_attempts:
                    reconnects += 1
                    warnings.append("stream_reconnected")
                    capture.release()
                    time.sleep(max(0.0, args.reconnect_delay))
                    capture = open_capture()
                    if not capture.isOpened():
                        warnings.append("stream_reopen_failed")
                    continue
                if analyzed > 0:
                    warnings.append("stream_ended" if is_stream else "video_ended")
                break
            if frame_index % max(1, sample_every) != 0:
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
    finally:
        capture.release()

    elapsed_ms = int((time.monotonic() - started_at) * 1000)

    if analyzed == 0:
        if is_stream:
            _fail("stream_unreadable", f"未能从视频流读取到任何帧：{redacted_source}", exit_code=5)
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

    limitations = [
        "Fixed-camera static background assumed.",
        "Dense crowds merge into single blobs; counts are lower bounds at high density.",
        "Moving objects other than people are counted.",
        "Confidence reflects frame-to-frame stability only, not ground-truth accuracy.",
    ]
    if is_stream:
        limitations.extend(
            [
                "Stream mode reads a short window only; it is not continuous background monitoring.",
                "End-to-end latency is not measured without source timestamps; network jitter and frame drops affect results.",
                "RTSP/RTMP/HTTP decoding depends on the local FFmpeg build.",
            ]
        )

    result = {
        "ok": True,
        "source_type": "live_stream" if is_stream else "recorded_video",
        "method": f"{args.method} + morphological filtering + connected components",
        "fps": round(float(fps), 2),
        "total_frames": total_frames,
        "frames_analyzed": analyzed,
        "sample_every": sample_every,
        "per_frame_counts": counts,
        "mean_count": round(mean_count, 2),
        "std_count": round(std_count, 2),
        "coefficient_of_variation": round(coefficient_of_variation, 4),
        "mean_blob_area_px": round(sum(mean_areas) / len(mean_areas), 2) if mean_areas else 0.0,
        "confidence": confidence,
        "confidence_basis": "temporal stability of per-frame blob counts (not absolute accuracy)",
        "warnings": unique_warnings,
        "limitations": limitations,
        "elapsed_ms": elapsed_ms,
        "effective_fps": round(analyzed / (elapsed_ms / 1000.0), 2) if elapsed_ms > 0 else 0.0,
    }
    if is_stream:
        result.update(
            {
                "stream": redacted_source,
                "reconnects": reconnects,
                "max_seconds": max_seconds,
            }
        )
    else:
        result["video"] = source_value

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
