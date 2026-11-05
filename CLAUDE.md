# CLAUDE.md — SkyGuard

本文件是 Claude Code 在本仓库工作的入口约定；完整规则见 `AGENTS.md` 与 `docs/MVP_LIMITATIONS.md`。

## 必读顺序

1. `AGENTS.md`（架构/安全/Git/证据规则）
2. `docs/MVP_LIMITATIONS.md`（禁止表述）
3. `research/CLAIMS.md`（技术主张状态）
4. `docs/MVP_ARCHITECTURE.md`（模块边界）

## 不可违背

- 不重写安全内核；不弱化四态、独立校验、未知不可用。
- Agent 只能创建待审批工单；不能审批/派发/控制无人机。
- 不伪造 AgentArts/昇腾/无人机/真实数据结果；未实机验证必须明说。
- 不删除或弱化既有测试；改算法必须补回归与可复现实验。
- 不自动 commit/push；不 reset/stash 用户未提交改动。
- 新主张必须登记到 `research/CLAIMS.md` 或标注“待验证”。

## 验证命令

```powershell
npm test
npm run build
npm run demo
npm run demo:mvp
npm run benchmark:competition
```

## 角色分工（建议）

- **架构师**：检查模块边界、数据流、场景配置与代码是否分离。
- **算法审查**：VoI 归一化/敏感性、预测滚动验证/泄漏、规划与调度约束。
- **安全审查**：独立校验、状态优先级、权限、过期审批、MCP 注入面。
- **实验评估**：多种子、置信区间、失败案例、原始数据与报告一致性。
