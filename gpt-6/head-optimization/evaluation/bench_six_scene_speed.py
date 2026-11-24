"""Benchmark the locked A–F paths and a continuous B street clip locally."""

import argparse
import configparser
import csv
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import time

SOURCE = Path(__file__).resolve()
VIDEO_SOURCE = SOURCE.with_name("run_schoolpath_video.py")
GROUPS = tuple("ABCDEF")
CLIP = "B_contiguous"
B_COUNT = 750
FPS = 25


def load_video():
    spec = importlib.util.spec_from_file_location("schoolpath_video", VIDEO_SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prepare(project, cchead, video, helper):
    runs = project / "evaluations/head-count-v2"
    holdout_path = runs / "holdout-five-draws-v1/protocol.json"
    parent_path = runs / "schoolpath-video-smoke-v1/protocol.json"
    holdout = helper.read_json(holdout_path)
    parent = helper.read_json(parent_path)
    for name, path, key in (
        ("holdout-five-draws-v1", holdout_path, "input_sha256"),
        ("schoolpath-video-smoke-v1", parent_path, "hashes"),
    ):
        state = helper.read_json(path.parent / "checkpoint.json")
        cfg = helper.read_json(path)
        if state["status"] != "complete" or state["protocol_sha256"] != helper.sha(path):
            raise ValueError(f"Unverified source run: {name}")
        if any(helper.sha(Path(file)) != value for file, value in cfg[key].items()):
            raise ValueError(f"Changed source run inputs: {name}")
    if (parent["weights"] != holdout["weights"] or parent["runtime"] != holdout["runtime"]
            or parent["inference"] != {**holdout["inference"], "batch": 1}):
        raise ValueError("The previous runs must agree on model and settings")

    split = project / "splits/head-count-v2"
    groups = {group: {} for group in GROUPS}
    for draw in holdout["rounds"]:
        for group, rows in draw["samples"].items():
            for row in rows:
                file = (split / row["test_image"]).resolve(strict=True)
                if not file.is_relative_to((split / "test" / group).resolve()):
                    raise ValueError(f"Unexpected A–F path: {file}")
                groups[group][row["image_sha256"]] = {
                    "file": str(file), "id": row["image_path"], "sha256": row["image_sha256"],
                    "recording": row["source_recording"],
                }
    expected_counts = helper.read_json(holdout_path.parent / "summary.json")["unique_images_per_group"]
    if {group: len(rows) for group, rows in groups.items()} != expected_counts:
        raise ValueError("The six source pools differ from the completed evaluation")
    plan = {
        group: sorted(rows.values(), key=lambda row: (
            row["recording"],
            int(m[1]) if (m := re.search(r"(\d+)(?:_RGB)?\.jpg$", row["id"], re.I)) else 0,
            row["id"],
        )) for group, rows in groups.items()
    }

    inventory_path = cchead / "gpt-6/files_sha256.jsonl"
    street = Path("street_train/street")
    seq = cchead / "raw" / street / "seqinfo.ini"
    index = {}
    with inventory_path.open(encoding="utf-8-sig") as f:
        for line in f:
            row = json.loads(line)
            if row["path"].startswith(street.as_posix() + "/"):
                index[row["path"]] = row["sha256"]
    if helper.sha(seq) != index[(street / "seqinfo.ini").as_posix()]:
        raise ValueError("The B clip sequence metadata changed")
    ini = configparser.ConfigParser()
    ini.read(seq, encoding="utf-8-sig")
    if ini["Sequence"].getint("frameRate") != FPS:
        raise ValueError("The B clip has an unexpected source frame rate")
    plan[CLIP] = []
    for i in range(B_COUNT):
        name = (street / "img" / f"{i}.jpg").as_posix()
        path = (cchead / "raw" / name).resolve(strict=True)
        plan[CLIP].append({"file": str(path), "id": name, "sha256": index[name], "recording": "street_train"})
    return {
        **{key: parent[key] for key in ("inference", "weights", "runtime", "seed", "ffmpeg", "ffprobe", "encoding")},
        "policy": {**holdout["policy"], CLIP: holdout["policy"]["B"]},
        "fusion": holdout["fusion"], "tile_fraction": holdout["tile_fraction"], "global_nms": holdout["global_nms"],
        "fps": FPS, "frames": plan,
        "input_hashes": {str(path): helper.sha(path) for path in (SOURCE, VIDEO_SOURCE, holdout_path, parent_path, seq, inventory_path)},
    }


def image(row, cv2, np):
    data = np.frombuffer(Path(row["file"]).read_bytes(), np.uint8)
    frame = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError(f"JPEG decoding failed: {row['id']}")
    return frame


def predict(frame, policy, model, cfg, bench, fusion, torch, np):
    full_settings = cfg["inference"]
    if policy == "full025":
        boxes, _ = bench.full_predict([frame], model, full_settings)[0]
    else:
        tile_settings = {**full_settings, "batch": 4}
        boxes, _ = bench.tile_predict(frame, model, tile_settings, cfg["tile_fraction"], cfg["global_nms"])
        if policy == "tiles025_plus_large_full":
            full, _ = bench.full_predict([frame], model, full_settings)[0]
            picked = fusion.supplement_indexes(full, boxes, full_settings["imgsz"] / max(frame.shape[:2]), np)
            boxes = np.concatenate((boxes, full[picked]))
        elif policy != "tiles025":
            raise ValueError(f"Unknown inference policy: {policy}")
    torch.cuda.synchronize()
    if not np.isfinite(boxes).all():
        raise ValueError("Non-finite model response")
    return boxes


def encoder(out, cfg, w, h, video):
    e = cfg["encoding"]
    cmd = [
        cfg["ffmpeg"], "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pixel_format", "bgr24",
        "-video_size", f"{w}x{h}", "-framerate", str(FPS), "-i", "pipe:0", "-an",
        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", e["codec"], "-preset", e["preset"],
        "-crf", str(e["crf"]), "-threads", str(e["threads"]), "-pix_fmt", e["pix_fmt"], str(out),
    ]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, creationflags=video.NO_WINDOW)


