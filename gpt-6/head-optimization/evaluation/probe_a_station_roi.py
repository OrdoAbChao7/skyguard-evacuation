"""Compare full and cropped inference inside fixed station ROIs on exposed A images."""

import argparse
from datetime import datetime, timezone
import importlib.util
import math
import os
from pathlib import Path

SOURCE = Path(__file__).resolve()
BENCHMARK = SOURCE.with_name("benchmark_b_paths.py")
METHODS = ("full640", "full960", "roi640")
CROP_PADDING = 0.02
STATION_POLYGONS = {
    "DMSA0442_GP094171": [[0, 0], [0.73, 0], [0.77, 0.48], [0.76, 1], [0, 1]],
    "DMSA0442_GP124171": [[0, 0], [0.70, 0], [0.76, 0.53], [0.76, 1], [0, 1]],
    "DMSA0472_GX160026": [[0, 0], [0.60, 0], [0.64, 1], [0, 1]],
    "DMSA0542_GP014177": [[0, 0], [0.72, 0], [0.83, 0.62], [0.82, 1], [0, 1]],
}


def bench_module():
    spec = importlib.util.spec_from_file_location("b_benchmark", BENCHMARK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def crop_bounds(polygon, width, height):
    """Pixel crop limits, padded outside the measurement polygon."""
    low = polygon.min(axis=0)
    high = polygon.max(axis=0)
    x0 = max(0, math.floor(float(low[0]) - width * CROP_PADDING))
    y0 = max(0, math.floor(float(low[1]) - height * CROP_PADDING))
    x1 = min(width, math.ceil(float(high[0]) + width * CROP_PADDING))
    y1 = min(height, math.ceil(float(high[1]) + height * CROP_PADDING))
    if x0 >= x1 or y0 >= y1:
        raise ValueError("A station crop must have positive dimensions")
    return x0, y0, x1, y1


def in_roi(boxes, polygon, cv2, np):
    centers = (boxes[:, :2] + boxes[:, 2:]) / 2
    return np.array([
        cv2.pointPolygonTest(polygon, (float(x), float(y)), False) >= 0 for x, y in centers
    ], dtype=bool)


def to_full_frame(boxes, xyxy, np):
    x, y = xyxy[:2]
    return boxes + np.array([x,y,x,y],dtype=boxes.dtype)


def fixed_inputs(project, probe, holdout, previous, helper):
    split = (project/"splits/head-count-v2").resolve(strict=True)
    old_cfg = probe/"probe_config.json"
    old_frames = probe/"frame_metrics.csv"
    old_summary = probe/"summary.json"
    sample_file = probe/"selected_samples.csv"
    baseline_file = probe.parent/"baseline-v1/run_protocol.json"
    receipt = project/"experiments/head-count-v2/round2-v1/training_receipt.json"
    old = helper.read_json(old_cfg)
    base = helper.read_json(baseline_file)
    training = helper.read_json(receipt)
    holdout_protocol = holdout/"protocol.json"
    holdout_checkpoint = holdout/"checkpoint.json"
    completed = helper.read_json(holdout_checkpoint)
    if completed["status"] != "complete" or completed["protocol_sha256"] != helper.sha(holdout_protocol):
        raise ValueError("The five-draw exposure list must be verifiable")
    held = {
        row["image_sha256"]
        for draw in helper.read_json(holdout_protocol)["rounds"]
        for row in draw["samples"]["A"]
    }
    model = Path(training["weight"]).resolve(strict=True)
    known = {
        model: old["models_sha256"]["round2"],
        old_frames: helper.read_json(old_summary)["frame_metrics_sha256"],
        sample_file: old["selection_sha256"],
        split/"split_protocol.json": old["split_sha256"],
    }
    if training["status"] != "complete" or training["weight_sha256"] != known[model]:
        raise ValueError("The model two receipt differs from the tested checkpoint")
    if any(helper.sha(path) != digest for path, digest in known.items()):
        raise ValueError("An earlier diagnostic or split input changed")
    samples = [row for row in helper.read_csv(sample_file) if row["group"] == "A"]
    if (len(samples) != 8 or set(STATION_POLYGONS) != {s["source_recording"] for s in samples}
            or any(s["label_type"] != "head_box" or s["diagnostic_role"] != "exposed_probe_only"
                   or s["image_sha256"] in held or not s["test_image"].startswith("test/A/ready/")
                   or not s["test_label"].startswith("test/A/ready/") for s in samples)):
        raise ValueError("Only the first A diagnostic group, excluding all five-draw A frames, may be read")
    reference = {
        (row["sha256"],row["setting"]): (int(row["pred"]), int(row["tp50"]))
        for row in helper.read_csv(old_frames)
        if row["group"]=="A" and row["model"]=="round2" and row["setting"] in ("base","size960")
    }
    if set(reference) != {(r["image_sha256"], mode) for r in samples for mode in ("base","size960")}:
        raise ValueError("The full-frame regression rows are incomplete")
    opts = old["settings"]["base"]
    resized = old["settings"]["size960"]
    if opts["imgsz"]!=640 or resized["imgsz"]!=960 or opts != {**resized,"imgsz":640} or opts["conf"]!=0.25:
        raise ValueError("The study must vary image size or ROI crop only")
    protocol = {
        "scope":"Eight first-probe A images only. Five-draw test images excluded.",
        "regions":STATION_POLYGONS, "crop_padding_fraction":CROP_PADDING,
        "regions_basis":"Image-plane passenger waiting and circulation area from clean development views. Rail/track-side service edge and adjacent outside area excluded. Fixed per recording, no ground-plane calibration.",
        "include":"Apply one fixed full-coordinate polygon per recording to ground-truth and predicted centers, boundary included.",
        "methods":list(METHODS), "samples":samples, "weights":str(model), "inference":opts,
        "inference_960":resized, "seed":base["seed"], "match_iou":base["match_iou"],
        "runtime":{key:base[key] for key in ("opencv","ultralytics","torch")},
        "input_sha256":{str(path):helper.sha(path) for path in
                        (SOURCE,BENCHMARK,previous.SOURCE,previous.HELPER,old_cfg,old_summary,
                         baseline_file,receipt,holdout_protocol,holdout_checkpoint,*known)},
    }
    if protocol["match_iou"] != 0.50:
        raise ValueError("Unexpected matching criterion")
    return protocol, split, reference


def make_preview(selected, out):
    from PIL import Image, ImageDraw, ImageFont
    cells = list(selected.items())
    cell_w, cell_h = 660, 480
    canvas = Image.new("RGB", (cell_w*2, cell_h*2+82), "#141f2c")
    draw = ImageDraw.Draw(canvas)
    font = "C:/Windows/Fonts/msyh.ttc"
    heading = ImageFont.truetype(font,29)
    note = ImageFont.truetype(font,17)
    draw.text((16,9), "SkyGuard  /  A 组固定计数区", font=heading, fill="#edf4ff")
    draw.text((16,50), "蓝线为三路共同计数区。按候车、排队和通行范围划定，区域外调暗。", font=note, fill="#b9cadd")
    for index,(name,(raw,polygon)) in enumerate(cells):
        rgb = Image.fromarray(raw[:,:,::-1])
        scale = min((cell_w-24)/rgb.width, (cell_h-50)/rgb.height)
        rgb = rgb.resize((round(rgb.width*scale),round(rgb.height*scale)),Image.Resampling.LANCZOS)
        shape = [tuple(round(float(v)*scale) for v in xy) for xy in polygon]
        mask = Image.new("L",rgb.size,0)
        ImageDraw.Draw(mask).polygon(shape,fill=255)
        masked = Image.composite(rgb,Image.blend(rgb,Image.new("RGB",rgb.size,"#0d1420"),0.52),mask)
        ImageDraw.Draw(masked).line(shape+[shape[0]],fill="#7dd4ff",width=3)
        x,y=(index%2)*cell_w+12,82+(index//2)*cell_h
        draw.text((x,y+5),name,font=note,fill="#f2f7fc")
        canvas.paste(masked,(x+(cell_w-24-masked.width)//2,y+33))
    canvas.save(out/"roi_preview.jpg",quality=92)


def summarize(rows):
    frames = len(rows)
    count = sum(row["gt_roi"] for row in rows)
    hits = sum(row["tp"] for row in rows)
    predictions = sum(row["pred"] for row in rows)
    abs_error = sum(row["absolute_error"] for row in rows)
    return {
        "images":frames, "gt_roi":count, "pred":predictions, "tp":hits,
        "unmatched":predictions-hits, "missed":count-hits, "mae":abs_error/frames,
        "bias":sum(row["signed_error"] for row in rows)/frames,
        "precision":hits/predictions if predictions else 0.0, "recall":hits/count if count else None,
        "small_gt":sum(row["small_gt"] for row in rows), "small_tp":sum(row["small_tp"] for row in rows),
    }


def run(args):
    bench = bench_module()
    previous = bench.load_fusion().load_previous()
    helper = previous.load_helpers()
    protocol, split, old = fixed_inputs(args.project.resolve(strict=True),args.probe.resolve(strict=True),
                                         args.holdout.resolve(strict=True),previous,helper)
    out = args.output.resolve()
    out.mkdir(parents=True,exist_ok=False)
    manifest = out/"protocol.json"
    helper.save_json(manifest,protocol)

    def event(message):
        line = f"{datetime.now(timezone.utc).isoformat()} PID={os.getpid()} {message}"
        print(line,flush=True)
        with (out/"run.log").open("a",encoding="utf-8") as log:
            log.write(line+"\n")

    import cv2
    import numpy as np

    model = previous.configure_model(protocol)
    samples = protocol["samples"]
    loaded = [helper.load_item(split,row,cv2,np) for row in samples]
    raws = [item[0] for item in loaded]
    polygons, crops, bounds, preview = [], [], [], {}
    for row,raw in zip(samples,raws):
        height,width = raw.shape[:2]
        polygon = np.asarray(STATION_POLYGONS[row["source_recording"]],np.float32) * np.array([width,height],np.float32)
        bound = crop_bounds(polygon,width,height)
        x0,y0,x1,y1 = bound
        polygons.append(polygon)
        crops.append(raw[y0:y1,x0:x1])
        bounds.append(bound)
        preview.setdefault(row["source_recording"],(raw,polygon))
    make_preview(preview,out)
    data = {}
    for name,images,options in (
        ("full640",raws,protocol["inference"]), ("full960",raws,protocol["inference_960"]),
        ("roi640",crops,protocol["inference"]),
    ):
        predictions = bench.full_predict(images,model,options)
        if len(predictions)!=len(samples):
            raise ValueError("Missing station inference result")
        data[name] = predictions
        event(f"{name} inferred {len(predictions)}/{len(samples)}")
    results = []
    for i,(row,(_,truth,_),polygon,bound) in enumerate(zip(samples,loaded,polygons,bounds)):
        uid = row["image_sha256"]
        inside = in_roi(truth,polygon,cv2,np)
        scoped_truth = truth[inside]
        norm = 640/max(raws[i].shape[:2])
        small = np.min(scoped_truth[:, 2:]-scoped_truth[:, :2],axis=1)*norm < 8
        for mode in METHODS:
            boxes, confidence = data[mode][i]
            if mode=="roi640":
                boxes = to_full_frame(boxes,bound,np)
            else:
                historic = old[uid,"base" if mode=="full640" else "size960"]
                actual = (len(boxes),int(helper.match_targets(boxes,confidence,truth,np).sum()))
                if actual != historic:
                    raise ValueError(f"Full-image historical mismatch for {uid}: {actual} != {historic}")
            scoped = in_roi(boxes,polygon,cv2,np)
            selected, scores = boxes[scoped],confidence[scoped]
            if not np.isfinite(selected).all() or not np.isfinite(scores).all():
                raise ValueError("Non-finite ROI prediction")
            matched = helper.match_targets(selected,scores,scoped_truth,np)
            tp, pred = int(matched.sum()), len(selected)
            delta = pred-len(scoped_truth)
            results.append({
                "source":row["source_recording"], "image_sha256":uid, "image_path":row["image_path"],
                "method":mode, "gt_full":len(truth), "gt_roi":len(scoped_truth), "pred":pred,
                "tp":tp, "unmatched":pred-tp, "missed":len(scoped_truth)-tp,
                "signed_error":delta, "absolute_error":abs(delta),
                "small_gt":int(small.sum()), "small_tp":int((small & matched).sum()),
                "crop_xyxy":",".join(map(str,bound)),
                "crop_scale_gain":max(raws[i].shape[:2])/max(crops[i].shape[:2]),
            })
    frame_file = out/"frame_metrics.csv"
    helper.save_csv(frame_file,results)
    groups = {
        mode:summarize([r for r in results if r["method"]==mode]) for mode in METHODS
    }
    per_site = {
        name: {mode:summarize([r for r in results if r["method"]==mode and r["source"]==name])
               for mode in METHODS} for name in STATION_POLYGONS
    }
    baseline_rows = [r for r in results if r["method"]=="full640"]
    total = sum(row["gt_full"] for row in baseline_rows)
    within = groups["full640"]["gt_roi"]
    helper.save_json(out/"summary.json", {
        "status":"complete", "gt_full":total, "gt_roi":within, "coverage":within/total,
        "metrics":groups, "by_recording":per_site,
        "protocol_sha256":helper.sha(manifest), "frame_metrics_sha256":helper.sha(frame_file),
    })
    event(f"complete images={len(samples)} truth_roi={within}/{total}")


if __name__=="__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project",type=Path)
    parser.add_argument("probe",type=Path)
    parser.add_argument("holdout",type=Path)
    parser.add_argument("output",type=Path)
    run(parser.parse_args())
