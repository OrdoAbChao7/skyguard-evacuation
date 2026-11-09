/**
 * 工作人员调度与工单系统。
 *
 * 边界：
 *  - Agent 只能创建 PENDING_APPROVAL 工单，不能审批、不能派发；
 *  - 审批由 admin / safety_operator 执行；
 *  - 接单、执行、反馈由被指派的 staff 身份执行；
 *  - 反馈可写回安全域观测并触发重新评估（由上层注入回调）。
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SafetyScenario, StaffMember } from '../safety/types';
import type { AuditActor, AuditLog } from '../safety/audit';

export const WORK_ORDER_TYPE = [
  'scene_verification',
  'crowd_control',
  'corridor_check',
  'camera_observation',
  'uav_observation',
] as const;
export type WorkOrderType = (typeof WORK_ORDER_TYPE)[number];

/** 对外 staff 视图：绝不返回演示登录码。 */
export function publicStaffMember(member: StaffMember): Omit<StaffMember, 'access_code'> {
  const { access_code: _accessCode, ...view } = member;
  return view;
}

/**
 * 工单类型到场景调查动作的固定映射。
 * 未显式提供 resource_request 时，必须从场景动作成本派生预算；
 * 场景缺少对应动作时 fail closed，禁止创建“不计预算”的工单。
 */
export const WORK_ORDER_ACTION_KIND: Record<WorkOrderType, string> = {
  scene_verification: 'staff_check',
  crowd_control: 'staff_check',
  corridor_check: 'staff_check',
  camera_observation: 'camera_query',
  uav_observation: 'uav_request',
};

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
  evidence_id: z.string().min(1).max(100),
  kind: z.string().min(1).max(64),
  summary: z.string().min(1).max(500),
  source: z.string().min(1).max(200),
  confidence: z.number().min(0).max(1).nullable().optional(),
  observed_at: z.string().datetime({ offset: true }).optional(),
});

