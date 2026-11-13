#!/usr/bin/env python3
"""导出 SkyGuard V7.2 参考预测模型为 ONNX（仅用于部署链路验证）。

模型语义（确定性线性趋势外推，不是 V7 生产预测器）：
  输入  history: float32[1, N]  —— 最近 N 分钟人数
  输出  forecast: float32[1, H] —— 未来 H 分钟线性外推（截断到 >=0）
  斜率 = (history[-1] - history[0]) / (N - 1)
  forecast[h] = max(0, history[-1] + slope * (h + 1))

用途：验证 ONNX 导出、数值一致性、CPU/ONNX Runtime 基准与 ATC 转换输入契约。
不得表述为 SkyGuard 生产预测精度或昇腾 NPU 实机结果。
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

try:
    import onnx
    from onnx import TensorProto, helper, numpy_helper
except ImportError as exc:  # pragma: no cover - 环境缺失时明确失败
    raise SystemExit(
        "缺少 onnx 依赖：请安装 requirements-v72.txt（pip install --only-binary=:all: onnx）"
    ) from exc


def build_model(history_len: int, horizon: int) -> onnx.ModelProto:
    if history_len < 2:
        raise ValueError("history_len 必须 >= 2")
    if horizon < 1:
        raise ValueError("horizon 必须 >= 1")

    history_input = helper.make_tensor_value_info("history", TensorProto.FLOAT, [1, history_len])
    forecast_output = helper.make_tensor_value_info("forecast", TensorProto.FLOAT, [1, horizon])

    first_index = numpy_helper.from_array(np.array([0], dtype=np.int64), name="first_index")
    last_index = numpy_helper.from_array(np.array([history_len - 1], dtype=np.int64), name="last_index")
    steps = numpy_helper.from_array(np.arange(1, horizon + 1, dtype=np.float32).reshape(1, horizon), name="steps")
    zero = numpy_helper.from_array(np.array([0.0], dtype=np.float32), name="zero")
    denom = numpy_helper.from_array(np.array([float(history_len - 1)], dtype=np.float32), name="denom")

    initializers = [first_index, last_index, steps, zero, denom]
    nodes = [
        helper.make_node("Gather", ["history", "first_index"], ["first"], axis=1),
        helper.make_node("Gather", ["history", "last_index"], ["last"], axis=1),
        helper.make_node("Sub", ["last", "first"], ["delta"]),
        helper.make_node("Div", ["delta", "denom"], ["slope"]),
        helper.make_node("Mul", ["slope", "steps"], ["offset"]),
        helper.make_node("Add", ["last", "offset"], ["raw_forecast"]),
        helper.make_node("Max", ["raw_forecast", "zero"], ["forecast"]),
    ]
    graph = helper.make_graph(nodes, "skyguard_linear_trend_forecast", [history_input], [forecast_output], initializers)
    model = helper.make_model(
        graph,
        producer_name="skyguard-v72-reference",
        opset_imports=[helper.make_opsetid("", 17)],
    )
    model.ir_version = 8
    onnx.checker.check_model(model)
    return model


def numpy_reference(history: np.ndarray, horizon: int) -> np.ndarray:
    history = np.asarray(history, dtype=np.float32).reshape(-1)
    slope = (history[-1] - history[0]) / float(len(history) - 1)
    steps = np.arange(1, horizon + 1, dtype=np.float32)
    return np.maximum(0.0, history[-1] + slope * steps).reshape(1, horizon)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="输出目录")
    parser.add_argument("--history-len", type=int, default=12)
    parser.add_argument("--horizon", type=int, default=5)
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model = build_model(args.history_len, args.horizon)
    model_path = out / "forecast_linear.onnx"
    onnx.save(model, model_path)
    digest = hashlib.sha256(model_path.read_bytes()).hexdigest()

    rng = np.random.default_rng(20261110)
    history = (300 + np.cumsum(rng.normal(0, 6, args.history_len))).astype(np.float32).reshape(1, -1)
    reference = numpy_reference(history, args.horizon)
    metadata = {
        "model": "forecast_linear.onnx",
        "sha256": digest,
        "producer": "skyguard-v72-reference",
        "input": {"name": "history", "shape": [1, args.history_len], "dtype": "float32"},
        "output": {"name": "forecast", "shape": [1, args.horizon], "dtype": "float32"},
        "semantics": "linear trend extrapolation from first/last history value, clamped at 0",
        "reference_sample": {
            "history": [float(value) for value in history.reshape(-1)],
            "forecast": [float(value) for value in reference.reshape(-1)],
        },
        "note": "参考模型，仅用于 ONNX/ATC 链路验证；不是 SkyGuard 生产预测器，也不是 NPU 实机证据。",
    }
    (out / "forecast_linear_metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    np.save(out / "reference_history.npy", history)
    print(json.dumps({"model": str(model_path), "sha256": digest, "history_len": args.history_len, "horizon": args.horizon}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
