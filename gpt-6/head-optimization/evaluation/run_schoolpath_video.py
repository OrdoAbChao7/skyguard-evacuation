"""Time single-frame model two counting and annotated video export on a training clip."""

import argparse
import configparser
from datetime import datetime, timezone
from fractions import Fraction
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

SOURCE = Path(__file__).resolve()
BENCH = SOURCE.with_name("benchmark_b_paths.py")
FRAME_COUNT = 750
PART_SIZE = 150
WARMUP_FRAMES = 8
RELATIVE_SOURCE = Path("schoolpath_train/schoolpath")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def load_bench():
    spec = importlib.util.spec_from_file_location("b_benchmark", BENCH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def frame_time(number, fps):
    return number / fps


def part_ranges(count, block):
    return [(start,min(start+block,count)) for start in range(0,count,block)]


def timing_stats(values, np):
    return {
        "mean_ms":float(np.mean(values)), "p50_ms":float(np.median(values)),
        "p95_ms":float(np.percentile(values,95)), "max_ms":float(np.max(values)),
    }


def captured(command, timeout=45):
    return subprocess.run(command,check=True,capture_output=True,text=True,encoding="utf-8",
                          errors="replace",timeout=timeout,creationflags=NO_WINDOW).stdout


def make_protocol(args, bench, previous, helper):
    base = args.project.resolve(strict=True)
    cchead = args.cchead.resolve(strict=True)
    source = (cchead/"raw"/RELATIVE_SOURCE).resolve(strict=True)
    audit = cchead/"gpt-6/files_sha256.jsonl"
    seq_info = source/"seqinfo.ini"
    parser = configparser.ConfigParser()
    parser.read(seq_info,encoding="utf-8-sig")
    schema = parser["Sequence"]
    width,height,fps,frames = (int(schema[k]) for k in ("imWidth","imHeight","frameRate","seqLength"))
    if ((width,height,fps)!=(1920,1080,25) or schema["imDir"]!="img"
            or schema["imExt"]!=".jpg" or frames<FRAME_COUNT):
        raise ValueError("Unexpected train-source sequence metadata")
    exp = base/"evaluations/head-count-v2"
    receipt_path = base/"experiments/head-count-v2/round2-v1/training_receipt.json"
    cfg_path = exp/"scene-probe-v1/probe_config.json"
    baseline_path = exp/"baseline-v1/run_protocol.json"
    split_path = base/"splits/head-count-v2/split_protocol.json"
    receipt = helper.read_json(receipt_path)
    cfg = helper.read_json(cfg_path)
    baseline = helper.read_json(baseline_path)
    split = helper.read_json(split_path)
    weight = Path(receipt["weight"]).resolve(strict=True)
    if (receipt["status"]!="complete" or helper.sha(weight)!=cfg["models_sha256"]["round2"]
            or receipt["weight_sha256"]!=cfg["models_sha256"]["round2"]
            or helper.sha(audit)!=split["additional_sources"][str(audit)]):
        raise ValueError("Expected the frozen model two and Cchead source inventory")
    names = [(RELATIVE_SOURCE/"img"/f"{i}.jpg").as_posix() for i in range(FRAME_COUNT)]
    wanted = {*names, (RELATIVE_SOURCE/"seqinfo.ini").as_posix()}
    seen = {}
    with audit.open(encoding="utf-8-sig") as index:
        for line in index:
            row = json.loads(line)
            if row["path"] in wanted:
                if row["path"] in seen:
                    raise ValueError("Duplicated input index entry")
                seen[row["path"]] = row
    if seen.keys()!=wanted or helper.sha(seq_info)!=seen[(RELATIVE_SOURCE/"seqinfo.ini").as_posix()]["sha256"]:
        raise ValueError("The 750 expected input frames and sequence metadata must be in the inventory")
    ffmpeg, ffprobe = (str(Path(shutil.which(binary)).resolve(strict=True))
                       for binary in ("ffmpeg","ffprobe"))
    encoder = captured([ffmpeg,"-version"]).splitlines()[0]
    return {
        "scope":"Cchead schoolpath_train 0–749. Timing and video export, training-source engineering only.",
        "root":str(cchead/"raw"), "source":str(source), "width":width, "height":height, "fps":fps,
        "input_frames":[seen[name] for name in names], "frame_count":FRAME_COUNT,
        "parts":[list(p) for p in part_ranges(FRAME_COUNT,PART_SIZE)],
        "ffmpeg":ffmpeg, "ffprobe":ffprobe, "encoder_version":encoder,
        "encoding":{"codec":"libx264","preset":"ultrafast","crf":23,"pix_fmt":"yuv420p","threads":4},
        "weights":str(weight), "seed":baseline["seed"],
        "inference":{**cfg["settings"]["base"],"batch":1},
        "runtime":{key:baseline[key] for key in ("torch","ultralytics","opencv")},
        "warmup_frames_per_process":WARMUP_FRAMES,
        "hashes":{str(path):helper.sha(path) for path in
                 (SOURCE,BENCH,bench.FUSION,previous.SOURCE,previous.HELPER,
                  receipt_path,cfg_path,baseline_path,split_path,seq_info,audit,weight)},
    }


def image_at(protocol, index, cv2, np):
    candidate = Path(protocol["root"])/protocol["input_frames"][index]["path"]
    array = cv2.imdecode(np.frombuffer(candidate.read_bytes(),np.uint8),cv2.IMREAD_COLOR)
    wanted = (protocol["height"],protocol["width"],3)
    if array is None or array.shape!=wanted:
        raise ValueError(f"Malformed RGB frame at index {index}")
    return array


def validate_clip(path, frame_number, cfg, count_frames=False):
    fields = "stream=width,height,r_frame_rate,avg_frame_rate,codec_name,pix_fmt,nb_frames,nb_read_frames:format=duration"
    cmd = [cfg["ffprobe"],"-v","error","-select_streams","v:0"]
    if count_frames:
        cmd.append("-count_frames")
    cmd.extend(["-show_entries",fields,"-of","json",str(path)])
    meta = json.loads(captured(cmd))
    stream = meta["streams"][0]
    count_key = "nb_read_frames" if count_frames else "nb_frames"
    if (len(meta["streams"])!=1 or stream["codec_name"]!="h264" or stream["pix_fmt"]!="yuv420p"
            or stream["width"]!=cfg["width"] or stream["height"]!=cfg["height"]
            or Fraction(stream["avg_frame_rate"])!=cfg["fps"] or int(stream[count_key])!=frame_number
            or not math.isclose(float(meta["format"]["duration"]),frame_number/cfg["fps"],abs_tol=0.004)):
        raise ValueError(f"Invalid annotated H.264 export: {path}")
    return meta


def draw_boxes(raw, boxes, index, timestamp, cv2):
    height,width = raw.shape[:2]
    for x1,y1,x2,y2 in boxes:
        a = min(width-1,max(0,round(float(x1)))),min(height-1,max(0,round(float(y1))))
        b = min(width-1,max(0,round(float(x2)))),min(height-1,max(0,round(float(y2))))
        cv2.rectangle(raw,a,b,(116,238,126),2,cv2.LINE_AA)
    cv2.rectangle(raw,(18,18),(675,114),(21,30,40),-1)
    cv2.putText(raw,f"SkyGuard  |  Estimated heads: {len(boxes)}",(31,57),
                cv2.FONT_HERSHEY_SIMPLEX,1.03,(230,246,241),2,cv2.LINE_AA)
    cv2.putText(raw,f"Model 2 / 640   Frame {index:04d}   {timestamp:06.2f}s",(31,96),
                cv2.FONT_HERSHEY_SIMPLEX,0.66,(185,203,224),2,cv2.LINE_AA)


def encode_part(path, output_csv, bounds, cfg, model, bench, helper, event, cv2, np, torch):
    first,last = bounds
    media_tmp = path.with_name(path.stem+".partial.mp4")
    enc_log = path.with_suffix(".ffmpeg.log")
    tuning = cfg["encoding"]
    command = [
        cfg["ffmpeg"],"-hide_banner","-loglevel","error","-nostdin","-y",
        "-f","rawvideo","-pixel_format","bgr24","-video_size",f"{cfg['width']}x{cfg['height']}",
        "-framerate",str(cfg["fps"]),"-i","pipe:0","-an","-c:v",tuning["codec"],
        "-preset",tuning["preset"],"-crf",str(tuning["crf"]),"-threads",str(tuning["threads"]),
        "-pix_fmt",tuning["pix_fmt"],str(media_tmp),
    ]
    rows = []
    started = time.perf_counter()
    with enc_log.open("w",encoding="utf-8") as stderr:
        child = subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,
                                 stderr=stderr,creationflags=NO_WINDOW)
        try:
            for index in range(first,last):
                begin = time.perf_counter()
                raw = image_at(cfg,index,cv2,np)
                decoded = time.perf_counter()
                result = bench.full_predict([raw],model,cfg["inference"])
                if len(result)!=1 or not np.isfinite(result[0][0]).all():
                    raise ValueError(f"Bad detector response for frame {index}")
                boxes,_ = result[0]
                torch.cuda.synchronize()
                counted = time.perf_counter()
                pts = frame_time(index,cfg["fps"])
                draw_boxes(raw,boxes,index,pts,cv2)
                child.stdin.write(memoryview(raw).cast("B"))
                sent = time.perf_counter()
                rows.append({
                    "frame":index,"source_time_s":round(pts,6),"estimated_heads":len(boxes),
                    "decode_ms":round((decoded-begin)*1000,6),
                    "inference_ms":round((counted-decoded)*1000,6),
                    "count_ready_ms":round((counted-begin)*1000,6),
                    "overlay_submit_ms":round((sent-counted)*1000,6),
                    "loop_ms":round((sent-begin)*1000,6),
                })
                if (index+1)%50==0:
                    fps = len(rows)/max(time.perf_counter()-started,1e-9)
                    event(f"frame={index+1}/{cfg['frame_count']} fps_current_part={fps:.1f} eta_s={(cfg['frame_count']-index-1)/fps:.1f}")
            child.stdin.close()
            if child.wait(timeout=45)!=0:
                raise ValueError(f"FFmpeg failed, see {enc_log}")
        except BaseException:
            if child.poll() is None:
                child.kill()
            try:
                child.stdin.close()
            except OSError:
                pass
            child.wait(timeout=15)
            raise
    elapsed = time.perf_counter()-started
    validate_clip(media_tmp,last-first,cfg)
    media_tmp.replace(path)
    helper.save_csv(output_csv,rows)
    return {
        "first":first,"last_exclusive":last,"seconds":elapsed,"mp4":path.name,"csv":output_csv.name,
        "mp4_sha256":helper.sha(path),"csv_sha256":helper.sha(output_csv),
    }


