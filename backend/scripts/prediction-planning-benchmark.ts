/**
 * 预测驱动规划对照实验（evaluation/final/prediction-planning）。
 *
 * 对同一合成序列与同一场景，比较三种需求来源：
 *   observed   = 最新观测人数
 *   predicted  = 预测点估计（不低于观测）
 *   robust     = 预测区间上界（不低于观测；不可靠时回退观测）
 *
 * 指标：规划需求、已分配、未解决、方案状态。全部为合成数据；不代表真实疏散效果。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../src/services/safety/network';
import { planEvacuation } from '../src/services/safety/planning/evacuation-planner';
import { ObservationStore } from '../src/services/safety/observations';
import { PredictionService } from '../src/services/mvp/prediction';
import type { DensityObservation, SafetyScenario } from '../src/services/safety/types';

const ROOT = path.resolve(__dirname, '../..');
const SCENARIO_PATH = path.join(ROOT, 'data/scenarios/stadium-evacuation.json');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(ROOT, 'evaluation/final/prediction-planning', RUN_ID);
const SEEDS = Array.from({ length: 30 }, (_, index) => 20261105 + index);
const MECHANISMS = ['stable', 'surge', 'decline', 'periodic', 'missing', 'noisy'] as const;
const TARGET = 'R_EAST_STAND';
const POINTS = 20;

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

function gaussian(random: () => number): number {
  const u = Math.max(1e-9, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function series(mechanism: typeof MECHANISMS[number], seed: number): number[] {
  const random = mulberry32(seed * 131 + MECHANISMS.indexOf(mechanism) * 7_919);
  return Array.from({ length: POINTS }, (_, t) => {
    let value = 300;
    if (mechanism === 'stable') value = 300 + gaussian(random) * 12;
    else if (mechanism === 'surge') value = t < 12 ? 220 + gaussian(random) * 10 : 220 + (t - 11) * 28 + gaussian(random) * 12;
    else if (mechanism === 'decline') value = Math.max(30, 520 - t * 8 + gaussian(random) * 10);
    else if (mechanism === 'periodic') value = 320 + 100 * Math.sin((2 * Math.PI * t) / 20) + gaussian(random) * 10;
    else if (mechanism === 'noisy') value = 300 + gaussian(random) * 80;
    return Math.max(0, Math.round(value));
  });
}

function observation(regionId: string, count: number, at: Date, index: number): DensityObservation {
  return {
    id: `OBS-${regionId}-${at.getTime()}-${index}`,
    region_id: regionId,
    observed_at: at.toISOString(),
    received_at: at.toISOString(),
    estimated_count: count,
    estimated_density: count / 750,
    confidence: 0.95,
    source: 'simulation',
    provider: 'final-experiment',
    model_version: 'synthetic/1.0.0',
    calibration_version: 'synthetic',
    valid: true,
  };
}

function baselineDemand(scenario: SafetyScenario): Map<string, number> {
  const demand = new Map<string, number>();
  for (const region of scenario.regions) {
    const baseline = scenario.simulation_baseline?.[region.id];
    demand.set(region.id, baseline?.count ?? 0);
  }
  return demand;
}

function planFor(scenario: SafetyScenario, demand: Map<string, number>) {
  const network = resolveEffectiveNetwork(scenario, []);
  return planEvacuation({
    scenario,
    network,
    demandByRegion: demand,
    scenarioVersion: scenario.version,
    constraintVersion: 0,
    observationVersion: 0,
  }).plan;
}

function main(): void {
  fs.mkdirSync(OUT, { recursive: true });
  const rows: Array<Record<string, unknown>> = [];
  for (const seed of SEEDS) {
    for (const mechanism of MECHANISMS) {
      const scenario = loadSafetyScenario(SCENARIO_PATH);
      const counts = series(mechanism, seed).map(value => value * 10);
      scenario.config.horizon_minutes = 3;
      const now = new Date('2026-11-09T12:00:00.000Z');
      const store = new ObservationStore();
      counts.forEach((count, index) => {
        store.ingest(observation(TARGET, count, new Date(now.getTime() - (counts.length - 1 - index) * 60_000), index));
      });
      const predictor = new PredictionService(scenario, store);
      const forecast = predictor.predict(TARGET, { now, horizonMinutes: 5, windowMinutes: 20 });
      const observed = counts[counts.length - 1];
      const reliable = forecast.sufficient && forecast.reliability.status !== 'failed' && forecast.predicted_count !== null;
      const modes = {
        observed: observed,
        predicted: reliable ? Math.max(observed, forecast.predicted_count ?? observed) : observed,
        robust: reliable ? Math.max(observed, forecast.interval?.upper ?? observed) : observed,
      };
      for (const [mode, targetDemand] of Object.entries(modes)) {
        const demand = baselineDemand(scenario);
        demand.set(TARGET, targetDemand);
        const plan = planFor(scenario, demand);
        rows.push({
          seed,
          mechanism,
          mode,
          observed,
          predicted: forecast.predicted_count,
          interval_upper: forecast.interval?.upper ?? null,
          reliability: forecast.reliability.status,
          reliable,
          target_demand: targetDemand,
          total_persons: plan.total_persons,
          evacuated_persons: plan.evacuated_persons,
          unresolved_persons: plan.unresolved_persons,
          status: plan.status,
          target_unresolved: plan.unresolved.filter(item => item.region_id === TARGET).reduce((sum, item) => sum + item.persons, 0),
        });
      }
    }
  }

  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const summary = Object.fromEntries(MECHANISMS.map(mechanism => [
    mechanism,
    Object.fromEntries(['observed', 'predicted', 'robust'].map(mode => {
      const subset = rows.filter(row => row.mechanism === mechanism && row.mode === mode);
      return [mode, {
        n: subset.length,
        target_demand: Number(mean(subset.map(row => row.target_demand as number)).toFixed(2)),
        total_persons: Number(mean(subset.map(row => row.total_persons as number)).toFixed(2)),
        evacuated: Number(mean(subset.map(row => row.evacuated_persons as number)).toFixed(2)),
        unresolved: Number(mean(subset.map(row => row.unresolved_persons as number)).toFixed(2)),
        target_unresolved: Number(mean(subset.map(row => row.target_unresolved as number)).toFixed(2)),
        reliable_rate: Number((subset.filter(row => row.reliable).length / Math.max(1, subset.length)).toFixed(4)),
      }];
    })),
  ]));

  const paired = Object.fromEntries(['predicted', 'robust'].map(mode => {
    const diffs = Object.fromEntries(MECHANISMS.map(mechanism => {
      const base = rows.filter(row => row.mechanism === mechanism && row.mode === 'observed');
      const candidate = rows.filter(row => row.mechanism === mechanism && row.mode === mode);
      const bySeed = new Map(candidate.map(row => [row.seed, row]));
      const values = base.flatMap(row => {
        const other = bySeed.get(row.seed as number);
        return other ? [(other.target_demand as number) - (row.target_demand as number)] : [];
      });
      return [mechanism, { mean_demand_increase: Number(mean(values).toFixed(2)), n: values.length }];
    }));
    return [mode, diffs];
  }));

  const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
  write('rows.json', rows);
  write('summary.json', { config: { seeds: SEEDS, mechanisms: MECHANISMS, target: TARGET, points: POINTS, horizon_minutes: 5 }, summary, paired });
  write('run_metadata.json', {
    generated_at: new Date().toISOString(),
    run_id: RUN_ID,
    node: process.version,
    platform: process.platform,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    data_nature: '合成序列；不代表真实人群或真实疏散效果。',
  });
  fs.writeFileSync(path.join(OUT, 'README.md'), `# 预测驱动规划对照实验

> 运行 ID：\`${RUN_ID}\`。合成序列；预测只用过去 20 分钟窗口，目标点不参与训练/校准。
> 需求规则：observed = 最新观测；predicted = max(观测, 预测点)；robust = max(观测, 区间上界)；
> 预测不可靠时 predicted/robust 回退 observed。规划器使用静态容量与时间扩展流。

## 主结果（30 seeds 均值）

| 机制 | 模式 | 目标需求 | 总需求 | 已分配 | 未解决 | 目标未解决 | 预测可靠率 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${MECHANISMS.flatMap(mechanism => ['observed', 'predicted', 'robust'].map(mode => {
  const value = summary[mechanism][mode];
  return `| ${mechanism} | ${mode} | ${value.target_demand} | ${value.total_persons} | ${value.evacuated} | ${value.unresolved} | ${value.target_unresolved} | ${value.reliable_rate} |`;
})).join('\n')}

## 边界

- 合成序列和静态容量场景；不是真实疏散效果或真实预测精度。
- predicted/robust 只允许上调需求，预测错误不会导致少规划；不可靠时回退观测。
- 预测区间仍存在 surge 欠覆盖问题，不得用于安全告警阈值。
`);
  console.log(`[prediction-planning] ${rows.length} rows -> ${OUT}`);
}

main();
