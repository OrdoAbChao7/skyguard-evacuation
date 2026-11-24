"""Compare full frames and overlapping tiles on the exposed C-group sample."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
from datetime import datetime, timezone

SOURCE = Path(__file__).resolve()
HELPER = SOURCE.with_name("scene_probe.py")
METHODS = ("full", "tiles", "tiles_cross_dedup")
TILE_FRACTION = 0.60
GLOBAL_NMS = 0.50
CLOSE_CENTER = 0.22
MIN_IOU = 0.25
COVERED_FRACTION = 0.82
SEAM_COVERED = 0.75
SEAM_ALONG = 0.45
SEAM_ACROSS = 0.22


def internal_edge_axes(boxes, tile_ids, tiles, np):
    """Return whether a box reaches an internal crop boundary on each axis."""
    own = tiles[tile_ids]
    margin = np.maximum(1.5, np.min(boxes[:, 2:] - boxes[:, :2], axis=1) * 0.12)
    frame_end = tiles[:, 2:].max(axis=0)
    near_start = (own[:, :2] > 0) & (boxes[:, :2] - own[:, :2] <= margin[:, None])
    near_end = (own[:, 2:] < frame_end) & (own[:, 2:] - boxes[:, 2:] <= margin[:, None])
    return near_start | near_end


def suppress_cross_tile(boxes, scores, tile_ids, tiles):
    """Drop a second view of a head only when geometry and tile provenance agree."""
    import numpy as np

    if not len(boxes):
        return np.empty(0, dtype=np.int64)
    sizes = boxes[:, 2:] - boxes[:, :2]
    if np.any(sizes <= 0):
        raise ValueError("Tile detections must have positive width and height")
    areas = sizes.prod(axis=1)
    centers = (boxes[:, :2] + boxes[:, 2:]) / 2
    edges = internal_edge_axes(boxes, tile_ids, tiles, np)
    clipped = edges.any(axis=1)
    order = np.lexsort((np.arange(len(boxes)), -scores, clipped))
    suppressed = np.zeros(len(boxes), dtype=bool)
    for position, index in enumerate(order):
        if suppressed[index]:
            continue
        remaining = order[position + 1:]
        others = remaining[(tile_ids[remaining] != tile_ids[index]) & ~suppressed[remaining]]
        if not len(others):
            continue
        common_size = np.maximum(
            np.minimum(boxes[index, 2:], boxes[others, 2:])
            - np.maximum(boxes[index, :2], boxes[others, :2]), 0,
        )
        common_area = common_size.prod(axis=1)
        overlap = common_area / (areas[index] + areas[others] - common_area)
        containment = common_area / np.minimum(areas[index], areas[others])
        distance = np.abs(centers[index] - centers[others]) / np.maximum(sizes[index], sizes[others])
        concentric = (containment >= COVERED_FRACTION) & (distance <= CLOSE_CENTER).all(axis=1)
        seam = np.zeros(len(others), dtype=bool)
        if not clipped[index]:
            x_edge = edges[others, 0] & (distance[:, 0] <= SEAM_ALONG) & (distance[:, 1] <= SEAM_ACROSS)
            y_edge = edges[others, 1] & (distance[:, 1] <= SEAM_ALONG) & (distance[:, 0] <= SEAM_ACROSS)
            seam = (areas[others] <= areas[index]) & (containment >= SEAM_COVERED) & (x_edge | y_edge)
        suppressed[others[(overlap >= MIN_IOU) & (concentric | seam)]] = True
    return np.flatnonzero(~suppressed)


def load_helpers():
    spec = importlib.util.spec_from_file_location("scene_probe", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_protocol(args, p):
    project = args.project.resolve(strict=True)
    initial = args.probe.resolve(strict=True)
    split = (project / "splits/head-count-v2").resolve(strict=True)
    weights_receipt = project / "experiments/head-count-v2/round2-v1/training_receipt.json"
    baseline_protocol = initial.parent / "baseline-v1/run_protocol.json"
    probe_config = initial / "probe_config.json"
    selection = initial / "selected_samples.csv"
    initial_summary = initial / "summary.json"
    full_rows = initial / "frame_metrics.csv"
    dense_summary = initial / "dense_probe_summary.json"
    tiled_rows = initial / "dense_probe_frames.csv"

    p_cfg = p.read_json(probe_config)
    b_cfg = p.read_json(baseline_protocol)
    t_cfg = p.read_json(dense_summary)
    receipt = p.read_json(weights_receipt)
    weights = Path(receipt["weight"]).resolve(strict=True)
    checks = {
        weights: p_cfg["models_sha256"]["round2"],
        split / "split_protocol.json": p_cfg["split_sha256"],
        selection: p_cfg["selection_sha256"],
        full_rows: p.read_json(initial_summary)["frame_metrics_sha256"],
        tiled_rows: t_cfg["rows_sha256"],
    }
    if any(p.sha(path) != expected for path, expected in checks.items()):
        raise ValueError("The original protocol, weights, or diagnostic files have changed")
    if receipt["status"] != "complete" or receipt["weight_sha256"] != checks[weights]:
        raise ValueError("The model two checkpoint did not match its training receipt")

    original_order = p.read_csv(selection)
    batch_size = p_cfg["settings"]["base"]["batch"]
    full_batches = []
    for offset in range(0, len(original_order), batch_size):
        batch = original_order[offset:offset + batch_size]
        c_rows = [row for row in batch if row["group"] == "C"]
        if c_rows:
            if len(c_rows) != len(batch):
                raise ValueError("The original C batch mixes unrelated samples")
            full_batches.append(c_rows)
    samples = [row for batch in full_batches for row in batch]
    ids = [row["image_sha256"] for row in samples]
    if len(set(ids)) != len(samples) or len(samples) != p_cfg["selection"]["C"]:
        raise ValueError("The exposed C sample count has changed")
    if any(row["diagnostic_role"] != "exposed_probe_only" or row["label_type"] != "head_box"
           or row["status"] != "ready" or not row["test_image"].startswith("test/C/ready/")
           or not row["test_label"].startswith("test/C/ready/") for row in samples):
        raise ValueError("Only the previously exposed C head-box pairs may be used")
    full_reference = {
        row["sha256"]: row for row in p.read_csv(full_rows)
        if row["group"] == "C" and row["model"] == "round2" and row["setting"] == "base"
    }
    tile_reference = {
        row["sha256"]: row for row in p.read_csv(tiled_rows)
        if row["group"] == "C" and row["variant"] == "tiles"
    }
    if set(full_reference) != set(ids) or set(tile_reference) != set(ids):
        raise ValueError("Missing earlier C reference results")
    protocol = {
        "scope": "Only the exposed C sample. Original annotated full frame for all methods.",
        "model": "round2",
        "weights": str(weights),
        "input_sha256": {
            str(path): p.sha(path) for path in (
                SOURCE, HELPER, *checks, weights_receipt, baseline_protocol, probe_config,
                initial_summary, dense_summary,
            )
        },
        "samples": samples,
        "full_batches": [[row["image_sha256"] for row in batch] for batch in full_batches],
        "inference": p_cfg["settings"]["base"],
        "seed": b_cfg["seed"],
        "runtime": {key: b_cfg[key] for key in ("ultralytics", "torch", "opencv")},
        "tile_fraction": TILE_FRACTION,
        "tile_grid": [2, 2],
        "global_nms_iou": GLOBAL_NMS,
        "match_iou": b_cfg["match_iou"],
        "cross_tile": {
            "min_iou": MIN_IOU, "center_offset": CLOSE_CENTER, "covered_fraction": COVERED_FRACTION,
            "seam_covered_fraction": SEAM_COVERED, "seam_along_offset": SEAM_ALONG,
            "seam_across_offset": SEAM_ACROSS, "edge_margin": "max(1.5 px, .12 × short box edge)",
            "priority": "unclipped, confidence descending, original index",
        },
        "methods": list(METHODS),
    }
    if protocol["match_iou"] != 0.50:
        raise ValueError("Head-box matching must stay compatible with the original probe")
    return protocol, split, full_reference, tile_reference


def configure_model(protocol):
    os.environ.update({
        "TORCH_FORCE_WEIGHTS_ONLY_LOAD": "1",
        "ULTRALYTICS_SAFE_LOAD": "true",
        "YOLO_AUTOINSTALL": "false",
        "YOLO_OFFLINE": "true",
        "YOLO_CONFIG_DIR": str(Path(sys.prefix) / "ultralytics-config"),
    })
    import cv2
    import torch
    import ultralytics
    from ultralytics.nn.tasks import _SafeLoad
    from ultralytics.utils import SAFE_LOAD

    actual = {"ultralytics": ultralytics.__version__, "torch": torch.__version__, "opencv": cv2.__version__}
    if actual != protocol["runtime"] or not SAFE_LOAD or not _SafeLoad.SUPPORTED or not torch.cuda.is_available():
        raise RuntimeError("Expected the pinned restricted CUDA environment")
    torch.manual_seed(protocol["seed"])
    torch.backends.cudnn.benchmark = False
    return ultralytics.YOLO(protocol["weights"], task="detect")


def full_predictions(loaded, model, opts):
    started = time.perf_counter()
    detections = model.predict(source=[item[0] for item in loaded], **opts)
    if len(detections) != len(loaded):
        raise ValueError("Missing full-frame predictions")
    boxes = [(result.boxes.xyxy.cpu().numpy(), result.boxes.conf.cpu().numpy()) for result in detections]
    seconds_per_frame = (time.perf_counter() - started) / len(loaded)
    return [(coords, conf, seconds_per_frame) for coords, conf in boxes]


def detect_tiles(raw, model, opts, np):
    import torch
    from torchvision.ops import nms

    height, width = raw.shape[:2]
    crop_h, crop_w = round(height * TILE_FRACTION), round(width * TILE_FRACTION)
    offsets = [(0, 0), (width - crop_w, 0), (0, height - crop_h), (width - crop_w, height - crop_h)]
    tiles = np.array([(x, y, x + crop_w, y + crop_h) for x, y in offsets])
    raw_tiles = [raw[y0:y1, x0:x1] for x0, y0, x1, y1 in tiles]
    started = time.perf_counter()
    results = model.predict(source=raw_tiles, **opts)
    if len(results) != len(tiles):
        raise ValueError("Missing tile predictions")
    projected = []
    scores = []
    provenance = []
    for index, ((x, y), result) in enumerate(zip(offsets, results)):
        boxes = result.boxes
        projected.append(boxes.xyxy.cpu() + torch.tensor([x, y, x, y], dtype=torch.float32))
        scores.append(boxes.conf.cpu())
        provenance.append(np.full(len(boxes), index, dtype=np.int64))
    boxes, confidence = torch.cat(projected), torch.cat(scores)
    picked = nms(boxes, confidence, GLOBAL_NMS).numpy()
    wide_boxes, wide_scores = boxes.numpy()[picked], confidence.numpy()[picked]
    tile_ids = np.concatenate(provenance)[picked]
    tiled_seconds = time.perf_counter() - started

    started = time.perf_counter()
    keep = suppress_cross_tile(wide_boxes, wide_scores, tile_ids, tiles)
    dedup_seconds = time.perf_counter() - started
    return [
        ("tiles", wide_boxes, wide_scores, tiled_seconds),
        ("tiles_cross_dedup", wide_boxes[keep], wide_scores[keep], tiled_seconds + dedup_seconds),
    ], len(boxes), dedup_seconds


def evaluate(row, loaded, baseline, model, protocol, references, p):
    import numpy as np

    raw, targets, _ = loaded
    digest = row["image_sha256"]
    tiles, raw_tile_count, dedup_seconds = detect_tiles(raw, model, protocol["inference"], np)
    methods = [("full", *baseline), *tiles]
    results = {}
    for name, boxes, scores, seconds in methods:
        if not np.isfinite(boxes).all() or not np.isfinite(scores).all():
            raise ValueError("Non-finite model output")
        matched = p.match_targets(boxes, scores, targets, np)
        total, tp = len(boxes), int(matched.sum())
        error = total - len(targets)
        results[name] = {
            "pred": total, "tp": tp, "unmatched": total - tp, "missed": len(targets) - tp,
            "signed_error": error, "absolute_error": abs(error),
            "seconds": round(seconds, 6), "matched_gt_indexes": np.flatnonzero(matched).tolist(),
        }
    original, original_tiles = references
    for name, expected, count_key, match_key in (
        ("full", original[digest], "pred", "tp50"),
        ("tiles", original_tiles[digest], "after", "after_tp50"),
    ):
        actual = results[name]
        if (actual["pred"], actual["tp"]) != (int(expected[count_key]), int(expected[match_key])):
            raise ValueError("Earlier result mismatch for {} {}: actual {} vs reference {}".format(
                digest[:12], name, (actual["pred"], actual["tp"]),
                (int(expected[count_key]), int(expected[match_key])),
            ))
    before = set(results["tiles"]["matched_gt_indexes"])
    after = set(results["tiles_cross_dedup"]["matched_gt_indexes"])
    return {
        "image_sha256": digest, "image_path": row["image_path"], "recording": row["source_recording"],
        "gt": len(targets), "raw_tile_predictions": raw_tile_count,
        "extra_removals": results["tiles"]["pred"] - results["tiles_cross_dedup"]["pred"],
        "dedup_seconds": round(dedup_seconds, 6), "gt_matches_lost": sorted(before - after),
        "gt_matches_gained": sorted(after - before), "results": results,
    }


def summarize(output, protocol, state, p):
    records = [state["items"][row["image_sha256"]] for row in protocol["samples"]]
    frame_rows = []
    overview = {}
    for method in METHODS:
        for record in records:
            metrics = {key: value for key, value in record["results"][method].items() if key != "matched_gt_indexes"}
            frame_rows.append({
                "method": method, "image_sha256": record["image_sha256"], "image_path": record["image_path"],
                "recording": record["recording"], "gt": record["gt"], **metrics,
            })
        rows = [record["results"][method] for record in records]
        count = len(rows)
        total = sum(record["gt"] for record in records)
        tp = sum(row["tp"] for row in rows)
        predicted = sum(row["pred"] for row in rows)
        abs_error = sum(row["absolute_error"] for row in rows)
        overview[method] = {
            "frames": count, "gt": total, "predicted": predicted, "tp": tp,
            "unmatched": predicted - tp, "missed": total - tp,
            "mae": abs_error / count, "wape": abs_error / total,
            "precision": tp / predicted if predicted else 0.0, "recall": tp / total,
            "undercount_frames": sum(row["signed_error"] < 0 for row in rows),
        }
    p.save_csv(output / "frame_metrics.csv", frame_rows)
    p.save_json(output / "summary.json", {
        "scope": protocol["scope"], "weights_sha256": protocol["input_sha256"][protocol["weights"]],
        "methods": overview, "extra_removals": sum(record["extra_removals"] for record in records),
        "gt_matches_lost": sum(len(record["gt_matches_lost"]) for record in records),
        "gt_matches_gained": sum(len(record["gt_matches_gained"]) for record in records),
        "frames_changed": sum(record["extra_removals"] > 0 for record in records),
        "mean_extra_dedup_ms": 1000 * sum(record["dedup_seconds"] for record in records) / len(records),
        "frame_metrics_sha256": p.sha(output / "frame_metrics.csv"),
    })


def main(args):
    if args.max_new is not None and args.max_new < 1:
        raise ValueError("--max-new must be a positive integer")
    p = load_helpers()
    protocol, split, full_reference, tile_reference = load_protocol(args, p)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    saved = output / "protocol.json"
    checkpoint = output / "checkpoint.json"
    if saved.exists():
        if p.read_json(saved) != protocol or not checkpoint.exists():
            raise ValueError("Cannot resume with a changed or incomplete run protocol")
        state = p.read_json(checkpoint)
        if state["protocol_sha256"] != p.sha(saved):
            raise ValueError("The checkpoint belongs to another protocol")
    else:
        if any(output.iterdir()):
            raise ValueError("A new run requires an empty folder")
        p.save_json(saved, protocol)
        state = {"status": "pending", "protocol_sha256": p.sha(saved), "items": {}, "failures": []}
        p.save_json(checkpoint, state)
    allowed_ids = {row["image_sha256"] for row in protocol["samples"]}
    if not state["items"].keys() <= allowed_ids:
        raise ValueError("The checkpoint includes unrecognized rows")

    def event(message):
        line = f"{datetime.now(timezone.utc).isoformat()} PID={os.getpid()} {message}"
        print(line, flush=True)
        with (output / "run.log").open("a", encoding="utf-8") as log:
            log.write(line + "\n")

    total = len(protocol["samples"])
    pending = [row for row in protocol["samples"] if row["image_sha256"] not in state["items"]]
    event(f"start completed={len(state['items'])}/{total}, pending={len(pending)}")
    active = None
    started = time.perf_counter()
    try:
        if pending:
            import cv2
            import numpy as np

            model = configure_model(protocol)
            by_id = {row["image_sha256"]: row for row in protocol["samples"]}
            to_run = {row["image_sha256"] for row in pending[:args.max_new]}
            amount = 0
            for batch_ids in protocol["full_batches"]:
                if to_run.isdisjoint(batch_ids):
                    continue
                batch = [by_id[item_id] for item_id in batch_ids]
                active = batch_ids[0]
                loaded = [p.load_item(split, row, cv2, np) for row in batch]
                baselines = full_predictions(loaded, model, protocol["inference"])
                for item_id, row, image, baseline in zip(batch_ids, batch, loaded, baselines):
                    if item_id not in to_run:
                        continue
                    active = item_id
                    result = evaluate(row, image, baseline, model, protocol, (full_reference, tile_reference), p)
                    state["items"][active] = result
                    amount += 1
                    p.save_json(checkpoint, state)
                    done = len(state["items"])
                    eta = (time.perf_counter() - started) / amount * (total - done)
                    event(f"frame {done}/{total} id={active[:12]} extra_removed={result['extra_removals']} eta_seconds={eta:.1f}")
        if len(state["items"]) == total:
            summarize(output, protocol, state, p)
            state["status"] = "complete"
            event("complete; summary.json and frame_metrics.csv written")
        else:
            state["status"] = "paused"
            event("paused at requested frame limit; resume with the same arguments without --max-new")
        p.save_json(checkpoint, state)
    except BaseException as error:
        state["status"] = "interrupted" if isinstance(error, KeyboardInterrupt) else "failed"
        state["failures"].append({"item": active, "type": type(error).__name__, "message": str(error)})
        p.save_json(checkpoint, state)
        event(f"{state['status']} item={active}: {error}")
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("probe", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--max-new", type=int, help="Limit this invocation to new frames, then checkpoint.")
    main(parser.parse_args())
