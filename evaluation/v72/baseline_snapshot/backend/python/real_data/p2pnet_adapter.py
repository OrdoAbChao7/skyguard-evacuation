"""P2PNet adapter for real-data evaluation.

Official code/weights: github.com/TencentYoutuResearch/CrowdCounting-P2PNet
(weights/SHTechA.pth trained on ShanghaiTech Part A train).

This adapter is intentionally defensive: it does not download data or weights,
does not alter the source repository, and reports explicit compatibility patches.
"""
from __future__ import annotations

import hashlib
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torchvision
import torchvision.transforms as T
from PIL import Image


def file_sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class P2PNetAdapter:
    def __init__(self, repo: Path, weights: Path, device: str = "cpu", threshold: float = 0.5):
        self.repo = Path(repo).resolve()
        self.weights = Path(weights).resolve()
        self.device = torch.device(device)
        self.threshold = float(threshold)
        if not self.repo.is_dir():
            raise FileNotFoundError(f"P2PNet repo not found: {self.repo}")
        if not self.weights.is_file():
            raise FileNotFoundError(f"P2PNet weights not found: {self.weights}")
        self._load()

    def _load(self) -> None:
        # P2PNet was written for torch 1.5 / torchvision 0.6. The official code
        # checks `float(torchvision.__version__[:3]) < 0.7`, which misparses
        # modern versions (0.29 -> "0.2"). Force the modern branch before import.
        torchvision.__version__ = "0.9.0"
        sys.path.insert(0, str(self.repo))
        import models.vgg_ as vgg_module  # noqa: WPS433
        original_vgg = vgg_module.vgg16_bn

        def vgg_without_pretrained(pretrained: bool = True, *args, **kwargs):
            # Backbone weights are overwritten by the trained checkpoint; avoid
            # a network download during adapter construction.
            return original_vgg(pretrained=False, *args, **kwargs)

        vgg_module.vgg16_bn = vgg_without_pretrained
        from types import SimpleNamespace
        from models import build_model  # noqa: WPS433

        args = SimpleNamespace(backbone="vgg16_bn", row=2, line=2)
        self.model = build_model(args)
        checkpoint = torch.load(self.weights, map_location="cpu")
        self.model.load_state_dict(checkpoint["model"])
        self.model.to(self.device)
        self.model.eval()
        self.transform = T.Compose([
            T.ToTensor(),
            T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ])
        self.weights_sha256 = file_sha256(self.weights)

    def predict(self, image_path: Path) -> dict:
        image = Image.open(image_path).convert("RGB")
        width, height = image.size
        new_width = max(128, width // 128 * 128)
        new_height = max(128, height // 128 * 128)
        resized = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
        tensor = self.transform(resized).unsqueeze(0).to(self.device)
        started = time.perf_counter()
        with torch.no_grad():
            outputs = self.model(tensor)
        inference_ms = (time.perf_counter() - started) * 1000
        scores = torch.softmax(outputs["pred_logits"], -1)[:, :, 1][0]
        points = outputs["pred_points"][0][scores > self.threshold].detach().cpu().numpy()
        return {
            "count": int(points.shape[0]),
            "points_resized": points,
            "original_size": [width, height],
            "resized_size": [new_width, new_height],
            "inference_ms": round(inference_ms, 3),
            "weights_sha256": self.weights_sha256,
        }
