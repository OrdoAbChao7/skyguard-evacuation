/**
 * V6 科研基准：多区域联合 VoI、序贯重试/退避、邻居信息预测、多事件规划压力。
 *
 *   npm run benchmark:v6 --prefix backend
 *
 * 输出：evaluation/v6/*.json + evaluation/V6_REPORT.md
 * 全部为合成数据；不得表述为真实场馆/平台效果。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import type { Incident, SafetyScenario } from '../src/services/safety/types';
import type { RegionRisk } from '../src/services/safety/risk';
import { buildRegionGraph, propagateRisk, rankInvestigationPriorities } from '../src/services/mvp/risk-graph';
import {
  decideMultiRegionInvestigation,
  priorBeliefsForRegions,
} from '../src/services/mvp/multi-voi';
import { decideInvestigation, fixedPriorityChoice, priorBelief, expectedRisk, entropy } from '../src/services/mvp/voi';
import {
  actionAvailability,
  createInvestigationSession,
  recordAttempt,
} from '../src/services/mvp/investigation-session';
import { predictSeries } from '../src/services/mvp/prediction';
import { planEvacuation } from '../src/services/safety/planning/evacuation-planner';
import { validateSafetyPlan } from '../src/services/safety/validator';
import { resolveEffectiveNetwork } from '../src/services/safety/network';
import { buildObservation } from '../src/services/safety/observations';
import type { DensityObservation } from '../src/services/safety/types';

const SEEDS = [20261105, 20261106, 20261107, 20261108, 20261109];
const OUT = path.resolve(__dirname, '../../evaluation/v6');
const SCENARIO_PATH = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const scenario: SafetyScenario = loadSafetyScenario(SCENARIO_PATH);
const policy = scenario.investigation;
if (!policy) throw new Error('缺少 investigation 策略');
fs.mkdirSync(OUT, { recursive: true });

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mean = (values: number[]) => values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
const std = (values: number[]) => values.length < 2 ? 0 : Math.sqrt(values.reduce((s, v) => s + (v - mean(values)) ** 2, 0) / (values.length - 1));
const ci = (values: number[]) => {
  const m = mean(values);
  const half = values.length > 1 ? 1.96 * std(values) / Math.sqrt(values.length) : 0;
  return { mean: Number(m.toFixed(4)), lower: Number((m - half).toFixed(4)), upper: Number((m + half).toFixed(4)) };
};
function write(name: string, data: unknown) { fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`); }

function risk(regionId: string, level: RegionRisk['level'], trusted: boolean): RegionRisk {
  return {
    regionId, level, count: 900, density: 1.2, confidence: trusted ? 0.9 : 0.3,
    observedAt: new Date().toISOString(), ageSeconds: 10, trusted, signals: [],
    thresholds: { watch_density: 1, high_density: 2, critical_density: 3, rise_rate_watch: 0.5, source: 'synthetic' },
    thresholdsSource: 'synthetic',
  };
}

// ---------------------------------------------------------------------------
// V6-A 多区域联合 VoI
// ---------------------------------------------------------------------------
function experimentA() {
  const rng = mulberry32(SEEDS[0] + 11);
  const graph = buildRegionGraph(scenario);
  const rows: Array<Record<string, unknown>> = [];

  for (let trial = 0; trial < 300; trial += 1) {
    const risks = scenario.regions.map(region => {
      const roll = rng();
      const level: RegionRisk['level'] = roll < 0.25 ? 'critical' : roll < 0.55 ? 'high' : roll < 0.8 ? 'watch' : 'normal';
      const trusted = rng() < 0.65;
      return risk(region.id, level, trusted);
    });
    const propagated = propagateRisk(scenario, risks);
    const priorities = rankInvestigationPriorities(scenario, risks, propagated);
    const target = priorities[0].regionId;
    const beliefs = priorBeliefsForRegions(policy, risks);
    const targetBelief = beliefs.get(target) ?? priorBelief(policy);
    const availability = Object.fromEntries(policy.actions.map(action => [action.id, { available: true }]));
    const multi = decideMultiRegionInvestigation(policy, target, beliefs, graph, availability);
    const multiEval = multi.evaluations.find(item => item.action_id === multi.recommended_action_id);

    const single = decideInvestigation(policy, targetBelief, { availability });
    const singleEval = single.evaluations.find(item => item.action_id === single.recommended_action_id);
    const fixedId = fixedPriorityChoice(policy, availability).action_id;
    const fixedEval = multi.evaluations.find(item => item.action_id === fixedId);

    const cost = (time: number, resource: number) => Number((time + 10 * resource).toFixed(4));
    const actionCost = (actionId: string | null | undefined) => {
      const action = policy.actions.find(item => item.id === actionId);
      return action ? cost(action.time_cost_minutes, action.resource_cost) : 0;
    };
    rows.push({
      trial,
      target,
      target_risk: risks.find(item => item.regionId === target)?.level ?? 'unknown',
      multi: multiEval ? {
        action: multiEval.action_id,
        benefit: multiEval.weighted_risk_reduction,
        covered: multiEval.covered_regions.length,
        cost: cost(multiEval.time_cost_minutes, multiEval.resource_cost),
        efficiency: Number((multiEval.weighted_risk_reduction / Math.max(1e-6, cost(multiEval.time_cost_minutes, multiEval.resource_cost))).toFixed(6)),
      } : null,
      single: singleEval ? {
        action: singleEval.action_id,
        benefit: singleEval.risk_reduction,
        covered: 1,
        cost: actionCost(singleEval.action_id),
        efficiency: Number((singleEval.risk_reduction / Math.max(1e-6, actionCost(singleEval.action_id))).toFixed(6)),
      } : null,
      fixed: fixedEval ? {
        action: fixedEval.action_id,
        benefit: fixedEval.weighted_risk_reduction,
        covered: fixedEval.covered_regions.length,
        cost: actionCost(fixedEval.action_id),
      } : null,
    });
  }

  const summarize = (key: 'multi' | 'single' | 'fixed') => {
    const items = rows.map(row => row[key]).filter(Boolean) as Array<{ benefit: number; covered: number; cost: number }>;
    return {
      trials: items.length,
      mean_benefit: ci(items.map(item => item.benefit)),
      mean_covered: ci(items.map(item => item.covered)),
      mean_cost: ci(items.map(item => item.cost)),
      benefit_per_cost: ci(items.map(item => item.benefit / Math.max(1e-6, item.cost))),
      coverage_gt1: items.filter(item => item.covered > 1).length,
    };
  };

  return {
    config: {
      seed: SEEDS[0] + 11,
      trials: 300,
      note: '风险配置与覆盖权重为合成/启发式；多区域收益按覆盖权重求和，成本只计一次。',
    },
    summary: { multi_region: summarize('multi'), single_region: summarize('single'), fixed_priority: summarize('fixed') },
    raw: rows,
  };
}

// ---------------------------------------------------------------------------
// V6-B 序贯重试 / 冷却 / 退避
// ---------------------------------------------------------------------------
function experimentB() {
  const action = policy.actions.find(item => item.id === 'A_CAMERA')!;
  const rng = mulberry32(SEEDS[1] + 21);
  const trials = 500;
  const failureProbability = 0.3;
  const rows: Array<Record<string, unknown>> = [];

  for (let trial = 0; trial < trials; trial += 1) {
    // 无重试
    const noRetrySuccess = rng() >= failureProbability;
    // 有重试：最多 1 次重试，冷却 + 退避
    const session = createInvestigationSession('R_EAST_STAND');
    let now = new Date('2026-11-05T10:00:00.000Z');
    let attempts = 0;
    let failures = 0;
    let success = false;
    let elapsed = 0;
    for (let round = 0; round < 3; round += 1) {
      const availability = actionAvailability(policy, action, session, now);
      if (!availability.available) {
        if (availability.nextAvailableAt) {
          const next = new Date(availability.nextAvailableAt);
          elapsed += (next.getTime() - now.getTime()) / 60_000;
          now = next;
          continue;
        }
        break;
      }
      attempts += 1;
      const ok = rng() >= failureProbability;
      recordAttempt(session, action, { success: ok, outcome: ok ? 'signal_normal' : 'unavailable' }, now);
      if (ok) { success = true; break; }
      failures += 1;
      elapsed += action.time_cost_minutes;
      now = new Date(now.getTime() + action.time_cost_minutes * 60_000);
    }
    rows.push({
      trial,
      no_retry: { success: noRetrySuccess, attempts: 1, elapsed_minutes: action.time_cost_minutes },
      retry: { success, attempts, failures, elapsed_minutes: Number(elapsed.toFixed(2)) },
    });
  }

  const summarize = (key: 'no_retry' | 'retry') => {
    const items = rows.map(row => row[key]) as Array<{ success: boolean; attempts: number; failures?: number; elapsed_minutes?: number }>;
    return {
      success_rate: Number((items.filter(item => item.success).length / items.length).toFixed(4)),
      mean_attempts: Number(mean(items.map(item => item.attempts)).toFixed(4)),
      mean_failures: Number(mean(items.map(item => item.failures ?? 0)).toFixed(4)),
      mean_elapsed_minutes: Number(mean(items.map(item => item.elapsed_minutes ?? 0)).toFixed(4)),
    };
  };

  return {
    config: {
      seed: SEEDS[1] + 21,
      trials,
      failure_probability: failureProbability,
      action: action.id,
      retry: action.retry,
      note: '失败概率为合成参数；验证冷却/退避逻辑，不代表真实设备故障率。',
    },
    summary: { no_retry: summarize('no_retry'), retry: summarize('retry') },
    raw: rows,
  };
}

// ---------------------------------------------------------------------------
// V6-C 邻居信息预测
// ---------------------------------------------------------------------------
function experimentC() {
  const horizons = [2, 5, 10];
  const results: Array<Record<string, unknown>> = [];
  for (const horizon of horizons) {
    const ownErrors: number[] = [];
    const spatialErrors: number[] = [];
    for (const seed of SEEDS) {
      const rng = mulberry32(seed + 31);
      for (let series = 0; series < 120; series += 1) {
        const base = 240 + rng() * 300;
        const slope = (rng() - 0.5) * 14;
        const length = 20 + horizon;
        const shared = Array.from({ length }, (_, t) => base + slope * t + (rng() + rng() + rng() - 1.5) * 6);
        const own = shared.map((value, t) => Math.max(0, Math.round(value + (rng() + rng() - 1) * 30)));
        const neighbourB = shared.map((value, t) => Math.max(0, Math.round(value + (rng() + rng() - 1) * 18)));
        const neighbourC = shared.map((value, t) => Math.max(0, Math.round(value + (rng() + rng() - 1) * 18)));
        const trainOwn = own.slice(0, 20);
        const trainB = neighbourB.slice(0, 20);
        const trainC = neighbourC.slice(0, 20);
        const truth = own[20 + horizon - 1];
        const ownPrediction = predictSeries(trainOwn, { horizonMinutes: horizon }).predicted;
        const bPrediction = predictSeries(trainB, { horizonMinutes: horizon }).predicted;
        const cPrediction = predictSeries(trainC, { horizonMinutes: horizon }).predicted;
        const spatialPrediction = Math.max(0, Math.round(0.75 * ownPrediction + 0.25 * ((bPrediction + cPrediction) / 2)));
        ownErrors.push(Math.abs(ownPrediction - truth));
        spatialErrors.push(Math.abs(spatialPrediction - truth));
      }
    }
    results.push({
      horizon_minutes: horizon,
      own_mae: ci(ownErrors),
      spatial_mae: ci(spatialErrors),
      relative_improvement: Number((1 - mean(spatialErrors) / Math.max(1e-6, mean(ownErrors))).toFixed(4)),
    });
  }
  return {
    config: {
      seeds: SEEDS,
      series_per_seed: 120,
      note: '共享趋势 + 区域独立噪声的合成序列；邻居信息不是真实人群迁移证据。',
    },
    results,
  };
}

// ---------------------------------------------------------------------------
// V6-D 多事件规划压力
// ---------------------------------------------------------------------------
function incident(id: string, affected: Incident['affected']): Incident {
  const now = new Date().toISOString();
  return {
    id, type: 'corridor_closure', description: 'V6 多事件压力', status: 'confirmed', severity: 'critical',
    affected, source: 'simulation', reported_by: 'v6', reported_at: now, confirmed_by: 'v6', confirmed_at: now,
  };
}

function experimentD() {
  const network = resolveEffectiveNetwork(scenario, [
    incident('V6-E', { region_ids: [], corridor_ids: [], exit_ids: ['E_EAST'] }),
    incident('V6-C', { region_ids: [], corridor_ids: ['C_MID'], exit_ids: [] }),
    incident('V6-S', { region_ids: ['R_EAST_STAND'], corridor_ids: [], exit_ids: [] }),
  ]);
  const demand = new Map(scenario.regions.map(region => [region.id, Math.round(region.holding_capacity_persons * 0.9)]));
  const output = planEvacuation({
    scenario, network, demandByRegion: demand,
    scenarioVersion: scenario.version, constraintVersion: 2, observationVersion: 2,
  });
  const observations = new Map<string, DensityObservation>(
    scenario.regions.map(region => [region.id, buildObservation({
      region,
      count: demand.get(region.id) ?? 0,
      confidence: 0.95,
      source: 'simulation',
      provider: 'v6',
      modelVersion: 'v6-benchmark',
      observedAt: new Date(),
    })]),
  );
  const validation = validateSafetyPlan({
    plan: output.plan, scenario, network,
    latestObservations: observations, config: scenario.config,
    constraintVersion: 2, observationVersion: 2,
  });
  return {
    config: {
      incidents: 3,
      demand_model: '区域在留容量 ×0.9 的合成需求',
      note: '多事件同时发生的合成压力；不代表真实场景。',
    },
    summary: {
      plan_status: output.plan.status,
      unresolved_persons: output.plan.unresolved_persons,
      viable_routes: output.plan.routes.length,
      validator_valid: validation.valid,
      violation_codes: Array.from(new Set(validation.violations.map(item => item.code))),
    },
  };
}

const a = experimentA();
write('experiment_a_multi_region_voi.json', a);
const b = experimentB();
write('experiment_b_retry_backoff.json', b);
const c = experimentC();
write('experiment_c_spatial_prediction.json', c);
const d = experimentD();
write('experiment_d_multi_event_planning.json', d);
write('run_metadata.json', {
  generated_at: new Date().toISOString(),
  seeds: SEEDS,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  scenario: { id: scenario.scenario_id, version: scenario.version, path: SCENARIO_PATH },
  data_nature: '全部为合成/模拟数据；不含真实场馆、人群、无人机、昇腾或 AgentArts 实测。',
});

const report = `# SkyGuard V6 科研报告

> ⚠ **V6.1 审计更正**：本报告的多区域比较（0.083 vs 0.024）未做预算配对；序贯重试的
> 91% vs 68.6% 实际是“2 次 vs 1 次尝试”的差异。请以 \`evaluation/V6_1_REPORT.md\`
> 的同预算/同尝试审计结果为准。

> 由 \`npm run benchmark:v6 --prefix backend\` 生成。全部为合成数据，不代表真实效果。

## 1. 多区域联合 VoI（300 次）

| 策略 | 平均加权风险降低 [95% CI] | 平均覆盖区域 | 平均成本 | 收益/成本 [95% CI] | 覆盖 >1 区域 |
| --- | --- | --- | --- | --- | --- |
| 多区域 VoI | ${a.summary.multi_region.mean_benefit.mean} [${a.summary.multi_region.mean_benefit.lower}, ${a.summary.multi_region.mean_benefit.upper}] | ${a.summary.multi_region.mean_covered.mean} | ${a.summary.multi_region.mean_cost.mean} | ${a.summary.multi_region.benefit_per_cost.mean} [${a.summary.multi_region.benefit_per_cost.lower}, ${a.summary.multi_region.benefit_per_cost.upper}] | ${a.summary.multi_region.coverage_gt1} |
| 单区域 VoI | ${a.summary.single_region.mean_benefit.mean} [${a.summary.single_region.mean_benefit.lower}, ${a.summary.single_region.mean_benefit.upper}] | ${a.summary.single_region.mean_covered.mean} | ${a.summary.single_region.mean_cost.mean} | ${a.summary.single_region.benefit_per_cost.mean} | ${a.summary.single_region.coverage_gt1} |
| 固定优先级 | ${a.summary.fixed_priority.mean_benefit.mean} [${a.summary.fixed_priority.mean_benefit.lower}, ${a.summary.fixed_priority.mean_benefit.upper}] | ${a.summary.fixed_priority.mean_covered.mean} | ${a.summary.fixed_priority.mean_cost.mean} | ${a.summary.fixed_priority.benefit_per_cost.mean} | ${a.summary.fixed_priority.coverage_gt1} |

**解读**：多区域联合评估只降低一次成本，却能把邻居区域的收益计入，因此覆盖/收益效率更高；
但覆盖权重与风险传播是启发式，不能当作真实人群传播规律。

## 2. 序贯重试与退避（500 次，失败率 ${b.config.failure_probability}）

| 策略 | 成功率 | 平均尝试 | 平均失败 | 平均耗时（分钟） |
| --- | --- | --- | --- | --- |
| 无重试 | ${b.summary.no_retry.success_rate} | ${b.summary.no_retry.mean_attempts} | ${b.summary.no_retry.mean_failures} | ${b.summary.no_retry.mean_elapsed_minutes} |
| 冷却 + 退避重试 | ${b.summary.retry.success_rate} | ${b.summary.retry.mean_attempts} | ${b.summary.retry.mean_failures} | ${b.summary.retry.mean_elapsed_minutes} |

**解读**：重试提高成功率，但增加尝试与时间；失败率为合成参数，不代表真实设备故障率。

## 3. 邻居信息预测（5 种子 × 120 序列）

| 窗口 | 自身 MAE [95% CI] | 邻居融合 MAE [95% CI] | 相对改进 |
| --- | --- | --- | --- |
${c.results.map(item => `| ${item.horizon_minutes} 分钟 | ${item.own_mae.mean} [${item.own_mae.lower}, ${item.own_mae.upper}] | ${item.spatial_mae.mean} [${item.spatial_mae.lower}, ${item.spatial_mae.upper}] | ${item.relative_improvement} |`).join('\n')}

**解读**：共享趋势的合成序列中邻居信息可降低误差；真实场景是否成立需真实数据验证。

## 4. 多事件规划压力

- 方案状态：${d.summary.plan_status}
- 未解决人数：${d.summary.unresolved_persons}
- 可用路线：${d.summary.viable_routes}
- 独立校验通过：${d.summary.validator_valid}
- 违规码：${d.summary.violation_codes.join(', ') || '无'}

**解读**：同时关闭出口/通道并标记区域异常时，规划与独立校验仍能给出明确结论；
这是合成压力测试，不是真实场馆安全评估。

## 5. 边界

- 所有风险配置、需求、失败概率、邻居序列均为合成；
- 多区域覆盖权重（邻居 0.5 / 全局 0.3）是工程启发式；
- 未在真实 AgentArts/昇腾/无人机/视频上验证；
- 不能把任何数字表述为真实场景效果或获奖保证。
`;
fs.writeFileSync(path.resolve(__dirname, '../../evaluation/V6_REPORT.md'), report);
console.log('[v6] 输出 evaluation/v6/*.json 与 evaluation/V6_REPORT.md');
