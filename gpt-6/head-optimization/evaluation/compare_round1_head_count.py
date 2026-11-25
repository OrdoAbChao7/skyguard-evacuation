"""Compare the last round-one checkpoint against the frozen original baseline."""

import argparse
import csv
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

SOURCE = Path(__file__).resolve()
BASELINE = SOURCE.with_name("head_count_baseline.py")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def baseline_helpers():
    spec=importlib.util.spec_from_file_location("head_count_baseline",BASELINE)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def paired_metrics(csv_path):
    with csv_path.open(encoding="utf-8-sig",newline="") as f:
        return {row["sha256"]:row for row in csv.DictReader(f)}


def compare(args):
    baseline=baseline_helpers()
    trained=args.trained.resolve(strict=True)
    ref=args.baseline.resolve(strict=True)
    split=args.split.resolve(strict=True)
    receipt_file=trained/"training_receipt.json"
    receipt=read_json(receipt_file)
    reference=read_json(ref/"run_protocol.json")
    ref_summary=read_json(ref/"summary.json")
    weights=(trained/"trained/weights/last.pt").resolve(strict=True)
    sha=baseline.checksum
    if receipt["status"]!="complete" or receipt["completed_epochs"]!=2 or Path(receipt["weight"]).resolve()!=weights:
        raise ValueError("Expected the completed last checkpoint from round 1")
    if (sha(weights)!=receipt["weight_sha256"] or receipt["source"]!=baseline.WEIGHT_SHA
        or sha(trained/"train_protocol.json")!=receipt["train_protocol_sha256"]):
        raise ValueError("Round 1 training evidence changed")
    selected,val,root,split_protocol=baseline.load_split(split)
    if (reference["samples"]!=len(selected) or reference["run_mode"]!="full"
        or reference["validation_manifest_sha256"]!=sha(val) or reference["split_protocol_sha256"]!=sha(split_protocol)
        or reference["settings"]!=baseline.SETTINGS or reference["model_sha256"]!=baseline.WEIGHT_SHA
        or reference["script_sha256"]!=sha(BASELINE) or reference["match_iou"]!=0.5
        or ref_summary["protocol_sha256"]!=sha(ref/"run_protocol.json")
        or ref_summary["frame_metrics_sha256"]!=sha(ref/"frame_metrics.csv")):
        raise ValueError("Reference baseline fails the identical-protocol check")
    before=paired_metrics(ref/"frame_metrics.csv")
    if set(before)!={r["image_sha256"] for r in selected}:
        raise ValueError("Reference baseline and validation membership differ")

    os.environ.update({
        "TORCH_FORCE_WEIGHTS_ONLY_LOAD":"1", "ULTRALYTICS_SAFE_LOAD":"true",
        "YOLO_AUTOINSTALL":"false", "YOLO_OFFLINE":"true",
        "YOLO_CONFIG_DIR":str(Path(sys.prefix)/"ultralytics-config"),
    })
    import cv2
    import numpy as np
    import torch
    import ultralytics
    from ultralytics import YOLO
    from ultralytics.nn.tasks import _SafeLoad
    from ultralytics.utils import SAFE_LOAD
    if not SAFE_LOAD or not _SafeLoad.SUPPORTED or not torch.cuda.is_available():
        raise RuntimeError("The restricted CUDA evaluator is required")
    if (ultralytics.__version__!=reference["ultralytics"] or torch.__version__!=reference["torch"]
        or cv2.__version__!=reference["opencv"] or torch.cuda.get_device_name(0)!=reference["gpu"]):
        raise ValueError("Round 1 and original baseline runtimes differ")
    torch.manual_seed(reference["seed"])
    torch.backends.cudnn.benchmark=False
    out=trained/"paired_evaluation"
    out.mkdir(exist_ok=True)
    protocol={
        "scope":"same-camera development, no sealed test",
        "config":reference["settings"],"match_iou":reference["match_iou"],
        "baseline_protocol_sha256":sha(ref/"run_protocol.json"),"baseline_results_sha256":sha(ref/"frame_metrics.csv"),
        "training_receipt_sha256":sha(receipt_file),"new_weights_sha256":sha(weights),
        "validation_sha256":sha(val),"split_protocol_sha256":sha(split_protocol),
        "evaluation_script_sha256":sha(SOURCE),"baseline_helpers_sha256":sha(BASELINE),"samples":len(selected),
    }
    contract=out/"run_protocol.json"
    if contract.exists() and read_json(contract)!=protocol:
        raise ValueError("Existing evaluation contract differs")
    baseline.atomic_json(contract,protocol)
    journal=out/"checkpoint.jsonl"
    results=baseline.checkpoints(journal,selected)
    prior=len(results)
    print(f"Round 1 comparison PID {os.getpid()}: {prior}/{len(selected)} measured",flush=True)
    model=YOLO(str(weights),task="detect")
    if len(model.names)!=1:
        raise ValueError("Expected one head class")
    started=time.monotonic()
    last=started
    settings=protocol["config"]
    with journal.open("ab") as checkpoint:
        for offset in range(prior,len(selected),settings["batch"]):
            batch=selected[offset:offset+settings["batch"]]
            loaded=[baseline.load_item(root,row,cv2,np) for row in batch]
            detections=model.predict(source=[item[0] for item in loaded],**settings)
            if len(detections)!=len(batch):
                raise ValueError("Wrong number of inference frames")
            done=[]
            for row,(_,gt),result in zip(batch,loaded,detections):
                old=before[row["image_sha256"]]
                if int(old["gt"])!=len(gt) or old["group"]!=row["group"]:
                    raise ValueError("Reference image labels differ")
                boxes=result.boxes
                xy=boxes.xyxy.cpu().numpy()
                scores=boxes.conf.cpu().numpy()
                if not np.isfinite(xy).all() or not np.isfinite(scores).all():
                    raise ValueError("Non-finite predictions")
                hits=baseline.count_matches(xy,scores,gt,np)
                error=len(boxes)-len(gt)
                done.append({
                    "frame":old["frame"],"group":row["group"],"image_path":row["image_path"],"sha256":row["image_sha256"],
                    "gt":len(gt),"pred":len(boxes),"signed_error":error,"absolute_error":abs(error),
                    "tp50":hits,"fp50":len(boxes)-hits,"fn50":len(gt)-hits,
                    "baseline_pred":int(old["pred"]),"baseline_absolute_error":int(old["absolute_error"]),
                    "absolute_error_reduction":int(old["absolute_error"])-abs(error),
                    "inference_ms":float(result.speed["inference"]),
                })
            checkpoint.write((json.dumps(done,allow_nan=False)+"\n").encode("utf-8"))
            checkpoint.flush()
            os.fsync(checkpoint.fileno())
            results.extend(done)
            now=time.monotonic()
            n=len(results)
            if n==len(selected) or n%256==0 or now-last>=30:
                rate=(n-prior)/max(now-started,0.01)
                print(f"{n}/{len(selected)} frames, {rate:.1f} frames/s, ETA {(len(selected)-n)/rate:.0f}s",flush=True)
                last=now
    if len(results)!=len(selected):
        raise ValueError("Evaluation is incomplete")
    csv_file=out/"frame_metrics.csv"
    tmp=csv_file.with_suffix(".csv.part")
    with tmp.open("w",encoding="utf-8-sig",newline="") as stream:
        writer=csv.DictWriter(stream,fieldnames=list(results[0]))
        writer.writeheader()
        writer.writerows(results)
    tmp.replace(csv_file)
    after=baseline.summarize(results,np)
    comparison={}
    for group,new in after.items():
        old=ref_summary["groups"][group]
        subset=[r for r in results if group=="all" or r["group"]==group]
        comparison[group]={
            "before":old,"after":new,"mae_reduction":old["mae"]-new["mae"],
            "mae_reduction_rate":(old["mae"]-new["mae"])/old["mae"],
            "improved_frames":sum(r["absolute_error_reduction"]>0 for r in subset),
            "tied_frames":sum(r["absolute_error_reduction"]==0 for r in subset),
            "worse_frames":sum(r["absolute_error_reduction"]<0 for r in subset),
        }
    result={"status":"complete","protocol_sha256":sha(contract),"frame_metrics_sha256":sha(csv_file),"comparison":comparison}
    baseline.atomic_json(out/"summary.json",result)
    print(json.dumps(result,ensure_ascii=False),flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ("split","trained","baseline"):
        parser.add_argument(name,type=Path)
    compare(parser.parse_args())
