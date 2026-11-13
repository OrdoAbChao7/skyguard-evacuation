# V7.4 标定质量证据

> 运行 ID：`v74-final-20261110T105851`。合成观测/夹具；无真实场馆数据。

## 1. 时钟同步

- 接受：3；拒绝：1
  - provider-slow: clock_skew_exceeds_limit (90s)

## 2. 缺失区间

- R_NORTH_STAND: 2026-11-10T01:03:00.000Z → 2026-11-10T01:04:50.000Z（110s，预期缺失 1 条）

## 3. 传感器可靠性（代理分数，不是准确率）

| provider | 观测数 | 区域 | 可用性 | 平均置信度 | 稳定性代理 | 可靠性 |
| --- | --- | --- | --- | --- | --- | --- |
| provider-a | 2 | 1 | 0.4 | 0.935 | 0.9218289085545723 | 0.3447 |
| provider-b | 1 | 1 | 0.2 | 0.7 | 1 | 0.14 |

## 4. 观测质量

- 覆盖：0.125；缺失区域：R_SOUTH_STAND,R_WEST_STAND,R_EAST_STAND,R_NORTH_CONCOURSE,R_SOUTH_CONCOURSE,R_EAST_PLAZA,R_WEST_PLAZA；
- 过期：1；低置信度：0；无效：0；重复时间戳：0。

## 5. 动态容量计划

- 校验：错误 0，警告 0
- 示例：t=5 corridor=0.5，t=12 exit=0.7，t=20 corridor=1

## 6. 边界

- 可靠性不是准确率；无真实 ground truth；
- 时钟偏移和容量计划都是合成演练参数；
- 不得表述为真实标定。
