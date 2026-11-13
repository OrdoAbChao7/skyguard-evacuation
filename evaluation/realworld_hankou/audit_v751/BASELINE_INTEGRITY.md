# V7.5.1 历史基线与哈希完整性审计 (BASELINE_INTEGRITY)

**审计对象**: `data/scenarios/stadium-evacuation.json`、`backend/src/services/safety/validator.ts`、`backend/src/services/safety/planning/evacuation-planner.ts`、`backend/src/services/safety/state-machine.ts`、`evaluation/realworld_hankou/AUDIT.md`、`REPRODUCE.md`  
**历史基准**: `4025ac1a4a5da5168c61876067000cdecc7c12b7`（`feat(v6.4): 公平 VoI 复跑与预算/AgentArts/MCP 工程加固`，2026-11-09 01:36 +0800）  
**当前 HEAD**: `66eb9d50f592b27f90de41fb207fea6a0eaf0d89`（`fix(v6.5): 修复独立审计 P0`，2026-11-09 07:52 +0800）  
**当前分支**: `feat/skyguard-mvp-e2e`  
**审计时间**: 2026-11-10T18:45Z

---

## 0. 路径更正

任务描述中的 `backend/src/core/validator.ts`、`backend/src/core/evacuation-planner.ts`、`backend/src/core/state-machine.ts` 在当前仓库中**不存在**。实际路径为：

| 任务写法 | 实际路径 |
| :--- | :--- |
| `backend/src/core/validator.ts` | `backend/src/services/safety/validator.ts` |
| `backend/src/core/evacuation-planner.ts` | `backend/src/services/safety/planning/evacuation-planner.ts` |
| `backend/src/core/state-machine.ts` | `backend/src/services/safety/state-machine.ts` |

本报告按实际路径核对。若对外材料仍写 `core/...`，应同步修正。

---

## 1. Git 状态与工作树

- `4025ac1` 是当前 HEAD 的祖先：`git merge-base --is-ancestor 4025ac1 HEAD` → **YES**。
- 四个基线文件在工作树中**无未提交修改**：`git status --porcelain -- <files>` 输出为空。
- `git diff --stat 4025ac1 HEAD -- <files>` 输出为空（0 行修改）。
- V7.5 的脚本、场景与报告全部为**未跟踪工作树文件**（`git ls-files --error-unmatch` 失败），不在任何 commit/tag 中。详见 §4。

---

## 2. 四个基线文件的独立哈希核对

### 2.1 结果表

| 文件 | `4025ac1` blob SHA-1 | `HEAD` blob SHA-1 | 工作树 `git hash-object` | blob 字节 | 工作树字节 | 工作树 SHA-256 |
| :--- | :--- | :--- | :--- | ---: | ---: | :--- |
| `data/scenarios/stadium-evacuation.json` | `3fc120a36525dc3fa80f85c79f2622d3fb26e8ee` | `3fc120a3…`（相同） | `3fc120a3…`（相同） | 28,844 | 28,844 | `7c6f0eccf529d469a70a7729dfc51bf2b0aa53ead57941539bba3a166d849264` |
| `backend/src/services/safety/validator.ts` | `4d6b7ba3849bd8e5a66cbbaed5691655f3927e5c` | `4d6b7ba3…`（相同） | `4d6b7ba3…`（相同） | 19,191 | 19,701 | `fc16e0e1fe84d1029f63e0672c60e71fae6696cefcb41777a34571976e0240ec` |
| `backend/src/services/safety/planning/evacuation-planner.ts` | `dccc4d51836f642dbcf97a5df1eb6dc1f391cc4a` | `dccc4d51…`（相同） | `dccc4d51…`（相同） | 12,861 | 13,185 | `b067a4d9b6e9f5326c4975abd1f495c846fbc095a1c7d3698d781f120de6481e` |
| `backend/src/services/safety/state-machine.ts` | `5e899910d9bb3213a09129899ddea8bec2767639` | `5e899910…`（相同） | `5e899910…`（相同） | 7,204 | 7,422 | `4dd6060b3d7cef901ffa82153618bd08e7ecdffb6787fb9500f1517bba3dd4eb` |

> 表中四个 SHA-256 均为 64 位十六进制，已用 `sha256sum` 逐项复核。

### 2.2 结论

