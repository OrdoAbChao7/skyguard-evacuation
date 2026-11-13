# V7.2 场馆标定流水线证据

> 运行 ID：`v72-calib-dev`。数据性质：**synthetic**。
> 合成档案与合成样本；估计值被降级为 estimated，不代表真实场馆标定。

## 1. 档案校验

- 有效：true
- 错误：0；警告：0
- 覆盖：8 区域 / 11 通道 / 4 出口 / 8 相机
- 来源计数：{"uncalibrated":42,"estimated":4}




## 2. 应用结果

- 档案版本：1.0.1+profile.stadium-synthetic-calibration.1.0.0
- 变更 0 项，阻止 0 项



## 3. 参数估计（合成样本）

| 出口 | 名义容量 | 估计值 | 来源等级 | 95% CI | 样本 |
| --- | --- | --- | --- | --- | --- |
| E_NORTH | 200 | 198.25 | estimated | [194.0941, 202.4059] | 16 |
| E_SOUTH | 200 | 203.5625 | estimated | [198.89, 208.235] | 16 |
| E_EAST | 260 | 258.5 | estimated | [253.4551, 263.5449] | 16 |
| E_WEST | 260 | 257.9375 | estimated | [252.3236, 263.5514] | 16 |

- 步行速度：1.172 m/s（estimated，n=16）
- 结论：合成数据即使统计稳定也不得标记 calibrated；真实标定需要授权实测样本。

## 4. 观测适配器

| 用例 | 接受 | 拒绝原因 | 来源 | 标定版本 |
| --- | --- | --- | --- | --- |
| fresh_live | true | - | live_video | camera-count-r_north_stand |
| stale | false | stale_observation | - | - |
| low_confidence | false | low_confidence | - | - |

## 5. 边界

- 未接入真实摄像机、真实场馆时序或授权数据；
- 参数估计只用于演示流水线行为，不得用于真实疏散指挥；
- 应用标定会改变场景版本，使既有计划失效；默认演示不落盘场景。
