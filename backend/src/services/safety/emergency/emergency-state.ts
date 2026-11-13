/**
 * V7.5 紧急覆盖状态机（研究模块）。
 *
 * NORMAL → RISK_WARNING → EMERGENCY_OVERRIDE → RECOVERY → NORMAL
 *
 * 约束：
 *  - 紧急状态立即失效既有路线承诺；恢复前不得重新承诺；
 *  - 只有独立校验通过的方案才可发布；过期/冲突观测一律不可发布；
 *  - 状态机只管理承诺与发布门禁，不替代四态决策、独立校验或人工审批。
 */

export type EmergencyState = 'NORMAL' | 'RISK_WARNING' | 'EMERGENCY_OVERRIDE' | 'RECOVERY';

export interface EmergencyConfig {
  /** 进入 RISK_WARNING 的风险比。 */
  warningRisk: number;
  /** 直接进入 EMERGENCY_OVERRIDE 的风险比。 */
  emergencyRisk: number;
  /** 连续多少 tick 达到 warningRisk 才进入警告。 */
  warningPersistence: number;
  /** 连续多少 tick 低于 recoveryRisk 才尝试恢复。 */
  recoveryPersistence: number;
  /** 恢复目标风险比。 */
  recoveryRisk: number;
  /** 迟滞：退出警告/恢复需要低于阈值多少。 */
  hysteresis: number;
  /** 紧急状态最短驻留 tick 数。 */
  minEmergencyTicks: number;
}

export const DEFAULT_EMERGENCY_CONFIG: EmergencyConfig = {
  warningRisk: 1,
  emergencyRisk: 1.3,
  warningPersistence: 2,
  recoveryPersistence: 3,
  recoveryRisk: 0.9,
  hysteresis: 0.1,
  minEmergencyTicks: 2,
};

export interface EmergencyInput {
  tick: number;
  riskRatio: number;
  unusableExit?: boolean;
  capacityViolation?: boolean;
  confirmedIncident?: boolean;
  observationsValid?: boolean;
  sensorConflict?: boolean;
  stale?: boolean;
  /** 当前候选方案是否通过独立校验。 */
  planValidated?: boolean;
  activeWorkOrders?: number;
}

export interface EmergencyEvent {
  tick: number;
  from: EmergencyState;
  to: EmergencyState;
  reason: string;
  risk: number;
  invalidateCommitments: boolean;
  releaseCommitments: boolean;
  publishable: boolean;
  activeWorkOrders: number;
}

export interface EmergencyOutcome {
  state: EmergencyState;
  event: EmergencyEvent | null;
  /** 是否允许发布新方案（仍需独立校验与人工审批）。 */
  publishable: boolean;
  /** 是否必须失效承诺。 */
  invalidateCommitments: boolean;
  /** 是否允许重新建立承诺（只有 NORMAL）。 */
  mayCommit: boolean;
  reason: string;
}

export class EmergencyStateMachine {
  private state: EmergencyState = 'NORMAL';
  private warningTicks = 0;
  private recoveryTicks = 0;
  private emergencyTicks = 0;
  private readonly events: EmergencyEvent[] = [];
  private readonly config: EmergencyConfig;

  constructor(configInput: Partial<EmergencyConfig> = {}) {
    this.config = { ...DEFAULT_EMERGENCY_CONFIG, ...configInput };
  }

  get current(): EmergencyState {
    return this.state;
  }

  get auditEvents(): EmergencyEvent[] {
    return this.events.map(event => ({ ...event }));
  }

  reset(): void {
    this.state = 'NORMAL';
    this.warningTicks = 0;
    this.recoveryTicks = 0;
    this.emergencyTicks = 0;
    this.events.length = 0;
  }