- **Git blob 层面完全一致**：`4025ac1`、`HEAD`、工作树的 `git hash-object` 三者相同；
- 因此 `validator.ts`、`evacuation-planner.ts`、`state-machine.ts` 自 `4025ac1` 以来**内容零修改**；
- `stadium-evacuation.json` 也**内容零修改**；
- 工作树字节数与 blob 字节数不同（如 validator 19,701 vs 19,191），是因为工作树是 **CRLF**，Git blob 是 **LF**；`git hash-object` 会做换行归一化，所以 SHA-1 相同；
- 工作树 SHA-256 是对 **CRLF 字节**计算的，所以在 LF 检出的机器上会得到不同值。

### 2.3 完整 SHA-256 值（CRLF 工作树）

```text
stadium-evacuation.json   7c6f0eccf529d469a70a7729dfc51bf2b0aa53ead57941539bba3a166d849264
validator.ts              fc16e0e1fe84d1029f63e0672c60e71fae6696cefcb41777a34571976e0240ec
evacuation-planner.ts     b067a4d9b6e9f5326c4975abd1f495c846fbc095a1c7d3698d781f120de6481e
state-machine.ts          4dd6060b3d7cef901ffa82153618bd08e7ecdffb6787fb9500f1517bba3dd4eb
```

> 校验方法说明：`REPRODUCE.md` 与 `AUDIT.md` 中的 SHA-256 与上述 CRLF 值一致，因此它们只能证明“当前 Windows 工作树字节未被改动”，不能跨平台证明“内容未改动”。跨平台应使用 `git hash-object` 或 `git diff 4025ac1 HEAD`；本报告两者均为空/相同。

---

## 3. 回归测试重跑

### 3.1 实际执行

在 `backend/` 下用 `tsx --test` 重跑与安全内核直接相关的测试：

| 测试文件 | 用例数 | 结果 |
| :--- | ---: | :---: |
| `tests/safety/safety-acceptance.test.ts` | 14 | 14/14 通过 |
| `tests/safety/safety-planner.test.ts` | 8 | 8/8 通过 |
| `tests/safety/safety-state-machine.test.ts` | 7 | 7/7 通过 |
| `tests/safety/scenario-fallback.test.ts` | 2 | 2/2 通过 |
| `tests/safety/observations.test.ts` | 3 | 3/3 通过 |
| **核心小计** | **34** | **34/34 通过** |
| `tests/safety/safety-api.test.ts` + `safety-providers.test.ts` | 13 | 13/13 通过 |
| **合计** | **47** | **47/47 通过** |

- 无 fail / skip / cancelled；
- 覆盖规划器容量/时间窗、关闭通道、未知容量、反向通道、流量守恒、状态机四态优先级、场景回退、观测；
- 这些测试证明“基线代码行为未回归”，不证明“汉口基准构造有效”。

> 早期记录中的“36/36”是另一个子集（未保留文件清单），本次无法精确复现该数字；以上 47 项是本次可逐文件复核的计数。

### 3.2 与全量测试的关系

- 后端全量 222/222、前端 20/20、E2E 143/143、合计 385/385，已在 `TEST_RECONCILIATION.md` 中逐项复核；
- 222 的构成是 **175 非汉口/非 crowd + 28 汉口 + 19 crowd**，不是 `AUDIT.md` 所写的“191 历史 + 31 汉口”；
- 全量通过不改变 §4 的构造有效性问题。

---

## 4. V7.5 成果的版本追溯状态

以下文件全部为**未跟踪工作树文件**，不在 `4025ac1`、`66eb9d5` 或任何 commit/tag 中：

```text
data/scenarios/hankou-marshland.json
evaluation/realworld_hankou/
scripts/benchmark/run-hankou-benchmark.ts
scripts/gis/generate-hankou-scenario.ts
scripts/crowd/differential-model.ts
scripts/crowd/sensitivity-analysis.ts
tests/e2e/realworld_hankou/
```

影响：

1. 750 轮基准、143 项 E2E、GIS 场景、人群模型都无法通过 `git checkout <commit>` 复现；
2. 只能依赖工作树哈希（本报告与 `SHA256SUMS.txt` 已记录）；
3. 若工作树被清理、覆盖或换行转换，成果不可恢复；
4. 对外不能写“已提交/已冻结/可追溯到 commit”；应写“未提交工作树成果，哈希见审计证据”。

