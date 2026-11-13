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

## 6. 感知回放展示包（已接入，demo_only）

`data/perception/citystreet-display/` 是一个**已落地的感知派生回放包**，用于验证前端时间轴、
热力与区域查询，并为"真实视频 → 跟踪 → 地面投影 → 区域统计"这条链路提供可回放的样本。

| 组成 | 说明 |
| --- | --- |
| `citystreet_display.json` | 60 帧（C3 机位 2280–2339）、13 个区域、逐人点位与 `zone_stats` |
| `PROVENANCE.json` | 来源、时间基、标定、真值状态、许可状态、已知误差、文件 SHA-256 |
| `PACKAGE_README.md` | 数据包原始说明（保留原始字节，纳入哈希） |
| `orthophoto-z20.jpg` | 航拍底图。**许可未确认，不随仓库分发**（`.gitignore`），需部署方本地提供 |

只读 API（无需鉴权，与其它读接口一致）：

```text
GET /api/v1/perception/displays                          # 摘要列表
GET /api/v1/perception/displays/:id                      # 底图坐标系、区域边界、来源与已知误差
GET /api/v1/perception/displays/:id/frames?from=&limit=   # 逐帧点位分页（limit 1–240）
GET /api/v1/perception/displays/:id/basemap               # 底图；缺失时 404 BASEMAP_NOT_BUNDLED
```

### 6.1 硬边界

- 展示包 schema（`people / frames / zone_stats`）与 `data/scenarios/*.json`
  （`zones / corridors / exits / capacity`）**没有任何映射关系**，不得进入规划器或独立校验器；
- 包在加载时做 zod 结构校验 + 跨字段一致性校验（区域引用、时间单调、方向人数不超过总人数、
  点位不越界），**任何一项不通过即整包 422 拒绝**，不做"跳过坏帧"的降级；
- 包内缺失 `PROVENANCE.json` 时只能上报 `license_status: UNKNOWN` 与 `provenance_complete: false`；
- 无逐帧真值，**不得**据此计算或宣称 MAE/RMSE/F1；
- 航拍底图许可未确认，缺失时前端退回无底图坐标系，**不得**用占位图冒充真实底图。

### 6.2 与"真实精度"的距离

本包是**派生显示数据**，回答了"链路能否跑通、前端能否正确展示"，**没有**回答
"人数估计有多准"。补齐真值需要：C3 机位逐帧人工标注 → 用 `matchPoints`/`countMetrics`
评测 → 结果落到 `evaluation/perception/`，并在 `research/CLAIMS.md` 登记后才可升级主张等级。
