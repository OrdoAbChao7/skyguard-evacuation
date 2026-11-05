"""Convert real-data counting output into SkyGuard observation payloads.

Important: a raw image count is NOT a calibrated density. Callers must provide
region area and camera calibration provenance; uncalibrated input is forced to
low confidence so SkyGuard's existing DEGRADED/untrusted semantics apply.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ImageEstimate:
    image_id: str
    count: int
    confidence: float
    model_version: str
    weights_sha256: str | None = None


def to_region_observation(
    estimate: ImageEstimate,
    *,
    region_id: str,
    area_m2: float,
    camera_id: str,
    calibration_status: str,
    area_provenance: str = "estimated",
    observed_at: str,
    calibration_version: str = "uncalibrated",
) -> dict:
    if area_m2 <= 0:
        raise ValueError("area_m2 must be positive")
    if not 0 <= estimate.confidence <= 1:
        raise ValueError("confidence must be in [0, 1]")
    calibrated = calibration_status in {"measured", "calibrated"}
    confidence = estimate.confidence if calibrated else min(estimate.confidence, 0.35)
    density = estimate.count / area_m2
    return {
        "region_id": region_id,
        "observed_at": observed_at,
        "estimated_count": int(estimate.count),
        "estimated_density": round(density, 4),
        "density_unit": "persons/m2",
        "confidence": round(confidence, 4),
        "source": "recorded_video",
        "provider": "p2pnet",
        "model_version": estimate.model_version,
        "calibration_version": calibration_version,
        "calibration_status": calibration_status,
        "area_provenance": area_provenance,
        "valid": True,
        "evidence": {
            "image_id": estimate.image_id,
            "weights_sha256": estimate.weights_sha256,
            "note": "image count converted using configured region area; not a field measurement",
        },
        "notes": [
            "Single image count is not a calibrated area density." if not calibrated else "Calibrated camera/area mapping required for trusted density.",
            "Overlapping cameras may double count the same person.",
        ],
    }
