"""Test adding unmatched large full-frame boxes to the original C-group tiles."""

import argparse
import importlib.util
import os
from datetime import datetime, timezone
from pathlib import Path

SOURCE = Path(__file__).resolve()
PREVIOUS = SOURCE.with_name("probe_c_tile_dedup.py")
MIN_SHORT_SIDE = 16
CORRESPONDENCE_IOU = 0.35
CORRESPONDENCE_CONTAINMENT = 0.75
CORRESPONDENCE_CENTER = 0.35
METHODS = ("full", "tiles", "tiles_plus_large_full")


def supplement_indexes(full_boxes, tile_boxes, image_scale, np):
    """Index full-frame boxes that are sufficiently large and lack a tile counterpart."""
    full_sizes = full_boxes[:, 2:] - full_boxes[:, :2]
    eligible = np.flatnonzero(np.min(full_sizes, axis=1) * image_scale >= MIN_SHORT_SIDE)
    if not len(eligible) or not len(tile_boxes):
        return eligible
    large = full_boxes[eligible]
    sizes = full_sizes[eligible]
    tile_sizes = tile_boxes[:, 2:] - tile_boxes[:, :2]
    common = np.maximum(
        np.minimum(large[:, None, 2:], tile_boxes[None, :, 2:])
        - np.maximum(large[:, None, :2], tile_boxes[None, :, :2]), 0,
    ).prod(axis=2)
    a = sizes.prod(axis=1)[:, None]
    b = tile_sizes.prod(axis=1)[None, :]
    iou = common / (a + b - common)
    containment = common / np.maximum(np.minimum(a, b), 1e-9)
    a_centers = (large[:, :2] + large[:, 2:]) / 2
    b_centers = (tile_boxes[:, :2] + tile_boxes[:, 2:]) / 2
    shifts = np.abs(a_centers[:, None, :] - b_centers[None, :, :]) / np.maximum(
        sizes[:, None, :], tile_sizes[None, :, :],
    )
    close = (shifts <= CORRESPONDENCE_CENTER).all(axis=2)
    corresponds = (iou >= CORRESPONDENCE_IOU) | ((containment >= CORRESPONDENCE_CONTAINMENT) & close)
    return eligible[~corresponds.any(axis=1)]


