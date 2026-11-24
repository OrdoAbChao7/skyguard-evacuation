"""Evaluate the frozen B/C inference choices on five seeded A–F holdout draws."""

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import importlib.util
import os
from pathlib import Path
import random
from statistics import mean, stdev
import time

SOURCE = Path(__file__).resolve()
BENCHMARK = SOURCE.with_name("benchmark_b_paths.py")
PER_GROUP = {"A": 6, "B": 24, "C": 16, "D": 4, "E": 12, "F": 16}
SEEDS = (2026112301, 2026112302, 2026112303, 2026112304, 2026112305)
METHODS = ("original_full025", "model2_full025", "optimized")


def load_bench():
    spec = importlib.util.spec_from_file_location("b_bench", BENCHMARK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def draw_plan(pools):
    ordered = {group: sorted(pools[group], key=lambda item: item["image_sha256"]) for group in PER_GROUP}
    if any(len(ordered[group]) < count for group, count in PER_GROUP.items()):
        raise ValueError("A holdout group has too few eligible images")
    rounds = []
    for number, seed in enumerate(SEEDS, 1):
        generator = random.Random(seed)
        picks = {group: generator.sample(ordered[group], count) for group, count in PER_GROUP.items()}
        rounds.append({"round": number, "seed": seed, "samples": picks})
    return rounds


def freeze_inputs(args, bench, fusion, prior, helper):
    root = args.project.resolve(strict=True)
    split = (root / "splits/head-count-v2").resolve(strict=True)
    exp = root / "evaluations/head-count-v2"
    exposed_run = exp / "scene-probe-v1"
    b_run = args.benchmark.resolve(strict=True)
    c_run = exp / "c-tile-fusion-v1"
    b_proto_path = b_run / "protocol.json"
    b_summary_path = b_run / "summary.json"
    b_frames = b_run / "frame_metrics.csv"
    c_proto_path = c_run / "protocol.json"
    c_summary_path = c_run / "summary.json"
    c_checkpoint_path = c_run / "checkpoint.json"
    c_rows = c_run / "frame_metrics.csv"
    exposure_file = exposed_run / "selected_samples.csv"
    exposure_config = exposed_run / "probe_config.json"
    split_file = split / "split_protocol.json"
    b_proto = helper.read_json(b_proto_path)
    b_summary = helper.read_json(b_summary_path)
    c_proto = helper.read_json(c_proto_path)
    c_summary = helper.read_json(c_summary_path)
    c_checkpoint = helper.read_json(c_checkpoint_path)
    exposure = helper.read_json(exposure_config)
    split_cfg = helper.read_json(split_file)
    if (b_summary["status"] != "complete" or b_summary["selected"] != bench.choose(b_summary["methods"])
            or helper.sha(b_proto_path) != b_summary["protocol_sha256"]
            or helper.sha(b_frames) != b_summary["csv_sha256"]):
        raise ValueError("The B development benchmark is incomplete")
    if (c_checkpoint["status"] != "complete" or helper.sha(c_proto_path) != c_checkpoint["protocol_sha256"]
            or helper.sha(c_rows) != c_summary["frame_metrics_sha256"]):
        raise ValueError("The C fusion protocol is unverified")
    for registered in (b_proto["inputs_sha256"], c_proto["input_sha256"]):
        if any(helper.sha(Path(path)) != digest for path, digest in registered.items()):
            raise ValueError("The development inputs changed")
    if b_proto["inference"] != c_proto["inference"] or b_proto["weights"] != c_proto["weights"]:
        raise ValueError("B and C must use the same model and base inference parameters")

    original = args.original.resolve(strict=True)
    model = Path(b_proto["weights"]).resolve(strict=True)
    expected = {
        original: exposure["models_sha256"]["original"],
        model: exposure["models_sha256"]["round2"],
        exposure_file: exposure["selection_sha256"],
        split_file: exposure["split_sha256"],
    }
    blocked = {r["image_sha256"] for r in helper.read_csv(exposure_file)}
    for name, cfg in split_cfg["development"].items():
        manifest = split / name
        expected[manifest] = cfg["sha256"]
        blocked.update(row["image_sha256"] for row in helper.read_csv(manifest))

    pools = {}
    seen = set()
    for group in PER_GROUP:
        definition = split_cfg["test_groups"][group]
        manifest = split / definition["manifest"]
        expected[manifest] = definition["sha256"]
        status = "pending_license" if group == "F" else "ready"
        prefix = f"test/{group}/{status}/"
        picks = []
        for row in helper.read_csv(manifest):
            if row["status"] != status or row["image_sha256"] in blocked:
                continue
            if group == "B" and int(Path(row["image_path"]).stem) <= 850:
                continue
            if (row["group"] != group or not row["test_image"].startswith(prefix)
                    or not row["test_label"].startswith(prefix) or row["image_sha256"] in seen):
                raise ValueError("Invalid or repeated holdout manifest row")
            if group == "F" and (row["dataset"] != "RGBT-CC" or row["light"] != "dark"
                                 or row["label_type"] != "person_point" or "_RGB." not in row["image_path"]):
                raise ValueError("F is limited to the existing RGB count-only source")
            seen.add(row["image_sha256"])
            picks.append(row)
        pools[group] = picks
    if any(helper.sha(path) != value for path, value in expected.items()):
        raise ValueError("A frozen weight, label index, or exposure list changed")

    files = (
        SOURCE, BENCHMARK, bench.FUSION, fusion.PREVIOUS, prior.HELPER, b_proto_path, b_summary_path,
        b_frames, c_proto_path, c_summary_path, c_checkpoint_path, c_rows, exposure_config, *expected,
    )
    protocol = {
        "scope": "Five seeded local holdout draws after fixing all A-F settings",
        "exclusions": "Training, development validation, the 82 exposed hashes, and B source frames at most 850",
        "sampling": "Seeded uniform per group, without replacement within each draw. Across-draw reuse allowed.",
        "pool_sizes": {group: len(pool) for group, pool in pools.items()},
        "per_group": PER_GROUP,
        "policy": {"A":"full025","B":b_summary["selected"],"C":"tiles025_plus_large_full",
                   "D":"full025","E":"full025","F":"full025"},
        "F_scope": "User-requested local count-only test. Existing RGBT RGB data, dataset license status unchanged.",
        "weights": str(model), "original_weights": str(original), "seed": b_proto["seed"],
        "inference": b_proto["inference"], "low_inference": b_proto["low_inference"],
        "runtime": b_proto["runtime"], "tile_fraction": b_proto["tile_fraction"],
        "global_nms": b_proto["global_nms"], "fusion": c_proto["fusion"], "match_iou": c_proto["match_iou"],
        "methods": list(METHODS),
        "input_sha256": {str(path): helper.sha(path) for path in files},
        "rounds": draw_plan(pools),
    }
    if protocol["match_iou"] != 0.50:
        raise ValueError("Expected the same head-box criterion as development")
    return protocol, split


def run_group(rows, group, split, protocol, model2, original, bench, fusion, helper, cv2, np):
    full_opts, low_opts = protocol["inference"], protocol["low_inference"]
    policy = protocol["policy"][group]
    size = full_opts["batch"]
    result = []
    for start in range(0, len(rows), size):
        chunk = rows[start:start+size]
        loaded = [helper.load_item(split, row, cv2, np) for row in chunk]
        raws = [item[0] for item in loaded]
        before = bench.full_predict(raws, original, full_opts)
        full = bench.full_predict(raws, model2, full_opts)
        if policy == "full015":
            optimized = bench.full_predict(raws, model2, low_opts)
        elif policy == "full025":
            optimized = full
        else:
            tiles = [bench.tile_predict(raw, model2, full_opts, protocol["tile_fraction"],
                                        protocol["global_nms"]) for raw in raws]
            optimized = []
            for raw, (tile_boxes, tile_scores), (full_boxes, full_scores) in zip(raws, tiles, full):
                if policy == "tiles025":
                    optimized.append((tile_boxes, tile_scores))
                else:
                    scale = full_opts["imgsz"] / max(raw.shape[:2])
                    keep = fusion.supplement_indexes(full_boxes, tile_boxes, scale, np)
                    optimized.append((np.concatenate((tile_boxes, full_boxes[keep])),
                                      np.concatenate((tile_scores, full_scores[keep]))))
        if any(len(outputs) != len(chunk) for outputs in (before, full, optimized)):
            raise ValueError("A model returned the wrong number of images")
        for row, item, ref, base, candidate in zip(chunk, loaded, before, full, optimized):
            truth = item[1]
            if (truth is None) != (group == "F"):
                raise ValueError("Unexpected count-only or head-box label")
            for name, (boxes, scores) in zip(METHODS, (ref, base, candidate)):
                metrics = bench.evaluate(boxes, scores, int(row["count"]), truth, helper, np)
                result.append({"group":group, "method":name, "image_sha256":row["image_sha256"],
                               "image_path":row["image_path"], **metrics})
    return result


def fold_summary(rows):
    gt = sum(row["gt"] for row in rows)
    pred = sum(row["pred"] for row in rows)
    errors = sum(row["absolute_error"] for row in rows)
    count = len(rows)
    metrics = {
        "n":count, "gt":gt, "pred":pred, "mae":errors/count, "wape":errors/gt,
        "bias":sum(row["signed_error"] for row in rows)/count,
    }
    if all(row["tp"] is not None for row in rows):
        hits = sum(row["tp"] for row in rows)
        metrics.update(tp=hits, unmatched=pred-hits, missed=gt-hits, recall=hits/gt,
                       precision=hits/pred if pred else 0.0)
    return metrics


def publish(out, protocol, completed, helper):
    flat, by_round = [], []
    coverage = defaultdict(set)
    for item in protocol["rounds"]:
        number, seed = item["round"], item["seed"]
        images = [row for group in PER_GROUP for row in completed[f"{number}:{group}"]]
        for row in images:
            coverage[row["group"]].add(row["image_sha256"])
        flat.extend({"round":number,"seed":seed, **row} for row in images)
        for group in (*PER_GROUP, "A-E", "overall"):
            selected = [r for r in images if group=="overall" or group==r["group"]
                        or (group=="A-E" and r["group"]!="F")]
            for method in METHODS:
                rows = [r for r in selected if r["method"]==method]
                by_round.append({"round":number, "seed":seed, "group":group, "method":method,
                                 **fold_summary(rows)})
    averages = {}
    for group in (*PER_GROUP, "A-E", "overall"):
        averages[group] = {}
        for method in METHODS:
            subsets = [row for row in by_round if row["group"]==group and row["method"]==method]
            measurements = [s["mae"] for s in subsets]
            values = {"mean_mae":mean(measurements), "sd_mae":stdev(measurements),
                      "mean_wape":mean(s["wape"] for s in subsets),
                      "mean_bias":mean(s["bias"] for s in subsets)}
            if "recall" in subsets[0]:
                values.update(mean_recall=mean(s["recall"] for s in subsets),
                              mean_precision=mean(s["precision"] for s in subsets))
            averages[group][method] = values
    round_fields = ["round","seed","group","method","n","gt","pred","mae","wape","bias",
                    "tp","unmatched","missed","recall","precision"]
    normalized = [{name:row.get(name) for name in round_fields} for row in by_round]
    helper.save_csv(out/"frame_metrics.csv", flat)
    helper.save_csv(out/"round_metrics.csv", normalized)
    helper.save_json(out/"summary.json", {
        "scope": protocol["scope"], "policy":protocol["policy"], "seeds":list(SEEDS),
        "pool_sizes":protocol["pool_sizes"], "per_group":PER_GROUP,
        "unique_images_per_group":{group:len(ids) for group,ids in coverage.items()},
        "averages":averages, "frame_metric_sha256":helper.sha(out/"frame_metrics.csv"),
        "round_metric_sha256":helper.sha(out/"round_metrics.csv"),
    })


def run(args):
    if args.max_groups is not None and args.max_groups < 1:
        raise ValueError("--max-groups must be positive")
    bench = load_bench()
    fusion = bench.load_fusion()
    prior = fusion.load_previous()
    helper = prior.load_helpers()
    protocol, split = freeze_inputs(args, bench, fusion, prior, helper)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    fixed = out/"protocol.json"
    checkpoint = out/"checkpoint.json"
    if fixed.exists():
        if helper.read_json(fixed) != protocol:
            raise ValueError("Do not resume with a changed frozen plan")
        state = helper.read_json(checkpoint)
        if state["protocol_sha256"] != helper.sha(fixed):
            raise ValueError("A checkpoint must match the locked analysis")
    else:
        if any(out.iterdir()):
            raise ValueError("A new run needs an empty directory")
        helper.save_json(fixed, protocol)
        state = {"status":"pending", "protocol_sha256":helper.sha(fixed), "groups":{}, "failures":[]}
        helper.save_json(checkpoint, state)

    def event(message):
        line = f"{datetime.now(timezone.utc).isoformat()} PID={os.getpid()} {message}"
        print(line, flush=True)
        with (out/"run.log").open("a", encoding="utf-8") as stream:
            stream.write(line+"\n")

    valid = {f"{item['round']}:{group}":(group,item["samples"][group])
             for item in protocol["rounds"] for group in PER_GROUP}
    stored = state["groups"]
    if not stored.keys() <= valid.keys():
        raise ValueError("Checkpoint includes a group outside the frozen draws")
    todo = [key for key in valid if key not in stored][:args.max_groups]
    event(f"frozen B={protocol['policy']['B']}; complete_groups={len(stored)}/{len(valid)} queued={len(todo)}")
    active = None
    try:
        if todo:
            import cv2
            import numpy as np

            model2 = prior.configure_model(protocol)
            original = prior.configure_model({**protocol, "weights":protocol["original_weights"]})
            begin = time.perf_counter()
            for i, key in enumerate(todo, 1):
                active = key
                group, rows = valid[key]
                stored[key] = run_group(rows, group, split, protocol, model2, original, bench, fusion, helper, cv2, np)
                helper.save_json(checkpoint, state)
                eta = (time.perf_counter()-begin)/i*(len(valid)-len(stored))
                event(f"round_group={key} pictures={len(rows)} done={len(stored)}/{len(valid)} eta_s={eta:.1f}")
        if len(stored) == len(valid):
            publish(out, protocol, stored, helper)
            state["status"] = "complete"
        else:
            state["status"] = "paused"
        helper.save_json(checkpoint,state)
        event(f"{state['status']} complete_groups={len(stored)}/{len(valid)}")
    except BaseException as exc:
        state["status"] = "interrupted" if isinstance(exc, KeyboardInterrupt) else "failed"
        state["failures"].append({"group":active,"type":type(exc).__name__,"message":str(exc)})
        helper.save_json(checkpoint,state)
        event(f"{state['status']} group={active}: {exc}")
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project",type=Path)
    parser.add_argument("benchmark",type=Path)
    parser.add_argument("original",type=Path)
    parser.add_argument("output",type=Path)
    parser.add_argument("--max-groups",type=int,help="Pause at an approved round/group checkpoint")
    run(parser.parse_args())
