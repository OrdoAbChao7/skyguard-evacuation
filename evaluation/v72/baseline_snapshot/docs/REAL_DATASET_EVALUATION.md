# 真实数据集评测说明

## 1. 已运行实验

- 数据集：ShanghaiTech Part A 官方 test split（182 图）
- 模型/权重：P2PNet 官方 SHTechA 权重（CPU）
- 结果：MAE **57.2418**、RMSE **96.0415**、NAE **0.1319**
- 平均模型前向延迟 **966.786 ms**，p95 **1582.897 ms**，FPS **1.034**
- 定位 F1 @8px **0.7405**
- 复跑：182/182 张预测人数一致，MAE/RMSE/NAE 完全一致

> 这是**公开数据集 + 官方权重**的结果，不是 SkyGuard 自训练模型，也不是真实场馆实测。

## 2. 复现命令

```powershell
python -I backend/python/real_data/run_p2pnet_eval.py `
  --dataset-root E:/datasets/shanghaitech/extracted `
  --part part_A_final --split test_data `
  --repo E:/datasets/P2PNet `
  --weights E:/datasets/P2PNet/weights/SHTechA.pth `
  --output evaluation/real-data

python -I backend/python/real_data/verify_results.py
python -I -m unittest discover -s backend/python/real_data/tests -p "test_*.py"
```

- 数据/权重位于仓库外；仓库只保存脚本、配置、结果与哈希。
- `evaluation/real-data/MANIFEST.json` + `SHA256SUMS` 校验证据完整性。

## 3. 结果文件

| 文件 | 内容 |
| --- | --- |
| `evaluation/real-data/RESULTS.json` | 182 图 per-image 结果、指标、延迟、环境 |
| `evaluation/real-data/REPORT.md` | 人类可读报告 |
| `evaluation/real-data/VERIFICATION.json` | 从 per-image 复算 6/6 |
| `evaluation/real-data/REPRODUCIBILITY.json` | 二次复跑比较 |
| `evaluation/real-data/repeat/RESULTS.json` | 第二遍原始结果 |
| `evaluation/real-data/CONFIG.json` | 数据/权重/环境/命令 |
| `evaluation/real-data/TEST_RESULTS.json` / `test_results.tsv` | 本轮测试与退出码 |
| `evaluation/real-data/MANIFEST.json` / `SHA256SUMS` | 9 个证据文件的 SHA-256 |

## 4. 方法与边界

- 官方 split，未训练、未用 test 标签调阈值；阈值固定 0.5（官方 demo 默认）。
- 预处理为 P2PNet 官方 resize（128 倍数）与 ImageNet 归一化。
- GT 计数取 `.mat` 中 `image_info.location` 点数；定位在 resize 坐标按 8 px 半径匹配。
- 延迟只测模型前向；CPU 结果不代表昇腾/GPU 性能。
- 数据集压缩包无显式 LICENSE；**许可状态 UNVERIFIED**，仅研究使用，不再分发。
- 单一数据集/单一权重；不能外推为真实场地精度。

## 5. 对 SkyGuard 的意义

- 证明感知评测流水线能在**真实公开标注数据**上端到端运行，而非只有合成/工具测试。
- 证明数字可从 per-image 原始结果复算，且二次运行确定性一致。
- 仍未证明真实场馆精度：需要 NWPU/UCF-QNRF、真实视频、摄像机标定与多摄像头去重。
