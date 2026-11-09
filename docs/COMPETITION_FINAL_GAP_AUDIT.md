# SkyGuard 竞赛最终差距审计（第二轮总攻后）

> 日期：2026-11-09。基线：`99d7d00` + 本轮未提交变更。
> 关联：[`COMPETITION_GAP_AUDIT_2026-11-09.md`](COMPETITION_GAP_AUDIT_2026-11-09.md)（第一轮）、
> [`SECURITY_REDTEAM_REPORT.md`](SECURITY_REDTEAM_REPORT.md)、
> [`RESEARCH_ALGORITHM_UPGRADE.md`](RESEARCH_ALGORITHM_UPGRADE.md)。

## 0. 结论先行

本轮完成了第二轮安全红队、预测-规划耦合、regime-aware 预测区间、联合粒子 VoI、
拥堵反馈与拥堵感知规划、Validator 十项独立约束、Playwright E2E、公开数据集跨域评测与证据清单。

**仍然不是可参赛的最终作品**：AgentArts 无真实租户、昇腾无实机、场馆/人员/无人机数据为零，
官方赛规未核验，PPT/演示视频/论文 PDF 未生成。按当前证据，只能表述为“研究原型候选 + 本地闭环 +
单一公开数据集跨域评测”。

## 1. 本轮实际完成

### 1.1 安全与工程

- V6.5 13 项 P1：12 项关闭，P1-11 仅关闭透明度；第二轮红队 D1–D22 全部修复或有明确残余记录。
- 默认生产配置不再匿名暴露 staff 登录码；生产强制读鉴权；审计参数有界；请求体降至 2MB。
- Validator：场景 horizon、在留容量、出口等待、全区域观测/传感器故障、停用区域、
  总量重算、step.persons、预测 provenance、求解器截断、路径方向自检。
- AgentArts：SSE 默认要求 `[DONE]`；续接复用 session 并按工单隔离幂等键；中途失败保留 failed run/trace。
- 感知：image_count 的 surveyed 必须与场景摄像头 measured/calibrated 和 calibration_id 一致。
- 观测：count ≤ 1,000,000，未来时间 >60s 拒绝。
- 证据：`.gitattributes` 强制 evaluation LF；`verify:evidence` 只读；新增 `RELEASE_MANIFEST.json`（179 文件）
  与 `evaluation/final/MANIFEST.json`（63 文件）。
- E2E：管理员登录、错误口令、staff 登录 3 条 Playwright 用例通过，CI 已加入。

### 1.2 算法

- 预测驱动规划需求（observed/predicted/robust），预测只上调、不可靠回退，方案带 provenance。
- 预测方法选择与 horizon 一致；regime-aware 区间；surge 覆盖率 0.7376 → **0.8667**（仍 <0.95）；
  预测动作默认禁用（`prediction_action_enabled=false`）。
- 联合粒子 VoI：联合熵/最坏区域风险/相关性敏感性实验；**负向结果**——未超过现有多区域加权。
- 拥堵反馈：BPR 容量折减 + 逐分钟队列仿真；拥堵感知规划将平均最大队列 76.1 → 0，
  但最终已服务/未服务人数不变。
- 公开数据集：Part B 跨域评测 MAE 22.16 / NAE 0.179 / F1 0.705（域迁移，非现场）。

### 1.3 验证

| 项目 | 结果 |
| --- | --- |
| 后端测试 | **205/205** |
| 前端测试 | **16/16** |
| Playwright E2E | **3/3** |
| `npm run build` | 通过 |
| `npm run demo` / `demo:mvp` | 三场景/三场景通过 |
| `verify:evidence` | 134/134 |
| 根证据清单 | 46/46 |
| `evaluation/final` 清单 | 63/63 |
| 发布证据清单 | 179/179（约 147.7 MB） |
| Docker | **未运行**（daemon 不可用） |

## 2. P0 / P1 / P2 清单

### P0（阻断正式参赛，均为外部/交付）

| ID | 项 | 状态 | 所需 |
| --- | --- | --- | --- |
| P0-A | AgentArts 真实租户、官方契约核验、平台 Trace | 未完成 | 租户、API Key、已发布运行时、Trace 权限 |
| P0-B | 昇腾 NPU/CANN/`.om` 实机与精度/延迟/功耗 | 未完成 | 设备、CANN、模型、功耗计 |
| P0-C | 官方赛规、赛道、评分、材料格式、报名截止 | 未核验 | 官方页面/报名系统、指导教师/学校 |
| P0-D | 交付包：PPT、演示视频、论文 PDF/LaTeX、release 归档 | 未完成 | 本环境可做 PPT/视频脚本，但最终录制与提交需人工 |
| P0-E | 场馆测绘、摄像机标定、真人流/工作人员研究 | 无 | 场地、授权、伦理审批、参与者 |
| P0-F | 数据/权重许可核验 | 部分 | ShanghaiTech 无 LICENSE；P2PNet academic-only |

### P1（核心可信度，部分已修）

