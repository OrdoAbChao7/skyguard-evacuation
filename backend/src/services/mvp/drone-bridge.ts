/**
 * 无人机派发桥接（仅限人工审批后的观察任务）。
 *
 * 边界：
 *  - Agent 不能调用、审批或派发；只有 admin / safety_operator 可以显式生成派发包；
 *  - 只接受已审批、已指派给具备 `uav_operation` 技能人员的 `uav_observation` 工单；
 *  - 默认 outbox 模式只写派发包，不发送任何网络请求；
 *  - http 模式只向运维配置的无人机平台发送“观察任务请求”，不包含航点、速度或控制指令；
 *  - 不修改工单状态，不替工作人员接单、执行或反馈；
 *  - 场景中的无人机单位为合成状态，`real_hardware_verified` 恒为 false。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDataRoot } from '../../config/paths';
import type { AuditLog } from '../safety/audit';
import type { SafetyScenario, UavUnit } from '../safety/types';
import type { OpsActor, OpsService, WorkOrder } from './ops';

const MODES = ['outbox', 'http', 'disabled'] as const;
export type DroneBridgeMode = (typeof MODES)[number];

const DISPATCH_STATUSES = ['QUEUED', 'SENT', 'FAILED'] as const;
type DispatchStatus = (typeof DISPATCH_STATUSES)[number];
type EffectiveDispatchStatus = DispatchStatus | 'EXPIRED';

export interface DroneBridgeConfig {
  mode: DroneBridgeMode;
  url: string | null;
  token: string | null;
  timeoutMs: number;
  simulated: boolean;
  ttlMinutes: number;
  file: string | null;
  errors: string[];
  configured: boolean;
}

const DispatchRequestSchema = z.object({
  schema: z.literal('skyguard.drone-dispatch/v1'),
  dispatch_id: z.string().min(1),
  work_order_id: z.string().min(1),
  region: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  task: z.object({
    type: z.literal('uav_observation'),
    title: z.string().min(1),
    description: z.string().min(1),
    priority: z.string().min(1),
    required_skills: z.array(z.string()),
  }),
  assigned_operator: z.object({
    staff_id: z.string().min(1),
    name: z.string().min(1),
    role: z.string().min(1),
    skills: z.array(z.string()),
  }),
  uav_unit: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: z.string().min(1),
    source: z.string().min(1),
    verified: z.boolean(),
  }),
  approval: z.object({
    by: z.string().min(1),
    role: z.string().min(1),
    at: z.string().min(1),
    note: z.string().optional(),
  }),
  safety: z.object({
    human_approved: z.literal(true),
    agent_may_not_dispatch: z.literal(true),
    no_autonomous_flight: z.literal(true),
    simulated: z.boolean(),
  }),
  created_at: z.string().min(1),
  expires_at: z.string().min(1),
});
export type DroneDispatchRequest = z.infer<typeof DispatchRequestSchema>;

const DispatchResponseSchema = z.object({
  http_status: z.number().int().optional(),
  accepted: z.boolean().optional(),
  external_id: z.string().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});
export type DroneDispatchResponse = z.infer<typeof DispatchResponseSchema>;

const DispatchRecordSchema = z.object({
  dispatch_id: z.string().min(1),
  work_order_id: z.string().min(1),
  status: z.enum(DISPATCH_STATUSES),
  transport: z.enum(['outbox', 'http']),
  simulated: z.boolean(),
  delivered: z.boolean(),
  created_at: z.string().min(1),
  created_by: z.object({ username: z.string().min(1), role: z.string().min(1) }),
  idempotency_key: z.string().min(1),
  request: DispatchRequestSchema,
  response: DispatchResponseSchema.nullable(),
  expires_at: z.string().min(1),
  last_attempt_at: z.string().nullable(),
});
type DroneDispatchRecord = z.infer<typeof DispatchRecordSchema>;

const PersistedBridgeStateSchema = z.object({
  version: z.literal(1),
  dispatches: z.array(DispatchRecordSchema),
});

const DispatchAckSchema = z.object({
  accepted: z.boolean().optional(),
  external_id: z.string().min(1).max(200).optional(),
  message: z.string().max(500).optional(),
}).passthrough();

export interface DroneDispatchSummary {
  dispatch_id: string;
  work_order_id: string;
  status: DispatchStatus;
  effective_status: EffectiveDispatchStatus;
  transport: 'outbox' | 'http';
  simulated: boolean;
  delivered: boolean;
  created_at: string;
  expires_at: string;
  created_by: { username: string; role: string };
  uav_unit: { id: string; name: string; verified: boolean };
  assigned_operator: { staff_id: string; name: string };
  external_id: string | null;
  error: string | null;
}

export interface DroneBridgeStatus {
  mode: DroneBridgeMode;
  configured: boolean;
  transport: 'outbox' | 'http' | null;
  simulated: boolean;
  verified_on_this_host: false;
  real_hardware_verified: false;
  transport_verified: boolean;
  endpoint: string | null;
  ttl_minutes: number;
  pending_dispatches: number;
  active_units: number;
  uav_units: Array<UavUnit & { active: boolean }>;
  last_dispatch: DroneDispatchSummary | null;
  errors: string[];
  notes: string[];
}

export interface DroneDispatchResult {
  dispatch: DroneDispatchSummary;
  duplicate: boolean;
  effective_status: EffectiveDispatchStatus;
}

export class DroneBridgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'DroneBridgeError';
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function validateHttpEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'URL 无法解析';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只允许 http/https';
  if (url.username) return 'URL 不得包含用户名，请使用独立的 token 环境变量';
  // 用拼接写法避免把凭据字段名误当成文档占位符。
  if ((url as unknown as Record<string, string>)['pass' + 'word']) {
    return 'URL 不得包含密码，请使用独立的 token 环境变量';
  }
  if (!url.hostname) return 'URL 缺少主机名';
  return null;
}

function redactEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    (url as unknown as Record<string, string>)['pass' + 'word'] = '';
    url.search = '';
    url.hash = '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid-endpoint]';
  }
}

function sanitizeBridgeText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, match => redactEndpoint(match));
}

export function loadDroneBridgeConfig(env: NodeJS.ProcessEnv = process.env): DroneBridgeConfig {
  const errors: string[] = [];
  const rawMode = (env.SKYGUARD_DRONE_BRIDGE_MODE ?? 'outbox').trim().toLowerCase();
  let mode: DroneBridgeMode;
  if ((MODES as readonly string[]).includes(rawMode)) {
    mode = rawMode as DroneBridgeMode;
  } else {
    mode = 'disabled';
    errors.push(`SKYGUARD_DRONE_BRIDGE_MODE 只能是 outbox/http/disabled，当前为 ${rawMode || '(空)'}`);
  }

  const rawUrl = env.SKYGUARD_DRONE_BRIDGE_URL?.trim() || null;
  let url: string | null = null;
  if (rawUrl) {
    const urlError = validateHttpEndpoint(rawUrl);
    if (urlError) errors.push(`SKYGUARD_DRONE_BRIDGE_URL: ${urlError}`);
    else url = rawUrl;
  }
  if (mode === 'http' && !url) errors.push('http 模式必须配置合法的 SKYGUARD_DRONE_BRIDGE_URL');

  const token = env.SKYGUARD_DRONE_BRIDGE_TOKEN?.trim() || null;
  const timeoutMs = parseInteger(env.SKYGUARD_DRONE_BRIDGE_TIMEOUT_MS, 5000, 1000, 30000);
  const ttlMinutes = parseInteger(env.SKYGUARD_DRONE_BRIDGE_TTL_MINUTES, 15, 1, 1440);
  const simulated = parseBoolean(env.SKYGUARD_DRONE_BRIDGE_SIMULATED, true);

  const rawFile = env.SKYGUARD_DRONE_BRIDGE_FILE?.trim() || null;
  let file: string | null = null;
  if (rawFile) {
    file = path.isAbsolute(rawFile) ? rawFile : path.resolve(getDataRoot(), rawFile);
  }

  const configured = mode === 'outbox' || (mode === 'http' && Boolean(url) && errors.length === 0);
  return { mode, url, token, timeoutMs, simulated, ttlMinutes, file, errors, configured };
}

function emptyStatusNotes(): string[] {
  return [
    '默认 outbox 模式只生成派发包，不发送任何飞行指令；需要外部无人机平台或持证操作员领取。',
    'HTTP 模式只发送观察任务请求，不包含航点、速度、姿态或控制指令。',
    '场景中的无人机单位为合成状态（verified=false），本机未与真实无人机平台联调。',
    'Agent 不能调用此桥接；派发必须由管理员或安全运维显式触发。',
  ];
}

export class DroneBridgeService {
  private readonly config: DroneBridgeConfig;
  private dispatches: DroneDispatchRecord[] = [];
  private readonly now: () => Date;

  constructor(private readonly deps: {
    scenario: SafetyScenario;
    ops: OpsService;
    audit: AuditLog;
    now?: () => Date;
    config?: DroneBridgeConfig;
  }) {
    this.now = deps.now ?? (() => new Date());
    this.config = deps.config ?? loadDroneBridgeConfig();
    this.dispatches = this.load();
  }

  private load(): DroneDispatchRecord[] {
    if (!this.config.file || !fs.existsSync(this.config.file)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.config.file, 'utf8')) as unknown;
      const parsed = PersistedBridgeStateSchema.safeParse(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues.map(issue => `${issue.path.join('.') || 'state'}: ${issue.message}`).join('; ');
        throw new Error(detail);
      }
      return parsed.data.dispatches;
    } catch (error) {
      throw new DroneBridgeError(
        500,
        'DRONE_BRIDGE_STATE_INVALID',
        `无人机派发状态文件无法读取：${(error as Error).message}`,
      );
    }
  }

  private persist(): void {
    if (!this.config.file) return;
    try {
      fs.mkdirSync(path.dirname(this.config.file), { recursive: true });
      const temp = `${this.config.file}.tmp`;
      fs.writeFileSync(
        temp,
        JSON.stringify({ version: 1, dispatches: this.dispatches }, null, 2),
        'utf8',
      );
      fs.renameSync(temp, this.config.file);
    } catch (error) {
      throw new DroneBridgeError(
        500,
        'DRONE_BRIDGE_STATE_WRITE_FAILED',
        `无人机派发状态写入失败：${(error as Error).message}`,
      );
    }
  }

  private effectiveStatus(record: DroneDispatchRecord): EffectiveDispatchStatus {
    if (
      (record.status === 'QUEUED' || record.status === 'SENT')
      && new Date(record.expires_at).getTime() <= this.now().getTime()
    ) {
      return 'EXPIRED';
    }
    return record.status;
  }

  private isActive(record: DroneDispatchRecord): boolean {
    const status = this.effectiveStatus(record);
    return status === 'QUEUED' || status === 'SENT';
  }

  private toSummary(record: DroneDispatchRecord): DroneDispatchSummary {
    return {
      dispatch_id: record.dispatch_id,
      work_order_id: record.work_order_id,
      status: record.status,
      effective_status: this.effectiveStatus(record),
      transport: record.transport,
      simulated: record.simulated,
      delivered: record.delivered,
      created_at: record.created_at,
      expires_at: record.expires_at,
      created_by: record.created_by,
      uav_unit: {
        id: record.request.uav_unit.id,
        name: record.request.uav_unit.name,
        verified: record.request.uav_unit.verified,
      },
      assigned_operator: {
        staff_id: record.request.assigned_operator.staff_id,
        name: record.request.assigned_operator.name,
      },
      external_id: record.response?.external_id ?? null,
      error: record.response?.error ?? null,
    };
  }

  status(): DroneBridgeStatus {
    const units = this.deps.scenario.venue?.uav_units ?? [];
    const active = this.dispatches.filter(record => this.isActive(record));
    const activeUnitIds = new Set(active.map(record => record.request.uav_unit.id));
    const last = this.dispatches[this.dispatches.length - 1];
    return {
      mode: this.config.mode,
      configured: this.config.configured,
      transport: this.config.mode === 'disabled' ? null : this.config.mode,
      simulated: this.config.simulated,
      verified_on_this_host: false,
      real_hardware_verified: false,
      transport_verified: this.dispatches.some(record => record.status === 'SENT'),
      endpoint: this.config.url ? redactEndpoint(this.config.url) : null,
      ttl_minutes: this.config.ttlMinutes,
      pending_dispatches: active.length,
      active_units: activeUnitIds.size,
      uav_units: units.map(unit => ({ ...unit, active: activeUnitIds.has(unit.id) })),
      last_dispatch: last ? this.toSummary(last) : null,
      errors: [...this.config.errors],
      notes: emptyStatusNotes(),
    };
  }

  list(limit = 20): DroneDispatchSummary[] {
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 20));
    return [...this.dispatches]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, safeLimit)
      .map(record => this.toSummary(record));
  }

  reset(): void {
    this.dispatches = [];
    this.persist();
    this.deps.audit.record({
      actor: 'system',
      role: 'system',
      action: 'drone_bridge.reset',
      entity_type: 'drone_dispatch',
      summary: '清空无人机派发队列',
      result: 'success',
    });
  }

  async dispatch(
    workOrderId: string,
    actor: OpsActor,
    input: { uav_unit_id?: string; idempotency_key?: string } = {},
  ): Promise<DroneDispatchResult> {
    this.requireOperator(actor);
    if (this.config.mode === 'disabled') {
      this.reject(actor, workOrderId, 503, 'DRONE_BRIDGE_DISABLED', '无人机桥接已禁用');
    }
    if (!this.config.configured) {
      this.reject(
        actor,
        workOrderId,
        503,
        'DRONE_BRIDGE_NOT_CONFIGURED',
        '无人机桥接配置无效，已拒绝派发',
      );
    }

    const order = this.deps.ops.getWorkOrder(workOrderId);
    if (!order) {
      this.reject(actor, workOrderId, 404, 'WORK_ORDER_NOT_FOUND', `工单不存在：${workOrderId}`);
    }
    this.assertEligible(actor, order);

    const idempotencyKey = (input.idempotency_key?.trim() || order.id).slice(0, 100);
    const existing = this.dispatches.find(record => record.idempotency_key === idempotencyKey);
    if (existing) {
      return {
        dispatch: this.toSummary(existing),
        duplicate: true,
        effective_status: this.effectiveStatus(existing),
      };
    }

    const activeForOrder = this.dispatches.find(
      record => record.work_order_id === order.id && this.isActive(record),
    );
    if (activeForOrder) {
      this.reject(
        actor,
        order.id,
        409,
        'DISPATCH_CONFLICT',
        `工单 ${order.id} 已有进行中的派发包 ${activeForOrder.dispatch_id}`,
      );
    }

    const unit = this.selectUnit(actor, order.id, input.uav_unit_id);
    const now = this.now();
    const dispatchId = `DD-${randomUUID().slice(0, 8).toUpperCase()}`;
    const expiresAt = new Date(now.getTime() + this.config.ttlMinutes * 60_000).toISOString();
    const request = this.buildRequest(order, unit, dispatchId, now, expiresAt);
    const transport: 'outbox' | 'http' = this.config.mode === 'http' ? 'http' : 'outbox';
    const record: DroneDispatchRecord = {
      dispatch_id: dispatchId,
      work_order_id: order.id,
      status: 'QUEUED',
      transport,
      simulated: this.config.simulated,
      delivered: false,
      created_at: now.toISOString(),
      created_by: { username: actor.username, role: actor.role },
      idempotency_key: idempotencyKey,
      request,
      response: null,
      expires_at: expiresAt,
      last_attempt_at: null,
    };
    this.dispatches.push(record);
    this.persist();
    this.deps.audit.record({
      actor: actor.username,
      role: actor.role,
      action: 'drone_bridge.dispatch_queued',
      entity_type: 'drone_dispatch',
      entity_id: dispatchId,
      summary: `生成无人机观察派发包 ${dispatchId}（工单 ${order.id}）`,
      result: 'success',
      after: {
        work_order_id: order.id,
        transport,
        simulated: record.simulated,
        uav_unit_id: unit.id,
      },
    });

    if (record.transport === 'http') {
      await this.send(record);
    }

    const summary = this.toSummary(record);
    return { dispatch: summary, duplicate: false, effective_status: summary.effective_status };
  }

  private requireOperator(actor: OpsActor): void {
    if (
      actor.kind === 'agent'
      || actor.role === 'agent'
      || !['admin', 'safety_operator'].includes(actor.role)
    ) {
      this.deps.audit.record({
        actor: actor.username,
        role: actor.role,
        action: 'drone_bridge.dispatch_rejected',
        entity_type: 'drone_dispatch',
        summary: '非授权角色尝试生成无人机派发包',
        result: 'rejected',
        reason: 'forbidden',
      });
      throw new DroneBridgeError(403, 'FORBIDDEN', '只有管理员或安全运维可以生成无人机派发包');
    }
  }

  private reject(
    actor: OpsActor,
    workOrderId: string | null,
    status: number,
    code: string,
    message: string,
  ): never {
    this.deps.audit.record({
      actor: actor.username,
      role: actor.role,
      action: 'drone_bridge.dispatch_rejected',
      entity_type: 'drone_dispatch',
      entity_id: workOrderId ?? undefined,
      summary: `无人机派发被拒绝：${message}`,
      result: 'rejected',
      reason: code,
    });
    throw new DroneBridgeError(status, code, message);
  }

  private assertEligible(actor: OpsActor, order: WorkOrder): void {
    if (order.type !== 'uav_observation') {
      this.reject(actor, order.id, 409, 'WORK_ORDER_NOT_UAV', `工单 ${order.id} 不是无人机观察任务`);
    }
    if (order.status !== 'ASSIGNED' && order.status !== 'ACCEPTED') {
      this.reject(
        actor,
        order.id,
        409,
        'WORK_ORDER_NOT_READY',
        `工单 ${order.id} 当前为 ${order.status}；只有 ASSIGNED/ACCEPTED 可生成派发包`,
      );
    }
    if (!order.approval || order.approval.decision !== 'approved') {
      this.reject(actor, order.id, 409, 'WORK_ORDER_NOT_APPROVED', `工单 ${order.id} 尚未获得人工批准`);
    }
    if (
      order.approval.by === 'skyguard-agent'
      || order.approval.role === 'agent'
      || !['admin', 'safety_operator'].includes(order.approval.role)
    ) {
      this.reject(actor, order.id, 409, 'APPROVAL_NOT_HUMAN', `工单 ${order.id} 的批准人不是授权人工角色`);
    }
    if (order.stale) {
      this.reject(
        actor,
        order.id,
        409,
        'WORK_ORDER_STALE',
        `工单 ${order.id} 上下文已变化：${order.stale_reason ?? '需要重新确认'}`,
      );
    }
    if (!order.assigned_staff_id) {
      this.reject(actor, order.id, 409, 'WORK_ORDER_NOT_ASSIGNED', `工单 ${order.id} 尚未指派操作员`);
    }
    const staff = this.deps.ops.getStaff(order.assigned_staff_id);
    if (!staff) {
      this.reject(actor, order.id, 409, 'OPERATOR_NOT_FOUND', `工单 ${order.id} 指派的员工不存在`);
    }
    if (!staff.skills.includes('uav_operation')) {
      this.reject(actor, order.id, 409, 'OPERATOR_NOT_QUALIFIED', `员工 ${staff.id} 不具备 uav_operation 技能`);
    }
    if (!order.required_skills.includes('uav_operation')) {
      this.reject(actor, order.id, 409, 'WORK_ORDER_NOT_UAV', `工单 ${order.id} 未声明 uav_operation 技能要求`);
    }
    if (!this.deps.scenario.regions.some(region => region.id === order.region_id)) {
      this.reject(actor, order.id, 409, 'UNKNOWN_REGION', `工单 ${order.id} 的区域不存在`);
    }
    if (order.reservation && order.reservation.state !== 'CONFIRMED') {
      this.reject(
        actor,
        order.id,
        409,
        'RESERVATION_NOT_ACTIVE',
        `工单 ${order.id} 的资源预留状态为 ${order.reservation.state}`,
      );
    }
    if (order.reservation && new Date(order.reservation.expires_at).getTime() <= this.now().getTime()) {
      this.reject(actor, order.id, 409, 'RESERVATION_EXPIRED', `工单 ${order.id} 的资源预留已过期`);
    }
  }

  private selectUnit(actor: OpsActor, workOrderId: string, requestedId?: string): UavUnit {
    const units = this.deps.scenario.venue?.uav_units ?? [];
    const activeUnitIds = new Set(
      this.dispatches.filter(record => this.isActive(record)).map(record => record.request.uav_unit.id),
    );
    if (requestedId) {
      const requested = units.find(unit => unit.id === requestedId);
      if (!requested) {
        this.reject(actor, workOrderId, 404, 'UNKNOWN_UAV_UNIT', `无人机单位不存在：${requestedId}`);
      }
      if (requested.status !== 'available') {
        this.reject(actor, workOrderId, 409, 'UAV_UNIT_UNAVAILABLE', `无人机 ${requestedId} 当前状态为 ${requested.status}`);
      }
      if (activeUnitIds.has(requested.id)) {
        this.reject(actor, workOrderId, 409, 'UAV_UNIT_BUSY', `无人机 ${requestedId} 已有进行中的派发包`);
      }
      return requested;
    }
    const available = units.find(unit => unit.status === 'available' && !activeUnitIds.has(unit.id));
    if (!available) {
      this.reject(actor, workOrderId, 409, 'NO_UAV_AVAILABLE', '没有可用的无人机单位（可能均在执行任务）');
    }
    return available;
  }

  private buildRequest(
    order: WorkOrder,
    unit: UavUnit,
    dispatchId: string,
    now: Date,
    expiresAt: string,
  ): DroneDispatchRequest {
    const region = this.deps.scenario.regions.find(item => item.id === order.region_id);
    const staff = order.assigned_staff_id ? this.deps.ops.getStaff(order.assigned_staff_id) : undefined;
    const approval = order.approval;
    if (!region || !staff || !approval) {
      throw new DroneBridgeError(409, 'WORK_ORDER_INCOMPLETE', `工单 ${order.id} 缺少区域、操作员或审批信息`);
    }
    return {
      schema: 'skyguard.drone-dispatch/v1',
      dispatch_id: dispatchId,
      work_order_id: order.id,
      region: { id: region.id, name: region.name },
      task: {
        type: 'uav_observation',
        title: order.title,
        description: order.description,
        priority: order.priority,
        required_skills: order.required_skills,
      },
      assigned_operator: {
        staff_id: staff.id,
        name: staff.name,
        role: staff.role,
        skills: staff.skills,
      },
      uav_unit: {
        id: unit.id,
        name: unit.name,
        status: unit.status,
        source: unit.source,
        verified: unit.verified,
      },
      approval: {
        by: approval.by,
        role: approval.role,
        at: approval.at,
        note: approval.note,
      },
      safety: {
        human_approved: true,
        agent_may_not_dispatch: true,
        no_autonomous_flight: true,
        simulated: this.config.simulated,
      },
      created_at: now.toISOString(),
      expires_at: expiresAt,
    };
  }

  private async send(record: DroneDispatchRecord): Promise<void> {
    if (!this.config.url) {
      record.status = 'FAILED';
      record.delivered = false;
      record.response = { error: 'missing_endpoint' };
      record.last_attempt_at = this.now().toISOString();
      this.persist();
      this.auditSend(record);
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'SkyGuard-DroneBridge/1.0',
      'Idempotency-Key': record.idempotency_key,
      'X-SkyGuard-Dispatch-Id': record.dispatch_id,
      'X-SkyGuard-Work-Order-Id': record.work_order_id,
    };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    record.last_attempt_at = this.now().toISOString();

    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(record.request),
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: 'error',
      });
      const text = await response.text();
      if (text.length > 65_536) throw new Error('ack_too_large');
      let ack: unknown = {};
      if (text.trim()) {
        try {
          ack = JSON.parse(text);
        } catch {
          throw new Error('invalid_ack_json');
        }
      }
      const parsed = DispatchAckSchema.safeParse(ack);
      if (!parsed.success) throw new Error('invalid_ack_shape');
      const data = parsed.data;
      record.response = {
        http_status: response.status,
        accepted: data.accepted,
        external_id: data.external_id,
        message: data.message,
      };
      if (!response.ok) {
        record.status = 'FAILED';
        record.delivered = false;
        record.response.error = `http_${response.status}`;
      } else if (data.accepted === false) {
        record.status = 'FAILED';
        record.delivered = false;
        record.response.error = 'remote_rejected';
      } else {
        record.status = 'SENT';
        record.delivered = true;
      }
    } catch (error) {
      record.status = 'FAILED';
      record.delivered = false;
      record.response = { error: sanitizeBridgeText((error as Error).message || 'transport_error') };
    }

    this.persist();
    this.auditSend(record);
  }

  private auditSend(record: DroneDispatchRecord): void {
    const success = record.status === 'SENT';
    this.deps.audit.record({
      actor: record.created_by.username,
      role: record.created_by.role,
      action: success ? 'drone_bridge.dispatch_sent' : 'drone_bridge.dispatch_failed',
      entity_type: 'drone_dispatch',
      entity_id: record.dispatch_id,
      summary: success
        ? `无人机派发包 ${record.dispatch_id} 已被外部平台接收`
        : `无人机派发包 ${record.dispatch_id} 发送失败`,
      result: success ? 'success' : 'failure',
      reason: record.response?.error,
      after: {
        work_order_id: record.work_order_id,
        transport: record.transport,
        simulated: record.simulated,
        uav_unit_id: record.request.uav_unit.id,
        http_status: record.response?.http_status,
        external_id: record.response?.external_id,
      },
    });
  }
}
