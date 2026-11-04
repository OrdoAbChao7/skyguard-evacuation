/**
 * 四态安全状态机（NORMAL / REROUTE / DEGRADED / REJECT）。
 *
 * 该模块是纯函数：只根据「事实」推导状态，不持有状态、不调用外部服务，
 * 便于单测覆盖每一条进入/退出条件。
 *
 * 状态优先级：DEGRADED > REJECT > REROUTE > NORMAL
 *  - 感知不可信时，任何"可行/不可行"的判断本身都不可信，因此最先降级；
 *  - 硬约束被违反时一律拒绝发布；
 *  - 存在已确认事件但已有通过校验的替代方案时为 REROUTE；
 *  - 其余为 NORMAL。
 */
import type {
  EvacuationPlan,
  SafetyState,
  SafetyValidationResult,
} from './types';

export interface SafetyStateReason {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface SafetyStateInput {
  /** 是否至少存在一条观测（任何区域）。 */
  hasObservations: boolean;
  /** 推理服务/感知链路是否健康。 */
  inferenceHealthy: boolean;
  inferenceFailureReason?: string;
  /** 观测不可信的区域及原因。 */
  untrustedRegions: Array<{ regionId: string; reasons: string[] }>;
  /** 已确认且会影响约束的事件数量。 */
  activeIncidentIds: string[];
  plan?: EvacuationPlan;
  validation?: SafetyValidationResult;
  /** 方案版本是否已落后于当前约束/观测版本。 */
  planInvalidated: boolean;
  lastValidObservationAt: string | null;
  now?: Date;
}

export interface SafetyStateSnapshot {
  state: SafetyState;
  headline: string;
  reasons: SafetyStateReason[];
  /** 是否允许把方案作为"已验证安全方案"发布到大屏。 */
  publishable: boolean;
  /** 是否允许显示绿色已验证路线。 */
  validated_route_display_allowed: boolean;
  /** 是否允许显示"候选方案"（明确标记未通过校验）。 */
  candidate_route_display_allowed: boolean;
  /** 是否需要人工介入。 */
  requires_operator_action: boolean;
  last_valid_observation_at: string | null;
  active_incident_ids: string[];
  decided_at: string;
}

/**
 * 这些违规表示"方案基于的输入已不是最新"，本身不足以断定物理上不可行，
 * 因此不进入 REJECT，而是要求重新规划（REROUTE）。
 */
const STALE_CODES = new Set([
  'stale_scenario',
  'stale_constraints',
  'stale_observations',
  'version_changed_during_planning',
]);

export function decideSafetyState(input: SafetyStateInput): SafetyStateSnapshot {
  const now = input.now ?? new Date();
  const reasons: SafetyStateReason[] = [];

  const base = {
    last_valid_observation_at: input.lastValidObservationAt,
    active_incident_ids: input.activeIncidentIds,
    decided_at: now.toISOString(),
  };

  // ---------- 1. DEGRADED：感知不可信 ----------
  const degradedReasons: SafetyStateReason[] = [];
  if (!input.inferenceHealthy) {
    degradedReasons.push({
      code: 'inference_unhealthy',
      message: `感知/推理服务异常：${input.inferenceFailureReason ?? '未知原因'}`,
      severity: 'critical',
    });
  }
  if (!input.hasObservations) {
    degradedReasons.push({
      code: 'no_observations',
      message: '系统尚未收到任何人群观测，无法建立当前态势',
      severity: 'critical',
    });
  }
  for (const region of input.untrustedRegions) {
    degradedReasons.push({
      code: 'untrusted_observation',
      message: `区域 ${region.regionId} 观测不可信：${region.reasons.join(', ')}`,
      severity: 'critical',
    });
  }

  if (degradedReasons.length > 0) {
    return {
      ...base,
      state: 'DEGRADED',
      headline: '感知降级 · 不得基于不可信数据发布新路线',
      reasons: degradedReasons,
      publishable: false,
      validated_route_display_allowed: false,
      // 降级时允许显示"最后一次通过校验的方案"，但必须标注为历史而非当前。
      candidate_route_display_allowed: false,
      requires_operator_action: true,
    };
  }

  // ---------- 2. REJECT：硬约束不满足 ----------
  const violations = input.validation?.violations ?? [];
  const hardViolations = violations.filter(violation => violation.severity === 'hard');
  const nonStaleHard = hardViolations.filter(violation => !STALE_CODES.has(violation.code));

  if (!input.plan) {
    reasons.push({
      code: 'no_plan',
      message: '当前没有任何疏散方案',
      severity: 'critical',
    });
    return {
      ...base,
      state: 'DEGRADED',
      headline: '无可用方案 · 等待首次规划',
      reasons,
      publishable: false,
      validated_route_display_allowed: false,
      candidate_route_display_allowed: false,
      requires_operator_action: true,
    };
  }

  if (nonStaleHard.length > 0) {
    return {
      ...base,
      state: 'REJECT',
      headline: '安全拒绝 · 不存在满足全部硬约束的方案',
      reasons: nonStaleHard.map(violation => ({
        code: violation.code,
        message: violation.message,
        severity: 'critical' as const,
      })),
      publishable: false,
      validated_route_display_allowed: false,
      // 允许展示"部分分配候选方案"，但必须明确标记为未通过校验。
      candidate_route_display_allowed: true,
      requires_operator_action: true,
    };
  }

  // 仅剩版本失效：方案本身可能是好的，但已不反映当前约束 → 必须重规划
  if (input.planInvalidated || hardViolations.length > 0) {
    return {
      ...base,
      state: 'REROUTE',
      headline: '方案已失效 · 需要重新规划',
      reasons: [
        {
          code: 'plan_invalidated',
          message: '场景/观测版本已变化，既有方案不得继续作为当前方案使用',
          severity: 'warning',
        },
        ...hardViolations.map(violation => ({
          code: violation.code,
          message: violation.message,
          severity: 'warning' as const,
        })),
      ],
      publishable: false,
      validated_route_display_allowed: false,
      candidate_route_display_allowed: true,
      requires_operator_action: true,
    };
  }

  // ---------- 3. REROUTE：存在已确认事件，但已有通过校验的替代方案 ----------
  if (input.activeIncidentIds.length > 0) {
    return {
      ...base,
      state: 'REROUTE',
      headline: '事件响应中 · 已重新规划并通过独立校验',
      reasons: [
        {
          code: 'active_incident',
          message: `存在 ${input.activeIncidentIds.length} 起已确认事件：${input.activeIncidentIds.join(', ')}`,
          severity: 'warning',
        },
      ],
      publishable: true,
      validated_route_display_allowed: true,
      candidate_route_display_allowed: false,
      requires_operator_action: false,
    };
  }

  // ---------- 4. NORMAL ----------
  return {
    ...base,
    state: 'NORMAL',
    headline: '常态运行 · 方案已通过独立校验',
    reasons: [
      { code: 'validated_plan', message: '当前方案通过独立安全校验', severity: 'info' },
    ],
    publishable: true,
    validated_route_display_allowed: true,
    candidate_route_display_allowed: false,
    requires_operator_action: false,
  };
}