def publish(out, cfg, state, helper, np):
    parts = out/"parts"
    ordered = [state["parts"][str(i)] for i in range(len(cfg["parts"]))]
    rows = [row for part in ordered for row in helper.read_csv(parts/part["csv"])]
    if [int(row["frame"]) for row in rows]!=list(range(cfg["frame_count"])):
        raise ValueError("Output frame rows are missing or duplicated")
    helper.save_csv(out/"frame_counts.csv",rows)
    playlist = parts/"concat.txt"
    playlist.write_text("".join(f"file '{row['mp4']}'\n" for row in ordered),encoding="ascii")
    tmp = out/"schoolpath_model2_640.partial.mp4"
    final = out/"schoolpath_model2_640.mp4"
    start = time.perf_counter()
    captured([cfg["ffmpeg"],"-hide_banner","-loglevel","error","-nostdin","-y",
              "-f","concat","-safe","1","-i",str(playlist),"-c","copy","-movflags","+faststart",str(tmp)])
    mux_seconds = time.perf_counter()-start
    meta = validate_clip(tmp,cfg["frame_count"],cfg,count_frames=True)
    tmp.replace(final)
    fields = ("decode_ms","inference_ms","count_ready_ms","overlay_submit_ms","loop_ms")
    metrics = {field:timing_stats([float(r[field]) for r in rows],np) for field in fields}
    total = sum(p["seconds"] for p in ordered)+mux_seconds
    all_counts = [int(row["estimated_heads"]) for row in rows]
    helper.save_json(out/"summary.json", {
        "status":"complete","frame_count":len(rows),"file_duration_s":float(meta["format"]["duration"]),
        "video":meta,"video_file":final.name,"video_sha256":helper.sha(final),
        "csv_sha256":helper.sha(out/"frame_counts.csv"),"metrics":metrics,
        "processing_seconds":total,"effective_fps":len(rows)/total,
        "count_fps_from_mean":1000/metrics["count_ready_ms"]["mean_ms"],
        "mux_seconds":mux_seconds, "count_min":min(all_counts),"count_max":max(all_counts),
        "startup":state["startup"],"scope":cfg["scope"],
        "count_timing_scope":"JPEG bytes read and decoded, model preprocessing/inference and returned count, CUDA synchronization.",
        "pipeline_timing_scope":"All part wall times with drawing, submission, H.264 flush and final mux. Excludes preflight, initial warm-up, part verification, and intentional pauses.",
        "protocol_sha256":helper.sha(out/"protocol.json"),
    })