export const WorkOrderCreateSchema = z.object({
  type: z.enum(WORK_ORDER_TYPE),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  region_id: z.string().min(1).max(100).optional(),
  target: z.string().min(1).max(200).optional(),
  required_skills: z.array(z.string().min(1).max(64)).max(20).default([]),
  evidence: z.array(EvidenceRefSchema).max(20).default([]),
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

const ALLOWED_TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
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

const TERMINAL_STATUSES: WorkOrderStatus[] = ['COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED'];
const BUDGET_EPSILON = 1e-9;

/** 稳定序列化：对象键排序，保证同一请求得到同一幂等指纹。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function requestFingerprint(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

const STAFF_STATUSES = { available: 'available', busy: 'busy' } as const;

function travelSecondsBetween(
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

export class OpsService {
  private staffStatus = new Map<string, StaffMember['status']>();
  private workOrders = new Map<string, WorkOrder>();
  private idempotency = new Map<string, { orderId: string; fingerprint: string }>();
  private budgetSettled = { actions: 0, cost: 0, person_minutes: 0 };

  constructor(
    private readonly scenario: SafetyScenario,
    private readonly audit: AuditLog,
    private readonly onFeedback?: (order: WorkOrder) => void,
    private readonly versionProvider?: () => { observation: number; constraint: number; scenario: string },
    private readonly persistFile?: string,
    private readonly onStateChange?: () => void,
    private readonly transactionRunner?: (fn: () => void) => void,
    private readonly canWrite?: () => void,
  ) {
    for (const member of scenario.staff) this.staffStatus.set(member.id, member.status);
    this.restorePersistedState();
    this.sweepExpiredReservations();
  }

  private assertWritable(): void {
    this.canWrite?.();
  }

  /** 把多步业务变更合并为一次统一状态提交。 */
  private withTransaction<T>(fn: () => T): T {
    this.assertWritable();
    if (!this.transactionRunner) return fn();
    let result!: T;
    this.transactionRunner(() => { result = fn(); });
    return result;
  }

  /** 可选持久化：OPS_PERSIST_FILE 指向 JSON 快照；未配置时保持纯内存。 */
  private restorePersistedState(): void {
    if (!this.persistFile || !fs.existsSync(this.persistFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistFile, 'utf8')) as {
        version?: number;
        workOrders?: WorkOrder[];
        staffStatus?: Array<[string, StaffMember['status']]>;
        idempotency?: Array<[string, string | { orderId: string; fingerprint: string }]>;
        budgetSettled?: { actions: number; cost: number; person_minutes: number };
      };
      this.applyPersistedState(raw);
    } catch (error) {
      // 旧版快照损坏不阻断启动；但会记录审计。统一状态存储使用 fail-closed。
      this.audit.record({
        actor: 'system',
        role: 'system',
        action: 'work_order.persistence_restore_failed',
        entity_type: 'ops_state',
        summary: '工单快照恢复失败，已忽略',
        result: 'failure',
        reason: (error as Error).message,
      });
    }
  }

  /** 从统一状态或旧快照恢复；供 MvpService 的事务存储复用。 */
  applyPersistedState(raw: {
    version?: number;
    workOrders?: WorkOrder[];
    staffStatus?: Array<[string, StaffMember['status']]>;
    idempotency?: Array<[string, string | { orderId: string; fingerprint: string }]>;
    budgetSettled?: { actions: number; cost: number; person_minutes: number };
  }): void {
    this.workOrders.clear();
    this.staffStatus.clear();
    this.idempotency.clear();
    for (const member of this.scenario.staff) this.staffStatus.set(member.id, member.status);
    for (const order of raw.workOrders ?? []) {
      if (!order || typeof order.id !== 'string') continue;
      // 旧快照没有 reservation 字段；补齐为 null 而不是伪造资源。
      this.workOrders.set(order.id, {
        ...order,
        reservation: order.reservation ?? null,
        stale: false,
        stale_reason: null,
      } as WorkOrder);
    }
    for (const [staffId, status] of raw.staffStatus ?? []) {
      if (this.staffStatus.has(staffId)) this.staffStatus.set(staffId, status);
    }
    for (const [key, value] of raw.idempotency ?? []) {
      if (typeof value === 'string') {
        this.idempotency.set(key, { orderId: value, fingerprint: '' });
      } else if (value && typeof value.orderId === 'string') {
        this.idempotency.set(key, { orderId: value.orderId, fingerprint: value.fingerprint ?? '' });
      }
    }
    const settled = raw.budgetSettled;
    this.budgetSettled = {
      actions: typeof settled?.actions === 'number' ? settled.actions : 0,
      cost: typeof settled?.cost === 'number' ? settled.cost : 0,
      person_minutes: typeof settled?.person_minutes === 'number' ? settled.person_minutes : 0,
    };
    this.sweepExpiredReservations();
  }

  exportState(): OpsPersistedState {
    return {
      version: 2,
      saved_at: new Date().toISOString(),
      workOrders: Array.from(this.workOrders.values()),
      staffStatus: Array.from(this.staffStatus.entries()),
      idempotency: Array.from(this.idempotency.entries()),
      budgetSettled: { ...this.budgetSettled },
    };
  }

  private persist(): void {
    if (this.persistFile) {
      try {
        fs.mkdirSync(path.dirname(this.persistFile), { recursive: true });
        const payload = JSON.stringify(this.exportState(), null, 2);
        const temp = `${this.persistFile}.tmp`;
        fs.writeFileSync(temp, payload);
        fs.renameSync(temp, this.persistFile);
      } catch (error) {
        this.audit.record({
          actor: 'system',
          role: 'system',
          action: 'work_order.persistence_failed',
          entity_type: 'ops_state',
          summary: '工单快照写入失败',
          result: 'failure',
          reason: (error as Error).message,
        });
      }
    }
    this.onStateChange?.();
  }

  private currentVersion(): { observation: number; constraint: number; scenario: string } {
    return this.versionProvider?.() ?? { observation: 0, constraint: 0, scenario: this.scenario.version };
  }

  // -------------------------------------------------------------------------
  // 资源预留与预算
  // -------------------------------------------------------------------------

  private activeReservationTotals(): { actions: number; cost: number; person_minutes: number } {
    let actions = 0;
    let cost = 0;
    let personMinutes = 0;
    for (const order of this.workOrders.values()) {
      const reservation = order.reservation;
      if (!reservation?.budget_tracked) continue;
      if (reservation.state !== 'HELD' && reservation.state !== 'CONFIRMED') continue;
      actions += 1;
      cost += reservation.budget_units;
      personMinutes += reservation.person_minutes;
    }
    return {
      actions,
      cost: Number(cost.toFixed(6)),
      person_minutes: Number(personMinutes.toFixed(6)),
    };
  }

  private budgetSnapshot() {
    const budget = this.scenario.investigation?.budget ?? null;
    const reserved = this.activeReservationTotals();
    const settled = {
      actions: this.budgetSettled.actions,
      cost: Number(this.budgetSettled.cost.toFixed(6)),
      person_minutes: Number(this.budgetSettled.person_minutes.toFixed(6)),
    };
    return {
      max_actions: budget?.max_actions ?? null,
      max_total_cost: budget?.max_total_cost ?? null,
      max_total_time_minutes: budget?.max_total_time_minutes ?? null,
      settled,
      reserved,
      remaining: {
        actions: budget ? Math.max(0, budget.max_actions - settled.actions - reserved.actions) : null,
        cost: budget ? Number(Math.max(0, budget.max_total_cost - settled.cost - reserved.cost).toFixed(6)) : null,
        person_minutes: budget
          ? Number(Math.max(0, budget.max_total_time_minutes - settled.person_minutes - reserved.person_minutes).toFixed(6))
          : null,
      },
    };
  }

  /**
   * 解析工单的资源请求：显式请求优先；缺省时从场景调查动作派生。
   * 场景存在 investigation 策略但缺少对应动作时拒绝，避免绕过动作/成本/时间预算。
   */
  private deriveResourceRequest(input: WorkOrderCreateInput): ResourceRequest | undefined {
    const policy = this.scenario.investigation;
    if (!policy) return input.resource_request;
    const kind = WORK_ORDER_ACTION_KIND[input.type];
    const action = policy.actions.find(item => item.kind === kind);
    if (!action) {
      if (input.resource_request) return input.resource_request;
      throw new ResourceUnavailableError(
        `场景 investigation 缺少 ${input.type} 对应的 ${kind} 动作成本，拒绝创建未计预算工单`,
      );
    }
    const derived: ResourceRequest = {
      person_minutes: action.time_cost_minutes,
      // 疏导/管控是执行动作而非 VoI 调查动作：计入动作数与人员时间，
      // 但不消耗调查信息成本预算。
      budget_units: input.type === 'crowd_control' ? 0 : action.resource_cost,
    };
    if (!input.resource_request) return derived;
    // 空对象/全零请求视为“未声明”，按场景动作成本派生；显式正数视为操作员估算。
    if (input.resource_request.person_minutes <= 0 && input.resource_request.budget_units <= 0) {
      return {
        ...derived,
        ...(input.resource_request.staff_id ? { staff_id: input.resource_request.staff_id } : {}),
        ...(input.resource_request.ttl_minutes === undefined ? {} : { ttl_minutes: input.resource_request.ttl_minutes }),
      };
    }
    return input.resource_request;
  }

  /** 候选工单的资源与预算预检；不产生任何预留。 */
  previewReservation(input: WorkOrderCreateInput): ReservationPreview {
    this.sweepExpiredReservations();
    const parsed = WorkOrderCreateSchema.parse(input);
    let resolved: WorkOrderCreateInput;
    try {
      resolved = { ...parsed, resource_request: this.deriveResourceRequest(parsed) };
    } catch (error) {
      return {
        eligible: false,
        reason_code: 'INVALID_REQUEST',
        reason: (error as Error).message,
        staff_id: null,
        budget: this.budgetSnapshot(),
      };
    }
    const budget = this.budgetSnapshot();
    let staffId: string | null = null;
    try {
      staffId = this.chooseHoldStaff(resolved, true);
    } catch (error) {
      return {
        eligible: false,
        reason_code: error instanceof ResourceUnavailableError && /unknown staff/.test(error.message)
          ? 'UNKNOWN_STAFF'
          : 'STAFF_UNAVAILABLE',
        reason: (error as Error).message,
        staff_id: null,
        budget,
      };
    }

    const request = resolved.resource_request;
    if (!request) {
      return { eligible: true, reason_code: 'NO_BUDGET', reason: null, staff_id: staffId, budget };
    }
    if (budget.max_actions === null) {
      return { eligible: true, reason_code: 'NO_BUDGET', reason: null, staff_id: staffId, budget };
    }

    const actionsUsed = budget.settled.actions + budget.reserved.actions;
    const costUsed = budget.settled.cost + budget.reserved.cost;
    const minutesUsed = budget.settled.person_minutes + budget.reserved.person_minutes;
    if (actionsUsed + 1 > budget.max_actions! + BUDGET_EPSILON) {
      return {
        eligible: false,
        reason_code: 'ACTION_BUDGET_EXCEEDED',
        reason: `调查动作预算 ${budget.max_actions} 已用/预留 ${actionsUsed}，候选工单将超限`,
        staff_id: staffId,
        budget,
      };
    }
    if (costUsed + request.budget_units > budget.max_total_cost! + BUDGET_EPSILON) {
      return {
        eligible: false,
        reason_code: 'COST_BUDGET_EXCEEDED',
        reason: `调查预算 ${budget.max_total_cost}，已用/预留 ${costUsed.toFixed(4)}，候选 ${request.budget_units} 将超限`,
        staff_id: staffId,
        budget,
      };
    }
    if (minutesUsed + request.person_minutes > budget.max_total_time_minutes! + BUDGET_EPSILON) {
      return {
        eligible: false,
        reason_code: 'TIME_BUDGET_EXCEEDED',
        reason: `调查时间预算 ${budget.max_total_time_minutes} 分钟，已用/预留 ${minutesUsed.toFixed(4)}，候选 ${request.person_minutes} 将超限`,
        staff_id: staffId,
        budget,
      };
    }
    return { eligible: true, reason_code: 'OK', reason: null, staff_id: staffId, budget };
  }

  getBudgetStatus(): ReservationPreview['budget'] {
    this.sweepExpiredReservations();
    return this.budgetSnapshot();
  }

  /**
   * 选择要软预留的工作人员：显式请求必须可用；推荐人员不可用时重新推荐。
   * 返回 null 表示没有可预留人员，但工单仍可进入待审批（派发时再检查）。
   */
  private chooseHoldStaff(input: WorkOrderCreateInput, strictExplicit: boolean): string | null {
    const explicit = input.resource_request?.staff_id;
    if (explicit) {
      const member = this.getStaff(explicit);
      if (!member) throw new ResourceUnavailableError(`unknown staff: ${explicit}`);
      if (member.runtime_status !== 'available') {
        throw new ResourceUnavailableError(`工作人员 ${explicit} 当前为 ${member.runtime_status}，不可预留`);
      }
      return explicit;
    }
    const recommended = input.recommendation?.staff_id;
    if (recommended) {
      const member = this.getStaff(recommended);
      if (member?.runtime_status === 'available') return recommended;
    }
    if (input.region_id) {
      const recommendation = this.recommendStaff({
        region_id: input.region_id,
        required_skills: input.required_skills,
      });
      return recommendation.recommended?.staff_id ?? null;
    }
    if (strictExplicit) return null;
    return null;
  }

  private buildReservation(
    input: WorkOrderCreateInput,
    staffId: string | null,
  ): ResourceReservation {
    const request = input.resource_request;
    const ttlMinutes = request?.ttl_minutes
      ?? this.scenario.config.work_order_reservation_ttl_minutes
      ?? 15;
    const now = new Date();
    return {
      reservation_id: `RES-${randomUUID().slice(0, 8).toUpperCase()}`,
      state: 'HELD',
      staff_id: staffId,
      person_minutes: request?.person_minutes ?? 0,
      budget_units: request?.budget_units ?? 0,
      budget_tracked: Boolean(request),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
      confirmed_at: null,
      released_at: null,
      release_reason: null,
      scenario_version: this.currentVersion().scenario,
      context_version: this.currentVersion(),
    };
  }

  private releaseReservation(
    order: WorkOrder,
    state: 'RELEASED' | 'EXPIRED',
    reason: string,
    settleBudget = false,
  ): boolean {
    const reservation = order.reservation;
    if (!reservation) return false;
    if (reservation.state === 'RELEASED' || reservation.state === 'EXPIRED') return false;
    if (reservation.staff_id) {
      const current = this.staffStatus.get(reservation.staff_id);
      if (current === 'reserved' || current === 'busy') {
        this.staffStatus.set(reservation.staff_id, 'available');
      }
    }
    if (settleBudget && reservation.budget_tracked) {
      this.budgetSettled.actions += 1;
      this.budgetSettled.cost = Number((this.budgetSettled.cost + reservation.budget_units).toFixed(6));
      this.budgetSettled.person_minutes = Number(
        (this.budgetSettled.person_minutes + reservation.person_minutes).toFixed(6),
      );
    }
    reservation.state = state;
    reservation.released_at = new Date().toISOString();
    reservation.release_reason = reason;
    return true;
  }

  /** 释放所有已过期的 HELD 预留；工单本身保持待审批，但需要重新确认资源。 */
  private sweepExpiredReservations(now: Date = new Date()): void {
    let changed = false;
    for (const order of this.workOrders.values()) {
      const reservation = order.reservation;
      if (!reservation || reservation.state !== 'HELD') continue;
      if (new Date(reservation.expires_at).getTime() > now.getTime()) continue;
      this.releaseReservation(order, 'EXPIRED', '资源预留过期');
      order.updated_at = now.toISOString();
      order.history.push({
        ts: now.toISOString(),
        status: order.status,
        actor: 'system',
        role: 'system',
        note: '资源预留过期，已释放；需管理员重新确认',
      });
      this.audit.record({
        actor: 'system',
        role: 'system',
        action: 'work_order.reservation_expired',
        entity_type: 'work_order',
        entity_id: order.id,
        summary: `工单 ${order.id} 的资源预留已过期并释放`,
        result: 'success',
        after: { reservation_id: reservation.reservation_id },
      });
      changed = true;
    }
    if (changed) this.persist();
  }

  /** 刷新并返回上下文失效状态；终态工单不标记过期。 */
  private refreshStaleness(order: WorkOrder): WorkOrder {
    if (TERMINAL_STATUSES.includes(order.status)) {
      order.stale = false;
      order.stale_reason = null;
      return order;
    }
    const current = this.currentVersion();
    const reasons: string[] = [];
    if (current.observation !== order.context_version.observation) {
      reasons.push(`观测版本 ${order.context_version.observation} → ${current.observation}`);
    }
    if (current.constraint !== order.context_version.constraint) {
      reasons.push(`约束版本 ${order.context_version.constraint} → ${current.constraint}`);
    }
    if (current.scenario !== order.context_version.scenario) {
      reasons.push(`场景版本 ${order.context_version.scenario} → ${current.scenario}`);
    }
    order.stale = reasons.length > 0;
    order.stale_reason = order.stale ? `工单上下文已变化：${reasons.join('；')}，需重新确认` : null;
    return order;
  }

  reset(): void {
    this.staffStatus.clear();
    for (const member of this.scenario.staff) this.staffStatus.set(member.id, member.status);
    this.workOrders.clear();
    this.idempotency.clear();
    this.budgetSettled = { actions: 0, cost: 0, person_minutes: 0 };
    this.persist();
  }

  getScenario(): SafetyScenario {
    return this.scenario;
  }

  listStaff(): Array<Omit<StaffMember, 'access_code'> & { runtime_status: string }> {
    return this.scenario.staff.map(member => ({
      ...publicStaffMember(member),
      runtime_status: this.staffStatus.get(member.id) ?? member.status,
    }));
  }

  getStaff(staffId: string): (StaffMember & { runtime_status: string }) | undefined {
    const member = this.scenario.staff.find(item => item.id === staffId);
    if (!member) return undefined;
    return { ...member, runtime_status: this.staffStatus.get(member.id) ?? member.status };
  }

  /** 演示用身份校验：真实部署必须替换为正式身份系统。 */
  authenticateStaff(staffId: string, accessCode: string): StaffMember | null {
    const member = this.scenario.staff.find(item => item.id === staffId);
    if (!member || !member.access_code) return null;
    return member.access_code === accessCode ? member : null;
  }

  recommendStaff(input: {
    region_id: string;
    required_skills?: string[];
    preferred_roles?: string[];
  }): RecommendStaffResult {
    const regionId = input.region_id;
    const requiredSkills = input.required_skills ?? [];
    const preferredRoles = new Set(input.preferred_roles ?? []);
    const regionExists = this.scenario.regions.some(region => region.id === regionId);
    if (!regionExists) throw new Error(`unknown region: ${regionId}`);

    const candidates: StaffRecommendation[] = [];
    for (const member of this.scenario.staff) {
      const runtimeStatus = this.staffStatus.get(member.id) ?? member.status;
      const reasons: string[] = [];
      const missingSkills = requiredSkills.filter(skill => !member.skills.includes(skill));

      if (runtimeStatus !== STAFF_STATUSES.available) {
        reasons.push(`当前状态为 ${runtimeStatus}，不可派单`);
      }
      if (missingSkills.length > 0) {
        reasons.push(`缺少技能：${missingSkills.join('、')}`);
      }

      const travel = travelSecondsBetween(this.scenario, member.region_id, regionId);
      if (travel === null) reasons.push('按现有通道不可达（需人工确认）');

      const available = runtimeStatus === STAFF_STATUSES.available;
      const skillOk = missingSkills.length === 0;
      const reachable = travel !== null;
      let score: number | null = null;
      if (available && skillOk && reachable) {
        const travelMinutes = travel / 60;
        const roleBonus = preferredRoles.has(member.role) ? 12 : 0;
        const skillBonus = requiredSkills.length > 0 ? 10 : 4;
        score = Number((100 - travelMinutes * 2 + roleBonus + skillBonus).toFixed(2));
        reasons.push(`状态可用`);
        reasons.push(requiredSkills.length > 0 ? `技能匹配：${requiredSkills.join('、')}` : '无强制技能要求');
        reasons.push(`预计到达 ${travelMinutes.toFixed(1)} 分钟`);
        if (roleBonus > 0) reasons.push(`岗位匹配：${member.role}`);
      }

      candidates.push({
        staff_id: member.id,
        name: member.name,
        role: member.role,
        region_id: member.region_id,
        status: runtimeStatus,
        skills: member.skills,
        travel_seconds: travel,
        travel_minutes: travel === null ? null : Number((travel / 60).toFixed(2)),
        score,
        reasons,
        source: member.source,
        verified: member.verified,
      });
    }

    const ranked = candidates
      .filter(item => item.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const recommended = ranked[0] ?? null;

    return {
      region_id: regionId,
      required_skills: requiredSkills,
      candidates: candidates.sort((a, b) => {
        if (a.score === null && b.score === null) return a.staff_id.localeCompare(b.staff_id);
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return b.score - a.score;
      }),
      recommended,
      shortage: recommended === null,
      reason: recommended
        ? `推荐 ${recommended.name}（${recommended.staff_id}）：${recommended.reasons.join('；')}`
        : '没有同时满足状态、技能与可达性要求的可用人员，需人工协调或调整任务。',
    };
  }

  createWorkOrder(actor: OpsActor, input: WorkOrderCreateInput): WorkOrder {
    return this.withTransaction(() => this.createWorkOrderInternal(actor, input));
  }

  private createWorkOrderInternal(actor: OpsActor, input: WorkOrderCreateInput): WorkOrder {
    const parsed = WorkOrderCreateSchema.parse(input);
    const fingerprint = requestFingerprint(parsed);
    if (parsed.idempotency_key) {
      const existingRecord = this.idempotency.get(parsed.idempotency_key);
      if (existingRecord) {
        // 旧快照可能没有指纹：此时宁可按冲突拒绝，也不静默复用不同参数。
        if (existingRecord.fingerprint !== fingerprint) {
          throw new IdempotencyConflictError(
            `幂等键 ${parsed.idempotency_key} 已用于不同的请求参数；拒绝复用`,
          );
        }
        const existing = this.workOrders.get(existingRecord.orderId);
        if (existing) {
          // 幂等键只在同一调用者、同一场景内可复用，防止跨用户/跨场景串单。
          if (existing.created_by.username !== actor.username || existing.created_by.role !== actor.role) {
            throw new IdempotencyConflictError(
              `幂等键 ${parsed.idempotency_key} 属于其他调用者；拒绝复用`,
            );
          }
          if (existing.context_version.scenario !== this.currentVersion().scenario) {
            throw new IdempotencyConflictError(
              `幂等键 ${parsed.idempotency_key} 属于旧场景版本；拒绝复用`,
            );
          }
          return this.refreshStaleness(existing);
        }
      }
    }
    if (parsed.region_id && !this.scenario.regions.some(region => region.id === parsed.region_id)) {
      throw new Error(`unknown region: ${parsed.region_id}`);
    }
    // 状态文件有 32MB 硬上限；工单无限增长最终会让服务只读/无法重启。
    if (this.workOrders.size >= 5000) {
      throw new ResourceUnavailableError('工单数量达到 5000 条上限，请归档后再创建');
    }

    // 创建前预检：预算 + 人员；不通过则不建立任何副作用。
    // 缺省 resource_request 时从场景动作派生，确保所有调查类工单计入预算。
    let resourceRequest = this.deriveResourceRequest(parsed);
    if (actor.role === 'agent' && resourceRequest) {
      // Agent 不得自选人员或申请超长 TTL；人员由推荐算法决定，TTL 受场景上限约束。
      const policyTtl = this.scenario.config.work_order_reservation_ttl_minutes ?? 15;
      resourceRequest = {
        person_minutes: resourceRequest.person_minutes,
        budget_units: resourceRequest.budget_units,
        ttl_minutes: Math.min(resourceRequest.ttl_minutes ?? policyTtl, policyTtl),
      };
    }
    const resolved: WorkOrderCreateInput = {
      ...parsed,
      resource_request: resourceRequest,
    };
    const preview = this.previewReservation(resolved);
    if (!preview.eligible) {
      throw new ResourceUnavailableError(preview.reason ?? '资源或预算不足，无法创建工单');
    }

    const now = new Date().toISOString();
    const status: WorkOrderStatus = parsed.submit ? 'PENDING_APPROVAL' : 'DRAFT';
    const reservation = this.buildReservation(resolved, preview.staff_id);
    const order: WorkOrder = {
      id: `WO-${randomUUID().slice(0, 8).toUpperCase()}`,
      type: parsed.type,
      title: parsed.title,
      description: parsed.description,
      priority: parsed.priority,
      region_id: parsed.region_id,
      target: parsed.target,
      required_skills: parsed.required_skills,
      evidence: parsed.evidence,
      status,
      created_by: {
        username: actor.username,
        role: actor.role,
        kind: actor.kind ?? (actor.role === 'agent' ? 'agent' : 'human'),
      },
      created_at: now,
      updated_at: now,
      approval: null,
      assigned_staff_id: null,
      assigned_at: null,
      accepted_at: null,
      started_at: null,
      completed_at: null,
      feedback: null,
      failure_reason: null,
      context_version: this.currentVersion(),
      idempotency_key: parsed.idempotency_key ?? null,
      reservation,
      stale: false,
      stale_reason: null,
      history: [{ ts: now, status, actor: actor.username, role: actor.role, note: parsed.submit ? '提交审批并预留资源' : '创建草稿并预留资源' }],
    };
    this.workOrders.set(order.id, order);
    if (reservation.staff_id) this.staffStatus.set(reservation.staff_id, 'reserved');
    if (parsed.idempotency_key) {
      this.idempotency.set(parsed.idempotency_key, { orderId: order.id, fingerprint });
    }
    this.persist();
    this.audit.record({
      actor: actor.username,
      role: actor.role,
      action: 'work_order.created',
      entity_type: 'work_order',
      entity_id: order.id,
      summary: `创建工单 ${order.id}：${order.title}（${status}）`,
      result: 'success',
      after: {
        status,
        type: order.type,
        region_id: order.region_id,
        reservation_id: reservation.reservation_id,
        reserved_staff: reservation.staff_id,
        budget_units: reservation.budget_units,
        person_minutes: reservation.person_minutes,
        expires_at: reservation.expires_at,
      },
    });
    return order;
  }

  getWorkOrder(id: string): WorkOrder | undefined {
    this.sweepExpiredReservations();
    const order = this.workOrders.get(id);
    return order ? this.refreshStaleness(order) : undefined;
  }

  listWorkOrders(filter: { status?: WorkOrderStatus; staff_id?: string; region_id?: string } = {}): WorkOrder[] {
    this.sweepExpiredReservations();
    return Array.from(this.workOrders.values())
      .filter(order => !filter.status || order.status === filter.status)
      .filter(order => !filter.staff_id || order.assigned_staff_id === filter.staff_id)
      .filter(order => !filter.region_id || order.region_id === filter.region_id)
      .map(order => this.refreshStaleness(order))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  private transition(
    order: WorkOrder,
    next: WorkOrderStatus,
    actor: OpsActor,
    options: { note?: string; patch?: Partial<WorkOrder> } = {},
  ): WorkOrder {
    this.assertWritable();
    if (!ALLOWED_TRANSITIONS[order.status].includes(next)) {
      throw new WorkOrderTransitionError(`工单 ${order.id} 不能从 ${order.status} 流转到 ${next}`);
    }
    const now = new Date().toISOString();
    order.status = next;
    order.updated_at = now;
    if (options.patch) Object.assign(order, options.patch);
    order.history.push({ ts: now, status: next, actor: actor.username, role: actor.role, note: options.note });
    this.audit.record({
      actor: actor.username,
      role: actor.role,
      action: `work_order.${next.toLowerCase()}`,
      entity_type: 'work_order',
      entity_id: order.id,
      summary: `工单 ${order.id} → ${next}`,
      result: 'success',
      after: { status: next, assigned_staff_id: order.assigned_staff_id },
    });
    this.persist();
    return order;
  }

  submitForApproval(id: string, actor: OpsActor): WorkOrder {
    return this.withTransaction(() => {
      const order = this.requireOrder(id);
      return this.transition(order, 'PENDING_APPROVAL', actor, { note: '提交审批' });
    });
  }

  /** 校验预留仍然有效（未过期、未释放、场景版本一致）；无效则 fail closed。 */
  private ensureReservationActive(order: WorkOrder, action: string): ResourceReservation | null {
    this.sweepExpiredReservations();
    const reservation = order.reservation;
    if (!reservation) return null;
    const current = this.currentVersion();
    if (reservation.state === 'EXPIRED') {
      throw new ResourceUnavailableError(`工单 ${order.id} 的资源预留已过期，请管理员重新确认后再${action}`);
    }
    if (reservation.state === 'RELEASED') {
      throw new ResourceUnavailableError(`工单 ${order.id} 的资源预留已释放，请重新确认后再${action}`);
    }
    if (reservation.scenario_version !== current.scenario) {
      throw new WorkOrderTransitionError(
        `工单 ${order.id} 的资源预留基于场景版本 ${reservation.scenario_version}，当前为 ${current.scenario}；请重新确认`,
      );
    }
    if (reservation.state === 'HELD' && new Date(reservation.expires_at).getTime() <= Date.now()) {
      this.releaseReservation(order, 'EXPIRED', '资源预留过期');
      this.persist();
      throw new ResourceUnavailableError(`工单 ${order.id} 的资源预留已过期，请管理员重新确认后再${action}`);
    }
    return reservation;
  }

  approve(id: string, actor: OpsActor, note?: string): WorkOrder {
    this.requireOperator(actor);
    return this.withTransaction(() => {
      const order = this.requireOrder(id);
      if (order.status !== 'PENDING_APPROVAL') {
        throw new WorkOrderTransitionError(`工单 ${order.id} 当前为 ${order.status}，只有 PENDING_APPROVAL 可审批`);
      }
      const reservation = this.ensureReservationActive(order, '审批');
      if (reservation && reservation.state === 'HELD') {
        reservation.state = 'CONFIRMED';
        reservation.confirmed_at = new Date().toISOString();
      }
      const now = new Date().toISOString();
      return this.transition(order, 'APPROVED', actor, {
        note: note ?? '审批通过',
        patch: { approval: { decision: 'approved', by: actor.username, role: actor.role, at: now, note } },
      });
    });
  }

  reject(id: string, actor: OpsActor, note: string): WorkOrder {
    this.requireOperator(actor);
    if (!note.trim()) throw new Error('拒绝工单必须填写审批意见');
    const order = this.requireOrder(id);
    const now = new Date().toISOString();
    return this.withTransaction(() => {
      const updated = this.transition(order, 'REJECTED', actor, {
        note,
        patch: { approval: { decision: 'rejected', by: actor.username, role: actor.role, at: now, note } },
      });
      this.releaseReservation(order, 'RELEASED', '审批拒绝');
      this.persist();
      return updated;
    });
  }

  assignStaff(id: string, actor: OpsActor, staffId?: string): WorkOrder {
    this.requireOperator(actor);
    const order = this.requireOrder(id);
    if (order.status !== 'APPROVED') {
      throw new WorkOrderTransitionError(`工单 ${order.id} 当前为 ${order.status}，只有 APPROVED 状态可派发`);
    }
    this.refreshStaleness(order);
    if (order.stale) {
      throw new WorkOrderTransitionError(`工单 ${order.id} 上下文已变化，审批已失效；请管理员重新确认后再派发（${order.stale_reason}）`);
    }
    const reservation = this.ensureReservationActive(order, '派发');
    const targetStaffId = staffId
      ?? reservation?.staff_id
      ?? (order.region_id
        ? this.recommendStaff({ region_id: order.region_id, required_skills: order.required_skills }).recommended?.staff_id
        : undefined);
    if (!targetStaffId) throw new WorkOrderTransitionError('没有可用工作人员，无法派发');
    const member = this.getStaff(targetStaffId);
    if (!member) throw new Error(`unknown staff: ${targetStaffId}`);

    return this.withTransaction(() => {
      // 先校验目标人员可用性，再改动原预留；失败时不产生任何状态变化。
      const reservedByThisOrder = reservation?.staff_id === targetStaffId
        && this.staffStatus.get(targetStaffId) === 'reserved';
      if (member.runtime_status !== 'available' && !reservedByThisOrder) {
        throw new WorkOrderTransitionError(`工作人员 ${targetStaffId} 当前为 ${member.runtime_status}，不可派发`);
      }
      if (reservation?.staff_id && reservation.staff_id !== targetStaffId) {
        const previous = this.staffStatus.get(reservation.staff_id);
        if (previous === 'reserved') this.staffStatus.set(reservation.staff_id, 'available');
      }
      if (reservation) {
        if (reservation.staff_id && reservation.staff_id !== targetStaffId) {
          reservation.staff_id = targetStaffId;
        } else if (!reservation.staff_id) {
          reservation.staff_id = targetStaffId;
        }
        if (reservation.state === 'HELD') {
          reservation.state = 'CONFIRMED';
          reservation.confirmed_at = new Date().toISOString();
        }
      }
      const now = new Date().toISOString();
      const updated = this.transition(order, 'ASSIGNED', actor, {
        note: `派发给 ${member.name}（${targetStaffId}）`,
        patch: { assigned_staff_id: targetStaffId, assigned_at: now },
      });
      this.staffStatus.set(targetStaffId, 'busy');
      this.persist();
      return updated;
    });
  }

  accept(id: string, actor: OpsActor): WorkOrder {
    return this.withTransaction(() => {
      const order = this.requireAssignedStaff(id, actor);
      return this.transition(order, 'ACCEPTED', actor, {
        note: '工作人员接单',
        patch: { accepted_at: new Date().toISOString() },
      });
    });
  }

  start(id: string, actor: OpsActor): WorkOrder {
    return this.withTransaction(() => {
      const order = this.requireAssignedStaff(id, actor);
      return this.transition(order, 'IN_PROGRESS', actor, {
        note: '开始执行',
        patch: { started_at: new Date().toISOString() },
      });
    });
  }

  complete(
    id: string,
    actor: OpsActor,
    feedback: { note: string; observation?: { count: number; confidence: number; valid?: boolean; reason?: string } },
  ): WorkOrder {
    const order = this.requireAssignedStaff(id, actor);
    if (!feedback.note.trim()) throw new Error('完成任务必须提交现场反馈说明');
    const now = new Date().toISOString();
    const observation = feedback.observation
      ? {
        count: feedback.observation.count,
        confidence: feedback.observation.confidence,
        valid: feedback.observation.valid ?? true,
        reason: feedback.observation.reason,
      }
      : undefined;
    return this.withTransaction(() => {
      const updated = this.transition(order, 'COMPLETED', actor, {
        note: feedback.note,
        patch: {
          completed_at: now,
          feedback: { staff_id: actor.staff_id ?? actor.username, note: feedback.note, at: now, observation },
        },
      });
      this.releaseStaff(order.assigned_staff_id);
      this.releaseReservation(order, 'RELEASED', 'completed', true);
      this.persist();
      // 现场反馈写回安全域；与工单完成在同一事务范围内提交一次统一状态。
      this.onFeedback?.(updated);
      return updated;
    });
  }

  fail(id: string, actor: OpsActor, reason: string): WorkOrder {
    const order = this.requireAssignedStaff(id, actor);
    if (!reason.trim()) throw new Error('失败工单必须说明原因');
    return this.withTransaction(() => {
      const updated = this.transition(order, 'FAILED', actor, {
        note: reason,
        patch: { failure_reason: reason },
      });
      this.releaseStaff(order.assigned_staff_id);
      // 已接单（承诺投入）或已开始执行的失败工单按声明值结算，防止“接单即失败”反复
      // 绕过预算；仅未接单的取消/拒绝/失败不结算。
      this.releaseReservation(
        order,
        'RELEASED',
        `failed:${reason}`,
        Boolean(order.started_at || order.accepted_at),
      );
      this.persist();
      return updated;
    });
  }

  /** 管理员取消未开始执行的工单；在途任务需现场协调，不允许静默取消。 */
  cancel(id: string, actor: OpsActor, reason: string): WorkOrder {
    this.requireOperator(actor);
    if (!reason.trim()) throw new Error('取消工单必须填写原因');
    const order = this.requireOrder(id);
    if (['IN_PROGRESS', 'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED'].includes(order.status)) {
      throw new WorkOrderTransitionError(`工单 ${order.id} 当前为 ${order.status}，不可取消`);
    }
    return this.withTransaction(() => {
      const updated = this.transition(order, 'CANCELLED', actor, {
        note: reason,
        patch: { failure_reason: reason },
      });
      this.releaseStaff(order.assigned_staff_id);
      this.releaseReservation(order, 'RELEASED', `cancelled:${reason}`);
      this.persist();
      return updated;
    });
  }

  /** 管理员在环境变化或预留过期后重新确认工单上下文与资源。 */
  revalidate(id: string, actor: OpsActor, note?: string): WorkOrder {
    return this.withTransaction(() => this.revalidateInternal(id, actor, note));
  }

  private revalidateInternal(id: string, actor: OpsActor, note?: string): WorkOrder {
    this.requireOperator(actor);
    const order = this.requireOrder(id);
    if (['COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED', 'DRAFT'].includes(order.status)) {
      throw new WorkOrderTransitionError(`工单 ${order.id} 当前为 ${order.status}，无需重新确认`);
    }
    const previous = { ...order.context_version };
    const previousReservation = order.reservation;
    if (previousReservation) {
      const expired = previousReservation.state === 'EXPIRED'
        || previousReservation.state === 'RELEASED'
        || (previousReservation.state === 'HELD'
          && new Date(previousReservation.expires_at).getTime() <= Date.now());
      if (expired) {
        const stillAvailable = previousReservation.staff_id
          ? this.getStaff(previousReservation.staff_id)?.runtime_status === 'available'
          : false;
        const synthetic = WorkOrderCreateSchema.parse({
          type: order.type,
          title: order.title,
          description: order.description,
          priority: order.priority,
          region_id: order.region_id,
          required_skills: order.required_skills,
          evidence: order.evidence,
          submit: true,
          resource_request: previousReservation.budget_tracked
            ? {
              person_minutes: previousReservation.person_minutes,
              budget_units: previousReservation.budget_units,
              ...(stillAvailable && previousReservation.staff_id
                ? { staff_id: previousReservation.staff_id }
                : {}),
            }
            : undefined,
        });
        const preview = this.previewReservation(synthetic);
        if (!preview.eligible) {
          throw new ResourceUnavailableError(preview.reason ?? '资源或预算不足，无法重新确认');
        }
        const ttlMinutes = this.scenario.config.work_order_reservation_ttl_minutes ?? 15;
        const now = new Date();
        previousReservation.state = 'HELD';
        previousReservation.staff_id = preview.staff_id;
        previousReservation.created_at = now.toISOString();
        previousReservation.expires_at = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
        previousReservation.confirmed_at = null;
        previousReservation.released_at = null;
        previousReservation.release_reason = null;
        previousReservation.scenario_version = this.currentVersion().scenario;
        previousReservation.context_version = this.currentVersion();
        if (preview.staff_id) this.staffStatus.set(preview.staff_id, 'reserved');
      } else {
        if (previousReservation.state === 'HELD') {
          const ttlMinutes = this.scenario.config.work_order_reservation_ttl_minutes ?? 15;
          previousReservation.expires_at = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
        }
        previousReservation.scenario_version = this.currentVersion().scenario;
        previousReservation.context_version = this.currentVersion();
      }
    } else {
      // 旧工单没有预留：重新确认时补建，避免"无预留也能派发"。
      const preview = this.previewReservation(WorkOrderCreateSchema.parse({
        type: order.type,
        title: order.title,
        description: order.description,
        priority: order.priority,
        region_id: order.region_id,
        required_skills: order.required_skills,
        evidence: order.evidence,
        submit: true,
      }));
      if (!preview.eligible) {
        throw new ResourceUnavailableError(preview.reason ?? '资源不足，无法重新确认');
      }
      order.reservation = this.buildReservation(WorkOrderCreateSchema.parse({
        type: order.type,
        title: order.title,
        description: order.description,
        priority: order.priority,
        region_id: order.region_id,
        required_skills: order.required_skills,
        evidence: order.evidence,
        submit: true,
      }), preview.staff_id);
      if (order.reservation.staff_id) this.staffStatus.set(order.reservation.staff_id, 'reserved');
    }
    order.context_version = this.currentVersion();
    this.refreshStaleness(order);
    const now = new Date().toISOString();
    order.updated_at = now;
    order.history.push({
      ts: now,
      status: order.status,
      actor: actor.username,
      role: actor.role,
      note: note ?? `重新确认上下文与资源（${previous.observation}→${order.context_version.observation}）`,
    });
    this.audit.record({
      actor: actor.username,
      role: actor.role,
      action: 'work_order.revalidated',
      entity_type: 'work_order',
      entity_id: order.id,
      summary: `工单 ${order.id} 重新确认上下文与资源`,
      result: 'success',
      after: {
        context_version: order.context_version,
        status: order.status,
        reservation_id: order.reservation?.reservation_id ?? null,
        reservation_state: order.reservation?.state ?? null,
      },
    });
    this.persist();
    return order;
  }

  private releaseStaff(staffId: string | null): void {
    if (!staffId) return;
    this.staffStatus.set(staffId, 'available');
    this.persist();
  }

  private requireOrder(id: string): WorkOrder {
    const order = this.workOrders.get(id);
    if (!order) throw new Error(`work order not found: ${id}`);
    return order;
  }

  private requireOperator(actor: OpsActor): void {
    if (!['admin', 'safety_operator'].includes(actor.role)) {
      throw new WorkOrderTransitionError('当前身份无权审批或派发工单，需要 admin 或 safety_operator 角色');
    }
  }

  private requireAssignedStaff(id: string, actor: OpsActor): WorkOrder {
    const order = this.refreshStaleness(this.requireOrder(id));
    if (order.stale) {
      throw new WorkOrderTransitionError(`工单 ${order.id} 上下文已变化（${order.stale_reason}），请等待管理员重新确认`);
    }
    if (actor.role !== 'staff') {
      throw new WorkOrderTransitionError('只有工作人员身份可以接单、执行与反馈');
    }
    if (order.assigned_staff_id !== actor.staff_id) {
      throw new WorkOrderTransitionError('只能操作指派给本人的工单');
    }
    return order;
  }
}
