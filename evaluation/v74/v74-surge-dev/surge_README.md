# V7.4 Surge/Regime 检测实验

> 运行 ID：`v74-surge-dev`。30 种子 × 4 机制 × 2 检测器；合成序列，不代表真实预测精度。

## 结果

| 检测器 | 机制 | 检测率 | 中位延迟 | 平均延迟 | 误报/100 步 |
| --- | --- | --- | --- | --- | --- |
| changepoint | stable | 0 | 0 | 0 | 0.6111 |
| changepoint | surge | 1 | 0 | 0 | 0 |
| changepoint | regime_shift | 1 | 0 | 0 | 0.3333 |
| changepoint | noisy | 0 | 0 | 0 | 0.7222 |
| naive3sigma | stable | 0 | 0 | 0 | 0.5556 |
| naive3sigma | surge | 1 | 0 | 0 | 0.3333 |
| naive3sigma | regime_shift | 1 | 0 | 0 | 0.3333 |
| naive3sigma | noisy | 0 | 0 | 0 | 0.5 |

## 解释

- 检测对象是相对基线的残差 (|value-300|)，不是疏散预测误差；
- stable 段误报率反映检测器噪声敏感性；
- 结果只用于选择门控策略，不得表述为真实人群突增检测精度。
