# SkyGuard V7.4 最终交付

> 版本：`v7.4.0-research.1`（`VERSION`）。日期：2026-11-10。
> 最终证据：`evaluation/v74/v74-final-20261110T105851/`（31 文件，2.9 MB）。
> 工作区状态：未提交、未推送、未打标签（按规则）。分支未切换。

## 1. 交付判定

| 目标 | 判定 | 证据/说明 |
| --- | --- | --- |
| 执行感知稳定性门控 | **VERIFIED（有界）** | 零容差拒绝全部候选；1min/2000 门控切换 −52%，+0.575min/+862 队列 |
| Pareto 份额扫描 | **VERIFIED（有界）** | F 策略 1837.66 vs 3820.75，Holm p<0.05；未疏散 3.81 |
| 风险触发承诺释放 | **PARTIALLY VERIFIED** | 2.62 次释放/场景；未疏散 2.87 |
| 区域选择性承诺 | **PARTIALLY VERIFIED** | 代码+单测存在，未进入 A-F 评测 |
| 风险敏感惩罚 | **NOT SUPPORTED（负结果）** | 与 V7.3 自适应 240/240 相同 |
| 动态容量容量安全 | **VERIFIED（合成）** | MPC 变体容量违规 0；静态 6.43/场景 |
| 更强预测基线 | **PARTIALLY VERIFIED** | 现有基线保留；未新增 ARIMA/Holt-Winters/神经基线 |
| Surge/regime 检测 | **VERIFIED（合成）** | CUSUM 100% vs 3σ 76.7%/73.3% |
| 跨数据集/真实数据 | **BLOCKED** | 无真实视频/轨迹；仅有合成与夹具 |
| 标定质量（时钟/缺失/可靠性/动态计划） | **VERIFIED（夹具）** | 90s 偏移拒绝、110s 缺失检测、代理可靠性、计划校验 |
| AgentArts 适配器 | **PARTIALLY VERIFIED** | 契约/SSE/会话/幂等/重试/trace；真实平台 `not_configured` |
| AgentArts 实机集成 | **BLOCKED** | 无租户/凭证；未发平台请求 |
| Ascend ONNX/CPU | **VERIFIED（CPU）** | checker valid，p50 0.0112ms，max_abs_diff 0 |
| Ascend NPU/CANN/OM | **BLOCKED** | 无 `npu-smi`/`atc`；OM 未执行 |
| 安全红队 | **VERIFIED** | 4+5+1 回归；283/283 |
| Docker 部署 | **BLOCKED** | daemon 不可用；未构建，不声称镜像可用 |
| CI | **VERIFIED（静态）** | YAML 解析 ok；实际运行需平台 |
| API 契约 | **VERIFIED** | 3/3 HTTP 200 |
| 浏览器 E2E | **VERIFIED（冒烟）** | 登录→指挥中心→代理 API；0 console/page error |
| 负载 | **PARTIALLY VERIFIED** | 本地状态端点 p95 7.3ms；非规划吞吐 |
| 可复现 demo（8 场景） | **VERIFIED（既有）** | `npm run demo`/`demo:mvp`；V7.4 未回归 |
| 文档交付 | **VERIFIED** | 本文件及配套报告 |
| 证据完整性 | **VERIFIED** | 31 文件清单；166/166；V7.2 快照 299 文件 |

## 2. 实现前 → 后

| 项目 | V7.3 | V7.4 |
| --- | --- | --- |
| 稳定性机制 | 自适应惩罚/承诺/振荡 | + 执行门控 + Pareto 份额 + 风险释放 + 区域选择性 |
| 切换（240 样本均值） | 1369.01（自适应） | 1837.66（Pareto）/ 1369.01（自适应） |
| 完成时间 | 10.879 | 10.492（Pareto）/ 10.879（自适应） |
| 容量口径 | 规划/执行/复核一致 | 不变，新增动态计划校验 |
| 标定质量 | 导入/映射 | + 时钟同步/缺失/可靠性/动态容量 |
| 检测 | CUSUM+spike | + 与 3σ 的 30 种子对照证据 |
| 生产检查 | 手工 | 脚本化 Docker/CI/API/负载/E2E |
| 红队 | V7.3 项 | + 门控/Pareto/动态容量/时钟 |

