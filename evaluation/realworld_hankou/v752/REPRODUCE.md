# V7.5.2 复现指南 (REPRODUCE)

**环境**: Node.js v24.19.0，npm 11.17.0，tsx v4.23.15（Windows/Git Bash 或等价 POSIX shell）。  
**工作目录**: 仓库根目录（本 worktree 为 `E:\Projects\skyguard-evacuation\.claude\worktrees\ecstatic-feistel-74fd5b`）。  
**写入范围**: 只写 `data/scenarios/hankou-v752-stress.json` 与 `evaluation/realworld_hankou/v752/`；不覆盖历史 V7.5/V7.5.1 数据。

---

## 1. 安装依赖

```bash
npm install
npm install --prefix backend
```

（若仓库已有 `node_modules`，可跳过。）

---

## 2. 生成压力场景

```bash
npx tsx scripts/simulation/v752/generate-scenarios.ts
```

输出：`data/scenarios/hankou-v752-stress.json`。

预期：

```text
ST-01: 18000 persons, 0 events
ST-02: 120000 persons, 1 events
ST-03: 80000 persons, 0 events
ST-04: 60000 persons, 2 events
ST-05: 45000 persons, 0 events
```

基础几何文件 `data/scenarios/hankou-marshland-v752-base.json` 是 V7.5 场景副本，SHA-256 固定为：

```text
9e3c10988289e6804d08b7c4d88166c1af947b73d2f0bc1c5c732c7d47a95b24
```

---

## 3. 运行 600 次基准

```bash
npx tsx scripts/simulation/v752/run-benchmark.ts
```

输出：

```text
evaluation/realworld_hankou/v752/raw/runs.jsonl              # 600 行原始记录
evaluation/realworld_hankou/v752/benchmark-summary.json      # 汇总 + 配对统计
evaluation/realworld_hankou/v752/run-metadata.json           # 分支/HEAD/种子/代码 SHA
evaluation/realworld_hankou/v752/decision-logs/*.json        # seed 1 代表性轨迹
evaluation/realworld_hankou/v752/evidence/ledger-probes.json # 账本探针
```

运行时间参考：约 2 分钟（本机 600 次 × 240 tick）。基准脚本会在任何质量残差非 0 时抛错，不会静默继续。

---

## 4. 运行回归测试

```bash
npx tsx --test backend/tests/simulation/v752.test.ts
```

预期：10/10 通过。

全后端测试：

```bash
npm test --prefix backend
```

预期：327/327 通过（包含本轮 10 个 V7.5.2 测试）。

---

## 5. 校验 SHA-256 清单

```bash
npx tsx scripts/simulation/v752/verify-manifest.ts
```

预期：

```text
OK: <n> files verified against evaluation/realworld_hankou/v752/SHA256SUMS.txt.
```

清单覆盖：

- `scripts/simulation/v752/*.ts`（含生成、引擎、策略、安全、传感器、基准、校验脚本）；
- `data/scenarios/hankou-marshland-v752-base.json` 与 `hankou-v752-stress.json`；
- `backend/tests/simulation/v752.test.ts`；
- `evaluation/realworld_hankou/v752/` 下全部报告、原始数据、汇总、决策日志、账本探针。

`SHA256SUMS.txt` 本身不在清单内（自引用问题）；`preflight-sha256.txt` 保留为修改前历史文件哈希。

---

## 6. 历史证据保护

本轮没有修改：

- `evaluation/realworld_hankou/benchmark-results.json`
- `evaluation/realworld_hankou/sensitivity-results.json`
- `evaluation/realworld_hankou/audit_v751/` 全部报告与 evidence
- `data/scenarios/hankou-marshland.json`
- `backend/src/services/safety/planning/route-stability.ts`
- `backend/src/services/safety/planning/v73-stability.ts`

修改前哈希见 [`preflight-sha256.txt`](preflight-sha256.txt)；修改后复核见 [PRESERVATION_CHECK.md](PRESERVATION_CHECK.md)。

---

## 7. 复现注意事项

1. 先确认 `git status` 与当前分支；不要在主仓库工作树直接覆盖 V7.5 未提交成果。
2. `generate-scenarios.ts` 是确定性的；同一份基础几何应生成同一份 stress JSON。
3. `run-benchmark.ts` 的 `solve_ms` 会随机器变化，但 `decision_log_hash` / `tick_ledger_hash` 不包含计时，可用于跨机器一致性检查。
4. 若修改任何仿真代码或场景参数，必须重新运行 600 次基准并重新生成 `SHA256SUMS.txt`；不得只改报告数字。
5. 负结果（ST-03 无策略差异、ST-04 改派未提高完成人数、V74 显著更差）必须保留，不得删除或调参掩盖。