def run(args):
    if args.max_parts is not None and args.max_parts<1:
        raise ValueError("--max-parts must be positive")
    bench = load_bench()
    previous = bench.load_fusion().load_previous()
    helper = previous.load_helpers()
    cfg = make_protocol(args,bench,previous,helper)
    out = args.output.resolve()
    out.mkdir(parents=True,exist_ok=True)
    fixed, checkpoint = out/"protocol.json",out/"checkpoint.json"
    if fixed.exists():
        if helper.read_json(fixed)!=cfg:
            raise ValueError("The fixed source or timing protocol changed")
        state = helper.read_json(checkpoint)
        if state["protocol_sha256"]!=helper.sha(fixed):
            raise ValueError("Checkpoint protocol mismatch")
    else:
        if any(out.iterdir()):
            raise ValueError("New runs require a unique empty output folder")
        helper.save_json(fixed,cfg)
        state = {"status":"pending","protocol_sha256":helper.sha(fixed),"parts":{},"startup":[],"failures":[]}
        helper.save_json(checkpoint,state)
    parts=out/"parts"
    parts.mkdir(exist_ok=True)
    for index,row in state["parts"].items():
        if (list(cfg["parts"][int(index)])!=[row["first"],row["last_exclusive"]]
                or helper.sha(parts/row["mp4"])!=row["mp4_sha256"] or helper.sha(parts/row["csv"])!=row["csv_sha256"]):
            raise ValueError("A completed part has unexpected data")
    remaining = [i for i in range(len(cfg["parts"])) if str(i) not in state["parts"]][:args.max_parts]

    def event(message):
        line=f"{datetime.now(timezone.utc).isoformat()} PID={os.getpid()} {message}"
        print(line,flush=True)
        with (out/"run.log").open("a",encoding="utf-8") as log:
            log.write(line+"\n")

    active = None
    event(f"start complete_parts={len(state['parts'])}/{len(cfg['parts'])}")
    try:
        import numpy as np
        if remaining:
            import cv2

            to_verify={i for n in remaining for i in range(*cfg["parts"][n])} | set(range(WARMUP_FRAMES))
            for i in sorted(to_verify):
                item=cfg["input_frames"][i]
                path=Path(cfg["root"])/item["path"]
                if not path.resolve(strict=True).is_relative_to(Path(cfg["source"])) or helper.sha(path)!=item["sha256"]:
                    raise ValueError(f"Input hash mismatch at training frame {i}")
            event(f"verified_input_frames={len(to_verify)}")
            start = time.perf_counter()
            model = previous.configure_model(cfg)
            import torch

            loaded = time.perf_counter()
            for i in range(WARMUP_FRAMES):
                bench.full_predict([image_at(cfg,i,cv2,np)],model,cfg["inference"])
            torch.cuda.synchronize()
            state["startup"].append({"model_load_seconds":loaded-start,"warmup_seconds":time.perf_counter()-loaded,
                                     "device":torch.cuda.get_device_name(0)})
            helper.save_json(checkpoint,state)
            for active in remaining:
                prefix=f"part-{active+1:02d}"
                result=encode_part(parts/(prefix+".mp4"),parts/(prefix+".csv"),cfg["parts"][active],
                                   cfg,model,bench,helper,event,cv2,np,torch)
                state["parts"][str(active)]=result
                helper.save_json(checkpoint,state)
                event(f"checkpoint part={active+1}/{len(cfg['parts'])} seconds={result['seconds']:.3f}")
        if len(state["parts"])==len(cfg["parts"]):
            publish(out,cfg,state,helper,np)
            state["status"]="complete"
        else:
            state["status"]="paused"
        helper.save_json(checkpoint,state)
        event(state["status"])
    except BaseException as error:
        state["status"]="interrupted" if isinstance(error,KeyboardInterrupt) else "failed"
        state["failures"].append({"part":active,"type":type(error).__name__,"message":str(error)})
        helper.save_json(checkpoint,state)
        event(f"{state['status']} part={active} {error}")
        raise


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project",type=Path)
    parser.add_argument("cchead",type=Path)
    parser.add_argument("output",type=Path)
    parser.add_argument("--max-parts",type=int,help="Pause after this many complete output segments")
    run(parser.parse_args())
