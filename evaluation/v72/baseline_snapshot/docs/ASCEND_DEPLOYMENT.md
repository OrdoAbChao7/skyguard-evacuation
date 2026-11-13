# 昇腾边云部署路径（设计与现状）

> **现状：未在任何真实昇腾设备上运行。** 本文件描述接入路径与验证清单，不是实机报告。

## 1. 当前实现

- `AscendCrowdProvider`：
  - 环境探针：CANN toolkit、`npu-smi`、`SKYGUARD_ASCEND_CMD`、`SKYGUARD_ASCEND_MODEL`；
  - 外部推理契约：stdin JSON → stdout JSON，Zod 校验；
  - 不可用时抛 `ProviderUnavailableError`，不伪造设备/延迟。
- 大屏 provider 状态会如实显示 `available=false`。

## 2. 目标架构

```text
摄像头/无人机 → 边缘节点（Ascend 310/310P/910B 等）
                   ├─ CANN 运行时
                   ├─ 人群计数模型（.om）
                   └─ skyguard ascend provider（stdin/stdout 或本地 HTTP）
                        │ 观测 JSON（count/confidence/model_version/device）
                        ▼
                 SkyGuard 后端（云端/边缘）
                   ├─ 观测可信度与风险
                   ├─ VoI / 预测 / 调度
                   └─ AgentArts（未实机验证）
```

## 3. 模型导出与转换（待执行）

1. 选择模型（P2PNet/CSRNet 或现场专用），在公开数据集训练/验证；
2. 导出 ONNX（记录 opset、输入尺寸、预处理）；
3. 使用对应 CANN 版本的 `atc` 转为 `.om`，记录命令与日志；
4. 核对算子兼容性（按芯片型号查官方兼容列表）；
5. 编写符合契约的推理程序：
   - 输入 `{region_id, camera_id, roi, video_path, model_path, max_frames}`；
   - 输出 `{ok, count, confidence, model_version, device}`；
6. 设置 `SKYGUARD_ASCEND_CMD` / `SKYGUARD_ASCEND_MODEL`；
7. 调用 `GET /api/v1/safety/providers` 确认 `ascend.available=true`。

## 4. 性能与可靠性采集（未执行）

- 单帧延迟、端到端延迟、吞吐（FPS）、内存/功耗；
- 连续运行稳定性、热降频、失败率；
- 与 CPU 基线的对比；记录硬件型号、CANN 版本、模型版本、输入尺寸；
- 任何数字必须来自实际设备日志，不能估算。

## 5. 回退策略

- NPU 不可用 → 视频路径回退 CPU MOG2（标记降级）→ 或模拟数据（标记 simulation）；
- 观测不可信 → 状态机 DEGRADED，不发布路线；
- 不允许把 CPU/模拟结果标为昇腾实测。

## 6. 验证清单

- [ ] 设备型号与 CANN 版本记录
- [ ] `.om` 导出命令与算子兼容日志
- [ ] 推理契约测试
- [ ] 真实视频/图像样本与标注
- [ ] 精度（MAE/RMSE）与延迟/吞吐/功耗
- [ ] 失败模式与回退演练
- [ ] 更新 `docs/MVP_LIMITATIONS.md` 与 `research/CLAIMS.md`

在上述清单完成前，对外只能表述“已完成适配层与部署路径，未实机验证”。