## 3. 负结果与失败

1. **零代价稳定性不成立**：严格门控拒绝全部候选；
2. **风险敏感惩罚无效**：与 V7.3 逐样本相同；
3. **Docker 未验证**：daemon 不可用；
4. **AgentArts 未接入**：无凭证；
5. **昇腾 NPU/OM 未验证**：无硬件/CANN；
6. **noisy 机制检测率 0**：CUSUM 与 3σ 均失效；
7. **动态容量场景稳定性收益缩小**：切换仅 −4.7%（自适应）。

## 4. 优先级清单

### P0（阻断交付）
- 无。

### P1（应在对外陈述前处理）
- 真实场馆/授权数据缺失 → 所有效果限定为合成；
- AgentArts 租户与昇腾硬件缺失 → 比赛材料必须分栏标注；
- 风险折扣/区域选择性承诺未被公平评测 → 主张降级。

### P2（工程完善）
- Pareto 求解延迟优化（40.9ms/步）；
- Docker 镜像与容器部署；
- 浏览器 E2E 扩展到写操作与异常路径；
- 真实拓扑的容量标定与时钟同步。

## 5. 华为生态状态

- **AgentArts**：适配器完成契约、SSE、会话头、幂等键、受限重试、trace 关联、工具权限门与人工审批；
  本地 stub 通过；真实平台 `not_configured`。**不得表述为「已接入 AgentArts」**。
- **Ascend/CANN/MindSpore**：ONNX 导出与 checker 通过；CPUExecutionProvider 基准完成；
  ATC 模板与 OM 元数据模板存在但未执行。**不得表述为「昇腾 NPU 验证」**。

## 6. 验证记录

| 命令 | 结果 |
| --- | --- |
| `npm test` | 后端 283/283，前端 17/17 |
| `npm run build` | 通过 |
| `npm run demo` | 通过 |
| `npm run demo:mvp` | 通过 |
| `npm run benchmark:v74 --prefix backend` | 31 文件证据 |
| `npm run verify:evidence --prefix backend` | 166/166 |
| `npm run freeze:verify:baseline`（V7.2） | 299 文件通过 |
| `frontend/e2e/smoke.mjs` | 通过 |

## 7. 变更规模

- 已跟踪文件：25 个，+2033 / −82 行（含 V7.2/V7.3 累积改动）；
- V7.4 新增源码/脚本：`v74-*.ts` 7 个（约 1610 行）、`calibration/quality.ts` 265 行、
  测试 2 个（196 行）、`frontend/e2e/smoke.mjs` 100 行；
- 证据：`evaluation/v74/` 下最终运行 31 文件，另有开发运行目录；
- 未提交/未推送/未打标签，符合规则。

## 8. 外部资源

- Node 24.19；Python 3.13.7；onnxruntime 1.29.0（CPU）；Playwright 1.65；
- 未使用真实场馆视频、授权数据、AgentArts 租户、昇腾硬件；
- 未访问付费数据或云 GPU。

## 9. 竞赛就绪度（诚实评估）

- **可演示**：端到端登录、指挥中心、安全四态、审批工单、稳定性对比、检测对比、证据清单；
- **可复现**：一条命令生成证据，离线可跑；
- **可辩护**：合成边界、负结果、阻塞项均有书面记录；
- **不足以宣称**：真实场景效果、平台实机、NPU 加速、生产级部署；
- **建议对外口径**：研究原型 + 可复现实验 + 明确阻塞，而非「已落地」。

## 10. 复现入口

```bash
npm test
npm run build
npm run demo
npm run demo:mvp
npm run benchmark:v74 --prefix backend
npm run verify:evidence --prefix backend
```
