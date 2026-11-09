# Real dataset evaluation · ShanghaiTech part_B_final/test_data

- Model: P2PNet (SHTechA weights)
- Images: 316
- MAE: 22.1614
- RMSE: 34.0471
- NAE: 0.1786
- FPS (model forward only): 0.691
- Mean inference: 1448.152 ms (p95 1553.947)
- Localization F1 @8.0px: 0.7052

## Density bins (by GT count)

| GT range | images | MAE |
| --- | --- | --- |
| 0-50 | 60 | 4.4833 |
| 50-100 | 109 | 9.3853 |
| 100-200 | 97 | 25.4639 |
| 200-500 | 47 | 60.0426 |
| 500-None | 3 | 139.6667 |

## Environment

- Python 3.13.7 / Torch 2.14.0+cpu / device cpu
- Repo commit: 5c91a81ca062b1c7fd3db3ad1c55b1c21f0a7455
- Weights SHA-256: 506047732b128ff09efef18e94bfacbe35fcfef300e5e9eeeece259b0488c63f

## Boundaries

- Public dataset result, not a real venue measurement.
- Dataset/weights are not redistributed; license must be verified.
- Compatibility patches are documented in the adapter; no accuracy claim beyond this split.
