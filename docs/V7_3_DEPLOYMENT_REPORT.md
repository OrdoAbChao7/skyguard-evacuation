# SkyGuard V7.3 部署与集成报告

> 日期：2026-11-10。证据：`evaluation/v73/v73-final-20261110T101711/`。
> 结论先行：**AgentArts 未接入真实平台；Ascend 无 NPU/CANN/OM；当前只完成适配器/契约/CPU 链路与可验证状态。**

## 1. AgentArts

### 1.1 当前状态

| 项 | 值 |
| --- | --- |
| 真实平台状态 | `not_configured` |
| 契约 | `official` |
| 缺失配置 | `AGENTARTS_BASE_URL`、`AGENTARTS_API_KEY`、`AGENTARTS_RUNTIME_NAME`（或 `AGENTARTS_AGENT_ID`） |
| 本地 stub | 健康通过；SSE `data.text` 决策解析；会话头存在；重试复用幂等键 |
| 业务闭环 | **未验证**（无平台 Trace/工具回执/审批等待/反馈续接证据） |

### 1.2 已实现/已验证

- 官方运行时路径 `/runtimes/{runtime_name}/invocations`（可配置）；
- Bearer API key、项目头、invoke mode、会话头；
- SSE/JSON 响应解析；截断显式失败；
- 429/5xx/超时有界重试；
- **V7.3 幂等键**：`X-Idempotency-Key`（可配置 `AGENTARTS_IDEMPOTENCY_HEADER`），
  重试复用同一键；不同 trace 生成不同键；
- 工具决策必须经本地权限注册表；人工审批/反馈续接由既有运行时测试覆盖。

### 1.3 真实接入所需

1. 真实租户的 Base URL、API key、Runtime/Agent ID、project ID；
2. 以租户文档校准 `AGENTARTS_INVOKE_PATH` / `HEALTH_PATH` / session/idempotency 头；
3. 平台 Trace、工具回执、审批等待、反馈续接的脱敏证据；
4. 多步工作流与失败恢复的真实运行记录。

在此之前，任何“已接入 AgentArts”的表述都不成立。

## 2. Ascend / CANN / ONNX

### 2.1 环境探测（最终运行）

| 项 | 值 |
| --- | --- |
| `npu-smi` | 不存在 |
| `atc` | 不存在 |
| CANN/ASCEND_HOME | 未设置 |
| ONNX | 1.23.2 |
| ONNX Runtime | 1.29.0 |
| ONNX checker | valid |
| ONNX SHA-256 | `3837d2523cc688c2b5a931dfa2b89830186527b11cee340047243a32cdd14baa` |
| CPU 推理 | p50 0.011ms，p95 0.0165ms，max_abs_diff 0 |
| OM 状态 | `not_executed_missing_atc_or_npu` |

### 2.2 已实现的部署链路

- `export_forecast_onnx.py`：12→5 参考模型导出，SHA-256/元数据；
- `benchmark_onnx.py`：ONNX checker + CPUExecutionProvider 基准 + 数值一致性；
- `validate_om_metadata.py`：拒绝“声称 NPU 但无 npu-smi/设备/驱动/CANN”的元数据；
- `deployment/om-metadata.ts`：同一规则的 TypeScript 校验与模板；
- `v73-ascend-pipeline.ts`：探测、导出、checker、CPU 基准、OM 模板、证据；
- `README.md`：ATC 命令模板与所需证据清单。

### 2.3 ATC 转换（未执行）

```bash
atc --model=forecast_linear.onnx \
    --framework=5 \
    --output=forecast_linear \
    --soc_version=<SOC> \
    --input_shape="history:1,12" \
    --log=error
```

必须记录：设备型号、驱动/CANN/atc 版本、ATC 完整日志、`.om` SHA-256、
NPU p50/p95/内存/吞吐、CPU↔NPU 数值一致性。缺一不可标记 `npu_verified`。

## 3. 部署就绪度

| 维度 | 状态 |
| --- | --- |
| 后端/前端构建 | 通过（见最终报告） |
| 安全 demo/MVP demo | 通过 |
| Shadow | 默认关闭、ready-for-review |
| AgentArts 适配器 | 完成；真实平台未接入 |
| ONNX 导出/CPU | 完成 |
| OM/NPU | 未执行 |
| 真实场馆 | 未提供 |
| Docker/CI | 未实跑 |

## 4. 外部资源清单

1. 真实场馆几何、容量、摄像机内外参与授权时序；
2. AgentArts 租户、凭证、平台 Trace；
3. 昇腾主机（310P/910B 等）、CANN/atc、可执行 OM；
4. Docker/CI 运行环境；
5. 第三方安全评审与现场演练。

## 5. 结论

V7.3 已完成所有当前环境可独立执行的部署准备与证据校验；
真实平台/硬件/场馆仍未验证，**不得宣称生产就绪或昇腾/AgentArts 实机成果**。
