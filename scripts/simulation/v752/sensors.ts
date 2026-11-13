/**
 * Sensor boundary for V7.5.2.
 *
 * `SensorStream.observe` is the only function that reads `SensorTruth`.
 * Strategies and the dynamic safety validator receive `ObservedSnapshot` only.
 * The stream consumes a fixed number of random draws per region per tick so
 * every strategy sees the same external disturbance under a given seed
 * (common random numbers).
 */
import type {
  ObservedRegionState,
  ObservedSnapshot,
  SensorProfile,
  SimScenario,
} from './types';

export type NetworkStatus = 'open' | 'closed' | 'unknown';

export interface SensorTruth {
  minute: number;
  regionOccupancy(regionId: string): number;
  corridorStatus(corridorId: string): NetworkStatus;
  exitStatus(exitId: string): NetworkStatus;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isDegraded(profile: SensorProfile, regionId: string, minute: number): boolean {
  if (profile.mode !== 'degraded') return false;
  if (minute + 1e-9 < profile.degradation_start_minute) return false;
  if (profile.recovery_minute !== null && minute >= profile.recovery_minute) return false;
  return profile.degraded_region_prefixes.some(prefix => regionId.startsWith(prefix));
}

export class SensorStream {
  private readonly rng: () => number;
  private readonly regionIds: string[];
  private readonly regionCountHistory = new Map<string, number[]>();
  private readonly corridorHistory = new Map<string, NetworkStatus[]>();
  private readonly exitHistory = new Map<string, NetworkStatus[]>();
  private readonly profile: SensorProfile;
  private readonly dtMinutes: number;

  constructor(scenario: SimScenario, seed: number, dtMinutes: number) {
    this.rng = mulberry32((seed * 2654435761) ^ 0x9e3779b9);
    this.regionIds = scenario.regions.map(region => region.id).sort();
    this.profile = scenario.sensorProfile;
    this.dtMinutes = dtMinutes;
    for (const regionId of this.regionIds) this.regionCountHistory.set(regionId, []);
    for (const corridor of scenario.corridors) this.corridorHistory.set(corridor.id, []);
    for (const exit of scenario.exits) this.exitHistory.set(exit.id, []);
  }

  private delayed(history: number[] | undefined, current: number, delayTicks: number): number {
    if (!history || history.length === 0) return current;
    const index = Math.max(0, history.length - 1 - delayTicks);
    return history[index] ?? current;
  }

  private delayedStatus<T extends NetworkStatus>(history: T[] | undefined, current: T, delayTicks: number): T {
    if (!history || history.length === 0) return current;
    const index = Math.max(0, history.length - 1 - delayTicks);
    return history[index] ?? current;
  }

  observe(truth: SensorTruth, scenario: SimScenario, tick: number): ObservedSnapshot {
    const regions = new Map<string, ObservedRegionState>();
    const corridorStatus = new Map<string, NetworkStatus>();
    const exitStatus = new Map<string, NetworkStatus>();

    for (const corridor of scenario.corridors) {
      const status = truth.corridorStatus(corridor.id);
      const history = this.corridorHistory.get(corridor.id)!;
      history.push(status);
      if (history.length > 256) history.shift();
    }
    for (const exit of scenario.exits) {
      const status = truth.exitStatus(exit.id);
      const history = this.exitHistory.get(exit.id)!;
      history.push(status);
      if (history.length > 256) history.shift();
    }

    for (const regionId of this.regionIds) {
      const currentCount = Math.max(0, truth.regionOccupancy(regionId));
      const history = this.regionCountHistory.get(regionId)!;
      history.push(currentCount);
      if (history.length > 256) history.shift();

      const degraded = isDegraded(this.profile, regionId, truth.minute);
      const noiseStd = degraded ? this.profile.degraded_noise_relative_std : this.profile.noise_relative_std;
      const bias = degraded ? this.profile.degraded_bias_relative : this.profile.bias_relative;
      const delayMinutes = degraded ? this.profile.degraded_delay_minutes : this.profile.delay_minutes;
      const dropoutRate = degraded ? this.profile.degraded_dropout_rate : this.profile.dropout_rate;
      const conflictRate = degraded ? this.profile.degraded_conflict_rate : this.profile.conflict_rate;
      const baseConfidence = degraded ? this.profile.degraded_confidence : this.profile.base_confidence;
      const delayTicks = Math.max(0, Math.ceil(delayMinutes / this.dtMinutes));

      // Fixed draw count per region per tick, independent of strategy/state.
      const uDropout = this.rng();
      const uNoise = this.rng();
      const uConflict = this.rng();
      const uConflictMagnitude = this.rng();

      const delayedCount = this.delayed(history, currentCount, delayTicks);
      const observedBase = delayedCount * (1 + bias);
      const noise = sampleNormalFrom(uNoise) * noiseStd * Math.max(1, delayedCount);
      let count: number | null = Math.max(0, Math.round(observedBase + noise));
      let valid = true;
      let conflict = false;
      const reasons: string[] = [];

      if (uDropout < dropoutRate) {
        count = null;
        valid = false;
        reasons.push('dropout');
      }
      if (uConflict < conflictRate && count !== null) {
        conflict = true;
        count = Math.max(0, Math.round(count * (1.35 + 0.4 * uConflictMagnitude)));
        reasons.push('multi_provider_conflict');
      }

      const ageSeconds = delayMinutes * 60;
      let confidence = baseConfidence;
      if (degraded) confidence -= 0.08;
      if (conflict) confidence -= 0.18;
      if (count === null) confidence = Math.min(confidence, 0.2);
      confidence = Math.max(0, Math.min(1, confidence));
      if (confidence < 0.6) reasons.push(`low_confidence_${confidence.toFixed(2)}`);
      if (ageSeconds > 90) reasons.push(`stale_${Math.round(ageSeconds)}s`);

      regions.set(regionId, {
        region_id: regionId,
        count,
        confidence: Number(confidence.toFixed(4)),
        age_seconds: Number(ageSeconds.toFixed(1)),
        valid: valid && count !== null,
        source: 'simulation',
        provider: degraded ? 'camera_degraded' : 'camera_nominal',
        conflict,
        untrusted_reasons: reasons,
      });
    }

    for (const corridor of scenario.corridors) {
      const current = truth.corridorStatus(corridor.id);
      const delayMinutes = this.profile.delay_minutes;
      const delayTicks = Math.max(0, Math.ceil(delayMinutes / this.dtMinutes));
      corridorStatus.set(corridor.id, this.delayedStatus(this.corridorHistory.get(corridor.id), current, delayTicks));
    }
    for (const exit of scenario.exits) {
      const current = truth.exitStatus(exit.id);
      const delayMinutes = this.profile.delay_minutes;
      const delayTicks = Math.max(0, Math.ceil(delayMinutes / this.dtMinutes));
      exitStatus.set(exit.id, this.delayedStatus(this.exitHistory.get(exit.id), current, delayTicks));
    }

    return {
      at_minute: truth.minute,
      regions,
      corridor_status: corridorStatus,
      exit_status: exitStatus,
    };
  }
}

/**
 * Deterministic standard-normal from one uniform draw using an inverse-CDF
 * approximation.  A single draw keeps the random stream aligned across
 * strategies; the approximation error is irrelevant to this discrete model.
 */
function sampleNormalFrom(u: number): number {
  const p = Math.min(1 - 1e-12, Math.max(1e-12, u));
  // Acklam-style rational approximation.
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
