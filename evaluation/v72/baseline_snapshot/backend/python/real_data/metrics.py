"""Counting and localization metrics with explicit definitions."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import numpy as np


@dataclass
class CountPair:
    image: str
    ground_truth: int
    predicted: int


def count_metrics(pairs: Iterable[CountPair]) -> dict:
    items = list(pairs)
    if not items:
        return {"n": 0, "mae": None, "rmse": None, "nae": None}
    errors = np.array([abs(p.predicted - p.ground_truth) for p in items], dtype=np.float64)
    gt = np.array([p.ground_truth for p in items], dtype=np.float64)
    gt_sum = float(gt.sum())
    return {
        "n": len(items),
        "mae": round(float(errors.mean()), 4),
        "rmse": round(float(np.sqrt((errors ** 2).mean())), 4),
        "nae": round(float(errors.sum() / gt_sum), 4) if gt_sum > 0 else None,
        "mean_gt": round(float(gt.mean()), 4),
        "mean_pred": round(float(np.mean([p.predicted for p in items])), 4),
    }


DEFAULT_BINS = [0, 50, 100, 200, 500, 10**9]


def density_bin_metrics(pairs: Iterable[CountPair], bins: list[int] | None = None) -> list[dict]:
    items = list(pairs)
    edges = bins or DEFAULT_BINS
    out = []
    for low, high in zip(edges[:-1], edges[1:]):
        subset = [p for p in items if low <= p.ground_truth < high]
        if not subset:
            out.append({"low": low, "high": high, "n": 0, "mae": None})
            continue
        errors = [abs(p.predicted - p.ground_truth) for p in subset]
        out.append({
            "low": low,
            "high": None if high >= 10**9 else high,
            "n": len(subset),
            "mae": round(float(np.mean(errors)), 4),
        })
    return out


def match_points(gt_points: np.ndarray, pred_points: np.ndarray, radius: float) -> dict:
    """Greedy nearest-neighbour matching at a fixed radius (localization diagnostic)."""
    gt = np.asarray(gt_points, dtype=np.float64).reshape(-1, 2)
    pred = np.asarray(pred_points, dtype=np.float64).reshape(-1, 2)
    used = set()
    tp = 0
    for point in gt:
        best = -1
        best_dist = float("inf")
        for index, candidate in enumerate(pred):
            if index in used:
                continue
            distance = float(np.hypot(candidate[0] - point[0], candidate[1] - point[1]))
            if distance <= radius and distance < best_dist:
                best, best_dist = index, distance
        if best >= 0:
            used.add(best)
            tp += 1
    fp = len(pred) - tp
    fn = len(gt) - tp
    precision = tp / len(pred) if len(pred) else (1.0 if len(gt) == 0 else 0.0)
    recall = tp / len(gt) if len(gt) else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "tp": tp, "fp": fp, "fn": fn,
        "precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4),
        "radius_px": radius,
    }
