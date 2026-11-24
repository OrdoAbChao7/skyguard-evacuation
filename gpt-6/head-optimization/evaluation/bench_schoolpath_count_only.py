"""Measure sustained count delivery without rendering or video encoding."""

import argparse
import csv
from datetime import datetime, timezone
import importlib.util
import os
from pathlib import Path
import time

SOURCE = Path(__file__).resolve()
VIDEO = SOURCE.with_name("run_schoolpath_video.py")


def load_video():
    spec = importlib.util.spec_from_file_location("schoolpath_video", VIDEO)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(directory):
    video = load_video()
    bench = video.load_bench()
    previous = bench.load_fusion().load_previous()
    helper = previous.load_helpers()
    out = directory.resolve(strict=True)
    pfile = out/"protocol.json"
    encoded_file = out/"summary.json"
    encoded_csv = out/"frame_counts.csv"
    cfg = helper.read_json(pfile)
    encoded = helper.read_json(encoded_file)
    if (encoded["status"]!="complete" or helper.sha(pfile)!=encoded["protocol_sha256"]
            or helper.sha(encoded_csv)!=encoded["csv_sha256"]
            or any(helper.sha(Path(p))!=v for p,v in cfg["hashes"].items())):
        raise ValueError("The completed video run and its fixed inputs must be unchanged")
    reference = {int(row["frame"]):int(row["estimated_heads"]) for row in helper.read_csv(encoded_csv)}
    if set(reference)!=set(range(cfg["frame_count"])):
        raise ValueError("Expected the same 750 source frames as the annotated video")
    plan = {
        "scope":"Same data, model and single-image inference as parent. JPEG read to count CSV output only.",
        "parent_protocol_sha256":helper.sha(pfile), "parent_summary_sha256":helper.sha(encoded_file),
        "runner_sha256":helper.sha(SOURCE), "frame_count":cfg["frame_count"],
        "inference":cfg["inference"], "warmup_frames":cfg["warmup_frames_per_process"],
    }
    receipt = out/"count_only_protocol.json"
    if receipt.exists():
        raise ValueError("A count-only timing run already exists")
    helper.save_json(receipt,plan)

    def event(message):
        line=f"{datetime.now(timezone.utc).isoformat()} PID={os.getpid()} {message}"
        print(line,flush=True)
        with (out/"count_only.log").open("a",encoding="utf-8") as log:
            log.write(line+"\n")

    import cv2
    import numpy as np

    for i,item in enumerate(cfg["input_frames"]):
        f=Path(cfg["root"])/item["path"]
        if not f.resolve(strict=True).is_relative_to(Path(cfg["source"])) or helper.sha(f)!=item["sha256"]:
            raise ValueError(f"Unexpected bytes in source frame {i}")
    event(f"verified {cfg['frame_count']} input frames")
    started=time.perf_counter()
    model=previous.configure_model(cfg)
    import torch

    loaded=time.perf_counter()
    for i in range(plan["warmup_frames"]):
        bench.full_predict([video.image_at(cfg,i,cv2,np)],model,cfg["inference"])
    torch.cuda.synchronize()
    warmed=time.perf_counter()
    tmp=out/"count_only_frames.partial.csv"
    fields=("frame","source_time_s","estimated_heads","decode_ms","inference_ms","count_ready_ms")
    samples=[]
    changed=[]
    begin=time.perf_counter()
    with tmp.open("x",encoding="utf-8-sig",newline="") as out_csv:
        writer=csv.DictWriter(out_csv,fieldnames=fields)
        writer.writeheader()
        for i in range(cfg["frame_count"]):
            a=time.perf_counter()
            frame=video.image_at(cfg,i,cv2,np)
            b=time.perf_counter()
            values=bench.full_predict([frame],model,cfg["inference"])
            if len(values)!=1 or not np.isfinite(values[0][0]).all():
                raise ValueError(f"Invalid predictions for frame {i}")
            torch.cuda.synchronize()
            c=time.perf_counter()
            count=len(values[0][0])
            row={
                "frame":i,"source_time_s":round(video.frame_time(i,cfg["fps"]),6),"estimated_heads":count,
                "decode_ms":round((b-a)*1000,6),"inference_ms":round((c-b)*1000,6),
                "count_ready_ms":round((c-a)*1000,6),
            }
            writer.writerow(row)
            samples.append(row)
            if count!=reference[i]:
                changed.append({"frame":i,"video":reference[i],"count_only":count})
            if (i+1)%150==0:
                rate=(i+1)/(time.perf_counter()-begin)
                out_csv.flush()
                event(f"frame={i+1}/{cfg['frame_count']} sustained_fps={rate:.2f} eta_s={(cfg['frame_count']-i-1)/rate:.2f}")
    elapsed=time.perf_counter()-begin
    final=out/"count_only_frames.csv"
    tmp.replace(final)
    helper.save_json(out/"count_only_summary.json",{
        "status":"complete","frames":len(samples),"seconds":elapsed,"sustained_fps":len(samples)/elapsed,
        "metrics":{key:video.timing_stats([row[key] for row in samples],np) for key in fields[3:]},
        "frames_with_different_counts":changed,"startup":{"load_s":loaded-started,"warmup_s":warmed-loaded},
        "csv_sha256":helper.sha(final), "protocol_sha256":helper.sha(receipt),
    })
    event(f"complete seconds={elapsed:.3f}, fps={len(samples)/elapsed:.2f}, changed_counts={len(changed)}")


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory",type=Path)
    run(parser.parse_args().directory)
