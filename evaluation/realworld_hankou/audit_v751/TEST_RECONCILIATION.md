# V7.5.1 测试数量与构成对账报告 (TEST_RECONCILIATION)

**审计对象**: `evaluation/realworld_hankou/` 及其对外报告中的测试数量主张  
**审计基准**: `feat/skyguard-mvp-e2e` @ `66eb9d5`（V7.5 成果为工作树未提交文件）  
**审计时间**: 2026-11-10T18:39Z（北京时间 2026-11-11 02:39）  
**审计方式**: 实际执行全部测试、E2E、演示与构建；不修改源代码、不修改测试、不修改实验数据。

---

## 1. 实际执行结果

| 套件 | 命令 | 结果 | 备注 |
| :--- | :--- | :---: | :--- |
| 后端单元/集成 | `npm test --prefix backend` | **222 / 222 通过** | `tsx --test`，0 fail / 0 skip |
| 前端单元 | `npm test --prefix frontend` | **20 / 20 通过** | Vitest，5 个测试文件 |
| 单元小计 | 222 + 20 | **242 / 242 通过** | 这就是报告中的“242 单元” |
| 汉口 E2E | `npx tsx tests/e2e/realworld_hankou/run-all-e2e.ts` | **143 / 143 通过** | Tier 1=61, Tier 2=60, Tier 3=14, Tier 4=8 |
| 单元 + E2E | 242 + 143 | **385 / 385 通过** | 与“385 项测试”总数一致 |
| 安全演示 | `npm run demo` | **3 / 3 场景符合预期** | NORMAL / REROUTE / REJECT |
| MVP 演示 | `npm run demo:mvp` | **3 / 3 场景通过** | 共 6 个演示场景 |
| 生产构建 | `npm run build` | **通过** | 后端 `tsc` + 前端 `tsc --noEmit && vite build` |

**结论**: “385 项测试全部通过”在“242 单元 + 143 E2E”的口径下成立；该表述应始终带口径，不能写成“385 个后端测试”或“385 个独立安全测试”。

---

## 2. 385、391 与 242 的口径对账

### 2.1 385 是正确的

```text
后端 222 + 前端 20 = 242 单元/集成
242 + 143 E2E = 385
```

因此 `FINAL_REPORT.md` 与 `REPRODUCE.md` 中“385 项（242 单元 + 143 E2E）”的**总数正确**。  
但 `AUDIT.md` 与部分汇报材料中的以下表述**不正确**：

| 原表述 | 实际 | 判定 |
| :--- | :--- | :---: |
| “后端 242 项” | 后端 **222**；242 是后端+前端 | **FAIL** |
| “前端 17 项” | 前端 **20** | **FAIL** |
| “191 项历史基线 + 31 项汉口 = 222” | **175 项非汉口/非 crowd + 28 项汉口 + 19 项 crowd = 222** | **FAIL** |
| “385 项测试，其中 28 项汉口 + 8 项 crowd 为新增” | 28 项汉口 + 19 项 crowd = **47 项新增**；8 不是 crowd 总数 | **FAIL** |

### 2.2 391 不是“更多测试”，而是不同计数单位

6 个 Demo 是**场景级验收**（3 个安全场景 + 3 个 MVP 场景），不是 `npm test` 或 E2E 中的测试用例。  
若把 6 个场景也当作“测试”相加，得到 391；这与 385 不矛盾，但属于**不同单位**，不能用来暗示“测试资产增加了 6 项”。对外应写：

> 385 项自动化测试（242 单元/集成 + 143 E2E）通过；另有 6 个演示场景验收通过。

---

## 3. 后端 222 项的真实构成

分别执行子集得到：

| 子集 | 命令 | 用例数 |
| :--- | :--- | ---: |
| 汉口安全相关 | `tsx --test tests/safety/hankou-*.test.ts` | **28** |
| 连续客流模型 | `tsx --test tests/crowd/*.test.ts` | **19** |
| 其余后端测试 | 222 − 28 − 19 | **175** |
| 合计 | — | **222** |

