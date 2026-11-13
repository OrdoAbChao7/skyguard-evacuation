# V7.2 场馆标定流水线使用说明

> 代码：`backend/src/services/safety/calibration/venue-calibration.ts`
> 示例档案：`data/venues/stadium-synthetic-profile.json`（**合成、未标定**）
> 证据脚本：`backend/scripts/v72-venue-calibration.ts`（`npm run benchmark:v72 -- --only=calibration`）

## 1. 档案结构

`VenueProfile` 包含：

- `regions[]`：面积、在留容量、相机 ID；
- `corridors[]`：端点、容量、通行秒数；
- `exits[]`：所属区域、容量；
- `cameras[]`：ROI、标定状态/版本、传感器元数据；
- `flow`：步行速度、BPR a/b、出口服务队列尺度；
- `observation_adapters[]`：适配器类型、相机→区域映射、标定版本；
- `data_nature`：`synthetic | public_dataset | authorized_real | mixed`。

每个参数是 `CalibratedValue`：

```json
{
  "value": 1.25,
  "unit": "m/s",
  "provenance": "estimated",
  "source": "synthetic stadium scenario",
  "method": "通用经验值；未用本场馆样本估计",
  "measured_at": null,
  "samples": 0,
  "confidence_interval": null
}
```

## 2. 校验规则

- 引用完整性：区域/通道/出口/相机 ID 必须存在；
- ROI 必须在 [0,1]；
- 容量/面积/通行时间必须为正（容量可为 0 但不得为负）；
- `measured/calibrated` 必须有来源、方法、时间；`calibrated` 还需 ≥5 样本与置信区间；
- **synthetic 档案不得包含 measured/calibrated**；
- `unknown` 参数不会被应用。

## 3. 应用与版本

`applyVenueProfile(scenario, profile)`：

- 返回新场景对象，不修改输入；
- 逐项记录 `before/after/provenance/source`；
- 新版本为 `原版本+profile.<profile_id>.<version>`；
- 版本变化会使既有计划失效，必须重新规划与校验。

## 4. 参数估计

- `estimateServiceRate(samples, source, dataNature?)`：吞吐率均值 + 1.96·SE；
- `estimateWalkingSpeed(samples, source, dataNature?)`：距离/时间均值；
- n≥10 且 CV≤0.3 才允许 `calibrated`；传 `dataNature` 时合成/公开数据会被降级；
- 样本不足只给 `estimated` 并写明原因。

## 5. 观测适配

`adaptCameraCount(input, scenario, { now, source })`：

- 接受 `simulation / recorded_video / live_video`；
- 拒绝 `unknown_region`、`camera_offline`、`invalid_count`、`low_confidence`、
  `stale_observation`、`timestamp_in_future`、`invalid_timestamp`；
- 保留相机标定版本与 provider/model 版本。

## 6. 真实标定的必要证据

1. 场馆平面图与区域面积测绘（含坐标系/比例尺）；
2. 通道/出口容量现场观测（至少 30 分钟高峰样本）；
3. 摄像机内参/外参、安装高度、俯仰角、ROI；
4. 人群速度与出口服务率样本（n≥10，记录时间/地点/天气/活动类型）；
5. 数据授权与隐私合规说明；
6. 标定版本、变更清单与回滚方案。

缺少任何一项时，参数必须保持 `estimated/uncalibrated`，不得用于真实疏散指挥。
