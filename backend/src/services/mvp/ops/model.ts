import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuditActor } from '../../safety/audit';
import type { SafetyScenario, StaffMember } from '../../safety/types';

export const WORK_ORDER_TYPE = [
  'scene_verification',
  'crowd_control',
  'corridor_check',
  'camera_observation',
  'uav_observation',
] as const;
export type WorkOrderType = (typeof WORK_ORDER_TYPE)[number];

export const WORK_ORDER_STATUS = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUS)[number];

export const RESERVATION_STATE = ['HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED'] as const;
export type ReservationState = (typeof RESERVATION_STATE)[number];

export const ResourceRequestSchema = z.object({
  /** 期望预留的具体工作人员；缺省时使用推荐人员。 */
  staff_id: z.string().min(1).optional(),
  /** 预计占用的人员分钟数（计入调查时间预算）。 */
  person_minutes: z.number().nonnegative().default(0),
  /** 预计消耗的调查预算单位（计入 max_total_cost）。 */
  budget_units: z.number().nonnegative().default(0),
  /** 覆盖场景默认 TTL（分钟）。 */
  ttl_minutes: z.number().positive().max(1440).optional(),
});
export type ResourceRequest = z.infer<typeof ResourceRequestSchema>;

export interface ResourceReservation {
  reservation_id: string;
  state: ReservationState;
  staff_id: string | null;
  person_minutes: number;
  budget_units: number;
  /** 是否计入调查预算（未提供 resource_request 的普通工单为 false）。 */
  budget_tracked: boolean;
  created_at: string;
  expires_at: string;
  confirmed_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  scenario_version: string;
  context_version: { observation: number; constraint: number; scenario: string };
}

export interface ReservationPreview {
  eligible: boolean;
  reason_code:
    | 'OK'
    | 'NO_BUDGET'
    | 'ACTION_BUDGET_EXCEEDED'
    | 'COST_BUDGET_EXCEEDED'
    | 'TIME_BUDGET_EXCEEDED'
    | 'STAFF_UNAVAILABLE'
    | 'UNKNOWN_STAFF'
    | 'INVALID_REQUEST';
  reason: string | null;
  staff_id: string | null;
  budget: {
    max_actions: number | null;
    max_total_cost: number | null;
    max_total_time_minutes: number | null;
    settled: { actions: number; cost: number; person_minutes: number };
    reserved: { actions: number; cost: number; person_minutes: number };
    remaining: { actions: number | null; cost: number | null; person_minutes: number | null };
  };
}

export const EvidenceRefSchema = z.object({
  evidence_id: z.string().min(1),
  kind: z.string().min(1),
  summary: z.string().min(1),
  source: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable().optional(),
  observed_at: z.string().datetime({ offset: true }).optional(),
});

export const WorkOrderCreateSchema = z.object({
  type: z.enum(WORK_ORDER_TYPE),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  region_id: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  required_skills: z.array(z.string()).default([]),
  evidence: z.array(EvidenceRefSchema).default([]),
  recommendation: z.object({
    staff_id: z.string().min(1).nullable(),
    reasons: z.array(z.string()).default([]),
    score: z.number().nullable(),
  }).optional(),
  /** 资源预留请求；缺省时仍会尝试预留推荐人员，但不计入调查预算。 */
  resource_request: ResourceRequestSchema.optional(),
  /** true 时直接进入待审批（Agent 默认）；false 时保持 DRAFT。 */
  submit: z.boolean().default(true),
  /** 幂等键：同一键重复创建返回同一工单，避免 Agent 重试产生重复任务。 */
  idempotency_key: z.string().min(1).max(100).optional(),
});
export type WorkOrderCreateInput = z.infer<typeof WorkOrderCreateSchema>;

export interface WorkOrderEvent {
  ts: string;
  status: WorkOrderStatus;
  actor: string;
  role: string;
  note?: string;
}

