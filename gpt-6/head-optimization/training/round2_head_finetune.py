"""Train the Cchead + RPEE run with the same batch and update budget as round 1."""

import argparse
from collections import Counter
import csv
import importlib.util
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import time

SCRIPT=Path(__file__).resolve()
FIRST=SCRIPT.with_name("round1_head_finetune.py")


def common_helpers():
    spec=importlib.util.spec_from_file_location("round1_head_finetune",FIRST)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def open_roles(first,split):
    if first.sha_path(split/"split_protocol.json")!=first.SPLIT_SHA:
        raise ValueError("Expected the frozen head-count-v2 split")
    proc=subprocess.run(
        [sys.executable,"-E","-s","-B",str(first.GUARD),"check-fit",str(split),"2"],
        check=True,capture_output=True,text=True,encoding="utf-8",
    )
    manifests={key:Path(path) for key,path in json.loads(proc.stdout).items()}
    if {key:path.name for key,path in manifests.items()}!={"train":"train_round2.csv","validation":"validation.csv"}:
        raise ValueError("Wrong development role files")
    roles={key:first.read_rows(path) for key,path in manifests.items()}
    train=roles["train"]
    cchead=[r for r in train if r["dataset"]=="Cchead"]
    rpee=[r for r in train if r["dataset"]=="RPEE-Heads"]
    if len(train)!=4719 or len(cchead)!=4003 or len(rpee)!=716 or len(roles["validation"])!=5472:
        raise ValueError("Unexpected approved cohort size")
    if {r["source_recording"] for r in cchead}!={"schoolpath_train"} or {r["site"] for r in rpee}!={"rpee_mitsubishi_hall"}:
        raise ValueError("Unexpected training source")
    if {(r["dataset"],r["source_recording"]) for r in roles["validation"]}!={("Cchead","schoolpath_test")}:
        raise ValueError("Unexpected validation source")
    meta=read_json(split/"split_protocol.json")
    roots={name:Path(path).resolve(strict=True) for name,path in meta["development_raw_roots"].items()}
    if set(roots)!={"Cchead","RPEE-Heads"}:
        raise ValueError("Training may only resolve the two approved development roots")
    return manifests,roles,roots


def sample_plan(train,quotas,seed):
    shuffled={}
    for n,(name,amount) in enumerate(quotas.items()):
        ids=sorted(r["image_sha256"][:24] for r in train if r["dataset"]==name)
        random.Random(seed+n).shuffle(ids)
        if not 0<amount<=len(ids) or 2*(len(ids)-amount)>len(ids):
            raise ValueError(f"Cannot cover {name} across two equal-budget passes")
        shuffled[name]=ids
    plan=[]
    for epoch in range(2):
        kept=[]
        for name,amount in quotas.items():
            ids=shuffled[name]
            excluded=len(ids)-amount
            start=epoch*excluded
            kept.extend(ids[:start]+ids[start+excluded:])
        random.Random(seed+10+epoch).shuffle(kept)
        plan.append(kept)
    existing={r["image_sha256"][:24] for r in train}
    if set(plan[0]+plan[1])!=existing or any(len(rows)!=sum(quotas.values()) or len(set(rows))!=len(rows) for rows in plan):
        raise ValueError("The rotated plan fails unique-source coverage")
    return plan


def normalized_label(first,data,row):
    if row["dataset"]=="RPEE-Heads":
        lines=[]
        for line in data.decode("utf-8-sig").splitlines():
            if line.strip():
                cls,x,y,w,h=line.split()
                lines.append(f"{cls} 0 {x} {y} {w} {h}")
        data="\n".join(lines).encode("utf-8")
    return first.convert_label(data,row)