def load_previous():
    spec = importlib.util.spec_from_file_location("previous_c_probe", PREVIOUS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_protocol(args, previous, helper):
    base, split, _, _ = previous.load_protocol(args, helper)
    artifact = args.reference.resolve(strict=True)
    prior_protocol = artifact / "protocol.json"
    prior_checkpoint = artifact / "checkpoint.json"
    prior_summary = artifact / "summary.json"
    reference = helper.read_json(prior_checkpoint)
    earlier = helper.read_json(prior_protocol)
    if earlier != base or reference["status"] != "complete" or reference["protocol_sha256"] != helper.sha(prior_protocol):
        raise ValueError("Expected the verified, unchanged C tiling experiment")
    if set(reference["items"]) != {row["image_sha256"] for row in base["samples"]}:
        raise ValueError("The reference sample does not match the exposed C selection")
    base["input_sha256"].update({
        str(path): helper.sha(path) for path in (SOURCE, prior_protocol, prior_checkpoint, prior_summary)
    })
    base.pop("cross_tile")
    base["methods"] = list(METHODS)
    base["fusion"] = {
        "base": "All original tile boxes are retained",
        "min_full_short_side_at_640": MIN_SHORT_SIDE,
        "comparison_iou": CORRESPONDENCE_IOU,
        "comparison_containment": CORRESPONDENCE_CONTAINMENT,
        "comparison_relative_center_per_axis": CORRESPONDENCE_CENTER,
        "note": "Original model confidence and original within-method NMS are unchanged",
    }
    return base, split, reference["items"]


def frame_result(row, loaded, global_prediction, model, protocol, reference, prior, helper, np):
    raw, truth, _ = loaded
    full_boxes, full_scores, _ = global_prediction
    tile_options, _, _ = prior.detect_tiles(raw, model, protocol["inference"], np)
    _, tile_boxes, tile_scores, _ = tile_options[0]
    scale = protocol["inference"]["imgsz"] / max(raw.shape[:2])
    picks = supplement_indexes(full_boxes, tile_boxes, scale, np)
    fused_boxes = np.concatenate((tile_boxes, full_boxes[picks]))
    fused_scores = np.concatenate((tile_scores, full_scores[picks]))
    variants = (
        ("full", full_boxes, full_scores),
        ("tiles", tile_boxes, tile_scores),
        ("tiles_plus_large_full", fused_boxes, fused_scores),
    )
    record = {}
    for name, boxes, scores in variants:
        if not np.isfinite(boxes).all() or not np.isfinite(scores).all():
            raise ValueError("Non-finite inference outputs")
        matches = np.flatnonzero(helper.match_targets(boxes, scores, truth, np)).tolist()
        count, hits = len(boxes), len(matches)
        if name in ("full", "tiles"):
            expected = reference["results"][name]
            if count != expected["pred"] or matches != expected["matched_gt_indexes"]:
                raise ValueError(f"{name} did not reproduce the verified C reference for {row['image_sha256']}")
        delta = count - len(truth)
        record[name] = {
            "pred": count, "tp": hits, "unmatched": count - hits, "missed": len(truth) - hits,
            "signed_error": delta, "absolute_error": abs(delta), "matched_gt_indexes": matches,
        }

    tiling = set(record["tiles"]["matched_gt_indexes"])
    fused = set(record["tiles_plus_large_full"]["matched_gt_indexes"])
    gained = sorted(fused - tiling)
    lost = sorted(tiling - fused)
    target_short_sides = np.min(truth[:, 2:] - truth[:, :2], axis=1) * scale
    return {
        "image_sha256": row["image_sha256"], "image_path": row["image_path"],
        "recording": row["source_recording"], "gt": len(truth), "results": record,
        "added_candidates_xyxy_conf": np.column_stack((full_boxes[picks], full_scores[picks])).tolist(),
        "gt_matches_gained": gained, "gt_matches_lost": lost,
        "gained_large": sum(float(target_short_sides[i]) >= MIN_SHORT_SIDE for i in gained),
    }


def write_results(output, protocol, frames, helper):
    ordered = [frames[row["image_sha256"]] for row in protocol["samples"]]
    flat = []
    metrics = {}
    truth = sum(item["gt"] for item in ordered)
    for method in METHODS:
        group = []
        for item in ordered:
            result = {key: val for key, val in item["results"][method].items() if key != "matched_gt_indexes"}
            group.append(result)
            flat.append({
                "method": method, "image_sha256": item["image_sha256"], "image_path": item["image_path"],
                "recording": item["recording"], "gt": item["gt"], **result,
            })
        predictions = sum(value["pred"] for value in group)
        hits = sum(value["tp"] for value in group)
        abs_error = sum(value["absolute_error"] for value in group)
        metrics[method] = {
            "frames": len(group), "gt": truth, "predicted": predictions, "tp": hits,
            "unmatched": predictions - hits, "missed": truth - hits, "precision": hits / predictions,
            "recall": hits / truth, "mae": abs_error / len(group), "wape": abs_error / truth,
            "undercount_frames": sum(value["signed_error"] < 0 for value in group),
        }
    csv_path = output / "frame_metrics.csv"
    helper.save_csv(csv_path, flat)
    helper.save_json(output / "summary.json", {
        "scope": protocol["scope"], "methods": metrics,
        "weights_sha256": protocol["input_sha256"][protocol["weights"]],
        "full_boxes_added": sum(len(item["added_candidates_xyxy_conf"]) for item in ordered),
        "gt_matches_gained": sum(len(item["gt_matches_gained"]) for item in ordered),
        "gt_matches_lost": sum(len(item["gt_matches_lost"]) for item in ordered),
        "gained_large": sum(item["gained_large"] for item in ordered),
        "frame_metrics_sha256": helper.sha(csv_path),
    })


def run(args):
    if args.max_new is not None and args.max_new <= 0:
        raise ValueError("--max-new must be positive")
    previous = load_previous()
    helper = previous.load_helpers()
    protocol, split, reference = build_protocol(args, previous, helper)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    protocol_path = out / "protocol.json"
    checkpoint = out / "checkpoint.json"

    if protocol_path.exists():
        if protocol != helper.read_json(protocol_path):
            raise ValueError("Cannot resume a different frozen run")
        state = helper.read_json(checkpoint)
        if state["protocol_sha256"] != helper.sha(protocol_path):
            raise ValueError("Checkpoint and protocol disagree")
    else:
        if any(out.iterdir()):
            raise ValueError("A new experiment needs an empty output directory")
        helper.save_json(protocol_path, protocol)
        state = {"status": "pending", "protocol_sha256": helper.sha(protocol_path), "frames": {}, "failures": []}
        helper.save_json(checkpoint, state)

    def event(message):
        line = f"{datetime.now(timezone.utc).isoformat()} PID={os.getpid()} {message}"
        print(line, flush=True)
        with (out / "run.log").open("a", encoding="utf-8") as stream:
            stream.write(line + "\n")

    rows = {item["image_sha256"]: item for item in protocol["samples"]}
    frames = state["frames"]
    if not frames.keys() <= rows.keys():
        raise ValueError("The checkpoint includes an image outside the approved diagnostic subset")
    todo = [item_id for item_id in rows if item_id not in frames][:args.max_new]
    todo_set = set(todo)
    total = len(rows)
    active = None
    event(f"start completed={len(frames)}/{total} requested={len(todo)}")
    try:
        if todo:
            import cv2
            import numpy as np
            import time

            model = previous.configure_model(protocol)
            started = time.perf_counter()
            done_now = 0
            for ids in protocol["full_batches"]:
                if todo_set.isdisjoint(ids):
                    continue
                event(f"batch size={len(ids)} start={ids[0][:12]}")
                loaded = [helper.load_item(split, rows[item_id], cv2, np) for item_id in ids]
                global_predictions = previous.full_predictions(loaded, model, protocol["inference"])
                for item_id, image, global_prediction in zip(ids, loaded, global_predictions):
                    if item_id not in todo_set:
                        continue
                    active = item_id
                    result = frame_result(rows[item_id], image, global_prediction, model, protocol,
                                          reference[item_id], previous, helper, np)
                    frames[item_id] = result
                    helper.save_json(checkpoint, state)
                    done_now += 1
                    added = len(result["added_candidates_xyxy_conf"])
                    eta = (time.perf_counter() - started) / done_now * (total - len(frames))
                    event(f"frame {len(frames)}/{total} id={item_id[:12]} added={added} eta_seconds={eta:.1f}")
        if len(frames) == total:
            write_results(out, protocol, frames, helper)
            state["status"] = "complete"
        else:
            state["status"] = "paused"
        helper.save_json(checkpoint, state)
        event(f"{state['status']} completed={len(frames)}/{total}")
    except BaseException as error:
        state["status"] = "interrupted" if isinstance(error, KeyboardInterrupt) else "failed"
        state["failures"].append({"item": active, "type": type(error).__name__, "message": str(error)})
        helper.save_json(checkpoint, state)
        event(f"{state['status']} item={active}: {error}")
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("probe", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--max-new", type=int, help="Checkpoint after processing at most this many new frames.")
    run(parser.parse_args())
