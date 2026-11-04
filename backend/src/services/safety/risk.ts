/**
 * 风险评估：确定性规则引擎（非训练模型）。
 *
 * 输入：区域观测、密度趋势、观测时效与置信度、区域阈值、可用出口/通道、已确认事件。
 * 输出：风险等级 + 每条判定理由（可追溯），以及数据是否可信。
 *
 * 阈值全部来自场景配置，并强制携带来源说明；未做现场标定的阈值在结果中原样透出。
 */
import type {
  DensityObservation,
  Incident,
  Region,
  RiskLevel,
  RiskThreshold,
  SafetyConfig,
} from './types';
import type { ObservationAssessment } from './observations';

/** 趋势计算的最小时间间隔（秒）。间隔过短时速率无意义，直接跳过。 */
export const MIN_TREND_ELAPSED_SECONDS = 30;

export interface RiskSignal {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface RegionRisk {
  regionId: string;
  level: RiskLevel;
  count: number | null;
  density: number | null;
  confidence: number | null;
  observedAt: string | null;
  ageSeconds: number | null;
  trusted: boolean;
  signals: RiskSignal[];
  thresholds: RiskThreshold;
  thresholdsSource: string;
}

const LEVEL_ORDER: RiskLevel[] = ['normal', 'watch', 'high', 'critical'];

function escalate(level: RiskLevel, steps = 1): RiskLevel {
  const index = LEVEL_ORDER.indexOf(level);
  if (index < 0) return level;
  return LEVEL_ORDER[Math.min(LEVEL_ORDER.length - 1, index + steps)];
}

function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  const rank = (level: RiskLevel) => (level === 'unknown' ? -1 : LEVEL_ORDER.indexOf(level));
  return rank(a) >= rank(b) ? a : b;
}

function levelFromDensity(density: number, thresholds: RiskThreshold): RiskLevel {
  if (density >= thresholds.critical_density) return 'critical';
  if (density >= thresholds.high_density) return 'high';
  if (density >= thresholds.watch_density) return 'watch';
  return 'normal';
}

export interface AssessRegionRiskInput {
  region: Region;
  config: SafetyConfig;
  assessment?: ObservationAssessment;
  previousObservation?: DensityObservation;
  /** 该区域在有效路网下是否存在可达的可用出口。 */
  hasUsableEgress: boolean;
  /** 该区域可用出口数量。 */
  usableExitCount: number;
  confirmedIncidents: Incident[];
  now?: Date;
}

export function assessRegionRisk(input: AssessRegionRiskInput): RegionRisk {
  const thresholds = input.region.thresholds ?? input.config.default_thresholds;
  const signals: RiskSignal[] = [];

  if (!input.assessment) {
    signals.push({ code: 'no_observation', message: '该区域尚无任何人群观测，无法评估风险' });
    return {
      regionId: input.region.id,
      level: 'unknown',
      count: null,
      density: null,
      confidence: null,
      observedAt: null,
      ageSeconds: null,
      trusted: false,
      signals,
      thresholds,
      thresholdsSource: thresholds.source,
    };
  }

  const { observation, ageSeconds, trusted } = input.assessment;
  const density = observation.estimated_density;
  let level = levelFromDensity(density, thresholds);

  signals.push({
    code: 'density_level',
    message: `当前密度 ${density.toFixed(2)} 人/m²，阈值 关注 ${thresholds.watch_density} / 高 ${thresholds.high_density} / 极高 ${thresholds.critical_density}`,
    detail: { density, thresholds: { ...thresholds } },
  });

  // 密度趋势：上升过快时提升一级
  const prev = input.previousObservation;
  if (prev && prev.region_id === observation.region_id) {
    const elapsedSeconds =
      (new Date(observation.observed_at).getTime() - new Date(prev.observed_at).getTime()) / 1000;
    if (elapsedSeconds >= MIN_TREND_ELAPSED_SECONDS) {
      const ratePerMinute = (density - prev.estimated_density) / (elapsedSeconds / 60);
      if (ratePerMinute >= thresholds.rise_rate_watch) {
        level = escalate(level, 1);
        signals.push({
          code: 'density_rising_fast',
          message: `密度上升 ${ratePerMinute.toFixed(2)} 人/m²/min，超过阈值 ${thresholds.rise_rate_watch}`,
          detail: { ratePerMinute, elapsedSeconds },
        });
      } else {
        signals.push({
          code: 'density_trend_normal',
          message: `密度变化 ${ratePerMinute.toFixed(3)} 人/m²/min，未超过上升阈值`,
          detail: { ratePerMinute, elapsedSeconds },
        });
      }
    } else {
      signals.push({
        code: 'trend_insufficient_elapsed',
        message: `两次观测间隔 ${Math.round(elapsedSeconds)}s 小于 ${MIN_TREND_ELAPSED_SECONDS}s，不计算趋势`,
        detail: { elapsedSeconds },
      });
    }
  }

  // 事件影响
  for (const incident of input.confirmedIncidents) {
    if (incident.affected.region_ids.includes(input.region.id)) {
      const criticalTypes = new Set(['fire', 'crowd_surge']);
      if (criticalTypes.has(incident.type)) level = maxLevel(level, 'critical');
      else level = maxLevel(level, 'high');
      signals.push({
        code: `incident_${incident.type}`,
        message: `已确认事件 ${incident.id}（${incident.type}）影响本区域`,
        detail: { incidentId: incident.id, severity: incident.severity },
      });
    }
  }

  // 出口/通路
  if (!input.hasUsableEgress) {
    level = 'critical';
    signals.push({
      code: 'no_usable_egress',
      message: '该区域在当前约束下不存在可达的可用出口',
    });
  } else if (input.usableExitCount === 0) {
    level = maxLevel(level, 'high');
    signals.push({ code: 'no_local_exit', message: '该区域本身无可用出口，需通过通道转移' });
  }

  // 数据可信度
  if (!trusted) {
    for (const reason of input.assessment.untrustedReasons) {
      signals.push({ code: 'untrusted_observation', message: `观测不可信：${reason}`, detail: { reason } });
    }
  }
  if (input.region.area_provenance !== 'measured') {
    signals.push({
      code: 'area_not_measured',
      message: `区域面积来源为 ${input.region.area_provenance}，密度换算存在系统误差`,
      detail: { area_provenance: input.region.area_provenance, area_m2: input.region.area_m2 },
    });
  }

  return {
    regionId: input.region.id,
    level,
    count: observation.estimated_count,
    density,
    confidence: observation.confidence,
    observedAt: observation.observed_at,
    ageSeconds: Math.round(ageSeconds),
    trusted,
    signals,
    thresholds,
    thresholdsSource: thresholds.source,
  };
}

/** 采集时是否也需要实时判定（用于 API 展示）。 */
export function riskSummary(risks: RegionRisk[]): { highest: RiskLevel; counts: Record<RiskLevel, number> } {
  const counts: Record<RiskLevel, number> = { normal: 0, watch: 0, high: 0, critical: 0, unknown: 0 };
  let highest: RiskLevel = 'normal';
  for (const risk of risks) {
    counts[risk.level] += 1;
    highest = maxLevel(highest, risk.level);
  }
  if (risks.length === 0) highest = 'unknown';
  return { highest, counts };
}
