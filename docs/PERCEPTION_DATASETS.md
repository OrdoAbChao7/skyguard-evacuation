# 感知数据集与评测接入说明

> 本仓库当前**没有**带标注的人群视频/图像数据，因此不能报告计数准确率。
> 本文件只定义接入路径与评测口径，不包含任何虚构指标。

## 1. 公开数据源（详见 research/SOURCES.jsonl）

| 数据集 | 入口 | 用途 | 许可 |
| --- | --- | --- | --- |
| NWPU-Crowd | https://www.crowdbenchmark.com/nwpucrowd.html | 大规模计数/定位 | 见数据集页面 |
| ShanghaiTech | https://www.crowdbenchmark.com/shanghaitech.html | 经典计数基准 | 见数据集页面 |
| P2PNet 官方实现 | https://github.com/TencentYoutuResearch/CrowdCounting-P2PNet | 点定位模型 | 见仓库 LICENSE |

> 未下载上述数据到仓库；使用前必须确认许可、隐私与本地存储政策。

## 2. 标注与目录约定（建议）

```text
data/perception/<dataset>/
  images/                 # 原始帧（不入库）
  annotations/*.json      # {image, width, height, points:[[x,y],...]}
  splits/{train,val,test}.json
  LICENSE.txt
```

## 3. 评测脚本契约（待实现）

- 输入：视频/图像、区域 ROI、像素→平方米标定；
- 输出：每个区域的 count、density、confidence、model_version、provider；
- 指标：MAE、RMSE、NAE；定位任务加 precision/recall/F1；
- 必须报告数据来源、划分、许可、失败案例；不得跨数据集混报。

## 4. 当前 CPU 视频路径的边界

`backend/python/crowd_service.py` 使用帧差/MOG2 + 连通域：

- 过计数：目标边缘被拆成两块；
- 欠计数：人群粘连、高密度只给下界；
- 误检：车辆、影子、飘动物；
- 依赖固定机位与稳定光照；
- 无标注验证，**不得声称准确率**。

## 5. 接入步骤

1. 选择数据集并确认许可；
2. 建立上述目录与标注格式；
3. 实现 `CrowdInferenceProvider` 适配器（P2PNet/CSRNet 或现场专用模型）；
4. 在验证集上评测 MAE/RMSE，保存原始结果到 `evaluation/perception/`；
5. 现场标定摄像机，更新场景 `calibration_status/version`；
6. 在文档中区分 measured / estimated / simulated。
