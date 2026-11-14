# SkyGuard 参赛提交包（2026-11-14）

## 产物

| 项 | 值 |
| --- | --- |
| 目录 | `submission/SkyGuard-submission-20261114/` |
| 压缩包 | `submission/SkyGuard-submission-20261114.zip` |
| 文件数 | 462（另含 `MANIFEST.json` / `SHA256SUMS.txt`，共 464） |
| 解压后大小 | 31,142,476 字节（约 31 MB） |
| zip 大小 | 8,731,743 字节（约 8.7 MB） |
| zip SHA-256 | `01152f6a823c3ef245037dd587c432e985e078e4374f04e3e1271c1c81b647c4` |
| 源码基线 | Git `96b9abd` + 工作树未提交改动 |
| 项目版本 | `v7.5.0-research.1`；场景配置 `7.6.0` |

## 已验证

- 提交包内后端测试 **334/334**、前端测试 **17/17**；
- 提交包内 `npm run build` 通过（后端 `tsc` + 前端 Vite，1821 modules）；
- `sha256sum -c SHA256SUMS.txt`：**462/462** 通过；
- `unzip -t`：压缩包无错误；
- 包内不含真实开发口令与开发 JWT 密钥（已脱敏为占位值）、`.env`、`data/admin_config.json`、`node_modules`、审计日志或未授权图片；
- 浏览器实测：`DEGRADED → 第 7 步人工审批/派发 → 工作人员反馈 → NORMAL`，截图见包内 `screenshots/`。

说明：包内测试使用开发仓库依赖（junction）在临时目录复现，**不是**全新机器上的 `npm ci`；干净机器复现仍是提交前人工步骤。

## 包内先读

1. `SUBMISSION.md`：作品说明、6–8 分钟演示路径、已验证/未验证边界；
2. `VERIFICATION.md`：本次快照实际执行的命令与结果；
3. `MANIFEST.json` / `SHA256SUMS.txt`：文件清单与哈希；
4. `screenshots/`：指挥大屏、仿真第 7 步、工作人员反馈、恢复常态；
5. `docs/`、`research/`、`evidence/`：技术报告、主张等级、限制与证据索引。

## 边界（不得删除或弱化）

这是研究原型，不是应急指挥系统，不能用于真实疏散指挥。场景与观测为合成/估算数据；
AgentArts 真实租户、昇腾 NPU/CANN/OM、无人机、真实场馆/摄像机/授权人流均未实机验证；
Docker/CI 未实机，第三方安全评审与消防/公共安全认证均无。

## 提交前仍需人工完成

- 填写队伍、学校、成员、指导教师与视频/仓库链接；
- 录制 6–8 分钟演示视频，按组委会要求导出 PDF/PPT；
- 在干净机器上执行 `npm run setup && npm test && npm run build`；
- 核对官方赛规、材料格式与演示时长；
- 确认航拍底图/第三方数据许可，未授权图片不随包分发；
- 如取得 AgentArts 租户或昇腾实机，更新证据后再替换“未验证”表述。