def materialize(first,output,roles,roots):
    final=output/"data"
    yaml=final/"dataset.yaml"
    if final.exists():
        saved=first.read_rows(final/"materials.csv")
        expected=[(role,r["dataset"],r["image_sha256"],int(r["count"]))
                  for role in ("train","validation") for r in roles[role]]
        actual=[(r["role"],r["dataset"],r["image_sha256"],int(r["count"])) for r in saved]
        if expected!=actual or read_json(yaml)!=first.yaml_data(final):
            raise ValueError("Materialized data cannot be resumed with this protocol")
        for item in saved:
            for key in ("image","label"):
                if first.sha_path(final/item[key+"_path"])!=item[key+"_sha256"]:
                    raise ValueError("Materialized data changed")
        return yaml

    stage=Path(tempfile.mkdtemp(prefix=".data-staging-",dir=output))
    entries=[]
    total=sum(len(rows) for rows in roles.values())
    for role,folder in (("train","train"),("validation","val")):
        (stage/"images"/folder).mkdir(parents=True)
        (stage/"labels"/folder).mkdir(parents=True)
        for row in roles[role]:
            stem=row["image_sha256"][:24]
            imp=f"images/{folder}/{stem}.jpg"
            lab=f"labels/{folder}/{stem}.txt"
            raw=roots[row["dataset"]]
            image=first.verified_bytes(raw,row,"image")
            text=normalized_label(first,first.verified_bytes(raw,row,"label"),row)
            for rel,data in ((imp,image),(lab,text)):
                with (stage/rel).open("xb") as f:
                    f.write(data)
            entries.append({
                "role":role,"dataset":row["dataset"],"image_path":imp,"label_path":lab,
                "image_sha256":row["image_sha256"],"label_sha256":first.sha_bytes(text),"count":row["count"],
            })
            if len(entries)%1000==0 or len(entries)==total:
                print(f"Staged {len(entries)}/{total} verified image and label pairs",flush=True)
    with (stage/"materials.csv").open("w",newline="",encoding="utf-8") as f:
        writer=csv.DictWriter(f,fieldnames=list(entries[0]))
        writer.writeheader()
        writer.writerows(entries)
    (stage/"dataset.yaml").write_text(json.dumps(first.yaml_data(final),indent=2)+"\n",encoding="utf-8")
    stage.rename(final)
    return yaml


