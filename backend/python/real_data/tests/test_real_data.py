import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image
import scipy.io as sio

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from metrics import CountPair, count_metrics, density_bin_metrics, match_points
from shanghaitech import load_part
from skyguard_adapter import ImageEstimate, to_region_observation


class MetricsTest(unittest.TestCase):
    def test_count_metrics(self):
        m = count_metrics([CountPair("a", 10, 12), CountPair("b", 20, 18)])
        self.assertEqual(m["mae"], 2.0)
        self.assertEqual(m["rmse"], 2.0)
        self.assertAlmostEqual(m["nae"], 4 / 30, places=4)

    def test_density_bins(self):
        bins = density_bin_metrics([CountPair("a", 40, 50), CountPair("b", 120, 100)])
        self.assertEqual(bins[0]["n"], 1)
        self.assertEqual(bins[2]["n"], 1)

    def test_match_points(self):
        result = match_points(np.array([[0, 0], [10, 10]]), np.array([[0, 1], [100, 100]]), 2)
        self.assertEqual(result["tp"], 1)
        self.assertEqual(result["fn"], 1)
        self.assertEqual(result["fp"], 1)


class LoaderTest(unittest.TestCase):
    def test_synthetic_mat_loader(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "part_A_final" / "test_data"
            (root / "images").mkdir(parents=True)
            (root / "ground_truth").mkdir(parents=True)
            Image.new("RGB", (4, 4), (0, 0, 0)).save(root / "images" / "IMG_1.jpg")
            info = np.empty((1, 1), dtype=[("location", "O"), ("number", "O")])
            points = np.array([[1.0, 2.0], [3.0, 4.0]])
            info[0, 0] = (points, 2)
            sio.savemat(root / "ground_truth" / "GT_IMG_1.mat", {"image_info": info})
            samples = load_part(Path(tmp), "part_A_final", "test_data")
            self.assertEqual(len(samples), 1)
            self.assertEqual(samples[0].count, 2)
            self.assertEqual(samples[0].points.shape, (2, 2))


class SkyGuardAdapterTest(unittest.TestCase):
    def test_uncalibrated_is_capped(self):
        payload = to_region_observation(
            ImageEstimate("img", 100, 0.95, "p2pnet", "abc"),
            region_id="R_EAST_STAND", area_m2=750, camera_id="CAM", calibration_status="uncalibrated",
            observed_at="2026-11-05T00:00:00Z",
        )
        self.assertLessEqual(payload["confidence"], 0.35)
        self.assertAlmostEqual(payload["estimated_density"], 100 / 750, places=4)

    def test_calibrated_keeps_confidence(self):
        payload = to_region_observation(
            ImageEstimate("img", 100, 0.9, "p2pnet"), region_id="R_EAST_STAND", area_m2=500,
            camera_id="CAM", calibration_status="calibrated", observed_at="2026-11-05T00:00:00Z",
        )
        self.assertEqual(payload["confidence"], 0.9)

    def test_invalid_area_rejected(self):
        with self.assertRaises(ValueError):
            to_region_observation(ImageEstimate("img", 1, 0.9, "m"), region_id="r", area_m2=0,
                                  camera_id="c", calibration_status="measured", observed_at="now")


if __name__ == "__main__":
    unittest.main()
