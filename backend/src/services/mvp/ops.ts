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
import type { SafetyScenario, StaffMember } from '../safety/types';
import type { AuditLog } from '../safety/audit';
import {
  ALLOWED_TRANSITIONS,
  IdempotencyConflictError,
  ResourceUnavailableError,
  TERMINAL_STATUSES,
  WorkOrderCreateSchema,
  WorkOrderTransitionError,
  requestFingerprint,
  type OpsActor,
  type OpsPersistedState,
  type RecommendStaffResult,
  type ReservationPreview,
  type ResourceReservation,
  type WorkOrder,
  type WorkOrderCreateInput,
  type WorkOrderStatus,
} from './ops/model';
import {
  authenticateStaff as authenticateStaffMember,
  getStaff as findStaff,
  listStaff as listStaffMembers,
  recommendStaff as recommendStaffForRegion,
} from './ops/staff';
import {
  budgetSnapshot as calcBudgetSnapshot,
  buildReservation as createReservation,
  previewReservation as previewReservationResult,
  releaseReservation as releaseOrderReservation,
  sweepExpiredReservations as sweepReservations,
  type ReservationContext,
} from './ops/reservations';

export * from './ops/model';


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

  private reservationContext(): ReservationContext {
    return {
      scenario: this.scenario,
      workOrders: this.workOrders,
      staffStatus: this.staffStatus,
      budgetSettled: this.budgetSettled,
      audit: this.audit,
      currentVersion: () => this.currentVersion(),
      persist: () => this.persist(),
      getStaff: staffId => this.getStaff(staffId),
      recommendStaff: input => this.recommendStaff(input),
    };
  }

  private sweepExpiredReservations(now?: Date): void {
    sweepReservations(this.reservationContext(), now);
  }

  private releaseReservation(
    order: WorkOrder,
    state: 'RELEASED' | 'EXPIRED',
    reason: string,
    settleBudget = false,
  ): boolean {
    return releaseOrderReservation(this.reservationContext(), order, state, reason, settleBudget);
  }

  private buildReservation(
    input: WorkOrderCreateInput,
    staffId: string | null,
  ): ResourceReservation {
    return createReservation(this.reservationContext(), input, staffId);
  }

  /** 候选工单的资源与预算预检；不产生任何预留。 */
  previewReservation(input: WorkOrderCreateInput): ReservationPreview {
    return previewReservationResult(this.reservationContext(), input);
  }

  getBudgetStatus(): ReservationPreview['budget'] {
    const ctx = this.reservationContext();
    sweepReservations(ctx);
    return calcBudgetSnapshot(this.scenario, this.workOrders, this.budgetSettled);
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

  listStaff(): Array<StaffMember & { runtime_status: string }> {
    return listStaffMembers(this.scenario, this.staffStatus);
  }

  getStaff(staffId: string): (StaffMember & { runtime_status: string }) | undefined {
    return findStaff(this.scenario, this.staffStatus, staffId);
  }

  /** 演示用身份校验：真实部署必须替换为正式身份系统。 */
  authenticateStaff(staffId: string, accessCode: string): StaffMember | null {
    return authenticateStaffMember(this.scenario, staffId, accessCode);
  }

  recommendStaff(input: {
    region_id: string;
    required_skills?: string[];
    preferred_roles?: string[];
  }): RecommendStaffResult {
    return recommendStaffForRegion(this.scenario, this.staffStatus, input);
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
        if (existingRecord.fingerprint && existingRecord.fingerprint !== fingerprint) {
          throw new IdempotencyConflictError(
            `幂等键 ${parsed.idempotency_key} 已用于不同的请求参数；拒绝复用`,
          );
        }
        const existing = this.workOrders.get(existingRecord.orderId);
        if (existing) return this.refreshStaleness(existing);
      }
    }
    if (parsed.region_id && !this.scenario.regions.some(region => region.id === parsed.region_id)) {
      throw new Error(`unknown region: ${parsed.region_id}`);
    }

    // 创建前预检：预算 + 人员；不通过则不建立任何副作用。
    const preview = this.previewReservation(parsed);
    if (!preview.eligible) {
      throw new ResourceUnavailableError(preview.reason ?? '资源或预算不足，无法创建工单');
    }

    const now = new Date().toISOString();
    const status: WorkOrderStatus = parsed.submit ? 'PENDING_APPROVAL' : 'DRAFT';
    const reservation = this.buildReservation(parsed, preview.staff_id);
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
      // 改派到其他人时，先释放原预留人员；再检查目标人员可用性。
      if (reservation?.staff_id && reservation.staff_id !== targetStaffId) {
        const previous = this.staffStatus.get(reservation.staff_id);
        if (previous === 'reserved') this.staffStatus.set(reservation.staff_id, 'available');
      }
      const reservedByThisOrder = reservation?.staff_id === targetStaffId
        && this.staffStatus.get(targetStaffId) === 'reserved';
      if (member.runtime_status !== 'available' && !reservedByThisOrder) {
        throw new WorkOrderTransitionError(`工作人员 ${targetStaffId} 当前为 ${member.runtime_status}，不可派发`);
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
      this.releaseReservation(order, 'RELEASED', `failed:${reason}`);
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