def timed(out, rows, group, mode, model, cfg, modules, event):
    video, bench, fusion, cv2, np, torch = modules
    policy = cfg["policy"][group]
    for row in rows[:8]:
        predict(image(row, cv2, np), policy, model, cfg, bench, fusion, torch, np)
    logs = []
    child = None
    stream_path = None
    resolution = None
    encoded_parts = []
    part_frames = 0

    def finish_part():
        child.stdin.close()
        if child.wait(timeout=45) != 0:
            raise RuntimeError(f"FFmpeg failed: {stream_path}")
        w, h = resolution
        encoded_parts.append({"file": stream_path.name, "width": w+(w%2), "height": h+(h%2), "frames": part_frames})

    f = out / f"{group}_{mode}.partial.csv"
    cols = ("index", "image", "width", "height", "count", "decode_ms", "inference_ms", "count_ready_ms", "frame_submit_ms")
    start = time.perf_counter()
    try:
        with f.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=cols)
            writer.writeheader()
            for index, row in enumerate(rows):
                a = time.perf_counter()
                frame = image(row, cv2, np)
                b = time.perf_counter()
                boxes = predict(frame, policy, model, cfg, bench, fusion, torch, np)
                c = time.perf_counter()
                h, w = frame.shape[:2]
                if mode == "video":
                    if resolution != (w, h):
                        if child is not None:
                            finish_part()
                        resolution = w, h
                        part_frames = 0
                        stream_path = out / f"{group}_video_{len(encoded_parts)+1:02d}.mp4"
                        child = encoder(stream_path, cfg, w, h, video)
                    video.draw_boxes(frame, boxes, index, index/FPS, cv2)
                    child.stdin.write(memoryview(frame).cast("B"))
                    part_frames += 1
                d = time.perf_counter()
                record = dict(index=index, image=row["id"], width=w, height=h, count=len(boxes),
                              decode_ms=(b-a)*1000, inference_ms=(c-b)*1000,
                              count_ready_ms=(c-a)*1000, frame_submit_ms=(d-a)*1000)
                writer.writerow(record)
                logs.append(record)
                if (index+1) % 75 == 0 or index+1 == len(rows):
                    rate = (index+1) / (time.perf_counter()-start)
                    event(f"{group}/{mode} frames={index+1}/{len(rows)} fps={rate:.2f} eta_s={(len(rows)-index-1)/rate:.1f}")
            if child is not None:
                finish_part()
    except BaseException:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=15)
        raise
    wall = time.perf_counter() - start
    for item in encoded_parts:
        clip = out / item["file"]
        video.validate_clip(clip, item["frames"], {**cfg, **item}, count_frames=True)
    f.replace(out / f"{group}_{mode}.csv")
    metrics = {key: video.timing_stats([row[key] for row in logs], np) for key in cols[5:]}
    return {"frames":len(logs), "seconds":wall, "fps":len(logs)/wall, "metrics":metrics,
            "encoded_parts":encoded_parts, "resolutions":sorted({(row["width"],row["height"]) for row in logs})}