export interface WorkOrder {
  id: string;
  type: WorkOrderType;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  region_id?: string;
  target?: string;
  required_skills: string[];
  evidence: z.infer<typeof EvidenceRefSchema>[];
  status: WorkOrderStatus;
  created_by: { username: string; role: string; kind: 'agent' | 'human' };
  created_at: string;
  updated_at: string;
  approval: {
    decision: 'approved' | 'rejected';
    by: string;
    role: string;
    at: string;
    note?: string;
  } | null;
  assigned_staff_id: string | null;
  assigned_at: string | null;
  accepted_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  feedback: {
    staff_id: string;
    note: string;
    at: string;
    observation?: { count: number; confidence: number; valid: boolean; reason?: string };
  } | null;
  failure_reason: string | null;
  /** 创建时的场景/约束/观测版本；用于检测审批后环境变化。 */
  context_version: { observation: number; constraint: number; scenario: string };
  idempotency_key: string | null;
  /** 资源预留（人员、预算、有效期）；所有工单在创建时建立。 */
  reservation: ResourceReservation | null;
  /** 当前上下文是否已落后（读取时计算）。 */
  stale: boolean;
  stale_reason: string | null;
  history: WorkOrderEvent[];
}

export interface StaffRecommendation {
  staff_id: string;
  name: string;
  role: string;
  region_id: string;
  status: string;
  skills: string[];
  travel_seconds: number | null;
  travel_minutes: number | null;
  score: number | null;
  reasons: string[];
  source: string;
  verified: boolean;
}

export interface RecommendStaffResult {
  region_id: string;
  required_skills: string[];
  candidates: StaffRecommendation[];
  recommended: StaffRecommendation | null;
  shortage: boolean;
  reason: string;
}

export interface OpsActor extends AuditActor {
  staff_id?: string;
  kind?: 'agent' | 'human';
}

export class WorkOrderTransitionError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'WorkOrderTransitionError';
  }
}

export class ResourceUnavailableError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ResourceUnavailableError';
  }
}

export class IdempotencyConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export const ALLOWED_TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['ASSIGNED', 'CANCELLED'],
  REJECTED: [],
  ASSIGNED: ['ACCEPTED', 'FAILED', 'CANCELLED'],
  ACCEPTED: ['IN_PROGRESS', 'FAILED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const TERMINAL_STATUSES: WorkOrderStatus[] = ['COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED'];
export const BUDGET_EPSILON = 1e-9;

/** 稳定序列化：对象键排序，保证同一请求得到同一幂等指纹。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function requestFingerprint(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

export const STAFF_STATUSES = { available: 'available', busy: 'busy' } as const;

export function travelSecondsBetween(
  scenario: SafetyScenario,
  fromRegionId: string,
  toRegionId: string,
): number | null {
  if (fromRegionId === toRegionId) return 0;
  const adjacency = new Map<string, Array<{ to: string; seconds: number }>>();
  for (const corridor of scenario.corridors) {
    if (corridor.status !== 'open' || corridor.capacity_per_min === null) continue;
    if (corridor.direction === 'both' || corridor.direction === 'forward') {
      const list = adjacency.get(corridor.from_region_id) ?? [];
      list.push({ to: corridor.to_region_id, seconds: corridor.traversal_seconds });
      adjacency.set(corridor.from_region_id, list);
    }
    if (corridor.direction === 'both' || corridor.direction === 'reverse') {
      const list = adjacency.get(corridor.to_region_id) ?? [];
      list.push({ to: corridor.from_region_id, seconds: corridor.traversal_seconds });
      adjacency.set(corridor.to_region_id, list);
    }
  }

  const distances = new Map<string, number>();
  const visited = new Set<string>();
  distances.set(fromRegionId, 0);
  while (true) {
    let current: string | null = null;
    let best = Infinity;
    for (const [regionId, distance] of distances) {
      if (!visited.has(regionId) && distance < best) {
        best = distance;
        current = regionId;
      }
    }
    if (current === null) break;
    if (current === toRegionId) return best;
    visited.add(current);
    for (const edge of adjacency.get(current) ?? []) {
      const next = best + edge.seconds;
      if (next < (distances.get(edge.to) ?? Infinity)) distances.set(edge.to, next);
    }
  }
  return distances.get(toRegionId) ?? null;
}

export interface OpsPersistedState {
  version: 2;
  saved_at: string;
  workOrders: WorkOrder[];
  staffStatus: Array<[string, StaffMember['status']]>;
  idempotency: Array<[string, { orderId: string; fingerprint: string }]>;
  budgetSettled: { actions: number; cost: number; person_minutes: number };
}
