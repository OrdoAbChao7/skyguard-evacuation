# 真实公开数据集评测报告 · ShanghaiTech Part A / test

> 数据：ShanghaiTech Part A 官方 test split（182 图）。  
> 模型：P2PNet 官方仓库 + 官方 `SHTechA.pth` 权重（CPU 推理）。  
> 这不是 SkyGuard 自训练模型，也不是真实场馆实测；仅代表该公开数据集/该权重/该实现下的结果。

## 1. 结果

| 指标 | 值 |
| --- | --- |
| 图片数 | 182 |
| MAE | **57.2418** |
| RMSE | **96.0415** |
| NAE（Σ\|pred−gt\|/Σgt） | **0.1319** |
| 平均 GT / 预测 | 433.9011 / 426.2418 |
| 定位 F1 @8px | 0.7405（P=0.7471, R=0.7339） |
| 平均推理延迟 | 966.786 ms |
| p95 延迟 | 1582.897 ms |
| FPS（仅模型前向） | 1.034 |

### 密度区间（按 GT 人数）

| GT 范围 | 图片数 | MAE |
| --- | --- | --- |
| 0–50 | 0 | — |
| 50–100 | 7 | 40.0000 |
| 100–200 | 36 | 17.8333 |
| 200–500 | 93 | 46.8172 |
| 500+ | 46 | 111.7826 |

## 2. 可复现性

- 第二次独立复跑：MAE/RMSE/NAE 完全一致，182/182 张图片预测人数完全相同；延迟不同（FPS 0.98 vs 1.03）。
- 记录：`REPRODUCIBILITY.json`、`repeat/RESULTS.json`。
- 结果数字由 `verify_results.py` 从 per-image 记录复算：6/6 通过。

## 3. 环境与兼容性

- Python 3.13.7、PyTorch 2.14.0+cpu、torchvision 0.29.1、CPU（RTX 4060 存在但当前 torch 为 CPU 版，CUDA 不可用）。
- P2PNet 官方代码面向 torch 1.5；适配器做了两项显式兼容：
  1. `torchvision.__version__` 版本判断（0.29 被旧代码误读为 0.2）；
  2. 构造 backbone 时禁用 `pretrained=True` 下载，随后加载官方 checkpoint。
- 权重 SHA-256：`506047732b128ff09efef18e94bfacbe35fcfef300e5e9eeeece259b0488c63f`。

## 4. 数据集与许可

- 数据来源：ShanghaiTech 数据集公开 Google Drive 链接（CSRNet 官方 README 引用）。
- 数据集压缩包内**未发现显式 LICENSE 文件**；许可证/使用条款状态 **UNVERIFIED**，仅用于研究，不在仓库中再分发。
- P2PNet 代码/权重为腾讯官方仓库，许可证为 academic-research-only（见仓库 LICENSE）；权重不随仓库分发。
- 数据与权重位于仓库外 `E:/datasets/`；仓库只保存配置、脚本、结果与哈希。

## 5. 与论文数字的关系

P2PNet 论文/README 在 ShanghaiTech Part A 报告 MAE 52.74（其官方评测设置）。
本次 57.24 是 CPU、当前预处理/阈值/实现下的结果，**不应表述为复现论文或超过论文**。

## 6. 限制

- 单一数据集、单一 split、单一权重；不能外推到真实场馆。
- 只有图像级计数；区域密度需要面积与摄像机标定。
- 未处理多摄像头重叠计数；未做遮挡/视角分层分析。
- 数据集许可未核验；发布/商用前必须确认。
