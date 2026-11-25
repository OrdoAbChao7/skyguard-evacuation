"""Check tiling and dark-frame contrast on the already exposed diagnostic images."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
from collections import defaultdict

SOURCE=Path(__file__).resolve()


def helpers():
    spec=importlib.util.spec_from_file_location("scene_probe",SOURCE.with_name("scene_probe.py"))
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(args):
    p=helpers()
    directory=args.probe.resolve(strict=True)
    project=args.project.resolve(strict=True)
    split=(project/"splits/head-count-v2").resolve(strict=True)
    receipt=p.read_json(project/"experiments/head-count-v2/round2-v1/training_receipt.json")
    configuration=p.read_json(directory/"probe_config.json")
    weights=Path(receipt["weight"]).resolve(strict=True)
    if p.sha(weights)!=configuration["models_sha256"]["round2"]:
        raise ValueError("Weight drift before focused probe")
    samples_file=directory/"selected_samples.csv"
    frame_file=directory/"frame_metrics.csv"
    if p.sha(samples_file)!=configuration["selection_sha256"] or p.sha(frame_file)!=p.read_json(directory/"summary.json")["frame_metrics_sha256"]:
        raise ValueError("Initial diagnostic files changed")
    samples=[r for r in p.read_csv(samples_file) if r["group"] in {"C","F"}]
    existing={r["sha256"]:r for r in p.read_csv(frame_file) if r["model"]=="round2" and r["setting"]=="base"}
    os.environ.update({"TORCH_FORCE_WEIGHTS_ONLY_LOAD":"1","ULTRALYTICS_SAFE_LOAD":"true","YOLO_AUTOINSTALL":"false",
                       "YOLO_OFFLINE":"true","YOLO_CONFIG_DIR":str(Path(sys.prefix)/"ultralytics-config")})
    import cv2
    import numpy as np
    import torch
    from torchvision.ops import nms
    from ultralytics import YOLO
    from ultralytics.nn.tasks import _SafeLoad
    from ultralytics.utils import SAFE_LOAD
    if not SAFE_LOAD or not _SafeLoad.SUPPORTED or not torch.cuda.is_available():
        raise RuntimeError("Expected restricted local CUDA")
    model=YOLO(str(weights),task="detect")
    opts=configuration["settings"]["base"]
    clahe=cv2.createCLAHE(clipLimit=2.0,tileGridSize=(8,8))
    frames=[]
    for row in samples:
        raw,gt,_=p.load_item(split,row,cv2,np)
        h,w=raw.shape[:2]
        ch,cw=round(h*.60),round(w*.60)
        xy=[(0,0),(w-cw,0),(0,h-ch),(w-cw,h-ch)]
        tiles=[raw[y:y+ch,x:x+cw] for x,y in xy]
        ranges=model.predict(source=tiles,**opts)
        rects=[]
        scores=[]
        for (x,y),piece in zip(xy,ranges):
            rects.append(piece.boxes.xyxy.cpu()+torch.tensor([x,y,x,y],dtype=torch.float32))
            scores.append(piece.boxes.conf.cpu())
        all_boxes=torch.cat(rects)
        all_scores=torch.cat(scores)
        keep=nms(all_boxes,all_scores,0.5)
        variants=[("tiles",all_boxes[keep].numpy(),all_scores[keep].numpy())]
        if row["group"]=="F":
            yuv=cv2.cvtColor(raw,cv2.COLOR_BGR2YCrCb)
            yuv[:,:,0]=clahe.apply(yuv[:,:,0])
            boosted=cv2.cvtColor(yuv,cv2.COLOR_YCrCb2BGR)
            value=model.predict(source=[boosted],**opts)[0].boxes
            variants.append(("clahe",value.xyxy.cpu().numpy(),value.conf.cpu().numpy()))
        n=int(row["count"])
        regular=existing[row["image_sha256"]]
        for kind,boxes,conf in variants:
            matched=p.match_targets(boxes,conf,gt,np) if gt is not None else None
            frames.append({"group":row["group"],"variant":kind,"sha256":row["image_sha256"],"gt":n,
                           "base":int(regular["pred"]),"after":len(boxes),"before_abs_error":int(regular["absolute_error"]),
                           "after_abs_error":abs(len(boxes)-n),"after_signed_error":len(boxes)-n,
                           "before_tp50":int(regular["tp50"]) if matched is not None else None,
                           "after_tp50":int(matched.sum()) if matched is not None else None})
    by=defaultdict(list)
    for r in frames:
        by[r["group"],r["variant"]].append(r)
    review=[]
    for (group,kind),rows in by.items():
        n=len(rows)
        review.append({"group":group,"setting":kind,"frames":n,"gt_mean":sum(r["gt"] for r in rows)/n,
                       "before_mean":sum(r["base"] for r in rows)/n,"after_mean":sum(r["after"] for r in rows)/n,
                       "before_mae":sum(r["before_abs_error"] for r in rows)/n,
                       "after_mae":sum(r["after_abs_error"] for r in rows)/n,
                       "before_tp50":sum(r["before_tp50"] for r in rows) if group=="C" else None,
                       "after_tp50":sum(r["after_tp50"] for r in rows) if group=="C" else None})
    p.save_csv(directory/"dense_probe_frames.csv",frames)
    p.save_json(directory/"dense_probe_summary.json",{
        "scope":"Same diagnostic images, no new test images or checkpoint updates",
        "model":"round2","weight_sha256":p.sha(weights),"tiles":"2 x 2, crop 60% of each original dimension, full-view NMS IoU 0.50",
        "clahe":"Y channel, clipLimit=2.0, tileGridSize=8x8",
        "rows_sha256":p.sha(directory/"dense_probe_frames.csv"),"groups":review,
    })
    print(json.dumps(review),flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project",type=Path)
    parser.add_argument("probe",type=Path)
    main(parser.parse_args())