| ID | 项 | 状态 |
| --- | --- | --- |
| P1-01 | 预测区间 surge 覆盖 0.8667，可靠子集约 0.69 | **未达标**；预测动作已禁用 |
| P1-02 | 预测未进入时间分阶段规划；静态模型无吞吐收益 | 已实现链路，**收益为负/中性** |
| P1-03 | 联合 VoI 未超过多区域加权 | **负向结果**，保留原始数据 |
| P1-04 | 拥堵感知只改变队列，不改变最终吞吐 | 已量化，贡献限定 |
| P1-05 | 风险传播参数未标定 | 未完成（真实迁移数据缺失） |
| P1-06 | Validator 与规划器共享 EffectiveNetwork；需求源仍依赖观测 | 部分；需独立需求/网络快照 |
| P1-07 | 多实例陈旧读；锁陈旧双写需独立进程探针 | 残余 |
| P1-08 | AgentArts 平台侧重试去重语义未验证 | 外部 |
| P1-09 | CSRNet/ARIMA/LSTM/MILP/POMDP 强基线缺失 | 未完成 |
| P1-10 | 论文/答辩数字仍需统一到本轮证据 | 部分更新 |

### P2（工程/体验）

- 审计轮转/哈希链、分布式限流、SQLite 迁移、工具超时不可取消、多 token 身份映射、
  移动端真机、依赖漏洞扫描、CI 固定 `tsx` 版本、Docker 实跑。

## 3. 可量化变化（相对 99d7d00）

| 指标 | 之前 | 现在 | 说明 |
| --- | --- | --- | --- |
| 后端测试 | 183 | **205** | 新增安全/算法/边界回归 |
| 浏览器 E2E | 0 | **3** | 管理员/staff |
| surge 95% 覆盖 | 0.7376 | **0.8667** | 仍低于 0.95 |
| surge 起点 <38 覆盖 | 0.6976 | **0.7881** | 仍不足 |
| 拥堵最大队列 | 76.1 | **0**（拥堵感知） | 最终吞吐不变 |
| 发布证据文件 | 81 | **179** | 含 final/Part B |
| 生产匿名 staff 码 | 暴露 | **不暴露** | 生产强制读鉴权 |
| Validator 约束 | 15 项 | **+horizon/在留/总量/provenance/truncation** | 独立检查增强 |

## 4. 最终问题回答

- **本轮实际完成了哪些代码和算法？** 见第 1 节与 `RESEARCH_ALGORITHM_UPGRADE.md`。
- **哪些原有问题真正关闭？** V6.5 P1-1～P1-10、P1-12、P1-13；红队 D1–D22 全部修复或记录残余；
  证据 CRLF、校验改写、生产占位符凭证、双向容量/在留容量、MCP 审计等。
- **哪些创新获得实验支持？** 预测确实进入规划需求（可复现 provenance）；regime-aware 区间提升 surge 覆盖；
  拥堵感知显著降低仿真队列；Validator 独立约束增强可被对抗测试检出。
- **哪些实验结果不理想？** 联合 VoI 未超过多区域加权；预测驱动在静态规划中无吞吐收益；
  surge 区间仍不达标；拥堵感知不改变最终吞吐。
- **相比原版本有哪些可量化提升？** 见第 3 节。
- **AgentArts 和昇腾是否真正实机运行？** **没有。** AgentArts 只有本地 stub/契约；昇腾只有探针与转换/评测脚本，
  无真实设备结果。
- **距离正式参赛还差什么？** 第 2 节 P0 全部，以及 P1 的强基线/真实标定/论文定稿。
- **哪些工作超出当前 AI 能力边界？** 真实租户/设备/场馆/人员研究、官方赛规确认、最终视频录制与提交、
  模型训练所需算力与数据许可。

## 5. 外部资源清单

1. AgentArts：租户控制台、API Key/AK-SK、已发布运行时名、官方 API/鉴权文档、Trace 导出。
2. 昇腾：具体型号、CANN/驱动、`atc`、可用 `.om`、功耗计。
3. 场馆：测绘、面积、通道/出口容量、摄像机标定、真实视频/人流、时间戳。
4. 人员研究：参与者、知情同意/伦理审批、任务脚本。
5. 许可：ShanghaiTech、P2PNet、NWPU/UCF-QNRF、CityStreet、航拍底图。
6. 无人机：设备、持证操作员、空域/场地审批、保险。
7. 赛事：官方赛题/评分/材料格式/截止日期、报名账号、指导教师/学校签字。
8. 部署：Docker daemon/CI runner、TLS 域名、secret manager、日志采集。
9. 专业评审：消防/公共安全/功能安全评审与演练授权。

## 6. 立即下一步（无外部依赖）

1. 论文主表统一到本轮证据；生成 LaTeX/PDF 骨架。
2. 答辩 PPT 骨架与 6–8 分钟演示脚本（含降级/拒绝路径）。
3. 补齐多工单续接与锁陈旧双写端到端测试。
4. 规划器与 Validator 独立网络/需求快照（消除共享 EffectiveNetwork）。
5. 强基线：CSRNet（许可允许时）、ARIMA/Prophet、MILP 小场景最优性 gap。
6. Docker daemon 可用时执行 build/run/volume 重启测试。
