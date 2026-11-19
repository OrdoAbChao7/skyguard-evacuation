/**
 * 场景驱动的人群仿真命令行。
 *
 *   npm run simulate:crowd --prefix backend
 *   npm run simulate:crowd --prefix backend -- --preset gate_closure --minutes 12
 *
 * 输出：
 *  - data/replays/crowd-sim-<preset>.json：可被 /mvp/replay/load 直接加载的回放数据；
 *  - data/simulations/crowd-sim-<preset>.json：摘要与逐分钟总量（便于复核）。
 *
 * 所有数据都是算法生成的合成数据，不是实测，也不是视频推理结果。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataRoot } from '../src/config/paths';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import {
  simulateCrowdFlow,
  type CrowdFlowPreset,
} from '../src/services/simulation/crowd-flow';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const scenarioFile = arg('scenario', 'hankou-mvp.json') as string;
const preset = arg('preset', 'normal') as CrowdFlowPreset;
if (!['normal', 'gate_closure', 'surge'].includes(preset)) {
  console.error(`未知 preset：${preset}（可选 normal / gate_closure / surge）`);
  process.exit(2);
}
const minutes = Number(arg('minutes', '10'));
const seed = Number(arg('seed', '42'));
const startAtRaw = arg('start-at');
const startAt = startAtRaw ? new Date(startAtRaw) : new Date(Date.now() - minutes * 60_000);
const outFile = arg('out', `crowd-sim-${preset}.json`) as string;
const reportFile = arg('report', `crowd-sim-${preset}.json`) as string;

const scenario = loadSafetyScenario(scenarioFile);
const result = simulateCrowdFlow(scenario, {
  minutes,
  seed,
  preset,
  start_at: startAt,
});

const replayPath = path.isAbsolute(outFile)
  ? outFile
  : path.resolve(getDataRoot(), 'replays', outFile);
const reportPath = path.isAbsolute(reportFile)
  ? reportFile
  : path.resolve(getDataRoot(), 'simulations', reportFile);

fs.mkdirSync(path.dirname(replayPath), { recursive: true });
fs.writeFileSync(replayPath, `${JSON.stringify({
  name: `算法人群仿真 · ${preset} · ${scenario.scenario_id}`,
  description: `场景驱动的合成人群流仿真；seed=${seed}，${minutes} 分钟，1 分钟步长。`,
  provenance: 'crowd-flow-v1 算法仿真（合成数据，未现场标定；不得当作实测）',
  rows: result.replay_rows,
}, null, 2)}\n`, 'utf8');

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify({
  summary: result.summary,
  timeline: result.samples.map(sample => ({
    minute: sample.minute,
    at: sample.at,
    totals: sample.totals,
    events: sample.events,
    busiest_regions: [...sample.regions]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(region => ({
        region_id: region.region_id,
        count: region.count,
        density: region.density,
        confidence: region.confidence,
        capacity_limited: region.capacity_limited,
        stranded: region.stranded,
      })),
  })),
}, null, 2)}\n`, 'utf8');

const summary = result.summary;
console.log('');
console.log(`SkyGuard 算法人群仿真 · ${scenario.name}`);
console.log(`  场景：${scenario.scenario_id} · 预设：${preset} · 种子：${seed} · ${minutes} 分钟`);
console.log(`  初始：${summary.initial_total} 人 · 外部到达：${summary.arrivals_total} 人`);
console.log(`  已疏散：${summary.evacuated} 人 · 场内：${summary.remaining_inside} 人 · 通道在途：${summary.in_transit} 人 · 无路可走：${summary.stranded} 人`);
console.log(`  守恒：${summary.conservation_ok ? '通过' : '失败'} · 峰值在途：${summary.peak_in_transit} 人 · 受限样本：${summary.congested_samples}`);
if (summary.peak_density) {
  console.log(`  峰值密度：${summary.peak_density.density} 人/m²（${summary.peak_density.region_name}，${summary.peak_density.at}）`);
}
if (summary.unresolved_regions.length > 0) {
  console.log(`  未解决区域：${summary.unresolved_regions.map(item => `${item.region_id}×${item.count}`).join('，')}`);
}
if (summary.events.length > 0) {
  console.log('  事件：');
  for (const event of summary.events) console.log(`    - ${event}`);
}
console.log('');
console.log('  逐分钟总量：');
for (const sample of result.samples) {
  const totals = sample.totals;
  console.log(`    ${String(sample.minute).padStart(2, '0')} 分钟 · 场内 ${String(totals.inside).padStart(6)} · 在途 ${String(totals.in_transit).padStart(5)} · 已疏散 ${String(totals.evacuated).padStart(6)} · 无路 ${totals.stranded}`);
}
console.log('');
console.log(`  回放数据：${replayPath}`);
console.log(`  仿真报告：${reportPath}`);
console.log('  说明：合成数据，标记为 simulation；不是实测，也不是视频推理结果。');
