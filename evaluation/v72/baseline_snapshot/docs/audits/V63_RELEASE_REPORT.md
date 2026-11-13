# V6.3 Baseline Integrity & Real-World Evidence Report

> 日期：2026-11-05  
> 范围：V6.2 一致性审计、基线冻结、真实公开数据集评测、感知接入与回归。  
> 数据性质：合成实验 + ShanghaiTech Part A 公开数据集；无真实场馆/AgentArts/昇腾实机。

## 1. V6.2 一致性审计结果

完整审计：`docs/audits/V62_CONSISTENCY_AUDIT.md`。

| 项 | 结论 |
| --- | --- |
| 多区域 0.2154 / 0.0472 / 0.1682 | VERIFIED：多区域均值、单区域均值、配对差；0.2154−0.0472=0.1682 |
| 单区域均值为 0 | INCONSISTENT：正确值为 0.0472；仓库无 0 记录 |
| 0.1682 CI / d_z / seed 聚类 | VERIFIED：trial 级 [0.1636,0.1728]，d_z=2.06；seed 聚类 [0.1626,0.1737] |
| V6.1 同目标 vs V6.2 轮换 | VERIFIED（敏感）：必须并列报告 |
| 序贯成功率 0.9089 | VERIFIED（定义为至少一次信息性证据） |
| 预算耗尽 0.0911 | INCONSISTENT 作为独立指标：success+budget_exhausted=1800/1800，attempts 全为 2；是机械互补 |
| 检测 0.7767 / 决策 0.9600 | VERIFIED；成功率 ≠ 检测率 |
| 预测无测试泄漏 | VERIFIED（每起点只用过去数据）；报告预测表缺表头，INCONSISTENT 格式 |
| Git 46 vs 28+31 | VERIFIED 口径：28 unstaged + 18 untracked 条目 = 46；untracked 实际 31 文件 |
| Markdown 链接 | 0 失效 |
| V6.1/V6.2 原始数据 | 未修改；V6.2 基线 151 文件 SHA-256 校验通过 |

## 2. Git 状态与冻结证据

- 分支：`feat/skyguard-mvp-e2e`
- HEAD：`3b62fe94bd03406532398dfbdcc6812bf669544d`（未提交 V6.2/V6.3 工作区）
- V6.2 基线：`evaluation/v62/freeze_v62.json`、`evaluation/v62/BASELINE_SHA256`
  - 151 文件、34,403,582 bytes；`sha256sum -c` exit 0
- V6.1 冻结：`evaluation/v61/FREEZE.sha256`；复跑 5/5 一致
- 证据清单：`evaluation/MANIFEST.json` 46/46
- 当前工作区：53 个 status 条目 = 28 unstaged 受跟踪修改 + 25 untracked 条目 / 63 个未跟踪文件（约 343,841 行）；staged 0。
- 本轮未 commit / push / PR / Tag；未 reset/stash/clean。

## 3. 数据集来源、许可与获取情况

| 数据集 | 获取 | 许可 |
| --- | --- | --- |
| ShanghaiTech Part A/B | **已获取**：公开 Google Drive 链接（CSRNet 官方 README 引用），167 MB zip，解压至仓库外 `E:/datasets/shanghaitech` | **UNVERIFIED**：压缩包无显式 LICENSE；研究用途，不随仓库分发 |
| NWPU-Crowd | 未获取：官方站点在当前网络不可达 | UNVERIFIED |
| UCF-QNRF | 未获取 | UNVERIFIED |

- 未绕过登录/付费/访问限制；未把数据集或权重提交到仓库。
- 仓库只保存脚本、配置、结果、SHA-256。

## 4. 模型与权重

| 项 | 值 |
| --- | --- |
| 模型 | P2PNet 官方实现（`TencentYoutuResearch/CrowdCounting-P2PNet`） |
| Repo commit | `5c91a81ca062b1c7fd3db3ad1c55b1c21f0a7455` |
| 权重 | `weights/SHTechA.pth`，86,372,926 bytes |
| 权重 SHA-256 | `506047732b128ff09efef18e94bfacbe35fcfef300e5e9eeeece259b0488c63f` |
| 许可 | Tencent academic-research-only（见官方 LICENSE） |
| 兼容性 | 官方代码面向 torch 1.5；适配器修正 torchvision 版本判断并禁用预训练 backbone 下载 |
| 环境 | Python 3.13.7、Torch 2.14.0+cpu、torchvision 0.29.1、CPU（CUDA 不可用） |

CSRNet 未使用：官方仓库无 LICENSE 元数据，权重 Google Drive；未获取。

## 5. 实际运行的真实数据集实验

