# 人群感知研究（真实数据）

> 目标：把 SkyGuard 的人群感知从“合成/CPU 运动前景”推进到**公开真实数据集可复现评测**。
> 本文件只陈述已核验事实与已运行结果；未获取的数据/权重明确标为未验证。

## 1. 数据集

| 数据集 | 规模/划分 | 标注格式 | 获取状态 | 许可状态 |
| --- | --- | --- | --- | --- |
| ShanghaiTech Part A | 300 train / 182 test | `.mat` 人头点坐标 | **已获取并运行 test** | **UNVERIFIED**：压缩包无显式 LICENSE；研究用途，不再分发 |
| ShanghaiTech Part B | 400 train / 316 test | 同上 | 随压缩包获取，未评测 | 同上 |
| NWPU-Crowd | 5,109 图 / 2.13M 标注 | 官方格式（点/计数） | **未获取**（官方站点在本网络不可达） | UNVERIFIED |
| UCF-QNRF | 1,535 图 / 1.25M 标注 | `.mat` 点标注 | **未获取** | UNVERIFIED |

- ShanghaiTech 数据来自 CSRNet 官方 README 引用的公开 Google Drive 链接；数据集不进入仓库，保存在 `E:/datasets/`。
- 未绕过登录、付费或访问限制；官方站点不可达时没有替代抓取。

## 2. 模型与权重

| 模型 | 官方实现 | 权重 | 许可 | 状态 |
| --- | --- | --- | --- | --- |
| P2PNet | `TencentYoutuResearch/CrowdCounting-P2PNet`（commit `5c91a81…`） | `weights/SHTechA.pth`（86,372,926 bytes，SHA-256 `506047…63f`） | Tencent academic-research-only | **CPU 推理已跑通** |
| CSRNet | `leeyeehoo/CSRNet-pytorch` | Google Drive（ShanghaiA/B） | 仓库无 LICENSE 元数据 | 未使用 |

- P2PNet 官方代码面向 torch 1.5；适配器显式处理：
  - `torchvision.__version__` 旧版本判断（0.29 被误读为 0.2）；
  - backbone 构造禁用 `pretrained=True` 下载，随后加载官方 checkpoint。
- 环境：Python 3.13.7、PyTorch 2.14.0+cpu、torchvision 0.29.1；机器有 RTX 4060 但当前 torch 为 CPU 版，**未安装/未验证 CUDA**。

## 3. 评测协议

- 官方 split：`part_A_final/test_data`，182 图，**不参与任何训练/调参**。
- 预处理：P2PNet 官方 resize 到 128 的整数倍；ImageNet 归一化；阈值 0.5。
- 计数：预测点数 vs GT 点数；MAE/RMSE/NAE。
- 定位：GT 点按 resize 比例缩放，半径 8 px 贪心匹配（仅诊断）。
- 延迟：仅模型前向；不含图片 I/O 与预处理；FPS=1000/mean_ms。
- 未做测试时自适应、未用 test 标签调阈值；无数据泄漏。

## 4. 已运行结果（ShanghaiTech Part A test，182 图）

| 指标 | 值 |
| --- | --- |
| MAE | **57.2418** |
| RMSE | **96.0415** |
| NAE | **0.1319** |
| 定位 F1 @8px | 0.7405 |
| 平均延迟 | 966.786 ms |
| p95 延迟 | 1582.897 ms |
| FPS | 1.034 |

- 第二遍独立复跑：182/182 张预测人数完全一致，MAE/RMSE 相同；延迟不同。
- 与论文 README 的 52.74 MAE 不直接可比；**不声称复现或超过论文**。

## 5. 接入 SkyGuard 的边界

```text
图像/视频 → P2PNet 计数 → 区域面积 → 密度估计 → 观测
→ 预测 → VoI → 风险 → 独立 Validator → 四态状态机
```

- 单张图像人数**不能**直接当单位面积密度：必须有区域面积与摄像机标定。
- 未标定输入：`to_region_observation` 将置信度压到 ≤0.35，SkyGuard 现有 `assessObservation` 会判为不可信 → `DEGRADED`，禁止发布路线。
- 多摄像头重叠：同一人可能被多个相机计数；需要空间去重/标定，本仓库未实现。
- 遮挡、视角、夜间、密度偏差：未做分层评测；不得声称鲁棒。
- Validator/状态机语义未改；感知失败不得绕过安全校验。

## 6. 未完成

- NWPU-Crowd / UCF-QNRF / ShanghaiTech B 评测；
- CSRNet 对照；
- 真实视频/摄像机标定/多摄像头去重；
- GPU/CUDA 与昇腾实机推理；
- 数据集许可证正式核验。
