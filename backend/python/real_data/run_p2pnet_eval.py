"""Run P2PNet on ShanghaiTech official test split and report real metrics.

Example:
  python -I backend/python/real_data/run_p2pnet_eval.py \
    --dataset-root E:/datasets/shanghaitech/extracted \
    --part part_A_final --split test_data \
    --repo E:/datasets/P2PNet --weights E:/datasets/P2PNet/weights/SHTechA.pth \
    --output evaluation/real-data

The script never downloads data/weights and never fabricates metrics. If inputs
are missing it writes a blocked RESULTS.json and exits with code 2.
"""
from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from metrics import CountPair, count_metrics, density_bin_metrics, match_points  # noqa: E402
from shanghaitech import load_part  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-root", required=True)
    parser.add_argument("--part", default="part_A_final")
    parser.add_argument("--split", default="test_data")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--weights", required=True)
    parser.add_argument("--output", default="evaluation/real-data")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="allow replacing an existing RESULTS.json/REPORT.md in --output",
    )
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--radius", type=float, default=8.0)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--device", default="cpu")
    return parser.parse_args()


def git_commit(repo: Path) -> str | None:
    try:
        return subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return None


def percentile(values: list[float], p: float) -> float:
    return float(np.percentile(np.asarray(values), p)) if values else float("nan")


def write_blocked(output: Path, reason: str, args: argparse.Namespace) -> None:
    output.mkdir(parents=True, exist_ok=True)
    payload = {
        "status": "blocked",
        "reason": reason,
        "dataset_root": args.dataset_root,
        "part": args.part,
        "split": args.split,
        "repo": args.repo,
        "weights": args.weights,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "metrics": None,
        "note": "No synthetic metrics are reported. Provide legal dataset/weights to run evaluation.",
    }
    (output / "RESULTS.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "REPORT.md").write_text(
        "# Real dataset evaluation\n\n"
        f"Status: **blocked**\n\nReason: {reason}\n\n"
        "No metrics were produced. Do not interpret this as a model result.\n",
        encoding="utf-8",
    )
    print(f"[real-data] blocked: {reason}")


