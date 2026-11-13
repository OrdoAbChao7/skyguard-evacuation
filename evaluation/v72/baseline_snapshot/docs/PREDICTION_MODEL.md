# 短时人流预测模型（adaptive-forecast-v3）

> 实现：`backend/src/services/mvp/prediction.ts`  
> API：`GET /api/v1/mvp/predictions/:regionId?horizon_minutes=5`  
> 工具：`predict_crowd_trend`  
> 基准：`evaluation/competition/experiment_b_prediction.json`

## 1. 为什么升级

v1/v2 固定使用 EMA+线性的 0.5 混合，在突增场景被“持久化”基线击败。
v3 不再预设赢家：用滚动验证在多个方法中选择，并单独校准区间。

## 2. 方法集合

| 方法 | 说明 |
| --- | --- |
| `persistence` | 保持最近一次可信人数（突增时最稳） |
| `ema` | 指数平滑（α=0.4） |
| `linear` | 最小二乘线性外推 |
| `damped` | EMA 水平 + 阻尼趋势（φ=0.8），抑制线性过冲 |
| `blend` | EMA 与当前趋势按滚动验证权重混合，再线性外推 |

## 3. 选择与区间

1. 取窗口内 `valid=true` 且 `confidence >= min_confidence` 的点；
2. **方法选择**：对最后 3 个历史点做一步回测，选验证 MAE 最小的方法；
3. **区间校准**：对所选方法做历史 h 步回测，取误差 95 分位 × 1.5 保守系数；
4. 数据不足（<3 点或跨度 <120 秒）→ 回退最近有效观测，不伪造趋势。

> 1.5 是工程保守系数，不是正式统计校准；覆盖率仍未达 95%。

## 4. 输出

```json
{
  "algorithm": "adaptive-forecast-v3",
  "current_count": 420,
  "predicted_count": 529,
  "interval": { "lower": 500, "upper": 558 },
  "trend": { "direction": "rising", "rate_per_minute": 25 },
  "selection": {
    "method": "damped",
    "selected_by": "rolling_validation",
    "candidates": [{ "method": "persistence", "validation_mae": 24.1, "validation_q95": 60.2 }]
  },
  "interval_calibration": 2.1,
  "sufficient": true,
  "uncertainty_note": "……"
}
```

## 5. 实验（5 种子 × 150 合成序列）

| 窗口 | 持久化 MAE | EMA MAE | 线性 MAE | 自适应 MAE | 区间覆盖率 | 峰值误差 |
| --- | --- | --- | --- | --- | --- | --- |
| 2 分钟 | 23.6 | 39.5 | 77.6 | 25.1 | 91.5% | 15.8 |
| 5 分钟 | 58.5 | 66.1 | 102.8 | 59.5 | 84.1% | 18.2 |
| 10 分钟 | 83.4 | 78.6 | 98.3 | 79.7 | 79.1% | 29.6 |

**如实解读**：

- 合成序列包含高斯突增；线性外推严重过冲，持久化/EMA 更稳；
- 自适应方法在 2/5 分钟接近持久化，10 分钟略优；没有“全面最优”；
- 方法选择频率：2 分钟时约 75% 选持久化，说明模型在突变场景自知信息不足；
- 区间覆盖率 5/10 分钟仅 84%/79%，存在过度自信风险，不能用于安全告警阈值。

## 6. 边界

- 没有真实标注人流数据，不能声称真实 MAE/RMSE/覆盖率；
- 未建模天气、演出节奏、入口管控、拥堵反馈；
- 预测是辅助信息，不直接发布安全结论；
- 任何准确率主张必须等真实数据与现场标定。

## 7. V6.1 严格滚动验证（审计更正）

- 测试起点 30..39；每个起点只用过去数据重新选择方法与区间。
- 场景：stable / surge / decline / periodic / missing（前向填充）。
- 结果（5 种子 × 120 序列，窗口 2/5/10 分钟）：

| 场景 | 自适应 vs Persistence | 结论 |
| --- | --- | --- |
| stable | 自适应明显更好（如 5 分钟 MAE 6.20 vs 11.23） | 自适应占优 |
| decline | 自适应明显更好（5 分钟 6.86 vs 24.15） | 自适应占优 |
| missing | 自适应更好（5 分钟 7.21 vs 10.90） | 自适应占优 |
| surge | persistence 略优（5 分钟 140.22 vs 144.52） | 突增仍难预测 |
| periodic | persistence 略优（5 分钟 74.44 vs 72.12） | 周期峰值难外推 |

- 90%/95% 区间覆盖率随场景在约 78%–99% 波动；**未稳定达到名义覆盖率**。
- 因此：不能笼统宣称自适优于持久化；区间不得用于安全告警阈值。

完整数据：`evaluation/v61/experiment_c_strict_prediction.json`。

## 7. V7.0 研究级扩展（`ensemble_v70`）

> 实现：`backend/src/services/mvp/forecast-advanced.ts`  
> API：`GET /api/v1/mvp/v70/forecast/:regionId?horizon_minutes=5`  
> 实验：`evaluation/v70/<run>/prediction_*`（30 种子 × 7 机制 × 11 方法）

新增方法：

| 方法 | 说明 |
| --- | --- |
| `kalman` | 局部线性趋势状态空间模型，按实际时间间隔推进，输出预测方差 |
| `arima` | ARIMA(1,1,0)：一阶差分上拟合 AR(1)，累加还原 |
| `holt_winters` | 加性趋势 + 可选季节项；季节长度由去趋势自相关选择 |
| `lstm_online` | 单层 LSTM（隐藏 4、截断 BPTT(1)、确定性种子），轻量神经网络基线 |
| `ensemble_v70` | 状态感知候选筛选 + 验证误差指数权重 + split-conformal 区间 + Page-Hinkley 漂移放大 |

关键设计：

1. 候选模型按 regime（stable/surge/decline/periodic/noisy/mixed）筛选，但**不是**硬切换；
2. 权重来自训练窗口内滚动验证 MAE；
3. 区间使用历史残差的 split-conformal 分位，并按近期误差比与漂移检测放大；
4. 漂移检测 = Page-Hinkley 输入水平漂移 + 验证误差比；
5. 所有选择/校准只使用过去数据；目标点不参与。

实验结果（必须与负向结果一起引用）：

- 集成显著优于 persistence/EMA/linear/Kalman/在线 LSTM；
- 但显著劣于 ARIMA/Holt-Winters/旧 `adaptive-forecast-v3`；
- **没有单一方法全场景最优**：stable/missing/noisy 最佳为在线 LSTM，surge/periodic 为 Holt-Winters，
  decline 为 linear，regime_shift 为 ARIMA；
- surge 95% 覆盖率仅 0.748，**不得用于安全告警阈值**；
- regime 检测在 periodic/surge 上准确率有限，只能作为候选筛选提示；
- 旧 `adaptive-forecast-v3` 仍是安全主链路默认预测；V7 引擎通过研究 API 提供，不替换默认链路。
