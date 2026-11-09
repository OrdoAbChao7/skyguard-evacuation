/**
 * 审计与决策 Trace。
 *
 * 所有关键安全操作（观测写入、事件创建/确认/解除、重新规划、校验）都必须留下：
 * 操作者、时间、输入、变更前后状态、结果。Trace 记录每个决策阶段的耗时与结论。
 *
 * 审计日志以 JSONL 追加写入 `data/audit/`，不做原地覆盖；
 * 写入失败不会阻断安全流程，但会在内存审计记录中标记落盘失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { resolveDataPath } from '../../config/paths';

const MAX_AUDIT_VALUE_BYTES = 4096;
const MAX_AUDIT_TEXT = 1024;

/** 审计字段有界化：防止 20MB 请求参数把 JSONL/内存撑爆。 */
function boundedValue(value: unknown): unknown {
  let text: string;
  try { text = JSON.stringify(value ?? null); } catch { return { truncated: true, error: 'unserializable' }; }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_AUDIT_VALUE_BYTES) return value;
  return {
    truncated: true,
    bytes,
    sha256: createHash('sha256').update(text).digest('hex'),
    preview: text.slice(0, MAX_AUDIT_TEXT),
  };
}

function boundedText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > MAX_AUDIT_TEXT ? `${value.slice(0, MAX_AUDIT_TEXT)}…[truncated ${value.length}]` : value;
}

export type AuditResult = 'success' | 'failure' | 'rejected';

export interface AuditEntry {
  id: string;
  ts: string;
  actor: string;
  role: string;
  action: string;
  entity_type: string;
  entity_id?: string;
  summary: string;
  result: AuditResult;
  reason?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  incident_id?: string;
  plan_id?: string;
  trace_id?: string;
  persisted?: boolean;
}

export interface AuditActor {
  username: string;
  role: string;
}

export interface TraceStage {
  stage: string;
  status: 'ok' | 'warning' | 'failed' | 'skipped';
  duration_ms: number;
  detail?: Record<string, unknown>;
}

export interface DecisionTrace {
  trace_id: string;
  started_at: string;
  finished_at?: string;
  actor: string;
  trigger: string;
  constraint_version: number;
  observation_version: number;
  stages: TraceStage[];
  outcome?: {
    state?: string;
    plan_id?: string;
    validation_valid?: boolean;
    violation_codes?: string[];
  };
}

const MAX_AUDIT_IN_MEMORY = 1000;
const MAX_TRACES_IN_MEMORY = 200;

export interface AuditLogState {
  entries: AuditEntry[];
  traces: DecisionTrace[];
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private traces = new Map<string, DecisionTrace>();
  private traceOrder: string[] = [];
  private auditDir: string;

  constructor(auditDir: string = resolveDataPath('audit')) {
    this.auditDir = auditDir;
  }

  record(entry: Omit<AuditEntry, 'id' | 'ts' | 'persisted'>): AuditEntry {
    const full: AuditEntry = {
      id: `AUD-${randomUUID()}`,
      ts: new Date().toISOString(),
      persisted: false,
      ...entry,
      summary: boundedText(entry.summary) ?? '',
      reason: boundedText(entry.reason),
      before: entry.before === undefined ? undefined : boundedValue(entry.before) as Record<string, unknown>,
      after: entry.after === undefined ? undefined : boundedValue(entry.after) as Record<string, unknown>,
    };
    try {
      fs.mkdirSync(this.auditDir, { recursive: true });
      const file = path.join(this.auditDir, `audit-${full.ts.slice(0, 10)}.jsonl`);
      fs.appendFileSync(file, `${JSON.stringify(full)}\n`, 'utf8');
      full.persisted = true;
    } catch (error) {
      full.persisted = false;
      console.error('[safety] audit persist failed:', (error as Error).message);
    }
    this.entries.push(full);
    if (this.entries.length > MAX_AUDIT_IN_MEMORY) this.entries.shift();
    return full;
  }

  list(limit = 100): AuditEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  startTrace(input: {
    actor: string;
    trigger: string;
    constraintVersion: number;
    observationVersion: number;
  }): DecisionTrace {
    const trace: DecisionTrace = {
      trace_id: `TRC-${randomUUID()}`,
      started_at: new Date().toISOString(),
      actor: input.actor,
      trigger: input.trigger,
      constraint_version: input.constraintVersion,
      observation_version: input.observationVersion,
      stages: [],
    };
    this.traces.set(trace.trace_id, trace);
    this.traceOrder.push(trace.trace_id);
    if (this.traceOrder.length > MAX_TRACES_IN_MEMORY) {
      const evicted = this.traceOrder.shift();
      if (evicted) this.traces.delete(evicted);
    }
    return trace;
  }

  addStage(
    trace: DecisionTrace,
    stage: string,
    status: TraceStage['status'],
    durationMs: number,
    detail?: Record<string, unknown>,
  ): void {
    trace.stages.push({ stage, status, duration_ms: Math.round(durationMs * 100) / 100, detail });
  }

  finishTrace(trace: DecisionTrace, outcome: NonNullable<DecisionTrace['outcome']>): void {
    trace.finished_at = new Date().toISOString();
    trace.outcome = outcome;
  }

  getTrace(traceId: string): DecisionTrace | undefined {
    return this.traces.get(traceId);
  }

  listTraces(limit = 20): DecisionTrace[] {
    return this.traceOrder
      .slice(-limit)
      .reverse()
      .map(id => this.traces.get(id)!)
      .filter(Boolean);
  }

  exportState(): AuditLogState {
    return {
      entries: this.entries.map(item => ({ ...item })),
      traces: this.traceOrder.map(id => this.traces.get(id)!).filter(Boolean).map(item => ({ ...item })),
    };
  }

  /** 只恢复内存视图；JSONL 审计文件仍为追加式事实来源。 */
  restoreState(state: AuditLogState): void {
    if (!state || !Array.isArray(state.entries) || !Array.isArray(state.traces)) {
      throw new Error('审计状态格式非法');
    }
    this.entries = state.entries
      .filter(item => item && typeof item.id === 'string')
      .slice(-MAX_AUDIT_IN_MEMORY);
    this.traces.clear();
    this.traceOrder = [];
    for (const trace of state.traces) {
      if (!trace || typeof trace.trace_id !== 'string') continue;
      this.traces.set(trace.trace_id, { ...trace });
      this.traceOrder.push(trace.trace_id);
    }
    if (this.traceOrder.length > MAX_TRACES_IN_MEMORY) {
      const overflow = this.traceOrder.length - MAX_TRACES_IN_MEMORY;
      for (const id of this.traceOrder.splice(0, overflow)) this.traces.delete(id);
    }
  }

  reset(): void {
    this.entries = [];
    this.traces.clear();
    this.traceOrder = [];
  }
}
