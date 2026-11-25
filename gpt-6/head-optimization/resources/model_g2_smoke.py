"""Verify the published YOLOv8s-Head checkpoint without dataset inference."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys


WEIGHT_BYTES = 22_513_507
WEIGHT_SHA256 = "1467b10e30a05be6a05950190e5efe30b50681270cb7baf6115ec96806b25964"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    args = parser.parse_args()
    path = args.checkpoint.resolve(strict=True)
    if path.stat().st_size != WEIGHT_BYTES:
        raise ValueError("Checkpoint size differs from the published file")
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != WEIGHT_SHA256:
        raise ValueError("Checkpoint hash differs from the published file")
    if sys.prefix == sys.base_prefix:
        raise RuntimeError("Run this check from the isolated Python environment")

    os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
    os.environ["YOLO_AUTOINSTALL"] = "false"
    os.environ["YOLO_OFFLINE"] = "true"
    os.environ["YOLO_CONFIG_DIR"] = str(Path(sys.prefix) / "ultralytics-config")

    import torch
    import torchvision
    import ultralytics
    from ultralytics.nn.modules.head import Detect
    from ultralytics.nn.tasks import DetectionModel, _SafeLoad, torch_safe_load
    from ultralytics.utils.checks import check_imgsz

    if not _SafeLoad.SUPPORTED:
        raise RuntimeError("This runtime does not support the restricted loader")
    checkpoint, _ = torch_safe_load(str(path), safe_only=True)
    model = checkpoint.get("ema")
    payload = "ema"
    if model is None:
        model = checkpoint.get("model")
        payload = "model"
    if not isinstance(model, DetectionModel):
        raise TypeError("Checkpoint did not contain an Ultralytics DetectionModel")

    head = model.model[-1]
    if not isinstance(head, Detect) or head.nc != 1:
        raise ValueError("Expected an Ultralytics detection head with one class")
    strides = [int(value) for value in model.stride.tolist()]
    default_imgsz = int(check_imgsz(640, stride=max(strides)))
    if default_imgsz != 640:
        raise ValueError("The planned 640-pixel input does not align to model stride")

    cpu_devices = sorted({str(param.device) for param in model.parameters()})
    if cpu_devices != ["cpu"] or not torch.cuda.is_available():
        raise RuntimeError("Expected CPU deserialization and an available CUDA device")
    model = model.float().eval().to("cuda:0")
    torch.cuda.synchronize()
    gpu_devices = sorted({str(param.device) for param in model.parameters()})
    if gpu_devices != ["cuda:0"]:
        raise RuntimeError(f"Model parameters landed on unexpected devices: {gpu_devices}")

    config = model.yaml
    training_args = checkpoint.get("train_args") or {}
    result = {
        "status": "passed",
        "weight_path": str(path),
        "sha256": digest,
        "loader": "torch_safe_load(safe_only=True), enforced weights_only",
        "versions": {
            "python": sys.version.split()[0],
            "torch": torch.__version__,
            "torchvision": torchvision.__version__,
            "ultralytics": ultralytics.__version__,
        },
        "model": {
            "type": type(model).__name__,
            "detection_head": type(head).__name__,
            "payload": payload,
            "yaml_file": config.get("yaml_file"),
            "scale": config.get("scale"),
            "depth_multiple": config.get("depth_multiple"),
            "width_multiple": config.get("width_multiple"),
            "module_types": sorted({type(layer).__name__ for layer in model.model}),
            "parameters": sum(param.numel() for param in model.parameters()),
            "input_channels": model.model[0].conv.in_channels,
            "strides": strides,
            "checked_imgsz": default_imgsz,
            "training_imgsz": training_args.get("imgsz"),
            "class_count": head.nc,
            "checkpoint_names": getattr(model, "names", None),
            "publisher_names": {"0": "head"},
        },
        "device": {
            "cpu_initial_load": cpu_devices,
            "gpu_parameters": gpu_devices,
            "gpu_name": torch.cuda.get_device_name(0),
            "cuda_build": torch.version.cuda,
        },
        "training_state": {
            "checkpoint_epoch": checkpoint.get("epoch"),
            "has_optimizer": checkpoint.get("optimizer") is not None,
        },
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
