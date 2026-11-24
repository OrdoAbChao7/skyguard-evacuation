"""Replay the already exposed six-scene sample with the frozen C fusion rule."""

import argparse
import importlib.util
import os
import time
from datetime import datetime, timezone
from pathlib import Path

SOURCE = Path(__file__).resolve()
FUSION = SOURCE.with_name("probe_c_tile_fusion.py")
GROUPS = tuple("ABCDEF")
METHODS = ("full", "tiles", "fusion_all", "fusion_C_only")


def load_fusion():
    spec = importlib.util.spec_from_file_location("c_fusion", FUSION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def policy_record(group, baseline, fusion):
    return fusion if group == "C" else baseline


def score_frame(boxes, scores, count, truth, helper, np):
    if not np.isfinite(boxes).all() or not np.isfinite(scores).all():
        raise ValueError("Non-finite prediction")
    if truth is not None and len(truth) != count:
        raise ValueError("Annotated count differs from the head-box count")
    pred = len(boxes)
    matched = np.flatnonzero(helper.match_targets(boxes, scores, truth, np)).tolist() if truth is not None else None
    hits = len(matched) if matched is not None else None
    return {
        "pred": pred, "signed_error": pred - count, "absolute_error": abs(pred - count),
        "tp": hits, "unmatched": pred - hits if hits is not None else None,
        "missed": count - hits if hits is not None else None, "matched_indexes": matched,
    }


def protocol_for(args, fusion, helper):
    project = args.project.resolve(strict=True)
    probe = args.probe.resolve(strict=True)
    c_folder = args.c_fusion.resolve(strict=True)
    split = (project / "splits/head-count-v2").resolve(strict=True)
    config_path = probe / "probe_config.json"
    old_path = probe / "frame_metrics.csv"
    old_summary = probe / "summary.json"
    selected_path = probe / "selected_samples.csv"
    baseline_path = probe.parent / "baseline-v1/run_protocol.json"
    c_protocol_path = c_folder / "protocol.json"
    c_checkpoint_path = c_folder / "checkpoint.json"
    c_summary_path = c_folder / "summary.json"
    model_receipt = project / "experiments/head-count-v2/round2-v1/training_receipt.json"
    config = helper.read_json(config_path)
    base = helper.read_json(baseline_path)
    c_protocol = helper.read_json(c_protocol_path)
    c_state = helper.read_json(c_checkpoint_path)
    receipt = helper.read_json(model_receipt)
    weight = Path(receipt["weight"]).resolve(strict=True)
    if receipt["status"] != "complete":
        raise ValueError("Expected the finished model two")
    known = {
        weight: config["models_sha256"]["round2"],
        selected_path: config["selection_sha256"],
        old_path: helper.read_json(old_summary)["frame_metrics_sha256"],
        split / "split_protocol.json": config["split_sha256"],
    }
    if any(helper.sha(path) != expected for path, expected in known.items()):
        raise ValueError("A fixed input has changed")
    if (c_state["status"] != "complete" or helper.sha(c_protocol_path) != c_state["protocol_sha256"]
            or c_protocol["input_sha256"][str(FUSION)] != helper.sha(FUSION)
            or receipt["weight_sha256"] != known[weight]):
        raise ValueError("The verified C fusion and model must be unchanged")
    for path, expected in c_protocol["input_sha256"].items():
        if helper.sha(Path(path)) != expected:
            raise ValueError("A source in the frozen C fusion protocol has changed")

    rows = helper.read_csv(selected_path)
    planned = config["selection"]
    expected = {group: sum(row["group"] == group for row in rows) for group in GROUPS}
    ids = [row["image_sha256"] for row in rows]
    if expected != planned or len(rows) != len(set(ids)):
        raise ValueError("The previously exposed 82-image sample has changed")
    for row in rows:
        group = row["group"]
        part = "pending_license" if group == "F" else "ready"
        expected_label = "person_point" if group == "F" else ("head_box_with_track_id" if group == "B" else "head_box")
        prefix = f"test/{group}/{part}/"
        if (row["diagnostic_role"] != "exposed_probe_only" or row["status"] != part
                or row["label_type"] != expected_label
                or not row["test_image"].startswith(prefix) or not row["test_label"].startswith(prefix)):
            raise ValueError("Only the listed, previously exposed frame and label pairs may be read")
        if group == "F" and (row["dataset"] != "RGBT-CC" or row["light"] != "dark" or "_RGB." not in row["image_path"]):
            raise ValueError("The F replay is RGB count-only")

    matches = {r["sha256"]: r for r in helper.read_csv(old_path) if r["setting"] == "base" and r["model"] == "round2"}
    old_weights = {
        model: {r["sha256"]: r for r in helper.read_csv(old_path) if r["setting"] == "base" and r["model"] == model}
        for model in ("original", "round1")
    }
    if set(matches) != set(ids) or any(set(x) != set(ids) for x in old_weights.values()):
        raise ValueError("Incomplete prior metric reference")
    if set(c_state["frames"]) != {row["image_sha256"] for row in rows if row["group"] == "C"}:
        raise ValueError("The C regression reference does not match the C cohort")
    opts = config["settings"]["base"]
    batch = opts["batch"]
    files = (
        SOURCE, FUSION, fusion.PREVIOUS, config_path, old_path, old_summary, selected_path,
        baseline_path, c_protocol_path, c_checkpoint_path, c_summary_path, model_receipt, *known,
    )
    protocol = {
        "scope": "Six-scene diagnostic replay of 82 previously exposed images only",
        "F_scope": config["F_scope"],
        "input_sha256": {str(path): helper.sha(path) for path in files},
        "weights": str(weight),
        "inference": opts,
        "seed": base["seed"],
        "runtime": {name: base[name] for name in ("ultralytics", "torch", "opencv")},
        "tile_fraction": c_protocol["tile_fraction"],
        "global_nms": c_protocol["global_nms_iou"],
        "fusion": c_protocol["fusion"],
        "policy": "Only C uses fusion; the other recorded groups use the model two full frame",
        "match_iou": c_protocol["match_iou"],
        "samples": rows,
        "batches": [ids[offset:offset + batch] for offset in range(0, len(ids), batch)],
        "methods": list(METHODS),
    }
    if protocol["match_iou"] != 0.50 or protocol["inference"] != c_protocol["inference"]:
        raise ValueError("Expected the original shared inference and matching settings")
    return protocol, split, matches, c_state["frames"], old_weights


def evaluate_frame(row, item, global_prediction, model, protocol, prior, fusion, helper, np):
    raw, truth, _ = item
    full, full_scores, _ = global_prediction
    tile_options, _, _ = prior.detect_tiles(raw, model, protocol["inference"], np)
    _, tiles, tile_scores, _ = tile_options[0]
    scale = protocol["inference"]["imgsz"] / max(raw.shape[:2])
    accepted = fusion.supplement_indexes(full, tiles, scale, np)
    count = int(row["count"])
    values = (
        ("full", full, full_scores),
        ("tiles", tiles, tile_scores),
        ("fusion_all", np.concatenate((tiles, full[accepted])), np.concatenate((tile_scores, full_scores[accepted]))),
    )
    scores = {name: score_frame(boxes, confidence, count, truth, helper, np) for name, boxes, confidence in values}
    group = row["group"]
    scores["fusion_C_only"] = policy_record(group, scores["full"], scores["fusion_all"])
    return {
        "group": group, "dataset": row["dataset"], "gt": count, "image_path": row["image_path"],
        "sha256": row["image_sha256"], "added": len(accepted), "scores": scores,
    }


def check_reference(result, old, c_row):
    current = result["scores"]["full"]
    old_tp = int(old["tp50"]) if old["tp50"] else None
    if (current["pred"], current["tp"]) != (int(old["pred"]), old_tp):
        raise ValueError(f"Full-frame reference mismatch on {result['sha256']}")
    if c_row is None:
        return
    for actual, earlier in (("full", "full"), ("tiles", "tiles"), ("fusion_all", "tiles_plus_large_full")):
        a, b = result["scores"][actual], c_row["results"][earlier]
        if (a["pred"], a["matched_indexes"]) != (b["pred"], b["matched_gt_indexes"]):
            raise ValueError(f"Frozen C fusion result mismatch on {result['sha256']}, {actual}")


def aggregate(items, method, include_boxes):
    scores = [row["scores"][method] for row in items]
    count = len(scores)
    gt = sum(row["gt"] for row in items)
    pred = sum(row["pred"] for row in scores)
    abs_error = sum(row["absolute_error"] for row in scores)
    total = {
        "images": count, "gt": gt, "pred": pred, "abs_error": abs_error, "mae": abs_error / count,
        "wape": abs_error / gt, "bias": sum(row["signed_error"] for row in scores) / count,
    }
    if include_boxes:
        hits = sum(row["tp"] for row in scores)
        total.update(tp=hits, unmatched=pred-hits, missed=gt-hits,
                     precision=hits/pred if pred else 0.0, recall=hits/gt)
    return total


def publish(out, protocol, frames, old_weights, helper):
    rows = [frames[row["image_sha256"]] for row in protocol["samples"]]
    flat = [
        {"group": row["group"], "image_sha256": row["sha256"], "image_path": row["image_path"],
         "gt": row["gt"], "method": method, **{k: v for k, v in row["scores"][method].items() if k != "matched_indexes"}}
        for row in rows for method in METHODS
    ]
    groups = {}
    for group in GROUPS:
        selected = [row for row in rows if row["group"] == group]
        groups[group] = {method: aggregate(selected, method, group != "F") for method in METHODS}
        groups[group]["historical_mae"] = {
            model: sum(int(values[row["sha256"]]["absolute_error"]) for row in selected) / len(selected)
            for model, values in old_weights.items()
        }
    path = out / "frame_metrics.csv"
    helper.save_csv(path, flat)
    helper.save_json(out / "summary.json", {
        "scope": protocol["scope"], "F_scope": protocol["F_scope"], "model_sha256": protocol["input_sha256"][protocol["weights"]],
        "groups": groups, "overall": {method: aggregate(rows, method, False) for method in METHODS},
        "A_to_E": {method: aggregate([row for row in rows if row["group"] != "F"], method, True) for method in METHODS},
        "frame_metrics_sha256": helper.sha(path),
    })


def run(args):
    if args.max_new is not None and args.max_new < 1:
        raise ValueError("--max-new must be positive")
    fusion = load_fusion()
    prior = fusion.load_previous()
    helper = prior.load_helpers()
    protocol, split, original, c_frames, old_weights = protocol_for(args, fusion, helper)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    frozen = out / "protocol.json"
    checkpoint = out / "checkpoint.json"
    if frozen.exists():
        if protocol != helper.read_json(frozen):
            raise ValueError("The saved protocol differs from this run")
        state = helper.read_json(checkpoint)
        if state["protocol_sha256"] != helper.sha(frozen):
            raise ValueError("The checkpoint protocol hash differs")
    else:
        if any(out.iterdir()):
            raise ValueError("A new run needs an empty directory")
        helper.save_json(frozen, protocol)
        state = {"status": "pending", "protocol_sha256": helper.sha(frozen), "frames": {}, "failures": []}
        helper.save_json(checkpoint, state)

    def event(message):
        line = f"{datetime.now(timezone.utc).isoformat()} PID={os.getpid()} {message}"
        print(line, flush=True)
        with (out / "run.log").open("a", encoding="utf-8") as stream:
            stream.write(line + "\n")

    source = {row["image_sha256"]: row for row in protocol["samples"]}
    stored = state["frames"]
    if not stored.keys() <= source.keys():
        raise ValueError("A checkpoint frame falls outside of the approved scope")
    todo = set([key for key in source if key not in stored][:args.max_new])
    total = len(source)
    event(f"start completed={len(stored)}/{total}, queued={len(todo)}")
    active = None
    try:
        if todo:
            import cv2
            import numpy as np

            model = prior.configure_model(protocol)
            start = time.perf_counter()
            processed = 0
            for batch in protocol["batches"]:
                if todo.isdisjoint(batch):
                    continue
                active = batch[0]
                items = [helper.load_item(split, source[key], cv2, np) for key in batch]
                globals_ = prior.full_predictions(items, model, protocol["inference"])
                for key, item, global_prediction in zip(batch, items, globals_):
                    if key not in todo:
                        continue
                    active = key
                    record = evaluate_frame(source[key], item, global_prediction, model, protocol, prior, fusion, helper, np)
                    check_reference(record, original[key], c_frames.get(key))
                    stored[key] = record
                    processed += 1
                    helper.save_json(checkpoint, state)
                    eta = (time.perf_counter() - start) / processed * (total - len(stored))
                    event(f"frame={len(stored)}/{total} group={record['group']} id={key[:12]} eta_seconds={eta:.1f}")
        if len(stored) == total:
            publish(out, protocol, stored, old_weights, helper)
            state["status"] = "complete"
        else:
            state["status"] = "paused"
        helper.save_json(checkpoint, state)
        event(f"{state['status']} completed={len(stored)}/{total}")
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
    parser.add_argument("c_fusion", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--max-new", type=int, help="Checkpoint after processing at most this many new frames")
    run(parser.parse_args())
