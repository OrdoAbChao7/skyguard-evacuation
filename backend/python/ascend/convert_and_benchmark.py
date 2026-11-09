"""Ascend model conversion + latency/accuracy benchmark preparation.

This script never fabricates device results. If `atc`, CANN, NPU, or the
external inference command are unavailable it writes a `blocked` JSON and
exits non-zero.

Usage (on an Ascend host):
  python -I backend/python/ascend/convert_and_benchmark.py \
    --model /data/models/crowd.onnx --output-dir /data/models/om \
    --soc-version Ascend310P3 --input-shape "input:1,3,512,512" \
    --frames-json /data/eval/frames.json --benchmark-frames 100

Outputs:
  CONVERSION.json   atc command, versions, hashes, transcript
  BENCHMARK.json    per-frame latency, throughput, optional accuracy
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="ONNX or Caffe model path")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--soc-version", required=True, help="e.g. Ascend310P3")
    parser.add_argument("--input-shape", required=True, help='e.g. "input:1,3,512,512"')
    parser.add_argument("--framework", type=int, default=5, help="atc framework id (5=ONNX)")
    parser.add_argument("--frames-json", help="optional JSON list of frame paths for benchmark")
    parser.add_argument("--benchmark-frames", type=int, default=50)
    parser.add_argument("--inference-command", default=os.environ.get("SKYGUARD_ASCEND_CMD", ""))
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_blocked(output: Path, reason: str, extra: dict) -> None:
    output.mkdir(parents=True, exist_ok=True)
    payload = {
        "status": "blocked",
        "reason": reason,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **extra,
        "note": "No device results were produced. Do not interpret this as an Ascend benchmark.",
    }
    (output / "CONVERSION.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[ascend] blocked: {reason}")


def main() -> int:
    args = parse_args()
    output = Path(args.output_dir)
    model = Path(args.model)
    if not model.is_file():
        write_blocked(output, f"model not found: {model}", {"model": str(model)})
        return 2
    atc = shutil.which("atc")
    if not atc:
        write_blocked(output, "atc not found in PATH; install CANN toolkit first", {
            "model": str(model),
            "model_sha256": sha256(model),
            "cann_home": os.environ.get("ASCEND_HOME_PATH") or os.environ.get("ASCEND_TOOLKIT_HOME"),
        })
        return 2
    output.mkdir(parents=True, exist_ok=True)
    om_path = output / f"{model.stem}.om"
    command = [
        atc,
        f"--model={model}",
        f"--framework={args.framework}",
        f"--output={om_path.with_suffix('')}",
        f"--soc_version={args.soc_version}",
        f"--input_shape={args.input_shape}",
    ]
    started = time.time()
    proc = subprocess.run(command, capture_output=True, text=True)
    elapsed = time.time() - started
    conversion = {
        "status": "ok" if proc.returncode == 0 and om_path.exists() else "failed",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": str(model),
        "model_sha256": sha256(model),
        "om": str(om_path) if om_path.exists() else None,
        "om_sha256": sha256(om_path) if om_path.exists() else None,
        "command": command,
        "elapsed_seconds": round(elapsed, 3),
        "returncode": proc.returncode,
        "stdout_tail": proc.stdout[-4000:],
        "stderr_tail": proc.stderr[-4000:],
        "cann_home": os.environ.get("ASCEND_HOME_PATH") or os.environ.get("ASCEND_TOOLKIT_HOME"),
        "soc_version": args.soc_version,
    }
    (output / "CONVERSION.json").write_text(json.dumps(conversion, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if conversion["status"] != "ok":
        print("[ascend] conversion failed; no benchmark produced")
        return 3

    command_path = Path(args.inference_command) if args.inference_command else None
    if not command_path or not command_path.exists():
        blocked = {
            "status": "blocked",
            "reason": "SKYGUARD_ASCEND_CMD / --inference-command not available; model converted but cannot benchmark",
            "conversion": conversion,
        }
        (output / "BENCHMARK.json").write_text(json.dumps(blocked, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("[ascend] benchmark blocked: no inference command")
        return 4

    frames: list[str] = []
    if args.frames_json:
        frames = json.loads(Path(args.frames_json).read_text(encoding="utf-8"))
    frames = frames[: args.benchmark_frames]
    if not frames:
        write_blocked(output, "no benchmark frames provided", {"conversion": conversion})
        return 5

    latencies: list[float] = []
    outputs: list[dict] = []
    for frame in frames:
        request = {
            "region_id": "benchmark",
            "camera_id": "benchmark",
            "roi": None,
            "video_path": frame,
            "model_path": str(om_path),
            "max_frames": 1,
        }
        begin = time.perf_counter()
        run = subprocess.run([str(command_path)], input=json.dumps(request), capture_output=True, text=True)
        latency_ms = (time.perf_counter() - begin) * 1000
        latencies.append(latency_ms)
        try:
            response = json.loads(run.stdout)
        except json.JSONDecodeError:
            response = {"ok": False, "message": run.stdout[-500:]}
        outputs.append({"frame": frame, "latency_ms": round(latency_ms, 3), "response": response})
    benchmark = {
        "status": "ok",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "conversion": conversion,
        "frames": len(frames),
        "latency_ms": {
            "mean": round(statistics.fmean(latencies), 3),
            "p50": round(statistics.median(latencies), 3),
            "p95": round(sorted(latencies)[max(0, int(len(latencies) * 0.95) - 1)], 3),
            "min": round(min(latencies), 3),
            "max": round(max(latencies), 3),
        },
        "throughput_fps": round(1000 / statistics.fmean(latencies), 3),
        "outputs": outputs,
        "note": "End-to-end host->device->host latency includes process startup. Accuracy requires labelled frames; not reported here.",
    }
    (output / "BENCHMARK.json").write_text(json.dumps(benchmark, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[ascend] benchmark ok: mean {benchmark['latency_ms']['mean']} ms over {len(frames)} frames")
    return 0


if __name__ == "__main__":
    sys.exit(main())
