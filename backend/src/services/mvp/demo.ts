/**
 * 控制台一键推演：正常、拥堵、不可信三类场景。
 *
 * 演示数据全部来自场景 ui_demos；缺配置时明确返回不可用，不回退到硬编码数据。
 */
import type { SafetyDecisionService } from '../safety/decision-service';
import type { SafetyScenario } from '../safety/types';
import type { AgentRun } from './agent';
import type { MvpDashboard } from './dashboard';
import type { ReplayService } from './ingest';
import type { OpsActor } from './ops';

export interface DemoSource {
  scenario: SafetyScenario;
  safety: SafetyDecisionService;
  replay: ReplayService;
  stepReplay(params: { count?: number; actor?: OpsActor }): unknown;
  runAgent(options: {
    regionId: string;
    trigger: string;
    actor?: OpsActor;
    runtime?: 'local' | 'agentarts';
  }): Promise<AgentRun>;
  dashboard(): MvpDashboard;
}

export async function runUiDemo(
  source: DemoSource,
  kind: 'A_normal' | 'B_surge' | 'C_untrusted',
  actor: OpsActor,
): Promise<Record<string, unknown>> {
  const demos = source.scenario.ui_demos;
  if (!demos) {
    return {
      available: false,
      scenario: kind,
      reason: '当前场景未配置 ui_demos；为保证场景可替换，不允许回退到代码内硬编码演示数据。',
    };
  }
  const now = Date.now();
  const step = (index: number, total: number) => new Date(now - (total - 1 - index) * 60_000).toISOString();
  const rowsFrom = (series: Record<string, number[]>, confidence: number) =>
    Object.entries(series).flatMap(([regionId, counts]) => counts.map((count, index) => ({
      timestamp: step(index, counts.length),
      region_id: regionId,
      count,
      confidence,
      source: 'csv_replay' as const,
    })));

  if (kind === 'A_normal') {
    const config = demos.normal;
    if (!config) return { available: false, scenario: kind, reason: '场景未配置 ui_demos.normal' };
    const rows = rowsFrom(config.series, config.confidence);
    source.replay.loadRows(rows, { name: 'ui-demo-normal', provenance: '合成回放数据（控制台一键推演）' });
    source.stepReplay({ count: rows.length, actor });
    const run = await source.runAgent({ regionId: config.region_id, trigger: 'ui_demo_normal', actor });
    return { available: true, scenario: kind, state: source.safety.getStatus().state, run, dashboard: source.dashboard() };
  }

  if (kind === 'B_surge') {
    const config = demos.surge;
    if (!config) return { available: false, scenario: kind, reason: '场景未配置 ui_demos.surge' };
    const rows = rowsFrom(config.series, config.confidence);
    source.replay.loadRows(rows, { name: 'ui-demo-surge', provenance: '合成回放数据（控制台一键推演）' });
    source.stepReplay({ count: rows.length, actor });
    if (config.degraded) {
      source.safety.ingestObservation({
        regionId: config.degraded.region_id,
        count: config.degraded.count,
        confidence: config.degraded.confidence,
        source: 'simulation',
        provider: 'ui-demo-degraded',
        modelVersion: 'demo/1.0.0',
        observedAt: new Date(),
        valid: true,
      }, actor);
    }
    source.safety.recompute(actor, 'ui_demo_surge');
    const run = await source.runAgent({ regionId: config.region_id, trigger: 'ui_demo_surge', actor });
    return { available: true, scenario: kind, state: source.safety.getStatus().state, run, dashboard: source.dashboard() };
  }

  const config = demos.reject;
  if (!config) return { available: false, scenario: kind, reason: '场景未配置 ui_demos.reject' };
  for (const region of source.scenario.regions) {
    source.safety.ingestObservation({
      regionId: region.id,
      count: config.offline.count,
      confidence: config.offline.confidence,
      source: 'simulation',
      provider: 'ui-demo-offline',
      modelVersion: 'demo/1.0.0',
      observedAt: new Date(),
      valid: false,
      invalidReason: config.offline.reason,
    }, actor);
  }
  source.safety.recompute(actor, 'ui_demo_untrusted');
  for (const region of source.scenario.regions) {
    const count = config.capacity_by_region[region.id];
    if (count === undefined) continue;
    source.safety.ingestObservation({
      regionId: region.id,
      count,
      confidence: config.capacity_confidence,
      source: 'simulation',
      provider: 'ui-demo-capacity',
      modelVersion: 'demo/1.0.0',
      observedAt: new Date(),
    }, actor);
  }
  const incident = source.safety.createIncident({
    type: config.incident.type,
    description: config.incident.description,
    severity: config.incident.severity,
    affected: {
      region_ids: config.incident.region_ids,
      corridor_ids: config.incident.corridor_ids,
      exit_ids: config.incident.exit_ids,
    },
    source: 'operator',
    actor: actor.username,
  });
  source.safety.confirmIncident(incident.id, actor);
  source.safety.recompute(actor, 'ui_demo_reject');
  const run = await source.runAgent({ regionId: config.region_id, trigger: 'ui_demo_reject', actor });
  return { available: true, scenario: kind, state: source.safety.getStatus().state, run, dashboard: source.dashboard() };
}
