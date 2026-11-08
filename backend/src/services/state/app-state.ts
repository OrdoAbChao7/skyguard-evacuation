/** 统一应用状态（单实例）：安全域 + 工单/预算 + Agent 运行 + 内存审计视图。 */
import type { SafetyPersistedState } from '../safety/decision-service';
import type { AuditLogState } from '../safety/audit';
import type { OpsPersistedState } from '../mvp/ops';
import type { AgentRun } from '../mvp/agent';

export interface PersistedAppState {
  schema_version: 1;
  saved_at: string;
  scenario: { id: string; version: string };
  safety: SafetyPersistedState;
  ops: OpsPersistedState;
  runs: AgentRun[];
  run_order: string[];
  audit: AuditLogState;
}
