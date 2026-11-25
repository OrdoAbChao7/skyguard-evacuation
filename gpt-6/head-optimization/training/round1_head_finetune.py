"""Prepare and train Cchead round 1 from the frozen development-only split."""

import argparse
from collections import Counter
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

BASE_SHA = "1467b10e30a05be6a05950190e5efe30b50681270cb7baf6115ec96806b25964"
SPLIT_SHA = "60554f0fb86b25af20fedba0b4cedc84f0032f7f107cd2723681300ed3259ec6"
SCRIPT = Path(__file__).resolve()
GUARD = SCRIPT.parent.parent / "data_prep" / "partition_head_count_v2.py"
PARAMS = {
    "epochs": 2, "batch": 4, "imgsz": 640, "device": "0", "workers": 2,
    "optimizer": "AdamW", "lr0": 0.001, "lrf": 0.1, "nbs": 8, "warmup_epochs": 0.25,
    "amp": False, "seed": 20261123, "deterministic": True, "cache": False,
    "mosaic": 0.0, "close_mosaic": 0, "mixup": 0.0,
    "scale": 0.20, "translate": 0.05, "fliplr": 0.5,
    "save": True, "save_period": 1, "plots": False, "val": False,
    "max_det": 1000, "verbose": False,
}


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha_path(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(".json.part")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_rows(path):
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def open_guarded_split(split):
    if sha_path(split / "split_protocol.json") != SPLIT_SHA:
        raise ValueError("Expected the approved head-count-v2 split")
    result = subprocess.run(
        [sys.executable, "-E", "-s", "-B", str(GUARD), "check-fit", str(split), "1"],
        check=True, capture_output=True, text=True, encoding="utf-8",
    )
    manifests = {k: Path(v) for k,v in json.loads(result.stdout).items()}
    if set(manifests) != {"train","validation"}:
        raise ValueError("Unexpected fit entry output")
    if any(v.parent != split / "development" for v in manifests.values()):
        raise ValueError("Fit role escaped the development directory")
    meta=json.loads((split / "split_protocol.json").read_text(encoding="utf-8"))
    roles = {k: read_rows(v) for k,v in manifests.items()}
    for key, expected in (("train",("schoolpath_train",4003)), ("validation",("schoolpath_test",5472))):
        rows=roles[key]
        if len(rows)!=expected[1] or {(r["dataset"],r["source_recording"]) for r in rows}!={("Cchead",expected[0])}:
            raise ValueError(f"Unexpected {key} membership")
    roots=meta["development_raw_roots"]
    return manifests, roles, Path(roots["Cchead"]).resolve(strict=True)


def select_smoke(rows):
    result=[]
    for group in ("A","B"):
        eligible=sorted((r for r in rows if r["group"]==group),key=lambda r:int(Path(r["image_path"]).stem))
        for n in range(8):
            result.append(eligible[n*len(eligible)//8])
    return result


def verified_bytes(root, row, kind):
    path=(root / row[kind+"_path"]).resolve(strict=True)
    if not path.is_relative_to(root):
        raise ValueError(f"Source outside the Cchead root: {path}")
    data=path.read_bytes()
    if sha_bytes(data)!=row[kind+"_sha256"]:
        raise ValueError(f"Source file differs from the locked split: {path}")
    return data


def convert_label(data, row):
    output=[]
    for line in data.decode("utf-8-sig").splitlines():
        if not line.strip():
            continue
        cls,track,*coords=line.split()
        x,y,w,h=map(float,coords)
        if cls!="0" or int(track)<0 or not all(map(math.isfinite,(x,y,w,h))) or not (0<=x<=1 and 0<=y<=1 and 0<w<=1 and 0<h<=1):
            raise ValueError(f"Malformed candidate label: {row['label_path']}")
        lo_x,lo_y=max(0,x-w/2),max(0,y-h/2)
        hi_x,hi_y=min(1,x+w/2),min(1,y+h/2)
        if not (lo_x<hi_x and lo_y<hi_y):
            raise ValueError(f"Degenerate converted box: {row['label_path']}")
        box=((lo_x+hi_x)/2,(lo_y+hi_y)/2,hi_x-lo_x,hi_y-lo_y)
        output.append("0 "+" ".join(format(v,".12g") for v in box))
    if len(output)!=int(row["count"]) or len(set(output))!=len(output):
        raise ValueError(f"Conversion changed box count: {row['label_path']}")
    return ("\n".join(output)+"\n").encode("utf-8")


def stage_dataset(run, roles, root):
    target=run/"data"
    dyaml=target/"dataset.yaml"
    if target.exists():
        with (target/"materials.csv").open(encoding="utf-8",newline="") as f:
            have=list(csv.DictReader(f))
        expected=[(key,row["image_sha256"],int(row["count"])) for key in ("train","validation") for row in roles[key]]
        actual=[(row["role"],row["image_sha256"],int(row["count"])) for row in have]
        if expected!=actual:
            raise ValueError("Existing staged identities differ from approved manifests")
        for row in have:
            for kind in ("image","label"):
                if sha_path(target/row[kind+"_path"])!=row[kind+"_sha256"]:
                    raise ValueError("Existing materialized input changed")
        if json.loads(dyaml.read_text(encoding="utf-8"))!=yaml_data(target):
            raise ValueError("Existing dataset YAML differs")
        return dyaml
    stage=Path(tempfile.mkdtemp(prefix=".data-staging-",dir=run))
    rows=[]
    total=sum(map(len,roles.values()))
    for role in ("train","validation"):
        folder="train" if role=="train" else "val"
        for row in roles[role]:
            stem=row["image_sha256"][:24]
            image=f"images/{folder}/{stem}.jpg"
            label=f"labels/{folder}/{stem}.txt"
            pixels=verified_bytes(root,row,"image")
            label_bytes=convert_label(verified_bytes(root,row,"label"),row)
            for name,data in ((image,pixels),(label,label_bytes)):
                target_file=stage/name
                target_file.parent.mkdir(exist_ok=True,parents=True)
                with target_file.open("xb") as stream:
                    stream.write(data)
            rows.append({"role":role,"image_path":image,"label_path":label,"image_sha256":row["image_sha256"],
                         "label_sha256":sha_bytes(label_bytes),"count":row["count"]})
            if len(rows)%1000==0 or len(rows)==total:
                print(f"Staged {len(rows)}/{total} image and label pairs",flush=True)
    with (stage/"materials.csv").open("w",encoding="utf-8",newline="") as stream:
        writer=csv.DictWriter(stream,fieldnames=rows[0])
        writer.writeheader()
        writer.writerows(rows)
    (stage/"dataset.yaml").write_text(json.dumps(yaml_data(target),indent=2)+"\n",encoding="utf-8")
    stage.rename(target)
    return dyaml


def yaml_data(target):
    return {"path":target.as_posix(),"train":"images/train","val":"images/val","names":{"0":"head"}}


def train(args):
    split=args.split.resolve(strict=True)
    weights=args.weights.resolve(strict=True)
    if sha_path(weights)!=BASE_SHA:
        raise ValueError("Round 1 requires the approved original checkpoint")
    sources, roles, raw=open_guarded_split(split)
    if args.smoke:
        roles={role:select_smoke(rows) for role,rows in roles.items()}
    run=args.output.resolve()
    run.mkdir(parents=True,exist_ok=True)
    for name,value in {
        "TORCH_FORCE_WEIGHTS_ONLY_LOAD":"1","ULTRALYTICS_SAFE_LOAD":"true","YOLO_AUTOINSTALL":"false",
        "YOLO_OFFLINE":"true","YOLO_CONFIG_DIR":str(Path(sys.prefix)/"ultralytics-config"),
    }.items():
        os.environ[name]=value
    import torch
    import ultralytics
    from ultralytics import YOLO
    from ultralytics.models.yolo.detect.train import DetectionTrainer
    from ultralytics.nn.tasks import _SafeLoad, torch_safe_load
    from ultralytics.utils import SAFE_LOAD, SETTINGS
    if not SAFE_LOAD or not _SafeLoad.SUPPORTED or not torch.cuda.is_available():
        raise RuntimeError("This training requires CUDA and the restricted checkpoint loader")
    for extra in ("tensorboard","mlflow","wandb","clearml","comet","neptune","hub","raytune"):
        if extra in SETTINGS:
            SETTINGS[extra]=False

    class Round1Trainer(DetectionTrainer):
        def final_eval(self):
            print("Epoch checkpoint retained; the frozen count benchmark handles final validation.",flush=True)

    conf=dict(PARAMS)
    if args.smoke:
        conf.update(epochs=1,workers=0)
    spec={
        "stage":"round1-cchead",
        "mode":"smoke" if args.smoke else "full",
        "split_protocol_sha256":SPLIT_SHA,"initial_weight_sha256":BASE_SHA,
        "manifest_hashes":{key:sha_path(path) for key,path in sources.items()},
        "counts":{key:len(v) for key,v in roles.items()},
        "group_counts":{key:dict(Counter(r["group"] for r in val)) for key,val in roles.items()},
        "script_sha256":sha_path(SCRIPT),"guard_sha256":sha_path(GUARD),
        "python":sys.version.split()[0],"torch":torch.__version__,"ultralytics":ultralytics.__version__,
        "gpu":torch.cuda.get_device_name(0),"training":conf,"comparison_checkpoint":"last epoch EMA without model selection",
    }
    contract=run/"train_protocol.json"
    if contract.exists():
        if json.loads(contract.read_text(encoding="utf-8"))!=spec:
            raise ValueError("The current train protocol differs; preserve its output directory")
    else:
        write_json(contract,spec)
    print(f"Round 1 {spec['mode']} PID {os.getpid()}, setting up the development-only files",flush=True)
    dataset=stage_dataset(run,roles,raw)
    if (run/"training_receipt.json").exists():
        raise ValueError("The run already has a completion receipt")
    model_dir=run/"trained"
    last=model_dir/"weights"/"last.pt"
    if last.exists() and not args.resume:
        raise ValueError("An epoch checkpoint exists; use explicit resume")
    if args.resume and not last.exists():
        raise ValueError("Resume requires a complete epoch checkpoint")
    source=last if args.resume else weights
    if args.resume:
        old,_=torch_safe_load(str(last),safe_only=True)
        if old.get("optimizer") is None or not 0<=int(old["epoch"])<conf["epochs"]-1:
            raise ValueError("The checkpoint does not contain a resumable epoch")
        if Path(old["train_args"]["data"]).resolve()!=dataset.resolve():
            raise ValueError("Resume checkpoint is bound to a different dataset")
    model=YOLO(str(source),task="detect")
    tick={"count":0,"time":0.0}

    def begin_epoch(trainer):
        tick.update(count=0,time=time.monotonic())
        print(f"Epoch {trainer.epoch+1}/{conf['epochs']} started",flush=True)

    def batch_end(trainer):
        tick["count"]+=1
        n=tick["count"]
        batches=len(trainer.train_loader)
        if n%100==0 or n==batches:
            elapsed=time.monotonic()-tick["time"]
            rate=n/max(elapsed,0.01)
            values={key:float(value) for key,value in trainer.tloss.items()}
            print(f"Epoch {trainer.epoch+1}/{conf['epochs']} {n}/{batches} batches; "
                  f"{rate:.2f} batches/s; ETA {(batches-n)/rate:.0f}s; loss={values}",flush=True)

    model.add_callback("on_train_epoch_start",begin_epoch)
    model.add_callback("on_train_batch_end",batch_end)
    if args.resume:
        model.train(trainer=Round1Trainer,resume=True)
    else:
        model.train(trainer=Round1Trainer,data=str(dataset),project=str(run),name="trained",exist_ok=True,**conf)
    if not last.is_file():
        raise ValueError("Training returned without the last epoch checkpoint")
    trained,_=torch_safe_load(str(last),safe_only=True)
    if int(trained["epoch"])!=conf["epochs"]-1 or trained.get("ema") is None:
        raise ValueError("Last checkpoint is missing a completed epoch or its EMA")
    receipt={
        "status":"complete","train_protocol_sha256":sha_path(contract),"weight":last.as_posix(),
        "weight_sha256":sha_path(last),"completed_epochs":conf["epochs"],
        "ema_optimizer_updates":int(trained["updates"]),"source":spec["initial_weight_sha256"],
        "data_yaml_sha256":sha_path(dataset),"materials_sha256":sha_path(dataset.parent/"materials.csv"),
    }
    write_json(run/"training_receipt.json",receipt)
    print(json.dumps(receipt),flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ("split","weights","output"):
        parser.add_argument(name,type=Path)
    parser.add_argument("--smoke",action="store_true")
    parser.add_argument("--resume",action="store_true")
    train(parser.parse_args())
