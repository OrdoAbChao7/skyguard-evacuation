# CityStreet 人流地图接入示例

这份数据可以接入前端，用于验证地图热力、时间轴和区域查询。它是 C3 单机位的离线回放示例，距离最终交付还需要验证现场接入、地图定位和人流统计精度。

## 数据结构

`citystreet_display.json` 是数据入口，`orthophoto-z20.jpg` 是对应的航拍底图。两个文件放在同一目录。

```text
citystreet_display.json
├── map          底图文件名和尺寸，768 × 768 像素
├── zones[]      13 个区域的编号和边界
└── frames[]     60 帧，按 timestamp_ms 播放
    ├── people[]      逐人点位、临时轨迹 ID、速度和方向
    └── zone_stats[]  各区估计人数、速度中位数和方向人数
```

## 前端怎么接

- **时间轴和热力。** 按 `timestamp_ms` 切换当前帧，用 `people[].map_xy_px` 在底图上生成无框热力，点越密颜色越红。坐标为空的点跳过绘制。
- **区域查询。** 用 `zones[].map_polygon_px` 判断点中了哪个区域，再按 `zone_id` 读取当前帧的 `zone_stats`。显示该区估计人数、速度中位数，以及朝向路口、离开路口和方向未知的人数。点位和边界均以原始底图左上角为像素原点，缩放底图时同步缩放图层。
- **后续功能。** 区域人数表示这一帧区内估计有多少人。过线流量和未来预测属于后续功能，当前示例用于回放已观测数据。

第 2300 帧对应播放到第 5 秒。S-A 区估计有 4 人，其中 3 人有速度估计，中位速度为 1.963 m/s。方向统计为 1 人朝路口、2 人离开路口、1 人未知。地图使用近似配准，东侧两个目视检查点偏差约为 4.4 米和 5.3 米。

## 数据来源

- **相机画面**取自本地 CityStreet 数据包的 C3 机位，第 2280 至 2339 帧。CityStreet 原始数据由香港城市大学 VISAL 团队发布。[数据集发布页](https://scholars.cityu.edu.hk/en/datasets/wide-area-crowd-counting-multi-view-fusion-networks-for-counting-/)
- **JSON 中的点位和统计**由本项目对上述画面做头部检测、跟踪和近似地面投影后生成。时间按 4 Hz 换算，`timestamp_ms` 以片段起点为零。[人头检测模型](https://huggingface.co/Sharath33/Person)
- **航拍底图**来自香港地政总署。
