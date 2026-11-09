/**
 * 拥堵反馈对照实验（evaluation/final/congestion）。
 *
 * 对比：
 *  A. 静态容量规划（planner 不知道拥堵）；
 *  B. 拥堵感知规划（BPR 容量折减后迭代重规划）；
 * 两者都放入同一逐分钟拥堵仿真，比较已服务人数、未服务队列、最大队列、拥堵分钟数。
 *
 * 全部为合成场景；BPR 参数未标定，不代表真实疏散时间。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { resolveEffectiveNetwork } from '../src/services/safety/network';
import { planEvacuation } from '../src/services/safety/planning/evacuation-planner';
import {
  DEFAULT_CONGESTION_POLICY,
  planWithCongestion,
  simulateCongestion,
  type CongestionPolicy,
} from '../src/services/safety/planning/congestion';
import type { SafetyScenario } from '../src/services/safety/types';

const ROOT = path.resolve(__dirname, '../..');
const SCENARIO_PATH = path.join(ROOT, 'data/scenarios/stadium-evacuation.json');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(ROOT, 'evaluation/final/congestion', RUN_ID);
const SCALES = [0.5, 1, 2, 4];
const ALPHAS = [0.05, 0.15, 0.3];

function demandFor(scenario: SafetyScenario, scale: number): Map<string, number> {
  const demand = new Map<string, number>();
  for (const region of scenario.regions) {
    const base = scenario.simulation_baseline?.[region.id]?.count ?? 0;
    demand.set(region.id, Math.round(base * scale));
  }
  return demand;
}

function main(): void {
  fs.mkdirSync(OUT, { recursive: true });
  const rows: Array<Record<string, unknown>> = [];
  for (const scale of SCALES) {
    for (const alpha of ALPHAS) {
      const scenario = loadSafetyScenario(SCENARIO_PATH);
      const network = resolveEffectiveNetwork(scenario, []);
      const demand = demandFor(scenario, scale);
      const policy: CongestionPolicy = {
        ...DEFAULT_CONGESTION_POLICY,
        enabled: true,
        bpr_alpha: alpha,
      };
      const input = {
        scenario,
        network,
        demandByRegion: demand,
        scenarioVersion: scenario.version,
        constraintVersion: 0,
        observationVersion: 0,
      };
      const staticPlan = planEvacuation(input);
      const aware = planWithCongestion(input, policy);
      const staticSim = simulateCongestion({ scenario, plan: staticPlan.plan, policy });
      const awareSim = simulateCongestion({ scenario, plan: aware.plan, policy });
      rows.push({
        demand_scale: scale,
        bpr_alpha: alpha,
        total_demand: [...demand.values()].reduce((sum, value) => sum + value, 0),
        static: {
          plan_status: staticPlan.plan.status,
          plan_unresolved: staticPlan.plan.unresolved_persons,
          served: staticSim.served_persons,
          abandoned: staticSim.abandoned_persons,
          max_corridor_queue: staticSim.max_corridor_queue,
          max_exit_queue: staticSim.max_exit_queue,
          congestion_minutes: staticSim.congestion_minutes,
          completion_minute: staticSim.completion_minute,
        },
        congestion_aware: {
          plan_status: aware.plan.status,
          plan_unresolved: aware.plan.unresolved_persons,
          iterations: aware.congestion.iterations,
          served: awareSim.served_persons,
          abandoned: awareSim.abandoned_persons,
          max_corridor_queue: awareSim.max_corridor_queue,
          max_exit_queue: awareSim.max_exit_queue,
          congestion_minutes: awareSim.congestion_minutes,
          completion_minute: awareSim.completion_minute,
          capacity_reductions: aware.congestion.effective_capacity.filter(item =>
            item.base !== null && item.effective !== null && item.effective < item.base),
        },
      });
    }
  }

  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const summary = {
    rows: rows.length,
    mean_static_served: Number(mean(rows.map(row => (row.static as any).served)).toFixed(2)),
    mean_aware_served: Number(mean(rows.map(row => (row.congestion_aware as any).served)).toFixed(2)),
    mean_static_abandoned: Number(mean(rows.map(row => (row.static as any).abandoned)).toFixed(2)),
    mean_aware_abandoned: Number(mean(rows.map(row => (row.congestion_aware as any).abandoned)).toFixed(2)),
    mean_static_max_queue: Number(mean(rows.map(row => (row.static as any).max_corridor_queue)).toFixed(2)),
    mean_aware_max_queue: Number(mean(rows.map(row => (row.congestion_aware as any).max_corridor_queue)).toFixed(2)),
  };

  const write = (name: string, data: unknown) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
  write('rows.json', rows);
  write('summary.json', { config: { scales: SCALES, alphas: ALPHAS, scenario: SCENARIO_PATH }, summary });
  write('run_metadata.json', {
    generated_at: new Date().toISOString(),
    run_id: RUN_ID,
    node: process.version,
    platform: process.platform,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    data_nature: '合成场景 + 未标定 BPR 参数；不代表真实疏散效果。',
  });
  fs.writeFileSync(path.join(OUT, 'README.md'), `# 拥堵反馈对照实验

> 运行 ID：\`${RUN_ID}\`。合成场景；BPR 参数未标定；仿真不重新分配路线。

## 结果（3 个需求规模 × 3 个 BPR alpha）

| 指标 | 静态规划 | 拥堵感知规划 |
| --- | --- | --- |
| 平均已服务人数 | ${summary.mean_static_served} | ${summary.mean_aware_served} |
| 平均未服务队列 | ${summary.mean_static_abandoned} | ${summary.mean_aware_abandoned} |
| 平均最大通道队列 | ${summary.mean_static_max_queue} | ${summary.mean_aware_max_queue} |

静态 vs 拥堵感知的逐行结果见 \`rows.json\`；负向/无提升结果同样保留。

## 边界

- 拥堵感知规划用 BPR 折减容量迭代重规划，只会更保守，不会产生更乐观的方案。
- 仿真按通道/出口队列结转，不建模人群动力学、速度衰减或重新选路。
- 结果不能表述为真实疏散时间或真实场馆性能。
`);
  console.log(`[congestion] ${rows.length} rows -> ${OUT}`);
}

main();