**判定**: 基线内核 **PASS**（内容零修改）；V7.5 成果版本追溯 **BLOCKED**（无 commit/tag）。

---

## 5. AUDIT.md 与 REPRODUCE.md 的具体错误

### 5.1 文件大小

`AUDIT.md` §6 表格：

| 文件 | AUDIT 声称 | 实际 | 判定 |
| :--- | ---: | ---: | :---: |
| `stadium-evacuation.json` | 33,639 | **28,844** | **FAIL** |
| `hankou-marshland.json` | 52,187 | **88,172** | **FAIL** |
| `validator.ts` | 19,701 | 19,701 | PASS |
| `evacuation-planner.ts` | 13,185 | 13,185 | PASS |
| `state-machine.ts` | 7,422 | 7,422 | PASS |
| `benchmark-results.json` | 389,828 | 389,828 | PASS |

- 两个场景 JSON 的大小与实际字节数不符；SHA-256 却与当前文件匹配。一个 28,844 字节的文件不可能同时是 33,639 字节，说明大小列是旧数据/手填错误；
- 代码文件大小正确，说明表格是混合来源，不是同一次 `stat` 的结果。

### 5.2 测试构成

| AUDIT 声称 | 实际 | 判定 |
| :--- | :--- | :---: |
| “191 项历史基线 + 31 项汉口” | 175 非汉口/非 crowd + 28 汉口 + 19 crowd | **FAIL** |
| “3 项演示用例” | `npm run demo` 3 + `npm run demo:mvp` 3 = 6 个场景 | **PARTIAL**（只数了一个脚本） |
| “242 单元 = 后端 222 + 前端 20” | 正确 | PASS |
| “385 = 242 + 143” | 正确 | PASS |

### 5.3 自认证表述

`AUDIT.md` 的结论是 `AUDIT_PASSED`、`APPROVED & VERIFIED`、`100% compliance`，但：

- 它是同一研发流程内的内部审计产物，不是第三方认证；
- 它未检查基准脚本的 `arrivalRate` 单位、队列双重计数、`planOutput` 未进入仿真、validator 硬编码、ST-05 oracle、ST-04 ID 不匹配；
- 因此 `AUDIT_PASSED` 不能作为对外“独立验证”的依据。

`.agents/teamwork/victory_auditor_1/audit_report.md` 的“VICTORY CONFIRMED / No hardcoding or facade implementations detected”与本轮代码事实直接矛盾；该文件是内部 Agent 产物，不得称为第三方审计。

---

## 6. 判定汇总

| 审计项 | 判定 | 依据 |
| :--- | :---: | :--- |
| `4025ac1` 是 HEAD 祖先 | **PASS** | `git merge-base --is-ancestor` |
| 四个基线文件自 `4025ac1` 零修改 | **PASS** | blob SHA-1 相同；diff 为空 |
| 工作树无未提交修改 | **PASS** | `git status` 为空 |
| 跨平台 SHA-256 可复现 | **FAIL/PARTIAL** | 报告哈希是 CRLF 工作树哈希；LF 检出会不同 |
| 回归测试通过 | **PASS** | 核心 34/34 + API/provider 13/13 |
| AUDIT 文件大小正确 | **FAIL** | 两个场景 JSON 大小错误 |
| AUDIT 测试构成正确 | **FAIL** | 191+31 无法复现；实际 175+28+19 |
| V7.5 成果可追溯到 commit/tag | **BLOCKED** | 全部未跟踪 |
| 内部审计可称第三方认证 | **FAIL** | 内部产物；且结论与代码事实矛盾 |

---

## 7. 建议的基线保护写法

对外材料应改为：

> 安全内核 `validator.ts`、`evacuation-planner.ts`、`state-machine.ts` 与历史场景 `stadium-evacuation.json` 相对 `4025ac1` 的 Git blob SHA-1 完全一致，`git diff` 为空；回归测试 47/47 通过。V7.5 新增脚本、场景与报告为未提交工作树成果，哈希见 `audit_v751/evidence/SHA256SUMS.txt`，尚不可通过 commit/tag 追溯。

不得写：

- “SHA-256 绝对一致，跨平台防篡改”（CRLF 依赖）；
- “191 项历史 + 31 项汉口”；
- “APPROVED & VERIFIED / 100% 合规”（内部自评）；
- “第三方审计确认无硬编码”。