def execute(args):
    first=common_helpers()
    split=args.split.resolve(strict=True)
    source=args.weights.resolve(strict=True)
    ref=args.round1.resolve(strict=True)
    original_result=read_json(ref/"training_receipt.json")
    original_protocol=read_json(ref/"train_protocol.json")
    sha=first.sha_path
    if (sha(source)!=first.BASE_SHA or original_result["source"]!=first.BASE_SHA
        or original_result["train_protocol_sha256"]!=sha(ref/"train_protocol.json")
        or original_result["completed_epochs"]!=2 or original_result["ema_optimizer_updates"]!=1063
        or original_protocol["script_sha256"]!=sha(FIRST)):
        raise ValueError("Round 1 comparison evidence changed")
    conf=dict(original_protocol["training"])
    manifests,roles,roots=open_roles(first,split)
    quotas={"Cchead":3396,"RPEE-Heads":607}
    if args.smoke:
        conf["workers"]=0
        core=[r for r in roles["train"] if r["dataset"]=="Cchead"]
        extra=[r for r in roles["train"] if r["dataset"]=="RPEE-Heads"]
        roles={"train":first.select_smoke(core)+extra[::120][:6],"validation":first.select_smoke(roles["validation"])}
        quotas={"Cchead":12,"RPEE-Heads":4}
    plan=sample_plan(roles["train"],quotas,conf["seed"])
    out=args.output.resolve()
    out.mkdir(parents=True,exist_ok=True)
    os.environ.update({
        "TORCH_FORCE_WEIGHTS_ONLY_LOAD":"1","ULTRALYTICS_SAFE_LOAD":"true","YOLO_AUTOINSTALL":"false",
        "YOLO_OFFLINE":"true","YOLO_CONFIG_DIR":str(Path(sys.prefix)/"ultralytics-config"),
    })
    import torch
    import ultralytics
    from ultralytics import YOLO
    from ultralytics.data.build import InfiniteDataLoader, seed_worker
    from ultralytics.models.yolo.detect.train import DetectionTrainer
    from ultralytics.nn.tasks import _SafeLoad, torch_safe_load
    from ultralytics.utils import SAFE_LOAD, SETTINGS

    if not SAFE_LOAD or not _SafeLoad.SUPPORTED or not torch.cuda.is_available():
        raise RuntimeError("The restricted CUDA training runtime is required")
    if (torch.__version__,ultralytics.__version__,torch.cuda.get_device_name(0))!=(original_protocol["torch"],original_protocol["ultralytics"],original_protocol["gpu"]):
        raise ValueError("The runtime differs from round 1")
    for name in ("tensorboard","mlflow","wandb","clearml","comet","neptune","hub","raytune"):
        if name in SETTINGS:
            SETTINGS[name]=False

    class EpochSampler(torch.utils.data.Sampler):
        def __init__(self,membership):
            self.sequence=membership
            self.epoch=0

        def __len__(self):
            return len(self.sequence[0])

        def __iter__(self):
            yield from self.sequence[self.epoch]

    class BudgetTrainer(DetectionTrainer):
        def get_dataloader(self,dataset_path,batch_size=16,rank=0,mode="train"):
            if mode!="train":
                return super().get_dataloader(dataset_path,batch_size,rank,mode)
            if rank!=-1:
                raise ValueError("The recorded budget is for a single GPU")
            dataset=self.build_dataset(dataset_path,mode,batch_size)
            by_stem={Path(p).stem:i for i,p in enumerate(dataset.im_files)}
            if len(by_stem)!=len(roles["train"]) or set(by_stem)!=set(plan[0]+plan[1]):
                raise ValueError("Loader membership differs from the full mixed pool")
            sampler=EpochSampler([[by_stem[stem] for stem in ep] for ep in plan])
            generator=torch.Generator().manual_seed((6148914691236517204+torch.initial_seed())%(1<<64))
            workers=self.args.workers
            return InfiniteDataLoader(dataset=dataset,batch_size=batch_size,sampler=sampler,num_workers=workers,
                                      prefetch_factor=4 if workers else None,pin_memory=True,
                                      collate_fn=dataset.collate_fn,worker_init_fn=seed_worker,generator=generator)

        def preprocess_batch(self,batch):
            stems=[Path(name).stem for name in batch["im_file"]]
            pos=len(self.epoch_seen)
            if stems!=plan[self.epoch][pos:pos+len(stems)]:
                raise ValueError("Actual training batch diverged from the frozen epoch")
            self.epoch_seen.extend(stems)
            return super().preprocess_batch(batch)

        def final_eval(self):
            print("Epoch checkpoint retained; the frozen count benchmark handles final validation.",flush=True)

    spec={
        "stage":"round2-cchead-rpee","mode":"smoke" if args.smoke else "full",
        "split_protocol_sha256":first.SPLIT_SHA,"initial_weight_sha256":first.BASE_SHA,
        "round1_receipt_sha256":sha(ref/"training_receipt.json"),
        "script_sha256":sha(SCRIPT),"helpers_sha256":sha(FIRST),"guard_sha256":sha(first.GUARD),
        "manifest_hashes":{key:sha(path) for key,path in manifests.items()},
        "counts":{key:len(v) for key,v in roles.items()},"quota_per_epoch":quotas,
        "total_draws":sum(map(len,plan)),"expected_updates":None if args.smoke else original_result["ema_optimizer_updates"],
        "epoch_order_sha256":first.sha_bytes(json.dumps(plan).encode("utf-8")),
        "python":sys.version.split()[0],"torch":torch.__version__,"ultralytics":ultralytics.__version__,
        "gpu":torch.cuda.get_device_name(0),"training":conf,"comparison_checkpoint":"last epoch EMA without model selection",
    }
    control=out/"train_protocol.json"
    if control.exists() and read_json(control)!=spec:
        raise ValueError("Existing run protocol differs")
    first.write_json(control,spec)
    first.write_json(out/"epoch_plan.json",plan)
    print(f"Round 2 {spec['mode']} PID {os.getpid()}; {sum(quotas.values())} train images per epoch, quotas={quotas}",flush=True)
    dataset=materialize(first,out,roles,roots)
    last=out/"trained/weights/last.pt"
    if (out/"training_receipt.json").exists():
        raise ValueError("Already completed")
    if args.resume != last.exists():
        raise ValueError("Existing epoch checkpoint and explicit resume must agree")
    if args.resume:
        ckpt,_=torch_safe_load(str(last),safe_only=True)
        if ckpt.get("optimizer") is None or not 0<=int(ckpt["epoch"])<1 or Path(ckpt["train_args"]["data"]).resolve()!=dataset.resolve():
            raise ValueError("Invalid resume checkpoint")
    model=YOLO(str(last if args.resume else source),task="detect")
    timer={"batch":0,"started":0.0}

    def epoch_start(trainer):
        timer.update(batch=0,started=time.monotonic())
        trainer.epoch_seen=[]
        trainer.train_loader.sampler.epoch=trainer.epoch
        trainer.train_loader.reset()
        if len(trainer.train_loader)!=(sum(quotas.values())+conf["batch"]-1)//conf["batch"]:
            raise ValueError("Batch budget differs from round 1")
        print(f"Epoch {trainer.epoch+1}/2 started ({len(trainer.train_loader)} batches)",flush=True)

    def batch_end(trainer):
        timer["batch"]+=1
        n=timer["batch"]
        total=len(trainer.train_loader)
        if n%100==0 or n==total:
            rate=n/max(time.monotonic()-timer["started"],0.01)
            losses={key:float(value) for key,value in trainer.tloss.items()}
            print(f"Epoch {trainer.epoch+1}/2 {n}/{total} batches; {rate:.2f} batches/s; "
                  f"ETA {(total-n)/rate:.0f}s; loss={losses}",flush=True)

    def epoch_end(trainer):
        actual=trainer.epoch_seen
        if actual!=plan[trainer.epoch]:
            raise ValueError("Actual epoch exposure is incomplete")
        first.write_json(out/f"epoch{trainer.epoch+1}_exposure.json",{
            "images":len(actual),"batches":len(trainer.train_loader),
            "image_order_sha256":first.sha_bytes(json.dumps(actual).encode("utf-8")),
        })

    model.add_callback("on_train_epoch_start",epoch_start)
    model.add_callback("on_train_batch_end",batch_end)
    model.add_callback("on_train_epoch_end",epoch_end)
    if args.resume:
        model.train(trainer=BudgetTrainer,resume=True)
    else:
        model.train(trainer=BudgetTrainer,data=str(dataset),project=str(out),name="trained",exist_ok=True,**conf)
    checkpoint,_=torch_safe_load(str(last),safe_only=True)
    updates=int(checkpoint["updates"])
    if int(checkpoint["epoch"])!=1 or checkpoint.get("ema") is None:
        raise ValueError("The trained last checkpoint has no final EMA")
    if not args.smoke and updates!=spec["expected_updates"]:
        raise ValueError(f"Actual optimizer budget {updates}, expected {spec['expected_updates']}")
    receipt={
        "status":"complete","train_protocol_sha256":sha(control),"weight":last.as_posix(),"weight_sha256":sha(last),
        "completed_epochs":2,"ema_optimizer_updates":updates,"source":first.BASE_SHA,
        "data_yaml_sha256":sha(dataset),"materials_sha256":sha(dataset.parent/"materials.csv"),
    }
    first.write_json(out/"training_receipt.json",receipt)
    print(json.dumps(receipt),flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ("split","weights","round1","output"):
        parser.add_argument(name,type=Path)
    parser.add_argument("--smoke",action="store_true")
    parser.add_argument("--resume",action="store_true")
    execute(parser.parse_args())
