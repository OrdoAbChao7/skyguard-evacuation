/**
 * 工作人员调度与工单系统。
 *
 * 边界：
 *  - Agent 只能创建 PENDING_APPROVAL 工单，不能审批、不能派发；
 *  - 审批由 admin / safety_operator 执行；
 *  - 接单、执行、反馈由被指派的 staff 身份执行；
 *  - 反馈可写回安全域观测并触发重新评估（由上层注入回调）。
 */
import { randomUUID } from 'node:crypto';
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
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUS)[number];

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
  constructor(message: string) {
    super(message);
    this.name = 'WorkOrderTransitionError';
  }
}

const ALLOWED_TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  DRAFT: ['PENDING_APPROVAL'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
  APPROVED: ['ASSIGNED'],
  REJECTED: [],
  ASSIGNED: ['ACCEPTED', 'FAILED'],
  ACCEPTED: ['IN_PROGRESS', 'FAILED'],
  IN_PROGRESS: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

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

export class OpsService {
  private staffStatus = new Map<string, StaffMember['status']>();
  private workOrders = new Map<string, WorkOrder>();

  private idempotency = new Map<string, string>();

  constructor(
    private readonly scenario: SafetyScenario,
    private readonly audit: AuditLog,
    private readonly onFeedback?: (order: WorkOrder) => void,
    private readonly versionProvider?: () => { observation: number; constraint: number; scenario: string },
    private readonly persistFile?: string,
  ) {
    for (const member of scenario.staff) this.staffStatus.set(member.id, member.status);
    this.restorePersistedState();
  }

  /** 可选持久化：OPS_PERSIST_FILE 指向 JSON 快照；未配置时保持纯内存。 */
  private restorePersistedState(): void {
    if (!this.persistFile || !fs.existsSync(this.persistFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistFile, 'utf8')) as {
        workOrders?: WorkOrder[];
        staffStatus?: Array<[string, StaffMember['status']]>;
        idempotency?: Array<[string, string]>;
      };
      for (const order of raw.workOrders ?? []) {
        if (order && typeof order.id === 'string') this.workOrders.set(order.id, order);
      }
      for (const [staffId, status] of raw.staffStatus ?? []) {
        if (this.staffStatus.has(staffId)) this.staffStatus.set(staffId, status);
      }
      for (const [key, orderId] of raw.idempotency ?? []) this.idempotency.set(key, orderId);
    } catch (error) {
      // 快照损坏不应阻断启动；记录到审计并在下一次写入时覆盖。
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

  private persist(): void {
    if (!this.persistFile) return;
    try {
      fs.mkdirSync(path.dirname(this.persistFile), { recursive: true });
      const payload = JSON.stringify({
        version: 1,
        saved_at: new Date().toISOString(),
        workOrders: Array.from(this.workOrders.values()),
        staffStatus: Array.from(this.staffStatus.entries()),
        idempotency: Array.from(this.idempotency.entries()),
      }, null, 2);
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

  private currentVersion(): { observation: number; constraint: number; scenario: string } {
    return this.versionProvider?.() ?? { observation: 0, constraint: 0, scenario: this.scenario.version };
  }

  /** 刷新并返回上下文失效状态；终态工单不标记过期。 */
  private refreshStaleness(order: WorkOrder): WorkOrder {
    if (['COMPLETED', 'FAILED', 'REJECTED'].includes(order.status)) {
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
    this.persist();
  }

  getScenario(): SafetyScenario {
    return this.scenario;
  }

  listStaff(): Array<StaffMember & { runtime_status: string }> {
    return this.scenario.staff.map(member => ({
      ...member,
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
    const parsed = WorkOrderCreateSchema.parse(input);
    if (parsed.idempotency_key) {
      const existingId = this.idempotency.get(parsed.idempotency_key);
      if (existingId) {
        const existing = this.workOrders.get(existingId);
        if (existing) return this.refreshStaleness(existing);
      }
    }
    if (parsed.region_id && !this.scenario.regions.some(region => region.id === parsed.region_id)) {
      throw new Error(`unknown region: ${parsed.region_id}`);
    }
    const now = new Date().toISOString();
    const status: WorkOrderStatus = parsed.submit ? 'PENDING_APPROVAL' : 'DRAFT';
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
      stale: false,
      stale_reason: null,
      history: [{ ts: now, status, actor: actor.username, role: actor.role, note: parsed.submit ? '提交审批' : '创建草稿' }],
    };
    this.workOrders.set(order.id, order);
    if (parsed.idempotency_key) this.idempotency.set(parsed.idempotency_key, order.id);
    this.persist();
    this.audit.record({
      actor: actor.username,
      role: actor.role,
      action: 'work_order.created',
      entity_type: 'work_order',
      entity_id: order.id,
      summary: `创建工单 ${order.id}：${order.title}（${status}）`,
      result: 'success',
      after: { status, type: order.type, region_id: order.region_id },
    });
    return order;
  }

  getWorkOrder(id: string): WorkOrder | undefined {
    const order = this.workOrders.get(id);
    return order ? this.refreshStaleness(order) : undefined;
  }

  listWorkOrders(filter: { status?: WorkOrderStatus; staff_id?: string; region_id?: string } = {}): WorkOrder[] {
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
    const order = this.requireOrder(id);
    return this.transition(order, 'PENDING_APPROVAL', actor, { note: '提交审批' });
  }

  approve(id: string, actor: OpsActor, note?: string): WorkOrder {
    this.requireOperator(actor);
    const order = this.requireOrder(id);
    const now = new Date().toISOString();
    const updated = this.transition(order, 'APPROVED', actor, {
      note: note ?? '审批通过',
      patch: { approval: { decision: 'approved', by: actor.username, role: actor.role, at: now, note } },
    });
    return updated;
  }

  reject(id: string, actor: OpsActor, note: string): WorkOrder {
    this.requireOperator(actor);
    if (!note.trim()) throw new Error('拒绝工单必须填写审批意见');
    const order = this.requireOrder(id);
    const now = new Date().toISOString();
    return this.transition(order, 'REJECTED', actor, {
      note,
      patch: { approval: { decision: 'rejected', by: actor.username, role: actor.role, at: now, note } },
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
    const targetStaffId = staffId
      ?? (order.region_id
        ? this.recommendStaff({ region_id: order.region_id, required_skills: order.required_skills }).recommended?.staff_id
        : undefined);
    if (!targetStaffId) throw new WorkOrderTransitionError('没有可用工作人员，无法派发');
    const member = this.getStaff(targetStaffId);
    if (!member) throw new Error(`unknown staff: ${targetStaffId}`);
    if (member.runtime_status !== 'available') {
      throw new WorkOrderTransitionError(`工作人员 ${targetStaffId} 当前为 ${member.runtime_status}，不可派发`);
    }
    this.staffStatus.set(targetStaffId, 'busy');
    const now = new Date().toISOString();
    return this.transition(order, 'ASSIGNED', actor, {
      note: `派发给 ${member.name}（${targetStaffId}）`,
      patch: { assigned_staff_id: targetStaffId, assigned_at: now },
    });
  }

  accept(id: string, actor: OpsActor): WorkOrder {
    const order = this.requireAssignedStaff(id, actor);
    return this.transition(order, 'ACCEPTED', actor, {
      note: '工作人员接单',
      patch: { accepted_at: new Date().toISOString() },
    });
  }

  start(id: string, actor: OpsActor): WorkOrder {
    const order = this.requireAssignedStaff(id, actor);
    return this.transition(order, 'IN_PROGRESS', actor, {
      note: '开始执行',
      patch: { started_at: new Date().toISOString() },
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
    const updated = this.transition(order, 'COMPLETED', actor, {
      note: feedback.note,
      patch: {
        completed_at: now,
        feedback: { staff_id: actor.staff_id ?? actor.username, note: feedback.note, at: now, observation },
      },
    });
    this.releaseStaff(order.assigned_staff_id);
    this.onFeedback?.(updated);
    return updated;
  }

  fail(id: string, actor: OpsActor, reason: string): WorkOrder {
    const order = this.requireAssignedStaff(id, actor);
    if (!reason.trim()) throw new Error('失败工单必须说明原因');
    const updated = this.transition(order, 'FAILED', actor, {
      note: reason,
      patch: { failure_reason: reason },
    });
    this.releaseStaff(order.assigned_staff_id);
    return updated;
  }

  /** 管理员在环境变化后重新确认工单上下文（不改变当前状态）。 */
  revalidate(id: string, actor: OpsActor, note?: string): WorkOrder {
    this.requireOperator(actor);
    const order = this.requireOrder(id);
    if (['COMPLETED', 'FAILED', 'REJECTED', 'DRAFT'].includes(order.status)) {
      throw new WorkOrderTransitionError(`工单 ${order.id} 当前为 ${order.status}，无需重新确认`);
    }
    const previous = { ...order.context_version };
    order.context_version = this.currentVersion();
    this.refreshStaleness(order);
    const now = new Date().toISOString();
    order.updated_at = now;
    order.history.push({
      ts: now,
      status: order.status,
      actor: actor.username,
      role: actor.role,
      note: note ?? `重新确认上下文（${previous.observation}→${order.context_version.observation}）`,
    });
    this.audit.record({
      actor: actor.username,
      role: actor.role,
      action: 'work_order.revalidated',
      entity_type: 'work_order',
      entity_id: order.id,
      summary: `工单 ${order.id} 重新确认上下文`,
      result: 'success',
      after: { context_version: order.context_version, status: order.status },
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
