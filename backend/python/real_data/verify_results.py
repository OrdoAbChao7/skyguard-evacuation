"""Recompute real-data count metrics from per-image results and verify JSON."""
from __future__ import annotations

import json
import math
import sys
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from metrics import CountPair, count_metrics, density_bin_metrics  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--output", default="evaluation/real-data", help="directory containing RESULTS.json")
args = parser.parse_args()
ROOT = Path(__file__).resolve().parents[3]
out_root = Path(args.output)
if not out_root.is_absolute():
    out_root = ROOT / out_root
results_path = out_root / "RESULTS.json"
out_path = out_root / "VERIFICATION.json"

if not results_path.exists():
    print("RESULTS.json missing")
    raise SystemExit(1)
data = json.loads(results_path.read_text(encoding="utf-8"))
if data.get("status") != "completed":
    print("results not completed; nothing to verify")
    raise SystemExit(1)

pairs = [CountPair(item["image"], int(item["ground_truth"]), int(item["predicted"])) for item in data["per_image"]]
metrics = count_metrics(pairs)
bins = density_bin_metrics(pairs)
checks = []
def check(name: str, expected, actual, tolerance=1e-3):
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        ok = math.isclose(float(expected), float(actual), abs_tol=tolerance)
    else:
        ok = expected == actual
    checks.append({"name": name, "expected": expected, "actual": actual, "pass": ok})

check("images", data["images"], len(pairs), 0)
check("mae", data["metrics"]["mae"], metrics["mae"])
check("rmse", data["metrics"]["rmse"], metrics["rmse"])
check("nae", data["metrics"]["nae"], metrics["nae"])
check("density_bins", data["density_bins_by_gt_count"], bins, 0)
weights = Path(data["weights"])
if weights.exists():
    import hashlib
    actual_sha = hashlib.sha256(weights.read_bytes()).hexdigest()
    check("weights_sha256", data["weights_sha256"], actual_sha, 0)
else:
    checks.append({"name": "weights_sha256", "expected": data["weights_sha256"], "actual": "weights file not present", "pass": None})

failed = [item for item in checks if item["pass"] is False]
out = {
    "generated_at": __import__("time").strftime("%Y-%m-%dT%H:%M:%SZ", __import__("time").gmtime()),
    "checks": len(checks),
    "passed": sum(1 for item in checks if item["pass"] is True),
    "failed": len(failed),
    "skipped": sum(1 for item in checks if item["pass"] is None),
    "results": checks,
}
out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"[real-data] verification {out['passed']}/{out['checks']} passed, {out['skipped']} skipped")
if failed:
    for item in failed:
        print("FAIL", item)
    raise SystemExit(1)
