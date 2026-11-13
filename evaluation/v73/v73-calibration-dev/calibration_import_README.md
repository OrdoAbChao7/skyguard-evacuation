# V7.3 场馆/观测导入流水线证据

> 运行 ID：`v73-calibration-dev`。数据性质：**synthetic**。
> 合成档案 + CSV 测试夹具；public/authorized 适配器只验证契约，不代表真实数据或许可。

## 1. 场景导入

- Schema 有效：true
- 拓扑错误：0；警告：0

## 2. 标定档案

- 校验：true；错误 0；警告 0
- 来源计数：{"uncalibrated":42,"estimated":4}
- 约束比较：错误 0；警告 0

## 3. CSV 观测

- 解析行：4；解析错误：0
- replay 接受：4；live 接受：4
- live 拒绝原因：无

## 4. 视频接口

- 接受：1；拒绝：stale_observation
- 说明：输入是已计数的帧，不是原始视频；不做 CV，不宣称计数精度。

## 5. 公开/授权适配器

- 公开数据集：接受 2；错误 0；
  数据性质证据：public_dataset
- 授权真实数据：接受 2；来源 field_report；
  错误 0

## 6. 方向性容量

- C_N_STAND：forward ×0.60，reverse ×0.40

## 7. 结论与边界

- 导入、校验、replay/live、视频计数、公开/授权适配器、方向性容量与约束均有可运行路径；
- **没有真实场馆/摄像机/授权数据**；fixtures 不是真实测量；
- 不得把本证据表述为真实标定或真实数据集验证。
