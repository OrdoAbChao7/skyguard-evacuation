# Real dataset evaluation · ShanghaiTech part_A_final/test_data

- Model: P2PNet (SHTechA weights)
- Images: 182
- MAE: 57.2418
- RMSE: 96.0415
- NAE: 0.1319
- FPS (model forward only): 0.98
- Mean inference: 1020.611 ms (p95 1714.774)
- Localization F1 @8.0px: 0.7405

## Density bins (by GT count)

| GT range | images | MAE |
| --- | --- | --- |
| 0-50 | 0 | None |
| 50-100 | 7 | 40.0 |
| 100-200 | 36 | 17.8333 |
| 200-500 | 93 | 46.8172 |
| 500-None | 46 | 111.7826 |

## Environment

- Python 3.13.7 / Torch 2.14.0+cpu / device cpu
- Repo commit: 5c91a81ca062b1c7fd3db3ad1c55b1c21f0a7455
- Weights SHA-256: 506047732b128ff09efef18e94bfacbe35fcfef300e5e9eeeece259b0488c63f

## Boundaries

- Public dataset result, not a real venue measurement.
- Dataset/weights are not redistributed; license must be verified.
- Compatibility patches are documented in the adapter; no accuracy claim beyond this split.
