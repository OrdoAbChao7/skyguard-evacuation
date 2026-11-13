/**
 * SkyGuard 性能基准。
 *
 * 目标：给出**本机实测**的规划/校验/决策延迟，而不是估算值。
 * 结果写入 evaluation/skyguard/performance.json，并可打印 markdown 表格。
 *
 * 运行：
 *   npx tsx scripts/skyguard-benchmark.ts --iterations 30 --out ../evaluation/skyguard/performance.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { SafetyDecisionService } from '../src/services/safety/decision-service';
import { AuditLog } from '../src/services/safety/audit';
import { resolveEffectiveNetwork } from '../src/services/safety/network';
import { planEvacuation } from '../src/services/safety/planning/evacuation-planner';
import { validateSafetyPlan } from '../src/services/safety/validator';
import { SafetyScenarioSchema, type SafetyScenario } from '../src/services/safety/types';

interface Sample {
  name: string;
  durations_ms: number[];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(3));
}

function summarise(samples: Sample[]) {
  return samples.map(sample => ({
    name: sample.name,
    iterations: sample.durations_ms.length,
    min_ms: Number(Math.min(...sample.durations_ms).toFixed(3)),
    mean_ms: Number((sample.durations_ms.reduce((a, b) => a + b, 0) / sample.durations_ms.length).toFixed(3)),
    p50_ms: percentile(sample.durations_ms, 50),
    p95_ms: percentile(sample.durations_ms, 95),
    max_ms: Number(Math.max(...sample.durations_ms).toFixed(3)),
  }));
}

/** 生成规则网格场景，用于测量规模扩展性。 */
function buildGridScenario(size: number, horizon: number): SafetyScenario {
  const regions = [];
  const corridors = [];
  const exits = [];
  const exitEvery = Math.max(2, Math.floor(size / 2));

  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const id = `G${row}_${column}`;
      regions.push({
        id,
        name: id,
        area_m2: 400,
        area_provenance: 'estimated',
        geometry: { x: column * 100, y: row * 100, width: 80, height: 80 },
        geometry_provenance: 'estimated',
        holding_capacity_persons: 400,
        enabled: true,
        camera: {
          camera_id: `CAM-${id}`,
          calibration_status: 'uncalibrated',
          calibration_version: 'grid',
        },
        source: 'benchmark grid',
        verified: false,
      });
      if (column % exitEvery === 0 && row % exitEvery === 0) {
        exits.push({
          id: `EX${row}_${column}`,
          name: `EX${row}_${column}`,
          region_id: id,
          status: 'open',
          capacity_per_min: 90,
          capacity_provenance: 'estimated',
          status_source: 'benchmark',
          verified: false,
          updated_at: '2026-10-01T00:00:00.000Z',
        });
      }
    }
  }

  let counter = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (column + 1 < size) {
        counter += 1;
        corridors.push({
          id: `H${counter}`,
          name: `H${counter}`,
          from_region_id: `G${row}_${column}`,
          to_region_id: `G${row}_${column + 1}`,
          status: 'open',
          direction: 'both',
          capacity_per_min: 80,
          capacity_provenance: 'estimated',
          traversal_seconds: 60,
          status_source: 'benchmark',
          verified: false,
          updated_at: '2026-10-01T00:00:00.000Z',
        });
      }
      if (row + 1 < size) {
        counter += 1;
        corridors.push({
          id: `V${counter}`,
          name: `V${counter}`,
          from_region_id: `G${row}_${column}`,
          to_region_id: `G${row + 1}_${column}`,
          status: 'open',
          direction: 'both',
          capacity_per_min: 80,
          capacity_provenance: 'estimated',
          traversal_seconds: 60,
          status_source: 'benchmark',
          verified: false,
          updated_at: '2026-10-01T00:00:00.000Z',
        });
      }
    }
  }

  return SafetyScenarioSchema.parse({
    scenario_id: `grid-${size}`,
    name: `grid-${size}`,
    version: '1.0.0',
    description: `synthetic ${size}x${size} grid benchmark`,
    notice: 'synthetic benchmark scenario',
    config: {
      horizon_minutes: horizon,
      max_observation_age_seconds: 90,
      min_confidence: 0.6,
      trend_window_seconds: 300,
      density_consistency_tolerance: 0.25,
      default_thresholds: {
        watch_density: 1,
        high_density: 2,
        critical_density: 3,
        rise_rate_watch: 0.5,
        source: 'benchmark',
      },
    },
    regions,
    corridors,
    exits,
    demo_scenarios: [],
  });
}

function parseArgs(): { iterations: number; out?: string } {
  const argv = process.argv.slice(2);
  let iterations = 20;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--iterations') iterations = Number(argv[i + 1]);
    if (argv[i] === '--out') out = argv[i + 1];
  }
  return { iterations, out };
}

