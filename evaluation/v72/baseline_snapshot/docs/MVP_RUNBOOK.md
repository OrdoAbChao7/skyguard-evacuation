# SkyGuard MVP 运行手册

## 1. 环境

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 20（开发使用 v24.19.0） |
| npm | 随 Node 安装 |
| Python | 可选（仅 CPU 视频计数；MCP/演示不需要） |
| 浏览器 | Chrome / Edge 现代版本 |

## 2. 安装与启动

```powershell
# 仓库根目录
npm run setup          # 安装 backend / frontend 依赖

npm run dev            # 同时启动后端(8010) + 前端(5173)
```

也可以分别启动：

```powershell
npm run dev:backend
npm run dev:frontend
```

访问：

- 指挥大屏：`http://localhost:5173/`
- 管理员登录：`http://localhost:5173/login`
- 工作人员移动端：`http://localhost:5173/staff`
- 健康检查：`http://localhost:8010/health`

生产构建：

```powershell
npm run build
npm start
# → http://localhost:8010/
```

## 3. 默认身份（必须修改）

| 身份 | 账号 | 密码/登录码 |
| --- | --- | --- |
| 管理员 | `admin` | `skyguard2026`（可用环境变量覆盖） |
| 工作人员 | `STF-01` ~ `STF-08` | 场景文件中的 `access_code`（演示：1001~1008） |

工作人员登录：大屏「审批中心与工单」→ 工作人员登录（工号 + 登录码）。
演示登录码来自 `data/scenarios/stadium-evacuation.json` 的合成名册，
真实部署必须替换为正式身份系统。

## 4. 演示

```powershell
npm run demo:mvp
```

三个场景：

| 场景 | 内容 | 预期 |
| --- | --- | --- |
| A 正常散场 | 回放 48 条观测、预测、风险评估 | NORMAL，不调查、不建单 |
| B 局部积聚 | 低置信观测 → VoI → 现场核查 + 无人机请求 → 审批 → 接单执行 → 反馈 → 重新评估 → 疏导工单 | 工单完整流转至 COMPLETED，状态回到可发布 |
| C 不可信/容量不足 | 全部无效观测 → DEGRADED；高密度 + 关闭东西出口 → REJECT | 禁止发布未验证路线，Agent 转人工 |

原有安全域演示仍然可用：

```powershell
npm run demo
```

## 5. 测试与构建

```powershell
npm test               # 后端（安全域 + MVP）+ 前端
npm run build          # backend tsc + frontend build
```

后端单独运行：

```powershell
npm run test:safety --prefix backend   # 既有 42 个安全用例
npx tsx --test tests/mvp/*.test.ts     # MVP 用例（在 backend 目录）
```

## 6. 实验

```powershell
npm run experiments:mvp
npm run benchmark:competition --prefix backend   # 竞赛级基准
npm run benchmark:v6 --prefix backend            # V6 多区域/重试/邻居预测
```

生成：

- `evaluation/mvp/experiment1_voi.json`
- `evaluation/mvp/experiment2_prediction.json`
- `evaluation/mvp/experiment3_safety_ablation.json`
- `evaluation/mvp/experiment4_business_loop.json`
- `evaluation/mvp/run_metadata.json`
- `evaluation/MVP_REPORT.md`

固定随机种子，重复运行结果一致（除耗时字段）。

## 7. MCP Server

```powershell
npm run mcp --prefix backend
```

stdio 传输；stdout 只输出协议消息。客户端配置见 `docs/MCP_TOOLS.md`。

可用环境变量：

```text
MCP_ACTOR_ROLE=agent|viewer|staff
MCP_ACTOR_NAME=mcp-agent
MCP_STAFF_ID=STF-02        # 仅 role=staff
MCP_STAFF_CODE=1002        # 仅 role=staff
DATA_ROOT=<仓库>/data
SAFETY_SCENARIO_FILE=<仓库>/data/scenarios/stadium-evacuation.json
```

## 8. HTTP API 速查

| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/v1/mvp/dashboard` | 聚合态势（预测/人员/工单/Agent/摄像头） | 否 |
| GET | `/api/v1/mvp/scenario` | 场景详情（规则、人员、VoI 配置） | 否 |
| GET | `/api/v1/mvp/predictions/:regionId` | 预测 | 否 |
| GET | `/api/v1/mvp/agent/runtime?probe=1` | AgentArts 状态 | 否 |
| POST | `/api/v1/mvp/agent/runs` | 运行 Agent | admin/operator |
| GET | `/api/v1/mvp/agent/runs` | 运行记录 | 否 |
| POST | `/api/v1/mvp/replay/load` | 加载回放文件 | admin/operator |
| POST | `/api/v1/mvp/replay/step` | 推进回放 | admin/operator |
| GET | `/api/v1/mvp/staff` | 人员 | 否 |
| GET | `/api/v1/mvp/work-orders` | 工单 | 否 |
| POST | `/api/v1/mvp/work-orders/:id/approve` | 审批 | admin/operator |
| POST | `/api/v1/mvp/work-orders/:id/reject` | 拒绝 | admin/operator |
| POST | `/api/v1/mvp/work-orders/:id/assign` | 派发 | admin/operator |
| POST | `/api/v1/mvp/work-orders/:id/accept` | 接单 | staff |
| POST | `/api/v1/mvp/work-orders/:id/start` | 开始 | staff |
| POST | `/api/v1/mvp/work-orders/:id/complete` | 完成 + 反馈 | staff |
| POST | `/api/v1/mvp/auth/staff-login` | 工作人员登录 | 否 |
| POST | `/api/v1/mvp/tools/:name` | 直接调用工具 | JWT |
| POST | `/api/v1/mvp/demo/run` | 一键推演 A/B/C | admin/operator |
| GET | `/api/v1/mvp/experiments` | 竞赛基准摘要 | 否 |
| GET | `/api/v1/mvp/multi-region` | 多区域风险传播与联合 VoI | 否 |
| POST | `/api/v1/mvp/work-orders/:id/revalidate` | 重新确认上下文 | admin/operator |

PowerShell 示例：

```powershell
$token = (Invoke-RestMethod -Method Post http://localhost:8010/api/v1/auth/login `
  -ContentType 'application/json' -Body '{"username":"admin","password":"skyguard2026"}').access_token

Invoke-RestMethod -Method Post http://localhost:8010/api/v1/mvp/agent/runs `
  -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' `
  -Body '{"region_id":"R_EAST_STAND","trigger":"manual"}'
```

## 9. 常见问题

| 现象 | 处理 |
| --- | --- |
| 大屏提示 `AGENTARTS UNAVAILABLE` | 正常：未配置真实租户。使用本地模式即可 |
| 审批按钮 403 | 需要管理员登录 `/login` |
| 接单按钮不可用 | 需要对应工作人员登录，且只能操作指派给本人的工单 |
| 状态一直 DEGRADED | 检查 `/api/v1/mvp/cameras`；低置信/过期观测必须重新取证 |
| 场景加载失败 | `SAFETY_SCENARIO_FILE` 必须是 `data/scenarios/` 下的文件名或绝对路径 |
| 端口冲突 | `$env:PORT=8099; npm run dev:backend` |
| MCP stdout 被日志污染 | 日志写 stderr；不要在工具里 `console.log` |

## 9.1 安全与持久化配置

| 变量 | 说明 |
| --- | --- |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | 进程内固定窗口限流 |
| `CORS_ORIGINS` | 逗号分隔的允许来源；默认 `*` |
| `READ_AUTH_REQUIRED=true` | 读接口也要求 JWT（公网建议） |
| `CSP_ENABLED=true` | 启用 Helmet CSP |
| `TRUST_PROXY=true` | 反向代理后设置 |
| `OPS_PERSIST_FILE=data/ops-state.json` | 工单 JSON 快照（单实例） |

详见 `docs/DEPLOYMENT.md`。

## 10. 数据清理

运行时数据：

- `data/audit/*.jsonl`：审计日志（追加写，不自动删除）
- `data/admin_config.json`：管理员哈希（首次启动生成）
- `data/replays/`：可放入 CSV/JSON 回放文件

均已在 `.gitignore` 中排除。
