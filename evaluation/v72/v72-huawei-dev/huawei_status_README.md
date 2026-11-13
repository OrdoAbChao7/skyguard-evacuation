# V7.2 华为生态集成状态

> 运行 ID：`v72-huawei-dev`。**不伪造平台/硬件结果**；无凭证、无 NPU 时明确标注阻塞。

## 1. AgentArts

### 1.1 真实平台

- 状态：not_configured
- 契约：official
- 缺失配置：AGENTARTS_BASE_URL、AGENTARTS_API_KEY、AGENTARTS_RUNTIME_NAME（或 AGENTARTS_AGENT_ID）
- 说明：没有真实 AgentArts 租户/凭证；未发起任何平台请求，不得声称已接入。

### 1.2 本地契约 stub（不是实机）

- 健康：{"mode":"AGENTARTS_CONNECTED","connectivity":"reachable","http_status":200}
- 决策：[{"tool":"camera_query","reasoning":"local stub decision","arguments":{"region_id":"R_NORTH_STAND"}},{"tool":"camera_query","reasoning":"local stub decision","arguments":{"region_id":"R_NORTH_STAND"}}]
- 会话头一致：true
- trace_id 不同：true

## 2. Ascend / CANN / ONNX

- npu-smi：{"available":false,"path":null}
- atc：{"available":false,"path":null}
- Python：{"onnx":{"available":true,"version":"1.23.2","error":null},"onnxruntime":{"available":true,"version":"1.29.0","error":null},"numpy":{"available":true,"version":"2.4.3","error":null}}
- ONNX 链路：executed_cpu_only
- CPU 基准文本：p50=0.0148ms，p95=0.028ms，max_abs_diff=0
- 边界：未检测到昇腾 NPU/CANN/atc；一切 NPU/OM 结果均为未验证。

## 3. 结论

- AgentArts：未接入真实平台（缺租户/凭证）；仅契约 stub。
- Ascend：无 NPU/CANN/atc；ONNX CPU 链路仅用于部署准备。
