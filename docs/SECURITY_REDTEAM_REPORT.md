# SkyGuard 第二轮安全红队报告

> 审计基线：`99d7d00` + 本轮未提交变更；审计方式：独立只读红队 Agent + 源码复核 + 探针。
> 日期：2026-11-09。本文记录发现、修复与残余风险；不宣称通过安全认证。

## 1. 结论

第二轮红队确认上一轮 P1 中 **P1-3、P1-5、P1-8、P1-12 仍有绕过路径**，并新发现
**匿名读取 staff 登录码、审计参数无上限、AgentArts 中途失败丢失 run、agent 可发布方案、
自报 surveyed 感知、未来观测绕过时效、生产读接口默认开放**等问题。本轮已逐项修复并补回归：

- 后端测试 **205/205**、前端 **16/16**、浏览器 E2E **3/3**；
- 仍未关闭的属于平台语义/真实环境验证（AgentArts 平台去重、锁陈旧双写探针、真实 NPU 等）。

## 2. 高危发现与修复

| ID | 发现 | 影响 | 修复 | 回归 |
| --- | --- | --- | --- | --- |
| D1 | `/mvp/scenario`、`/mvp/dashboard`、`/mvp/staff` 返回 `access_code` | 匿名→staff 登录→可写反馈/改工单 | `listStaff`/场景响应剔除 `access_code`；生产强制读鉴权 | `security.test.ts` 断言不含 access_code |
| D2 | 工具失败审计写入完整 20MB 参数 | 磁盘/内存 DoS，状态文件进入只读 | 审计字段有界（4KB + sha256 摘要）；请求体降至 2MB；工具输入统一 16KB/1000 字符/50 元素上限 | `agent.test.ts` 超大参数审计 <10KB |
| D3 | `resource_request: {}`/全零绕过动作成本 | 可反复创建不计成本工单 | 空/零请求等价于缺省，按场景动作派生；正数显式估算保留 | `reservations.test.ts` 空/零请求派生非零成本 |
| D4 | Validator 使用方案自报 horizon | 伪造 100 分钟窗口通过 10 分钟安全约束；超大 horizon DoS | Validator 只使用场景 horizon；`horizon_mismatch` hard；schema 上限 1440 | `safety-acceptance.test.ts` 伪造 horizon 被拒 |
| D5 | SSE 完整事件后断流仍成功 | 执行过期决策 | 默认要求显式 `[DONE]`；无标记 fail closed；保留 `AGENTARTS_SSE_REQUIRE_DONE=false` 显式放宽 | 无 DONE 必须 reject，放宽后可接受 |
| D6 | 多工单续接共用幂等前缀 | 冲突/串单 | 前缀加入 `workOrderId`；自动续接传入触发工单 | 代码审查（端到端多工单测试列为待补） |
| D7 | AgentArts 第 2 步失败丢失 run/trace | 副作用无来源，重试重复 | 循环 try/catch，保留已执行 trace 并落 failed run/审计 | `agentarts-runtime.test.ts` 中途失败仍记录 |
| D8 | agent 可调 `calculate_candidate_plan` 发布方案 | 越权改变已验证方案 | 角色限制为 admin/safety_operator | `agent.test.ts` agent 调用 FORBIDDEN |
| D9 | image_count 的 `surveyed` 由调用方自报 | 外部模型可冒充已标定观测 | ingest 要求区域摄像头 `measured/calibrated`，并校验 calibration_id | `adapter.test.ts` 自报 surveyed 被拒 |
| D10 | Validator 无在留容量检查 | 超员方案可通过 | 增加逐分钟占用检查（含出口等待），hard | `safety-acceptance.test.ts` 超员被拒 |
| D11 | Agent 可自选人员/24h TTL | 长期占用调度资源 | Agent 请求移除 staff_id，TTL 截断到场景上限 | `reservations.test.ts` TTL ≤ 策略上限 |
| D12 | `count` 无上限、未来 `observed_at` 绕过时效 | DoS/时效绕过 | count ≤ 1,000,000；未来 >60s 返回 `FUTURE_OBSERVATION` | `safety-api.test.ts` 两项均 400 |
| D13 | checksum 不含 revision；旧幂等指纹为空可绕过；工单无上限 | 篡改/兼容绕过/状态膨胀 | 新 envelope checksum 覆盖 revision/saved_at；旧格式校验兼容；空指纹按冲突拒绝；工单上限 5000 | `state-persistence.test.ts` 现有用例通过 |
| D14 | perception 5xx 与 reload 400 回显路径 | 内部路径泄漏 | perception 改用 `failFromError`；生产 reload 不返回 detail | 生产 5xx 脱敏测试 |
| D15 | 生产读接口默认开放 | 场景/工单/审计/路径暴露 | `productionAuthConfigErrors` 要求 `READ_AUTH_REQUIRED=true` | P0-5 测试更新 |
| D16 | 接单后未开始即失败不结算 | 反复“接单即失败”绕过预算 | accepted_at 或 started_at 存在即结算 | `reservations.test.ts` accept→fail 结算 |
| D17 | uncaughtException 继续运行 | 不一致内存状态 | `uncaughtException`/`unhandledRejection` 退出码 1 | 代码审查 |
| D18 | refresh 丢 staff_id；限流豁免路径错误 | staff 续期失效；登录限流不符合配置 | refresh 保留 staff_id；限流按 baseUrl+path 豁免 | 代码审查 |
| D19 | 回放可自报 live_video | 来源误导 | 回放强制 `csv_replay`，原始来源写入 provider | 代码审查 |
| D20 | storeRun 只读失败不回滚内存 | 展示未落盘 run | 持久化失败回滚 runs/runOrder | 代码审查 |
| D21 | Validator 未过滤 disabled 区域 | 停用区域导致误拒/误接 | enabled 区域过滤与停用引用检查 | 与规划器一致 |
| D22 | 工具参数无长度上限 | 审计/CPU 放大 | 注册表统一 16KB/1000 字符/50 元素/6 层 | `agent.test.ts` 超大参数 INVALID_ARGUMENT |