def run(args):
    video = load_video()
    bench = video.load_bench()
    fusion = bench.load_fusion()
    prior = fusion.load_previous()
    helper = prior.load_helpers()
    cfg = prepare(args.project.resolve(strict=True), args.cchead.resolve(strict=True), video, helper)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    path = out / "protocol.json"
    checkpoint = out / "checkpoint.json"
    if path.exists():
        if helper.read_json(path) != cfg:
            raise ValueError("The benchmark protocol has changed")
        state = helper.read_json(checkpoint)
        if helper.sha(path) != state["protocol_sha256"]:
            raise ValueError("The checkpoint protocol hash differs")
    else:
        if any(out.iterdir()):
            raise ValueError("Expected an empty benchmark directory")
        helper.save_json(path, cfg)
        state = {"protocol_sha256":helper.sha(path), "status":"running", "completed":{}, "errors":[]}
        helper.save_json(checkpoint, state)

    def event(message):
        line = f"{datetime.now(timezone.utc).isoformat()} pid={os.getpid()} {message}"
        print(line, flush=True)
        with (out / "run.log").open("a", encoding="utf-8") as log:
            log.write(line + "\n")

    work = [(g, mode) for g in (*GROUPS, CLIP) for mode in ("count", "video")]
    pending = [(g, mode) for g,mode in work if f"{g}/{mode}" not in state["completed"]]
    for g, _ in pending:
        for row in cfg["frames"][g]:
            if helper.sha(Path(row["file"])) != row["sha256"]:
                raise ValueError(f"Input checksum changed: {g} {row['id']}")
    event(f"verified sources; prior completed={len(state['completed'])}/{len(work)}")
    model = prior.configure_model(cfg)
    import cv2
    import numpy as np
    import torch

    modules = video, bench, fusion, cv2, np, torch
    for g, mode in pending:
        if args.max_paths is not None and args.max_paths <= 0:
            break
        key = f"{g}/{mode}"
        event(f"start {key}")
        try:
            value = timed(out, cfg["frames"][g], g, mode, model, cfg, modules, event)
            value["csv_sha256"] = helper.sha(out / f"{g}_{mode}.csv")
            for part in value["encoded_parts"]:
                part["sha256"] = helper.sha(out / part["file"])
            state["completed"][key] = value
        except BaseException as error:
            state["status"] = "interrupted" if isinstance(error, KeyboardInterrupt) else "failed"
            state["errors"].append({"path":key, "error":str(error)})
            helper.save_json(checkpoint, state)
            raise
        helper.save_json(checkpoint, state)
        event(f"saved {key} ({len(state['completed'])}/{len(work)})")
        if args.max_paths is not None:
            args.max_paths -= 1

    if len(state["completed"]) == len(work):
        agreement = {}
        for g in (*GROUPS, CLIP):
            a, b = (helper.read_csv(out / f"{g}_{mode}.csv") for mode in ("count", "video"))
            if [(r["index"], r["image"]) for r in a] != [(r["index"], r["image"]) for r in b]:
                raise ValueError(f"{g} frame positions disagree")
            agreement[g] = sum(r["count"] != s["count"] for r,s in zip(a,b))
        state["status"] = "complete"
        helper.save_json(out / "summary.json", {
            "status":"complete", "device":torch.cuda.get_device_name(0), "policy":cfg["policy"],
            "results":state["completed"], "count_differences":agreement, "protocol_sha256":helper.sha(path),
        })
    else:
        state["status"] = "paused"
    helper.save_json(checkpoint, state)
    event(state["status"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("cchead", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--max-paths", type=int)
    run(parser.parse_args())