def main() -> int:
    args = parse_args()
    output = Path(args.output)
    # 冻结证据保护：默认拒绝覆盖既有结果，避免缺数据时把 blocked 写进已提交证据。
    if (output / "RESULTS.json").exists() and not args.overwrite:
        print(
            f"[real-data] refusing to overwrite existing {output / 'RESULTS.json'}; "
            "choose a new --output or pass --overwrite",
            file=sys.stderr,
        )
        return 3
    dataset_root = Path(args.dataset_root)
    repo = Path(args.repo)
    weights = Path(args.weights)
    if not dataset_root.is_dir():
        write_blocked(output, f"dataset root not found: {dataset_root}", args)
        return 2
    if not repo.is_dir():
        write_blocked(output, f"P2PNet repo not found: {repo}", args)
        return 2
    if not weights.is_file():
        write_blocked(output, f"weights not found: {weights}", args)
        return 2
    try:
        samples = load_part(dataset_root, args.part, args.split)
    except Exception as error:  # noqa: BLE001
        write_blocked(output, f"dataset load failed: {error}", args)
        return 2
    if args.limit:
        samples = samples[: args.limit]
    if not samples:
        write_blocked(output, "no samples found", args)
        return 2

    from p2pnet_adapter import P2PNetAdapter  # noqa: E402

    started = time.perf_counter()
    adapter = P2PNetAdapter(repo, weights, device=args.device, threshold=args.threshold)
    load_ms = (time.perf_counter() - started) * 1000

    pairs: list[CountPair] = []
    latencies: list[float] = []
    per_image = []
    local = {"tp": 0, "fp": 0, "fn": 0}
    for index, sample in enumerate(samples, 1):
        result = adapter.predict(sample.image_path)
        pairs.append(CountPair(sample.image_path.stem, sample.count, result["count"]))
        latencies.append(result["inference_ms"])
        original_w, original_h = result["original_size"]
        resized_w, resized_h = result["resized_size"]
        scaled_gt = sample.points * np.array([resized_w / original_w, resized_h / original_h])
        match = match_points(scaled_gt, result["points_resized"], args.radius)
        local["tp"] += match["tp"]
        local["fp"] += match["fp"]
        local["fn"] += match["fn"]
        per_image.append({
            "image": sample.image_path.name,
            "ground_truth": sample.count,
            "predicted": result["count"],
            "error": result["count"] - sample.count,
            "inference_ms": result["inference_ms"],
        })
        if index % 20 == 0 or index == len(samples):
            print(f"[real-data] {index}/{len(samples)} images")

    metrics = count_metrics(pairs)
    precision = local["tp"] / (local["tp"] + local["fp"]) if (local["tp"] + local["fp"]) else 0.0
    recall = local["tp"] / (local["tp"] + local["fn"]) if (local["tp"] + local["fn"]) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    result = {
        "status": "completed",
        "dataset": "ShanghaiTech",
        "part": args.part,
        "split": args.split,
        "model": "P2PNet SHTechA",
        "repo": str(repo),
        "repo_commit": git_commit(repo),
        "weights": str(weights),
        "weights_sha256": adapter.weights_sha256,
        "threshold": args.threshold,
        "localization_radius_px": args.radius,
        "environment": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "device": args.device,
            "platform": platform.platform(),
        },
        "images": len(samples),
        "load_ms": round(load_ms, 2),
        "metrics": metrics,
        "density_bins_by_gt_count": density_bin_metrics(pairs),
        "localization": {
            "tp": local["tp"], "fp": local["fp"], "fn": local["fn"],
            "precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4),
            "radius_px": args.radius,
            "note": "GT points scaled to P2PNet resized coordinates; greedy matching.",
        },
        "latency_ms": {
            "mean": round(float(np.mean(latencies)), 3),
            "p50": round(percentile(latencies, 50), 3),
            "p95": round(percentile(latencies, 95), 3),
            "fps": round(1000.0 / float(np.mean(latencies)), 3) if latencies else None,
            "measurement": "model forward only; excludes image I/O and preprocessing",
        },
        "per_image": per_image,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "limitations": [
            "Single public dataset/split; not a real venue measurement.",
            "P2PNet code from 2021; compatibility patches applied for torchvision 0.29 (version check) and pretrained backbone download disabled.",
            "ShanghaiTech license/terms must be verified by the user; dataset/weights are not redistributed.",
        ],
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "RESULTS.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report = f"""# Real dataset evaluation · ShanghaiTech {args.part}/{args.split}

- Model: P2PNet (SHTechA weights)
- Images: {len(samples)}
- MAE: {metrics['mae']}
- RMSE: {metrics['rmse']}
- NAE: {metrics['nae']}
- FPS (model forward only): {result['latency_ms']['fps']}
- Mean inference: {result['latency_ms']['mean']} ms (p95 {result['latency_ms']['p95']})
- Localization F1 @{args.radius}px: {result['localization']['f1']}

## Density bins (by GT count)

| GT range | images | MAE |
| --- | --- | --- |
{chr(10).join(f"| {b['low']}-{b['high']} | {b['n']} | {b['mae']} |" for b in result['density_bins_by_gt_count'])}

## Environment

- Python {result['environment']['python']} / Torch {result['environment']['torch']} / device {args.device}
- Repo commit: {result['repo_commit']}
- Weights SHA-256: {result['weights_sha256']}

## Boundaries

- Public dataset result, not a real venue measurement.
- Dataset/weights are not redistributed; license must be verified.
- Compatibility patches are documented in the adapter; no accuracy claim beyond this split.
"""
    (output / "REPORT.md").write_text(report, encoding="utf-8")
    print(f"[real-data] completed: MAE={metrics['mae']} RMSE={metrics['rmse']} FPS={result['latency_ms']['fps']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