  evaluate(input: EmergencyInput): EmergencyOutcome {
    const risk = Number.isFinite(input.riskRatio) ? Math.max(0, input.riskRatio) : Number.POSITIVE_INFINITY;
    const tick = Number.isFinite(input.tick) ? input.tick : 0;
    const observationsValid = input.observationsValid !== false && input.sensorConflict !== true && input.stale !== true;
    const hardTrigger = Boolean(input.unusableExit || input.capacityViolation || input.confirmedIncident)
      || risk >= this.config.emergencyRisk;
    const publishable = observationsValid && input.planValidated !== false;
    const previous = this.state;
    let next = previous;
    let reason = 'hold';
    let invalidate = false;
    let release = false;

    if (hardTrigger) {
      this.warningTicks = 0;
      this.recoveryTicks = 0;
      if (previous !== 'EMERGENCY_OVERRIDE') {
        next = 'EMERGENCY_OVERRIDE';
        reason = input.confirmedIncident
          ? 'confirmed_incident'
          : input.unusableExit
            ? 'exit_unusable'
            : input.capacityViolation
              ? 'capacity_violation'
              : 'risk_above_emergency_threshold';
        invalidate = true;
        release = true;
      } else {
        reason = 'emergency_hold';
      }
      this.emergencyTicks += 1;
    } else {
      switch (previous) {
        case 'NORMAL': {
          if (risk >= this.config.warningRisk) {
            this.warningTicks += 1;
          } else {
            this.warningTicks = 0;
          }
          if (this.warningTicks >= this.config.warningPersistence) {
            next = 'RISK_WARNING';
            reason = 'risk_warning_persisted';
            this.warningTicks = 0;
          }
          break;
        }
        case 'RISK_WARNING': {
          if (risk < this.config.warningRisk - this.config.hysteresis) {
            this.warningTicks += 1;
          } else {
            this.warningTicks = 0;
          }
          if (this.warningTicks >= this.config.warningPersistence) {
            next = 'NORMAL';
            reason = 'warning_cleared';
            this.warningTicks = 0;
          }
          break;
        }
        case 'EMERGENCY_OVERRIDE': {
          this.emergencyTicks += 1;
          if (this.emergencyTicks < this.config.minEmergencyTicks) {
            reason = 'min_emergency_dwell';
            break;
          }
          if (risk < this.config.recoveryRisk) {
            this.recoveryTicks += 1;
          } else {
            this.recoveryTicks = 0;
          }
          if (this.recoveryTicks >= this.config.recoveryPersistence) {
            next = 'RECOVERY';
            reason = 'recovery_started';
            this.recoveryTicks = 0;
          }
          break;
        }
        case 'RECOVERY': {
          const recovered = observationsValid
            && input.planValidated === true
            && risk < this.config.recoveryRisk - this.config.hysteresis;
          if (recovered) {
            this.recoveryTicks += 1;
          } else {
            this.recoveryTicks = 0;
          }
          if (this.recoveryTicks >= this.config.recoveryPersistence) {
            next = 'NORMAL';
            reason = 'recovery_validated';
            this.recoveryTicks = 0;
            this.emergencyTicks = 0;
          }
          break;
        }
      }
    }

    if (next !== previous) {
      const event: EmergencyEvent = {
        tick,
        from: previous,
        to: next,
        reason,
        risk: Number.isFinite(risk) ? Number(risk.toFixed(4)) : 999,
        invalidateCommitments: invalidate || next === 'EMERGENCY_OVERRIDE',
        releaseCommitments: release,
        publishable,
        activeWorkOrders: Math.max(0, input.activeWorkOrders ?? 0),
      };
      this.events.push(event);
      this.state = next;
      return {
        state: next,
        event,
        publishable,
        invalidateCommitments: event.invalidateCommitments,
        mayCommit: next === 'NORMAL',
        reason,
      };
    }

    return {
      state: this.state,
      event: null,
      publishable,
      invalidateCommitments: this.state === 'EMERGENCY_OVERRIDE' || this.state === 'RECOVERY',
      mayCommit: this.state === 'NORMAL',
      reason: this.state === 'EMERGENCY_OVERRIDE' ? 'emergency_hold' : reason,
    };
  }
}

/**
 * 状态机自检：用于测试/审计的确定性序列回放。
 * 返回每个 tick 的状态与发布/承诺权限。
 */
export function replayEmergencySequence(
  inputs: EmergencyInput[],
  config: Partial<EmergencyConfig> = {},
): Array<EmergencyOutcome & { tick: number }> {
  const machine = new EmergencyStateMachine(config);
  return inputs.map(input => ({ ...machine.evaluate(input), tick: input.tick }));
}
