"""Run the original head detector on the frozen Cchead development manifest."""

import argparse
from collections import Counter
import csv
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import time


WEIGHT_SHA = "1467b10e30a05be6a05950190e5efe30b50681270cb7baf6115ec96806b25964"
SETTINGS = {
    "imgsz": 640, "conf": 0.25, "iou": 0.50, "max_det": 1000, "batch": 8,
    "device": "0", "quantize": 32, "rect": False, "augment": False, "verbose": False, "save": False,
}
SOURCE = Path(__file__).resolve()
GUARD = SOURCE.parent.parent / "data_prep" / "partition_head_count_v2.py"


def checksum(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def checked_source(root, field, row):
    relative = PurePosixPath(row[field + "_path"])
    path = root.joinpath(*relative.parts).resolve(strict=True)
    if relative.is_absolute() or ".." in relative.parts or not path.is_relative_to(root):
        raise ValueError(f"Development file escaped its root: {path}")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != row[field + "_sha256"]:
        raise ValueError(f"Development file changed after split freeze: {path}")
    return data


def load_split(split):
    guard = subprocess.run(
        [sys.executable, "-E", "-s", "-B", str(GUARD), "check-fit", str(split), "1"],
        check=True, capture_output=True, text=True, encoding="utf-8",
    )
    val = Path(json.loads(guard.stdout)["validation"])
    if val != (split / "development" / "validation.csv").resolve(strict=True):
        raise ValueError(f"Unexpected validation manifest: {val}")
    with val.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    if {(r["dataset"], r["source_recording"]) for r in rows} != {("Cchead", "schoolpath_test")}:
        raise ValueError("Baseline only accepts the Cchead development sequence")
    if Counter(r["group"] for r in rows) != {"A":1561,"B":3911}:
        raise ValueError("Development counts differ from the approved split")
    rows.sort(key=lambda r: int(Path(r["image_path"]).stem))
    proto = split / "split_protocol.json"
    root_path = json.loads(proto.read_text(encoding="utf-8"))["development_raw_roots"]["Cchead"]
    return rows, val, Path(root_path).resolve(strict=True), proto


def load_item(root, row, cv2, np):
    image = cv2.imdecode(np.frombuffer(checked_source(root, "image", row), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.shape != (1080,1920,3):
        raise ValueError(f"Unexpected validation frame decode: {row['image_path']}")
    label = checked_source(root, "label", row).decode("utf-8-sig")
    gt = []
    height, width = image.shape[:2]
    for line in label.splitlines():
        fields = line.split()
        if not fields:
            continue
        cls, _, cx, cy, w, h = fields
        x,y,bw,bh = map(float, (cx,cy,w,h))
        if cls != "0":
            raise ValueError(f"Unexpected validation class ID: {cls}")
        gt.append((max(0,x-bw/2)*width, max(0,y-bh/2)*height,
                   min(1,x+bw/2)*width, min(1,y+bh/2)*height))
    if len(gt) != int(row["count"]):
        raise ValueError(f"Validation head count drift: {row['label_path']}")
    return image, np.asarray(gt, dtype=np.float32).reshape(-1,4)


def count_matches(pred, scores, truth, np):
    if not len(pred) or not len(truth):
        return 0
    overlap = np.maximum(np.minimum(pred[:, None, 2:], truth[None, :, 2:]) -
                         np.maximum(pred[:, None, :2], truth[None, :, :2]), 0).prod(axis=2)
    areas = np.maximum(pred[:,2:]-pred[:,:2],0).prod(axis=1)
    truth_areas = np.maximum(truth[:,2:]-truth[:,:2],0).prod(axis=1)
    iou = overlap / np.maximum(areas[:,None]+truth_areas[None,:]-overlap, 1e-9)
    used = np.zeros(len(truth),dtype=bool)
    hits = 0
    for index in np.argsort(-scores, kind="stable"):
        available = np.where(used, -1, iou[index])
        best = int(available.argmax())
        if available[best] >= 0.5:
            used[best] = True
            hits += 1
    return hits


def summarize(records, np):
    groups = {}
    for group in ("A","B","all"):
        here = [r for r in records if group == "all" or r["group"] == group]
        signed = np.array([r["signed_error"] for r in here],dtype=np.float64)
        tp = sum(r["tp50"] for r in here)
        fp = sum(r["fp50"] for r in here)
        fn = sum(r["fn50"] for r in here)
        true = sum(r["gt"] for r in here)
        groups[group] = {
            "samples": len(here), "gt_total": true, "pred_total": sum(r["pred"] for r in here),
            "mae": float(np.abs(signed).mean()), "mean_signed_error": float(signed.mean()),
            "rmse": float(np.sqrt(np.square(signed).mean())),
            "wape": float(np.abs(signed).sum()/true),
            "exact_count_rate": float((signed==0).mean()),
            "p90_absolute_error": float(np.quantile(np.abs(signed),0.9)),
            "tp50": tp, "fp50": fp, "fn50": fn, "precision50": tp/(tp+fp) if tp+fp else None,
            "recall50": tp/(tp+fn) if tp+fn else None,
        }
    return groups


def atomic_json(path, value):
    temp = path.with_suffix(".json.part")
    temp.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+"\n",encoding="utf-8")
    temp.replace(path)


def checkpoints(path, selected):
    if not path.exists():
        return []
    parsed = []
    with path.open("r+b") as f:
        while True:
            line_start = f.tell()
            line = f.readline()
            if not line:
                break
            if not line.endswith(b"\n"):
                f.truncate(line_start)
                break
            batch = json.loads(line)
            if not isinstance(batch, list) or not batch:
                raise ValueError("Invalid checkpoint batch")
            parsed.extend(batch)
    if [x["sha256"] for x in parsed] != [x["image_sha256"] for x in selected[:len(parsed)]]:
        raise ValueError("Checkpoint rows do not match the frozen sequence")
    return parsed


def execute(args):
    split = args.split.resolve(strict=True)
    weights = args.weights.resolve(strict=True)
    if checksum(weights) != WEIGHT_SHA:
        raise ValueError("Baseline requires the original approved v8s-head.pt")
    selected, val, root, protocol = load_split(split)
    if args.smoke:
        selected = sorted(
            [r for g in ("A","B") for r in [x for x in selected if x["group"] == g][::250][:8]],
            key=lambda r: int(Path(r["image_path"]).stem),
        )
    os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
    os.environ["ULTRALYTICS_SAFE_LOAD"] = "true"
    os.environ["YOLO_AUTOINSTALL"] = "false"
    os.environ["YOLO_OFFLINE"] = "true"
    os.environ["YOLO_CONFIG_DIR"] = str(Path(sys.prefix)/"ultralytics-config")

    import cv2
    import numpy as np
    import torch
    import ultralytics
    from ultralytics import YOLO
    from ultralytics.nn.tasks import _SafeLoad
    from ultralytics.utils import SAFE_LOAD

    if not SAFE_LOAD or not _SafeLoad.SUPPORTED:
        raise RuntimeError("The restricted checkpoint loader is required")
    if not torch.cuda.is_available():
        raise RuntimeError("The frozen baseline requires CUDA")
    torch.manual_seed(20261123)
    torch.backends.cudnn.benchmark = False

    run = args.output
    run.mkdir(parents=True, exist_ok=True)
    spec = {
        "run_mode": "smoke" if args.smoke else "full", "role": "same-camera-development",
        "split": split.as_posix(), "split_protocol_sha256": checksum(protocol),
        "validation_manifest_sha256": checksum(val), "model_sha256": WEIGHT_SHA, "script_sha256": checksum(SOURCE),
        "guard_sha256": checksum(GUARD), "samples": len(selected), "sample_groups": dict(Counter(r["group"] for r in selected)),
        "python": sys.version.split()[0], "ultralytics": ultralytics.__version__, "torch": torch.__version__,
        "opencv": cv2.__version__, "gpu": torch.cuda.get_device_name(0),
        "seed": 20261123, "match_iou": 0.5, "settings": SETTINGS,
    }
    contract = run / "run_protocol.json"
    if contract.exists():
        if json.loads(contract.read_text(encoding="utf-8")) != spec:
            raise ValueError("Existing run protocol differs; use a new run directory")
    else:
        atomic_json(contract,spec)
    journal = run / "checkpoint.jsonl"
    records = checkpoints(journal,selected)
    prior = len(records)
    print(f"Baseline {spec['run_mode']}: {len(selected)} frames, {prior} already measured, PID {os.getpid()}",flush=True)
    model = YOLO(str(weights),task="detect")
    if len(model.names) != 1:
        raise ValueError("Unexpected model class count")
    started = time.monotonic()
    logged = started
    with journal.open("ab") as checkpoint:
        for offset in range(prior,len(selected),SETTINGS["batch"]):
            batch = selected[offset:offset+SETTINGS["batch"]]
            loaded = [load_item(root,r,cv2,np) for r in batch]
            results = model.predict(source=[item[0] for item in loaded],**SETTINGS)
            if len(results) != len(batch):
                raise ValueError("Inference returned the wrong number of frames")
            finished = []
            for row, (_,gt), result in zip(batch,loaded,results):
                boxes = result.boxes
                xyxy = boxes.xyxy.cpu().numpy()
                conf = boxes.conf.cpu().numpy()
                if len(boxes) and (not np.isfinite(xyxy).all() or not np.isfinite(conf).all()):
                    raise ValueError(f"Non-finite detection values: {row['image_path']}")
                hits = count_matches(xyxy,conf,gt,np)
                error = len(boxes)-len(gt)
                finished.append({
                    "frame": int(Path(row["image_path"]).stem), "group": row["group"],
                    "image_path": row["image_path"], "sha256": row["image_sha256"],
                    "gt": len(gt), "pred": len(boxes), "signed_error": error,
                    "absolute_error": abs(error), "tp50": hits, "fp50": len(boxes)-hits, "fn50": len(gt)-hits,
                    "inference_ms": float(result.speed["inference"]),
                })
            record = (json.dumps(finished,allow_nan=False)+"\n").encode("utf-8")
            checkpoint.write(record)
            checkpoint.flush()
            os.fsync(checkpoint.fileno())
            records.extend(finished)
            now=time.monotonic()
            done=len(records)
            if done==len(selected) or done%256==0 or now-logged>=30:
                rate=(done-prior)/max(now-started,0.01)
                print(f"{done}/{len(selected)} frames; {rate:.1f} frames/s; ETA {(len(selected)-done)/rate:.0f}s",flush=True)
                logged=now

    if len(records)!=len(selected):
        raise ValueError("Baseline count differs from manifest")
    csv_path=run/"frame_metrics.csv"
    temporary=csv_path.with_suffix(".csv.part")
    with temporary.open("w",encoding="utf-8-sig",newline="") as f:
        writer=csv.DictWriter(f,fieldnames=list(records[0]))
        writer.writeheader()
        writer.writerows(records)
    temporary.replace(csv_path)
    summary={
        "status":"complete","role":spec["role"],"mode":spec["run_mode"],"protocol_sha256":checksum(contract),
        "frame_metrics_sha256":checksum(csv_path),"groups":summarize(records,np),
        "median_model_inference_ms":float(np.median([r["inference_ms"] for r in records])),
    }
    atomic_json(run/"summary.json",summary)
    print(json.dumps(summary,ensure_ascii=False),flush=True)


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    for option in ("split","weights","output"):
        parser.add_argument(option,type=Path)
    parser.add_argument("--smoke",action="store_true")
    execute(parser.parse_args())