- 数据集：ShanghaiTech Part A 官方 **test split**（182 图）
- 协议：官方目录划分；未训练、未用 test 调阈值；resize 到 128 倍数；阈值 0.5
- 计数：预测点数 vs GT `.mat` 点数
- 定位：GT 点按 resize 比例缩放，8 px 半径贪心匹配
- 延迟：仅模型前向
- 复跑：第二遍独立运行，182/182 张预测人数完全一致

## 6. MAE / RMSE / FPS 与误差分析

| 指标 | 值 |
| --- | --- |
| MAE | **57.2418** |
| RMSE | **96.0415** |
| NAE | **0.1319** |
| 平均 GT / 预测 | 433.9011 / 426.2418 |
| 定位 F1 @8px | **0.7405** |
| 平均延迟 | **966.786 ms** |
| p95 延迟 | 1582.897 ms |
| FPS | **1.034** |

密度区间（按 GT）：

| GT 范围 | 图片 | MAE |
| --- | --- | --- |
| 0–50 | 0 | — |
| 50–100 | 7 | 40.0000 |
| 100–200 | 36 | 17.8333 |
| 200–500 | 93 | 46.8172 |
| 500+ | 46 | 111.7826 |

- 高密度区间误差最大（MAE 111.78），与遮挡/粘连一致；未做遮挡分层。
- P2PNet 论文 README 报告 ShanghaiTech A MAE 52.74（其设置）；本次 57.24 不应表述为复现或超过论文。
- 结果来自公开数据集+官方权重，不代表 SkyGuard 自训练模型或真实场馆精度。

## 7. 感知算法与 SkyGuard 接入

- 评测流水线：`backend/python/real_data/`（数据加载、P2PNet 适配、指标、复算、复跑）。
- 接入适配：`skyguard_adapter.py` 将图像计数转换为观测载荷：
  - 需要区域面积与摄像机标定；
  - 未标定时置信度强制 ≤0.35 → SkyGuard 现有 `assessObservation` 判不可信 → `DEGRADED`；
  - 多摄像头重叠/遮挡未解决；
  - Validator 与四态状态机语义未改。
- 单张图人数不能直接解释为真实单位面积密度。
- 结论：接口/安全降级路径已实现并测试；真实场馆接入未验证。

## 8. AgentArts 与昇腾进度

| 项 | 状态 |
| --- | --- |
| AgentArts | 适配器/契约完成；无租户/凭证/官方 API；V6.2 URL 审计 S15/S18 华为页面 404；**未实机** |
| MCP | 15 工具，权限/幂等/错误码/协议测试通过；能否连接真实感知模型未验证 |
| 昇腾 CANN/MindSpore/OM | 仅探针/契约/部署文档；无 NPU/CANN/`.om`；**未实机** |
| 无人机 | 工单请求/审批/模拟反馈；无飞控 |

## 9. 测试与构建结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| Python real-data tests | 0 | 7/7 |
| Real-data metric verification | 0 | 6/6 |
| Real-data SHA-256 | 0 | 9/9（最终清单） |
| V6.2 baseline SHA-256 | 0 | 151/151 |
| backend tests | 0 | 104/104 |
| frontend tests | 0 | 8/8 |
| backend tsc | 0 | 通过 |
| frontend tsc | 0 | 通过 |
| npm run build | 0 | 通过 |
| npm run demo | 0 | 通过 |
| npm run demo:mvp | 0 | 通过 |
| docker info | 1 | Docker daemon 未启动；未构建 |

- 首次 real-data SHA 失败是因为 `VERIFICATION.json` 在 manifest 之后重新生成；最终清单已重建并验证（记录在 `TEST_RESULTS.json`）。
- 日志/汇总：`evaluation/real-data/test_results.tsv`、`TEST_RESULTS.json`。

## 10. 尚需用户提供的资源

1. NWPU-Crowd、UCF-QNRF、ShanghaiTech Part B 的合法获取/许可确认；
2. CSRNet 权重与许可；
3. 真实场馆视频、摄像机标定、区域面积与通道容量；
4. 华为云 AgentArts 租户/凭证/官方 API；
5. 昇腾 NPU/CANN 设备；
6. Docker daemon/CI 运行环境；
7. 消防/公共安全专业评审资源。

## 11. 下一阶段研发建议

1. 用相同协议跑 NWPU-Crowd、UCF-QNRF、Part B 与 CSRNet 对照；
2. 摄像机标定与多摄像头去重，再接入 SkyGuard 观测；
3. 在 GPU/CUDA 与昇腾上测延迟/吞吐（不得沿用 CPU 数字）；
4. AgentArts 真实工作流与 Trace；
5. 真实场馆测绘与受控演练。

> 本轮未自动 commit/push/PR/Tag，未删除或覆盖 V6.1/V6.2 原始数据。
