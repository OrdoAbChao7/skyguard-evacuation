#!/usr/bin/env python3
"""ONNX Runtime CPU 推理基准与数值一致性检查（V7.2）。

明确边界：
  - 使用 CPUExecutionProvider；**不是昇腾 NPU/CANN 实机结果**；
  - 被测模型是参考线性趋势模型，不是 SkyGuard 生产预测器；
  - 结果只用于验证导出/推理链路、延迟量级与数值一致性。
"""
from __future__ import annotations

import argparse
import json
import platform
import statistics
import time
from pathlib import Path

import numpy as np

try:
    import onnxruntime as ort
except ImportError as exc:  # pragma: no cover
    raise SystemExit("缺少 onnxruntime：pip install onnxruntime") from exc

from export_forecast_onnx import numpy_reference


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((p / 100.0) * (len(ordered) - 1)))))
    return float(ordered[index])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True, help="包含 forecast_linear.onnx 的目录")
    parser.add_argument("--out", required=True, help="输出目录")
    parser.add_argument("--iterations", type=int, default=300)
    args = parser.parse_args()

    model_dir = Path(args.model_dir)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model_path = model_dir / "forecast_linear.onnx"
    metadata_path = model_dir / "forecast_linear_metadata.json"
    if not model_path.exists():
        raise SystemExit(f"模型不存在：{model_path}（先运行 export_forecast_onnx.py）")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    history_len = int(metadata["input"]["shape"][1])
    horizon = int(metadata["output"]["shape"][1])

    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    providers = session.get_providers()

    onnx_check = {"available": False, "valid": None, "error": None}
    try:
        import onnx  # type: ignore
        loaded = onnx.load(str(model_path))
        onnx.checker.check_model(loaded)
        onnx_check = {"available": True, "valid": True, "error": None}
    except ImportError as exc:
        onnx_check = {"available": False, "valid": None, "error": f"onnx not installed: {exc}"}
    except Exception as exc:  # noqa: BLE001
        onnx_check = {"available": True, "valid": False, "error": str(exc)[:500]}

    rng = np.random.default_rng(20261110)
    histories = [
        (300 + np.cumsum(rng.normal(0, 8, history_len))).astype(np.float32).reshape(1, -1)
        for _ in range(32)
    ]
    for history in histories[:5]:
        session.run([output_name], {input_name: history})

    latencies: list[float] = []
    max_abs_diff = 0.0
    for index in range(args.iterations):
        history = histories[index % len(histories)]
        started = time.perf_counter()
        output = session.run([output_name], {input_name: history})[0]
        latencies.append((time.perf_counter() - started) * 1000.0)
        reference = numpy_reference(history, horizon)
        max_abs_diff = max(max_abs_diff, float(np.max(np.abs(output - reference))))

    result = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": "forecast_linear.onnx",
        "model_sha256": metadata["sha256"],
        "onnx_check": onnx_check,
        "runtime": {
            "name": "onnxruntime",
            "version": ort.__version__,
            "providers": providers,
            "device": "cpu",
            "platform": platform.platform(),
            "python": platform.python_version(),
        },
        "workload": {
            "input_shape": [1, history_len],
            "output_shape": [1, horizon],
            "iterations": args.iterations,
        },
        "latency_ms": {
            "p50": round(percentile(latencies, 50), 4),
            "p95": round(percentile(latencies, 95), 4),
            "mean": round(statistics.fmean(latencies), 4),
            "max": round(max(latencies), 4),
        },
        "numerical_consistency": {
            "max_abs_diff": round(max_abs_diff, 8),
            "tolerance": 1e-3,
            "passed": max_abs_diff <= 1e-3,
        },
        "boundary": "CPUExecutionProvider；不是昇腾 NPU/CANN 实机结果；参考模型不是生产预测器。",
    }
    (out / "onnx_cpu_benchmark.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "p50_ms": result["latency_ms"]["p50"],
        "p95_ms": result["latency_ms"]["p95"],
        "max_abs_diff": result["numerical_consistency"]["max_abs_diff"],
        "providers": providers,
    }, ensure_ascii=False))
    return 0 if result["numerical_consistency"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
