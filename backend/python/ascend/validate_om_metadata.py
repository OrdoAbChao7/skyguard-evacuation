#!/usr/bin/env python3
"""验证 Ascend OM 元数据，禁止伪造 NPU 证据。

用法：
  python validate_om_metadata.py --metadata om-metadata.json [--om model.om]

规则：
  - 声称 benchmark.executed_on == "npu" 时，必须有 npu-smi 可用与设备型号/驱动/CANN 版本；
  - om_sha256 必须与 --om 文件一致（若提供）；
  - 数值一致性必须 passed；
  - 否则状态为 not_verified，不得用于“昇腾实机”表述。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REQUIRED = ["model_name", "soc_version", "cann_version", "atc_command", "om_sha256", "onnx_sha256",
            "input_shape", "output_shape", "device_evidence", "benchmark", "numerical_consistency", "generated_at"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--om", required=False)
    args = parser.parse_args()

    path = Path(args.metadata)
    result = {"metadata": str(path), "errors": [], "warnings": [], "status": "not_verified"}
    if not path.exists():
        result["errors"].append("metadata file missing")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        result["errors"].append(f"invalid JSON: {exc}")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1

    for key in REQUIRED:
        if key not in data:
            result["errors"].append(f"missing field {key}")

    if data.get("errors"):
        result["errors"].extend(str(item) for item in data["errors"])

    device = data.get("device_evidence") or {}
    benchmark = data.get("benchmark") or {}
    consistency = data.get("numerical_consistency") or {}
    claims_npu = benchmark.get("executed_on") == "npu"
    if claims_npu:
        if not device.get("npu_smi_available"):
            result["errors"].append("benchmark claims npu but npu_smi_available is false")
        for key in ["device_model", "driver_version", "cann_version"]:
            if not device.get(key):
                result["errors"].append(f"benchmark claims npu but device_evidence.{key} is missing")
    if consistency.get("passed") is not True:
        result["errors"].append("numerical consistency did not pass")
    if data.get("om_sha256") and len(str(data["om_sha256"])) != 64:
        result["errors"].append("om_sha256 must be 64 hex chars")

    if args.om:
        om_path = Path(args.om)
        if not om_path.exists():
            result["errors"].append(f"om file missing: {om_path}")
        else:
            digest = hashlib.sha256(om_path.read_bytes()).hexdigest()
            result["om_actual_sha256"] = digest
            if digest != data.get("om_sha256"):
                result["errors"].append("om_sha256 mismatch")
            if om_path.stat().st_size == 0:
                result["errors"].append("om file is empty")

    if not claims_npu:
        result["warnings"].append("benchmark.executed_on is not npu; status remains not_verified")
    if not result["errors"] and claims_npu:
        result["status"] = "npu_verified"
    elif not result["errors"]:
        result["status"] = "valid_metadata_not_npu_verified"
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not result["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
