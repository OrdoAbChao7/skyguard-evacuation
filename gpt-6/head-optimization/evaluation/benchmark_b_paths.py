"""Compare B-scene speed and head counts on the 24 already exposed street images."""

import argparse
import importlib.util
import os
import random
import time
from datetime import datetime, timezone
from pathlib import Path

SOURCE = Path(__file__).resolve()
FUSION = SOURCE.with_name("probe_c_tile_fusion.py")
METHODS = ("full025", "full015", "tiles025")
PASSES = 3


def load_fusion():
    spec = importlib.util.spec_from_file_location("c_fusion", FUSION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def full_predict(raws, model, settings):
    return [(result.boxes.xyxy.cpu().numpy(), result.boxes.conf.cpu().numpy())
            for result in model.predict(source=raws, **settings)]


def tile_predict(raw, model, settings, fraction, global_nms):
    import torch
    from torchvision.ops import nms

    height, width = raw.shape[:2]
    ch, cw = round(height * fraction), round(width * fraction)
    offsets = [(0, 0), (width-cw, 0), (0, height-ch), (width-cw, height-ch)]
    crops = [raw[y:y+ch, x:x+cw] for x, y in offsets]
    results = model.predict(source=crops, **settings)
    if len(results) != len(crops):
        raise ValueError("Missing tiled predictions")
    boxes = torch.cat([result.boxes.xyxy.cpu() + torch.tensor([x, y, x, y], dtype=torch.float32)
                       for result, (x, y) in zip(results, offsets)])
    scores = torch.cat([result.boxes.conf.cpu() for result in results])
    keep = nms(boxes, scores, global_nms)
    return boxes[keep].numpy(), scores[keep].numpy()


def evaluate(boxes, scores, count, truth, helper, np):
    if len(scores) != len(boxes) or not np.isfinite(boxes).all() or not np.isfinite(scores).all():
        raise ValueError("Invalid inference result")
    if truth is not None and len(truth) != count:
        raise ValueError("Count and truth boxes are inconsistent")
    error = len(boxes) - count
    hits = int(helper.match_targets(boxes, scores, truth, np).sum()) if truth is not None else None
    return {"gt": count, "pred": len(boxes), "tp": hits, "signed_error": error, "absolute_error": abs(error)}


def benchmark_stats(rows, np):
    times = [r["milliseconds"] for r in rows]
    gt = sum(r["gt"] for r in rows)
    pred = sum(r["pred"] for r in rows)
    hit = sum(r["tp"] for r in rows)
    return {"mae": sum(r["absolute_error"] for r in rows)/len(rows), "gt": gt, "pred": pred, "tp": hit,
            "unmatched": pred-hit, "missed": gt-hit, "recall": hit/gt,
            "precision": hit/pred if pred else 0.0, "median_ms": float(np.median(times)),
            "p95_ms": float(np.percentile(times, 95)), "mean_ms": float(np.mean(times))}


def choose(metrics):
    return min(("full015", "tiles025"), key=lambda name: (metrics[name]["mae"], metrics[name]["median_ms"]))


def inputs(project, probe, prior, helper):
    split = (project/"splits/head-count-v2").resolve(strict=True)
    cfg_file = probe/"probe_config.json"
    selection = probe/"selected_samples.csv"
    scene = helper.read_json(cfg_file)
    baseline_file = probe.parent/"baseline-v1/run_protocol.json"
    base = helper.read_json(baseline_file)
    receipt_file = project/"experiments/head-count-v2/round2-v1/training_receipt.json"
    receipt = helper.read_json(receipt_file)
    weight = Path(receipt["weight"]).resolve(strict=True)
    expected = {weight: scene["models_sha256"]["round2"], selection: scene["selection_sha256"],
                split/"split_protocol.json": scene["split_sha256"]}
    if receipt["status"] != "complete" or receipt["weight_sha256"] != expected[weight]:
        raise ValueError("Expected the fixed model two")
    if any(helper.sha(path) != digest for path, digest in expected.items()):
        raise ValueError("Fixed B benchmark inputs changed")
    rows = [r for r in helper.read_csv(selection) if r["group"]=="B"]
    if len(rows)!=24 or any(r["diagnostic_role"]!="exposed_probe_only" or r["status"]!="ready"
                            or r["dataset"]!="Cchead" or int(Path(r["image_path"]).stem)>850 for r in rows):
        raise ValueError("Only the 24 previously exposed B frames may be timed and tuned")
    protocol = {
        "scope": "24 B-group development diagnostic frames, street source frames at most 850",
        "weights": str(weight), "seed": base["seed"], "inference": scene["settings"]["base"],
        "low_inference": scene["settings"]["conf015"], "runtime": {k:base[k] for k in ("opencv","torch","ultralytics")},
        "tile_fraction": prior.TILE_FRACTION, "global_nms": prior.GLOBAL_NMS, "passes": PASSES,
        "selection_rule": "Lower development count MAE, then lower median wall time",
        "timing": "Predecoded BGR input, one frame or a 4-tile batch per call; GPU sync before and after, including detector preprocessing and box mapping/NMS. Excludes decoding, label scoring, and rendering.",
        "inputs_sha256": {str(path): helper.sha(path) for path in
                          (SOURCE,FUSION,prior.SOURCE,prior.HELPER,cfg_file,baseline_file,receipt_file,*expected)},
        "frames": rows,
    }
    return protocol, split


def run(args):
    helper_fusion = load_fusion()
    prior = helper_fusion.load_previous()
    helper = prior.load_helpers()
    protocol, split = inputs(args.project.resolve(strict=True), args.probe.resolve(strict=True), prior, helper)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    helper.save_json(out/"protocol.json", protocol)

    def event(message):
        line = f"{datetime.now(timezone.utc).isoformat()} PID={os.getpid()} {message}"
        print(line,flush=True)
        with (out/"run.log").open("a",encoding="utf-8") as f:
            f.write(line+"\n")

    event("loading the exposed B sample")
    model = prior.configure_model(protocol)
    import cv2
    import numpy as np
    import torch

    loaded = [helper.load_item(split,row,cv2,np) for row in protocol["frames"]]
    fraction, global_nms = protocol["tile_fraction"], protocol["global_nms"]
    full, low = protocol["inference"], protocol["low_inference"]

    def predict(method, raw):
        if method=="tiles025":
            return tile_predict(raw, model, full, fraction, global_nms)
        return full_predict([raw], model, low if method=="full015" else full)[0]

    for raw,_,_ in loaded[:4]:
        for method in METHODS:
            predict(method,raw)
    torch.cuda.synchronize()

    results = []
    for attempt in range(PASSES):
        order = list(range(len(loaded)))
        random.Random(protocol["seed"]+attempt).shuffle(order)
        for index in order:
            image, truth, _ = loaded[index]
            identifier = protocol["frames"][index]["image_sha256"]
            phase = (index+attempt)%len(METHODS)
            for method in METHODS[phase:]+METHODS[:phase]:
                torch.cuda.synchronize()
                started = time.perf_counter()
                boxes,scores = predict(method, image)
                torch.cuda.synchronize()
                elapsed = (time.perf_counter()-started)*1000
                counts = evaluate(boxes,scores,len(truth),truth,helper,np)
                results.append({"pass":attempt+1,"method":method,"image_sha256":identifier,
                                "milliseconds":elapsed,**counts})
        helper.save_csv(out/"frame_metrics.csv",results)
        event(f"completed={attempt+1}/{PASSES} passes, timing_rows={len(results)}")

    identical = {}
    for item in results:
        key = (item["image_sha256"],item["method"])
        sample = (item["gt"],item["pred"],item["tp"])
        if key in identical and identical[key]!=sample:
            raise ValueError("The repeated benchmark predictions were not stable")
        identical[key] = sample
    metrics = {}
    for method in METHODS:
        metric_rows = [x for x in results if x["method"]==method]
        before = benchmark_stats([x for x in metric_rows if x["pass"]==1],np)
        timed = benchmark_stats(metric_rows,np)
        before.update({key:timed[key] for key in ("median_ms","p95_ms","mean_ms")})
        before["estimated_fps_from_mean"] = 1000/before["mean_ms"]
        before["timed_frames"] = len(metric_rows)
        metrics[method] = before
    helper.save_json(out/"summary.json",{
        "status":"complete", "selected":choose(metrics), "images":len(loaded), "methods":metrics,
        "device":torch.cuda.get_device_name(0), "timing":protocol["timing"],
        "protocol_sha256":helper.sha(out/"protocol.json"), "csv_sha256":helper.sha(out/"frame_metrics.csv"),
    })
    event(f"complete selected={choose(metrics)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project",type=Path)
    parser.add_argument("probe",type=Path)
    parser.add_argument("output",type=Path)
    run(parser.parse_args())
