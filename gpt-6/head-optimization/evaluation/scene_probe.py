"""Run a small six-group count diagnostic and two inference-only probes."""

import argparse
from collections import defaultdict, Counter
import csv
import hashlib
import json
import os
from pathlib import Path
import sys

CAPS={"A":8,"B":24,"C":16,"D":6,"E":12,"F":16}
NAMES=("base","size960","conf015")


def sha(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f,"sha256").hexdigest()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_csv(path):
    with path.open(encoding="utf-8-sig",newline="") as f:
        return list(csv.DictReader(f))


def save_csv(path,rows):
    part=path.with_suffix(".csv.part")
    with part.open("w",encoding="utf-8-sig",newline="") as f:
        writer=csv.DictWriter(f,fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    part.replace(path)


def save_json(path,value):
    part=path.with_suffix(".json.part")
    part.write_text(json.dumps(value,indent=2,allow_nan=False)+"\n",encoding="utf-8")
    part.replace(path)


def frame_key(row):
    name=Path(row["image_path"]).stem
    return int(name.rsplit("_",1)[-1]) if row["dataset"]!="RGBT-CC" else int(name.split("_")[0])


def choose(split):
    proto=read_json(split/"split_protocol.json")
    chosen=[]
    for group,cap in CAPS.items():
        record=proto["test_groups"][group]
        manifest=split/record["manifest"]
        if sha(manifest)!=record["sha256"]:
            raise ValueError(f"Changed split manifest {manifest}")
        rows=[r for r in read_csv(manifest) if r["status"]==("pending_license" if group=="F" else "ready")]
        if group=="F" and any(r["dataset"]!="RGBT-CC" or r["light"]!="dark" or r["label_type"]!="person_point" for r in rows):
            raise ValueError("F must be the RGB dark count-only cohort")
        if group=="B":
            rows=sorted((r for r in rows if frame_key(r)<=850),key=frame_key)
        else:
            rows.sort(key=lambda r:(int(r["count"]),r["source_recording"],frame_key(r)))
        if len(rows)<cap:
            raise ValueError(f"Too few diagnostic candidates for {group}")
        for i in range(cap):
            row=dict(rows[i*(len(rows)-1)//(cap-1)])
            row["diagnostic_role"]="exposed_probe_only"
            chosen.append(row)
    if len({r["image_sha256"] for r in chosen})!=sum(CAPS.values()):
        raise ValueError("Repeated sample in diagnostic subset")
    return chosen


def checked(split,relative,digest):
    target=(split/relative).resolve(strict=True)
    if not target.is_relative_to(split/"test") or sha(target)!=digest:
        raise ValueError(f"Diagnostic bytes escaped their manifest: {target}")
    return target


def load_item(split,row,cv2,np):
    image=checked(split,row["test_image"],row["image_sha256"])
    label=checked(split,row["test_label"],row["label_sha256"])
    raw=cv2.imdecode(np.frombuffer(image.read_bytes(),np.uint8),cv2.IMREAD_COLOR)
    if raw is None:
        raise ValueError(f"Undecodable diagnostic image: {image}")
    height,width=raw.shape[:2]
    if row["label_type"]=="person_point":
        count=len(read_json(label)["points"])
        boxes=None
        small=None
    else:
        boxes=[]
        for line in label.read_text(encoding="utf-8-sig").splitlines():
            if not line.strip():
                continue
            fields=line.split()
            expected=6 if row["label_type"]=="head_box_with_track_id" else 5
            if len(fields)!=expected or float(fields[0])!=0:
                raise ValueError(f"Unexpected box schema in {label}")
            cx,cy,w,h=map(float,fields[-4:])
            boxes.append((max(0,cx-w/2)*width,max(0,cy-h/2)*height,
                          min(1,cx+w/2)*width,min(1,cy+h/2)*height))
        boxes=np.asarray(boxes,dtype=np.float32).reshape(-1,4)
        count=len(boxes)
        small=np.min(boxes[:,2:]-boxes[:,:2],axis=1)*(640/max(height,width))<8
    if count!=int(row["count"]):
        raise ValueError(f"Diagnostic ground-truth count differs: {label}")
    return raw,boxes,small


def match_targets(pred,conf,gt,np):
    matched=np.zeros(len(gt),dtype=bool)
    if not len(pred) or not len(gt):
        return matched
    inter=np.maximum(np.minimum(pred[:,None,2:],gt[None,:,2:])-np.maximum(pred[:,None,:2],gt[None,:,:2]),0).prod(axis=2)
    pred_area=np.maximum(pred[:,2:]-pred[:,:2],0).prod(axis=1)
    gt_area=np.maximum(gt[:,2:]-gt[:,:2],0).prod(axis=1)
    iou=inter/np.maximum(pred_area[:,None]+gt_area[None,:]-inter,1e-9)
    for idx in np.argsort(-conf,kind="stable"):
        scores=np.where(matched,-1,iou[idx])
        j=int(scores.argmax())
        if scores[j]>=0.5:
            matched[j]=True
    return matched


def rollup(rows):
    buckets=defaultdict(list)
    for r in rows:
        buckets[(r["model"],r["setting"],r["group"])].append(r)
    groups=[]
    for (model,setting,group),bucket in buckets.items():
        n=len(bucket)
        rec={"model":model,"setting":setting,"group":group,"frames":n,
             "mae":sum(r["absolute_error"] for r in bucket)/n,
             "bias":sum(r["signed_error"] for r in bucket)/n,
             "wape":sum(r["absolute_error"] for r in bucket)/sum(r["gt"] for r in bucket)}
        if bucket[0]["tp50"] is not None:
            total={k:sum(r[k] for r in bucket) for k in ("tp50","fp50","fn50","small_gt","small_tp","other_gt","other_tp")}
            rec.update(total)
            rec["recall50"]=total["tp50"]/(total["tp50"]+total["fn50"])
            rec["precision50"]=total["tp50"]/(total["tp50"]+total["fp50"]) if total["tp50"]+total["fp50"] else None
            for size in ("small","other"):
                rec[size+"_recall50"]=total[size+"_tp"]/total[size+"_gt"] if total[size+"_gt"] else None
        groups.append(rec)
    return groups


def execute(args):
    root=args.project.resolve(strict=True)
    split=(root/"splits/head-count-v2").resolve(strict=True)
    experiments=root/"experiments/head-count-v2"
    ref=root/"evaluations/head-count-v2/baseline-v1/run_protocol.json"
    baseline=read_json(ref)
    paths={"original":args.original.resolve(strict=True)}
    expected={"original":baseline["model_sha256"]}
    for number in (1,2):
        folder=experiments/f"round{number}-v1"
        receipt=read_json(folder/"training_receipt.json")
        model=f"round{number}"
        weights=(folder/"trained/weights/last.pt").resolve(strict=True)
        if receipt["status"]!="complete" or Path(receipt["weight"]).resolve()!=weights:
            raise ValueError("Unrecognized experiment receipt")
        paths[model]=weights
        expected[model]=receipt["weight_sha256"]
    if any(sha(path)!=expected[model] for model,path in paths.items()):
        raise ValueError("An evaluated checkpoint differs from its receipt")
    sample=choose(split)
    settings={key:dict(baseline["settings"]) for key in NAMES}
    settings["size960"]["imgsz"]=960
    settings["conf015"]["conf"]=0.15
    out=args.output.resolve()
    out.mkdir(parents=True,exist_ok=False)
    save_csv(out/"selected_samples.csv",sample)
    save_json(out/"probe_config.json",{
        "stage":"exploratory, not a final or training result","selection":CAPS,
        "street": "frame number at most 850; evenly spaced within this window",
        "other_sampling": "even count quantiles among eligible images, including endpoints",
        "models_sha256":expected,"settings":settings,"split_sha256":sha(split/"split_protocol.json"),
        "selection_sha256":sha(out/"selected_samples.csv"), "implementation_sha256":sha(Path(__file__)),
        "F_scope":"local RGB dark count-only research probe; formal license status unchanged",
    })

    os.environ.update({
        "TORCH_FORCE_WEIGHTS_ONLY_LOAD":"1","ULTRALYTICS_SAFE_LOAD":"true","YOLO_AUTOINSTALL":"false",
        "YOLO_OFFLINE":"true","YOLO_CONFIG_DIR":str(Path(sys.prefix)/"ultralytics-config"),
    })
    import cv2
    import numpy as np
    import torch
    import ultralytics
    from ultralytics import YOLO
    from ultralytics.utils import SAFE_LOAD
    from ultralytics.nn.tasks import _SafeLoad
    if not SAFE_LOAD or not _SafeLoad.SUPPORTED or not torch.cuda.is_available():
        raise RuntimeError("The safe CUDA loader is required")
    if (ultralytics.__version__,torch.__version__)!=(baseline["ultralytics"],baseline["torch"]):
        raise ValueError("Expected baseline evaluator runtime")
    torch.manual_seed(baseline["seed"])
    torch.backends.cudnn.benchmark=False
    result=[]
    for name,weight in paths.items():
        model=YOLO(str(weight),task="detect")
        for kind in ("base",) if name=="original" else NAMES:
            opts=dict(settings[kind])
            step=opts["batch"]
            before=len(result)
            for offset in range(0,len(sample),step):
                batch=sample[offset:offset+step]
                loaded=[load_item(split,r,cv2,np) for r in batch]
                pred=model.predict(source=[v[0] for v in loaded],**opts)
                if len(pred)!=len(batch):
                    raise ValueError("A diagnostic batch returned the wrong frame count")
                for row,(_,gt,small),chosen in zip(batch,loaded,pred):
                    boxes=chosen.boxes
                    coords=boxes.xyxy.cpu().numpy()
                    scores=boxes.conf.cpu().numpy()
                    if not np.isfinite(coords).all() or not np.isfinite(scores).all():
                        raise ValueError("Non-finite predictions")
                    target=int(row["count"])
                    err=len(boxes)-target
                    if gt is None:
                        tp=fp=fn=n_small=tp_small=n_other=tp_other=None
                    else:
                        matched=match_targets(coords,scores,gt,np)
                        tp=int(matched.sum())
                        fp=len(boxes)-tp
                        fn=target-tp
                        n_small=int(small.sum())
                        tp_small=int((small&matched).sum())
                        n_other=target-n_small
                        tp_other=tp-tp_small
                    result.append({
                        "model":name,"setting":kind,"group":row["group"],"dataset":row["dataset"],"sha256":row["image_sha256"],
                        "image_path":row["image_path"],"gt":target,"pred":len(boxes),"signed_error":err,"absolute_error":abs(err),
                        "tp50":tp,"fp50":fp,"fn50":fn,"small_gt":n_small,"small_tp":tp_small,
                        "other_gt":n_other,"other_tp":tp_other,
                    })
                if offset%24==0 or len(result)-before==len(sample):
                    print(f"{name}/{kind}: {len(result)-before}/{len(sample)}",flush=True)
            save_csv(out/"frame_metrics.csv",result)
        del model
    groups=rollup(result)
    save_json(out/"summary.json",{
        "status":"complete","cohort":CAPS,"frame_rows":len(result),
        "configuration_sha256":sha(out/"probe_config.json"),"frame_metrics_sha256":sha(out/"frame_metrics.csv"),
        "groups":groups,
    })
    print(f"Complete: {len(sample)} unique images, {len(result)} predictions",flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ("project","original","output"):
        parser.add_argument(name,type=Path)
    execute(parser.parse_args())
