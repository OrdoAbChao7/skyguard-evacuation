# V7.4 生产工程检查

> 运行 ID：`v74-final-20261110T105851`。

## 1. Docker

- Dockerfile：true
- Daemon：blocked
- 说明：Docker daemon 不可用；未执行 docker build，不得声称镜像已验证。

## 2. CI

- Workflow 存在：true
- YAML 解析：ok

## 3. API 契约

| 路径 | HTTP | 通过 |
| --- | --- | --- |
| /health | 200 | true |
| /api/v1/safety/status | 200 | true |
| /api/v1/safety/scenario | 200 | true |

## 4. 负载（本地状态端点）

- 100 次 / 并发 10；错误 0
- p50 4.775ms，p95 7.319ms，max 9.109ms

## 5. 浏览器 E2E

- 脚本：`frontend/e2e/smoke.mjs`
- 结果：见 `browser_e2e.json`（登录、指挥中心、代理 API）

## 6. 边界

- Docker daemon 不可用：镜像/容器未验证；
- 负载为本地单机状态端点，不代表真实并发；
- E2E 只覆盖冒烟路径。