## 3. Validator / 规划器加固

- Validator 只信任场景 horizon；`solver_truncated` 进入 plan schema 并 hard 拒绝；
- 逐分钟区域在留容量检查；出口前排队计入区域占用直到 `route.arrive_minute`；
- 所有启用区域必须有可信观测，传感器故障区域 hard 拒绝；
- 停用区域/通道端点/出口所属区域禁用检查；
- `exit_totals`/`corridor_totals` 从 routes 独立重算并要求一致；`step.persons` 必须等于 route.persons；
- 需求 provenance 校验：观测模式精确一致；预测模式只允许上调、与 provenance/区间上界一致；
- 规划器路径分解自检：方向/链路错配时标记 `solver_truncated`，禁止发布；
- 双向通道共享同一分钟容量（闸门节点），与 Validator 聚合口径一致。

## 4. 残余风险

1. **AgentArts 平台侧幂等语义**：稳定 `X-Request-Id` 已发送，但平台是否去重需真实租户验证。
2. **多工单续接端到端测试**：代码已按 workOrderId 隔离，尚未构造完整双工单平台 stub。
3. **锁陈旧双写**：文件锁 mtime 60s + CAS；活锁超时/进程存活校验仍是残余并发风险（需独立进程探针）。
4. **状态文件完整性**：无密钥 SHA-256 只能防损坏，不能防有文件写权限者的故意篡改；生产应使用受保护卷/签名。
5. **审计轮转/哈希链**：仍为 JSONL 追加，生产需外部采集与轮转。
6. **多实例**：CAS 防止静默覆盖，但第二个实例仍需重启才能读到新状态；单实例仍是交付边界。
7. **平台/硬件/真实场景**：AgentArts 真实租户、昇腾实机、场馆标定、无人机、用户研究均未验证。

## 5. 复现命令

```bash
npm test
npm run build
npm run demo
npm run demo:mvp
npm run test:e2e --prefix frontend
npm run verify:evidence --prefix backend
npm run manifest:final --prefix backend -- --verify
npm run manifest:release --prefix backend -- --verify
```