28 项汉口的四个文件为：`hankou-benchmark.test.ts`、`hankou-integration.test.ts`、`hankou-scenario.test.ts`、`hankou-stress-challenge.test.ts`。  
19 项 crowd 的两个文件为：`dynamic-model.test.ts`、`stress-adversarial.test.ts`。

因此 `AUDIT.md` 的“191 + 31”虽然算术上等于 222，但两个加数都无法由测试运行器复现。**总数 222 正确，构成错误。**

---

## 4. 测试通过是否等于结论成立

**不等于。** 本次审计确认：

1. 汉口 E2E 使用 `tests/e2e/realworld_hankou/fixtures/gis-pipeline-data.ts` 中的**平行夹具**：
   - 使用 `RIVER_ALIGNMENT_ANGLE_DEG = 42.0`，而不是生成器的 50.961°；
   - 使用与 `scripts/gis/generate-hankou-scenario.ts` 不同的闸门坐标（例如 G03、G05、G07、G10 均不同）；
   - 因此 E2E 验证的是夹具中的逻辑，不是 `data/scenarios/hankou-marshland.json` 的真实生成管线。
2. `hankou-benchmark.test.ts` 验证的是：
   - JSON 是否存在、是否有 750 条记录；
   - 置信区间是否满足 `lower <= mean <= upper`；
   - p 值是否在 `[0,1]`、Holm 校正是否单调；
   - 抖动削减率是否 >70%、ST-05 通过率是否 =100%。
   
   这些断言**把预期结论写成了测试**，但没有验证：
   - 仿真是否使用了规划器输出的 `plan`；
   - 质量是否守恒；
   - 闸口队列是否计入 `unserved`；
   - `validator_passed` 是否来自真实验证器而不是硬编码；
   - V7.4 在 ST-05 是否使用了真值观测。
3. 测试通过只能说明“当前实现与当前测试断言一致”，不能说明“算法对比有效”或“现实安全”。

---

## 5. 判定汇总

| 主张 | 判定 | 说明 |
| :--- | :---: | :--- |
| 后端 222、前端 20、E2E 143、合计 385 全部通过 | **PASS** | 本次实际执行复现 |
| 242 = 后端 + 前端 | **PASS** | 口径正确 |
| “后端 242” | **FAIL** | 后端只有 222 |
| “前端 17” | **FAIL** | 前端 20 |
| “191 历史 + 31 汉口” | **FAIL** | 实际 175 + 47 |
| “Demo 6 属于 385” | **FAIL** | Demo 不在 385 内；若相加为 391，单位不同 |
| 测试通过证明算法优越/现实安全 | **FAIL** | 测试未覆盖构造有效性；且断言了预期结论 |
| E2E 验证真实 GIS 生成管线 | **FAIL** | 使用 42° 平行夹具，坐标与生成器不同 |
| 构建通过 | **PASS** | `npm run build` 成功 |

---

## 6. 复现命令

```bash
npm test
npx tsx tests/e2e/realworld_hankou/run-all-e2e.ts
npm run demo
npm run demo:mvp
npm run build
```

子集计数：

```bash
cd backend
node_modules/.bin/tsx --test tests/safety/hankou-*.test.ts
node_modules/.bin/tsx --test tests/crowd/*.test.ts
```

---

## 7. 证据与限制

- 本次执行发生在主工作树 `E:/Projects/skyguard-evacuation`，V7.5 相关文件为**未提交工作树文件**；测试结果对应该工作树，不对应任何 Git commit 或 tag。
- 未修改任何源代码、测试或实验数据；未执行 commit / push / PR / tag。
- 测试执行不构成第三方认证；`victory_auditor_1` 是内部 Agent 产物，本次审计发现其“未检测到硬编码或门面实现”的结论与代码事实不符。
