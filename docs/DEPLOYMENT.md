# SkyGuard 部署手册

## 1. 本地开发

```powershell
npm run setup
npm run dev          # backend 8010 + frontend 5173
npm test
npm run demo:mvp
```

## 2. 生产构建

```powershell
npm run build        # backend tsc + frontend vite build
$env:NODE_ENV='production'
$env:SECRET_KEY='<long-random-secret>'
$env:SKYGUARD_ADMIN_PASSWORD='<strong-password>'
npm start            # 由后端托管 frontend/dist，默认 8010
```

## 3. 关键环境变量

| 变量 | 默认 | 生产建议 |
| --- | --- | --- |
| `PORT` | `8010` | 由网关/容器注入 |
| `DATA_ROOT` | 仓库 `data/` | 挂载持久卷 |
| `SAFETY_SCENARIO_FILE` | `stadium-evacuation.json` | 现场场景文件名 |
| `SECRET_KEY` / `JWT_SECRET` | 开发默认值（警告） | **必须**显式设置 |
| `SKYGUARD_ADMIN_USERNAME/PASSWORD` | `admin / skyguard2026` | 首次启动前修改 |
| `OPS_PERSIST_FILE` | 未设置（纯内存） | `data/ops-state.json` 并挂载持久卷 |
| `MVP_RUNS_FILE` | 未设置（纯内存） | `data/agent-runs.json` 并挂载持久卷 |
| `AGENT_RUNTIME` | `local` | 未完成真实租户验证前保持 `local` |
| `AGENTARTS_BASE_URL` / `AGENTARTS_API_KEY` | 未设置 | 仅通过部署密钥注入 |
| `AGENTARTS_RUNTIME_NAME` | 回退 `AGENTARTS_AGENT_ID` | 租户发布页的运行时名 |
| `AGENTARTS_CONTRACT` | `official` | 生产使用 `official`；`template` 仅本地测试 |
| `AGENTARTS_MAX_STEPS` | `4` | 1~10；防止平台循环 |
| `AGENTARTS_AUTO_CONTINUE` | `false` | 需要真实租户验证后再开启 |
| `MCP_ACTOR_ROLE` | `agent` | HTTP/stdio MCP 服务端身份；客户端不能自报 |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | 300 / 60000 | 按网关能力调整 |
| `CORS_ORIGINS` | `*` | 精确列出前端域名 |
| `READ_AUTH_REQUIRED` | `false` | 公网部署建议 `true` |
| `CSP_ENABLED` | 生产自动开启 | 保持开启 |
| `TRUST_PROXY` | `false` | 反向代理后设为 `true` |
| `LOG_FORMAT` | `dev` | `combined` 或结构化日志 |

## 4. Docker

```bash
docker build -t skyguard:mvp .
docker run --rm -p 8010:8010 \
  -e SECRET_KEY='change-me' \
  -e SKYGUARD_ADMIN_PASSWORD='change-me' \
  -e OPS_PERSIST_FILE=/app/data/ops-state.json \
  -e MVP_RUNS_FILE=/app/data/agent-runs.json \
  -v skyguard-data:/app/data \
  skyguard:mvp
```

> Dockerfile 未在目标生产环境实机验证；构建依赖公网 npm。

## 5. 反向代理与安全

- 必须启用 TLS；
- 只暴露 8010 给代理，不直接公网；
- 设置 `CORS_ORIGINS`、`READ_AUTH_REQUIRED=true`、`TRUST_PROXY=true`；
- 管理员口令、`SECRET_KEY` 使用密钥管理，不写进镜像/仓库；
- 审计日志 `data/audit/*.jsonl` 需集中采集与轮转；
- 工单快照 `data/ops-state.json` 与 Agent 运行快照 `data/agent-runs.json` 需备份；
  单实例写入，不支持多副本并发。
- HTTP MCP 端点 `POST /mcp` 与网页 API 同进程、共享状态；公网部署时必须在网关层
  限制来源与身份，当前没有独立 MCP 鉴权层。

## 6. 可观测性

- `/health`：存活检查；
- `X-Request-Id`：请求关联；
- 审计日志：`tool.*`、`work_order.*`、`agent.run`、规划/校验事件；
- 限流响应：429 + `Retry-After`；
- 建议外部接入 Prometheus/日志平台（本仓库未内置）。

## 7. 已知部署限制

- 单进程内存状态；多实例需要共享存储/消息队列；
- 限流为进程内固定窗口；
- 无数据库事务；
- 无正式身份系统（工作人员演示登录码）；
- 未通过任何安全/消防认证。

## 8. CI

`.github/workflows/ci.yml`：安装依赖 → 后端/前端测试 → 构建 → 安全演示 → MVP 演示 →
Python 语法检查 → 校验已提交证据清单（行尾无关）→ 证据一致性检查（不重跑基准）→ 上传 `evaluation/`。
CI 未在真实仓库运行验证（需推送后观察）。