async function main(): Promise<void> {
  const { iterations, out } = parseArgs();
  const results: Array<ReturnType<typeof summarise>[number] & { nodes?: number; arcs?: number }> = [];

  const repoScenario = loadSafetyScenario(path.resolve(__dirname, '../../data/scenarios/venue-default.json'));

  // 1. 演示场景：规划
  const network = resolveEffectiveNetwork(repoScenario, []);
  const demand = new Map<string, number>(
    Object.entries(repoScenario.simulation_baseline ?? {}).map(([regionId, item]) => [regionId, item.count]),
  );
  if (demand.size === 0) {
    throw new Error('场景缺少 simulation_baseline，无法生成基准需求');
  }
  const planSamples: number[] = [];
  let referencePlan = planEvacuation({
    scenario: repoScenario,
    network,
    demandByRegion: demand,
    scenarioVersion: repoScenario.version,
    constraintVersion: 0,
    observationVersion: 0,
  }).plan;

  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    const { plan } = planEvacuation({
      scenario: repoScenario,
      network,
      demandByRegion: demand,
      scenarioVersion: repoScenario.version,
      constraintVersion: 0,
      observationVersion: 0,
    });
    planSamples.push(performance.now() - started);
    referencePlan = plan;
  }
  results.push({ ...summarise([{ name: 'planEvacuation (6 regions / 11 corridors)', durations_ms: planSamples }])[0] });

  // 2. 演示场景：独立校验
  const observations = new Map(
    [...demand.keys()].map(regionId => [
      regionId,
      {
        id: `OBS-${regionId}`,
        region_id: regionId,
        observed_at: new Date().toISOString(),
        received_at: new Date().toISOString(),
        estimated_count: demand.get(regionId)!,
        estimated_density: 0.5,
        confidence: 0.9,
        source: 'simulation' as const,
        provider: 'benchmark',
        model_version: 'benchmark',
        calibration_version: 'benchmark',
        valid: true,
      },
    ]),
  );
  const validationSamples: number[] = [];
  for (let i = 0; i < iterations * 5; i += 1) {
    const started = performance.now();
    validateSafetyPlan({
      plan: referencePlan,
      scenario: repoScenario,
      network,
      latestObservations: observations,
      config: repoScenario.config,
      constraintVersion: 0,
      observationVersion: 0,
    });
    validationSamples.push(performance.now() - started);
  }
  results.push({ ...summarise([{ name: 'validateSafetyPlan (6 regions / 11 corridors)', durations_ms: validationSamples }])[0] });

  // 3. 规模扩展：网格场景
  for (const size of [3, 5, 7]) {
    const gridScenario = buildGridScenario(size, 10);
    const gridNetwork = resolveEffectiveNetwork(gridScenario, []);
    const gridDemand = new Map(gridScenario.regions.map(region => [region.id, 300]));
    const samples: number[] = [];
    let nodeCount = 0;
    for (let i = 0; i < Math.max(5, Math.floor(iterations / 4)); i += 1) {
      const started = performance.now();
      const output = planEvacuation({
        scenario: gridScenario,
        network: gridNetwork,
        demandByRegion: gridDemand,
        scenarioVersion: gridScenario.version,
        constraintVersion: 0,
        observationVersion: 0,
      });
      samples.push(performance.now() - started);
      nodeCount = gridScenario.regions.length * (gridScenario.config.horizon_minutes + 1);
      void output;
    }
    results.push({
      ...summarise([{ name: `planEvacuation grid ${size}x${size} (horizon 10)`, durations_ms: samples }])[0],
      nodes: nodeCount,
    });
  }

  // 4. 决策闭环（含审计落盘）
  const auditDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'skyguard-bench-'));
  const service = new SafetyDecisionService({ scenario: repoScenario, auditLog: new AuditLog(auditDir) });
  const actor = { username: 'benchmark', role: 'safety_operator' };
  for (const [regionId, count] of demand) {
    service.ingestObservation(
      {
        regionId,
        count,
        confidence: 0.9,
        source: 'simulation',
        provider: 'benchmark',
        modelVersion: 'benchmark',
      },
      actor,
    );
  }
  const recomputeSamples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    service.recompute(actor, 'benchmark');
    recomputeSamples.push(performance.now() - started);
  }
  results.push({
    ...summarise([{ name: 'decision.recompute end-to-end (incl. audit append)', durations_ms: recomputeSamples }])[0],
  });

  const report = {
    generated_at: new Date().toISOString(),
    host: {
      platform: process.platform,
      node: process.version,
      cpu: require('node:os').cpus()?.[0]?.model ?? 'unknown',
    },
    note: '本基准只测量本机单进程计算延迟，不包含网络往返、前端渲染与真实昇腾推理。',
    results,
  };

  console.log('\n| 场景 | 迭代 | min | mean | p50 | p95 | max |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const row of results) {
    console.log(
      `| ${row.name} | ${row.iterations} | ${row.min_ms} | ${row.mean_ms} | ${row.p50_ms} | ${row.p95_ms} | ${row.max_ms} |`,
    );
  }

  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n[done] 写入 ${path.resolve(out)}`);
  }
  fs.rmSync(auditDir, { recursive: true, force: true });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
