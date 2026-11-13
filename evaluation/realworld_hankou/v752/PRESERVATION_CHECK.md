# V7.5.2 历史证据保护检查 (PRESERVATION_CHECK)

**原则**: 本轮只新增 `evaluation/realworld_hankou/v752/`、`data/scenarios/hankou-v752-stress.json`、`scripts/simulation/v752/` 与 `backend/tests/simulation/v752.test.ts`；不修改 V7.5/V7.5.1/V7.2/V7.3/V7.4 的原始证据与参数。

---

## 1. 修改前哈希（preflight）

文件：[`preflight-sha256.txt`](preflight-sha256.txt)

| 文件 | 修改前 SHA-256 |
| :--- | :--- |
| `scripts/benchmark/run-hankou-benchmark.ts` | `35b6391c146bedd7b7c57ac6cc6e3a01d1f5e57d41654f330ef7dc7b4b042fd1` |
| `scripts/crowd/differential-model.ts` | `f705114f465a0aff3358e63785edc9cc819be477db7e61ec53d828973344ff1a` |
| `evaluation/realworld_hankou/benchmark-results.json` | `2dcd3c779aced5bf1c55a7fd9a20230ed29839dfa4de0645630503819ce55fd6` |
| `evaluation/realworld_hankou/sensitivity-results.json` | `92b4090aeccb5e14846990acc1eabc985caa187187be6af075346b5494f33350` |
| `data/scenarios/hankou-marshland.json` | `9e3c10988289e6804d08b7c4d88166c1af947b73d2f0bc1c5c732c7d47a95b24` |
| `backend/src/services/safety/planning/route-stability.ts` | `6b86f531b4e4605a68a4b6497395e3d5ae8c8474b127a32383efcb83a790937b` |
| `backend/src/services/safety/planning/v73-stability.ts` | `33d5b765c0d853585ff56a5b6a8eea2a9afb7e6a6713dea3f921082a0c0fc290` |

---

## 2. 修改后复核

在 **2026-11-11** 本轮结束时重新计算：

| 文件 | 结果 |
| :--- | :--- |
| `scripts/benchmark/run-hankou-benchmark.ts` | **SAME** |
| `scripts/crowd/differential-model.ts` | **SAME** |
| `evaluation/realworld_hankou/benchmark-results.json` | **SAME** |
| `evaluation/realworld_hankou/sensitivity-results.json` | **SAME** |
| `data/scenarios/hankou-marshland.json` | **SAME** |
| `backend/src/services/safety/planning/route-stability.ts` | **SAME**（worktree 副本） |
| `backend/src/services/safety/planning/v73-stability.ts` | **SAME**（worktree 副本） |

说明：`route-stability.ts` / `v73-stability.ts` 在本次 worktree 中存在，主工作树当前没有同路径文件；preflight 的这两条相对路径按本 worktree 复核为 SAME。

---

## 3. 未修改的目录

- `evaluation/realworld_hankou/audit_v751/`：全部审计报告与 `evidence/` 未写入；
- `evaluation/realworld_hankou/` 下的 V7.5 报告、`benchmark-results.json`、`sensitivity-results.json` 未写入；
- `evaluation/v72/`、`evaluation/v73/`、`evaluation/v74/` 冻结证据未写入；
- `data/scenarios/hankou-marshland.json`、`data/scenarios/stadium-evacuation.json` 未写入；
- `backend/src/services/safety/` 既有安全内核未修改。

> 本轮只读取上述文件用于审计与对照，没有覆盖、重命名或删除。

---

## 4. 新增文件（不属于历史证据）

| 路径 | 说明 |
| :--- | :--- |
| `scripts/simulation/v752/*.ts` | V7.5.2 仿真内核、场景生成、基准、诊断、清单校验 |
| `backend/tests/simulation/v752.test.ts` | V7.5.2 回归测试 |
| `data/scenarios/hankou-marshland-v752-base.json` | V7.5 基础几何副本（SHA 与历史文件一致） |
| `data/scenarios/hankou-v752-stress.json` | 合成压力场景 |
| `evaluation/realworld_hankou/v752/**` | 本轮报告、原始数据、证据 |

---

## 5. 提交状态

本轮**没有**执行 `git commit`、`git push`、`git tag` 或 PR。分支为 `feat/v752-simulation-integrity`，基线 HEAD 为 `345f4d1660573c44de12ad26fa19136a6a5e9122`。所有新增/修改仍在工作树中，等待授权后再提交。
