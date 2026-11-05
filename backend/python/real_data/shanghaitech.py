"""ShanghaiTech Part A/B loader following the official directory split."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import scipy.io as sio


@dataclass
class ShanghaiTechSample:
    image_path: Path
    gt_path: Path
    points: np.ndarray
    count: int


def load_part(root: Path, part: str, split: str) -> list[ShanghaiTechSample]:
    """part in {part_A_final, part_B_final}; split in {train_data, test_data}."""
    base = Path(root) / part / split
    images_dir = base / "images"
    gt_dir = base / "ground_truth"
    if not images_dir.is_dir() or not gt_dir.is_dir():
        raise FileNotFoundError(f"ShanghaiTech structure not found: {base}")
    samples = []
    for image_path in sorted(images_dir.iterdir()):
        if image_path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        gt_path = gt_dir / f"GT_{image_path.stem}.mat"
        if not gt_path.exists():
            raise FileNotFoundError(f"missing annotation: {gt_path}")
        mat = sio.loadmat(gt_path)
        info = mat["image_info"][0, 0]
        location = info["location"]
        while isinstance(location, np.ndarray) and location.dtype == object and location.size == 1:
            location = location.item()
        points = np.asarray(location, dtype=np.float64).reshape(-1, 2)
        count = int(points.shape[0])
        samples.append(ShanghaiTechSample(image_path, gt_path, points, count))
    return samples
