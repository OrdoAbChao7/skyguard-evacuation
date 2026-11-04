/**
 * 突发事件管理：状态迁移与约束变更。
 *
 * 规则（与需求文档一致）：
 *  - `reported` 只是待确认情报，不改变任何约束；
 *  - 只有 `confirmed` 事件才进入有效路网并使其影响的通道/出口关闭；
 *  - `resolved` / `dismissed` 为终态，解除后旧方案必须重新规划与校验，不得自动恢复。
 */
import { randomUUID } from 'node:crypto';
import type { Incident, IncidentStatus, IncidentType } from './types';

export class IncidentTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncidentTransitionError';
  }
}

export interface CreateIncidentInput {
  type: IncidentType;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affected: { region_ids?: string[]; corridor_ids?: string[]; exit_ids?: string[] };
  source: 'operator' | 'natural_language' | 'sensor' | 'simulation';
  rawText?: string;
  actor: string;
  /** 已存在的事件引用别名（演示脚本用）。 */
  ref?: string;
}

const ALLOWED_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  reported: ['confirmed', 'dismissed'],
  confirmed: ['resolved'],
  resolved: [],
  dismissed: [],
};

export class IncidentStore {
  private incidents = new Map<string, Incident>();
  private aliases = new Map<string, string>();
  private version = 0;

  getVersion(): number {
    return this.version;
  }

  list(): Incident[] {
    return [...this.incidents.values()].sort((a, b) => a.reported_at.localeCompare(b.reported_at));
  }

  get(id: string): Incident | undefined {
    const resolved = this.aliases.get(id) ?? id;
    return this.incidents.get(resolved);
  }

  resolveRef(ref: string): Incident | undefined {
    const id = this.aliases.get(ref) ?? ref;
    return this.incidents.get(id);
  }

  create(input: CreateIncidentInput, now: Date = new Date()): Incident {
    const incident: Incident = {
      id: `INC-${randomUUID()}`,
      type: input.type,
      description: input.description,
      status: 'reported',
      severity: input.severity,
      affected: {
        region_ids: input.affected.region_ids ?? [],
        corridor_ids: input.affected.corridor_ids ?? [],
        exit_ids: input.affected.exit_ids ?? [],
      },
      source: input.source,
      raw_text: input.rawText,
      reported_by: input.actor,
      reported_at: now.toISOString(),
    };
    this.incidents.set(incident.id, incident);
    if (input.ref) this.aliases.set(input.ref, incident.id);
    // 事件创建本身不改变物理约束，但仍视为情报版本变化（不影响约束版本）
    return incident;
  }

  private transition(
    id: string,
    target: IncidentStatus,
    actor: string,
    now: Date,
    mutate?: (incident: Incident) => void,
  ): Incident {
    const incident = this.resolveRef(id);
    if (!incident) throw new IncidentTransitionError(`事件不存在：${id}`);
    const allowed = ALLOWED_TRANSITIONS[incident.status];
    if (!allowed.includes(target)) {
      throw new IncidentTransitionError(`事件 ${incident.id} 不允许从 ${incident.status} 迁移到 ${target}`);
    }
    const next: Incident = { ...incident, status: target };
    if (target === 'confirmed') {
      next.confirmed_by = actor;
      next.confirmed_at = now.toISOString();
    }
    if (target === 'resolved') {
      next.resolved_by = actor;
      next.resolved_at = now.toISOString();
    }
    mutate?.(next);
    this.incidents.set(next.id, next);
    this.version += 1;
    return next;
  }

  confirm(id: string, actor: string, now: Date = new Date()): Incident {
    return this.transition(id, 'confirmed', actor, now);
  }

  resolve(id: string, actor: string, note?: string, now: Date = new Date()): Incident {
    return this.transition(id, 'resolved', actor, now, incident => {
      incident.resolution_note = note;
    });
  }

  dismiss(id: string, actor: string, note?: string, now: Date = new Date()): Incident {
    return this.transition(id, 'dismissed', actor, now, incident => {
      incident.resolution_note = note;
    });
  }

  confirmed(): Incident[] {
    return this.list().filter(incident => incident.status === 'confirmed');
  }

  clear(): void {
    this.incidents.clear();
    this.aliases.clear();
    this.version = 0;
  }
}
