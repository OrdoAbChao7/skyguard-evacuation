/**
 * 指挥中心仪表盘聚合。
 *
 * 只读取服务公开状态，不修改任何安全域数据。
 */
import type { AuditLog } from '../safety/audit';
import type { SafetyDecisionService } from '../safety/decision-service';
import type { SafetyScenario } from '../safety/types';
import type { AgentRun } from './agent';
import type { AgentArtsStatus } from './agentarts';
import type { CameraHealth, ReplayStatus } from './ingest';
import type { OpsService } from './ops';
import type { PredictionResult, PredictionService } from './prediction';

export interface MvpDashboard {
  scenario: {
    id: string;
    name: string;
    version: string;
    notice: string;
    venue: SafetyScenario['venue'] | null;
    horizon_minutes: number;
    regions: number;
    exits: number;
  };
  safety: ReturnType<SafetyDecisionService['getStatus']>;
  cameras: CameraHealth[];
  predictions: PredictionResult[];
  staff: ReturnType<OpsService['listStaff']>;
  work_orders: ReturnType<OpsService['listWorkOrders']>;
  agent_runs: AgentRun[];
  agentarts: AgentArtsStatus;
  replay: ReplayStatus;
  audit: Array<Record<string, unknown>>;
  state_store?: { enabled: boolean; writable: boolean; revision: number; path: string | null };
  generated_at: string;
}

export interface DashboardSource {
  scenario: SafetyScenario;
  safety: SafetyDecisionService;
  prediction: PredictionService;
  ops: OpsService;
  replay: {
    status(): ReplayStatus;
  };
  audit: AuditLog;
  cameraHealth(regionId?: string): CameraHealth[];
  listAgentRuns(limit?: number): AgentRun[];
  getAgentArtsStatusCached(): AgentArtsStatus;
  getStateStoreHealth(): {
    enabled: boolean;
    writable: boolean;
    revision: number;
    path: string | null;
  };
}

export function buildDashboard(source: DashboardSource): MvpDashboard {
  return {
    scenario: {
      id: source.scenario.scenario_id,
      name: source.scenario.name,
      version: source.scenario.version,
      notice: source.scenario.notice,
      venue: source.scenario.venue ?? null,
      horizon_minutes: source.scenario.config.horizon_minutes,
      regions: source.scenario.regions.length,
      exits: source.scenario.exits.length,
    },
    safety: source.safety.getStatus(),
    cameras: source.cameraHealth(),
    predictions: source.scenario.regions.map(region => source.prediction.predict(region.id)),
    staff: source.ops.listStaff(),
    work_orders: source.ops.listWorkOrders(),
    agent_runs: source.listAgentRuns(10),
    agentarts: source.getAgentArtsStatusCached(),
    replay: source.replay.status(),
    audit: source.audit.list(20) as unknown as Array<Record<string, unknown>>,
    state_store: source.getStateStoreHealth(),
    generated_at: new Date().toISOString(),
  };
}
