/**
 * 自然语言事件入口（确定性规则解析，不依赖大模型）。
 *
 * 安全原则：
 *  - 自然语言只是"录入辅助"，输出永远是**待确认草稿**，绝不直接改变约束；
 *  - 解析结果必须由操作员走 `POST /incidents` 正式登记并确认；
 *  - 大模型不得参与"是否满足硬约束"的判定，也不得把未通过校验的方案改写为通过。
 */
import type { IncidentType, SafetyScenario } from './types';

export interface IncidentDraft {
  type: IncidentType;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affected: { region_ids: string[]; corridor_ids: string[]; exit_ids: string[] };
  matched_terms: string[];
  confidence: number;
  /** 需要操作员补充的信息，非空时必须人工确认后才能提交。 */
  needs_human_review: string[];
  raw_text: string;
}

const TYPE_KEYWORDS: Array<{ type: IncidentType; terms: string[]; severity: 'low' | 'medium' | 'high' | 'critical' }> = [
  { type: 'fire', terms: ['火灾', '起火', '着火', '火情', '烟雾', 'fire', 'smoke'], severity: 'critical' },
  { type: 'corridor_closure', terms: ['关闭', '封闭', '封锁', '禁止通行', 'blocked', 'closed'], severity: 'high' },
  { type: 'crowd_surge', terms: ['拥挤', '踩踏', '人流激增', '聚集', '拥堵', 'surge', 'crowd'], severity: 'high' },
  { type: 'sensor_failure', terms: ['摄像头故障', '视频中断', '感知故障', '设备故障', '信号丢失', 'camera', 'sensor'], severity: 'medium' },
];

export function parseIncidentText(text: string, scenario: SafetyScenario): IncidentDraft {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  const matchedTerms: string[] = [];

  let type: IncidentType = 'other';
  let severity: 'low' | 'medium' | 'high' | 'critical' = 'medium';
  for (const rule of TYPE_KEYWORDS) {
    const hits = rule.terms.filter(term => lower.includes(term.toLowerCase()));
    if (hits.length > 0) {
      if (type === 'other') {
        type = rule.type;
        severity = rule.severity;
      }
      matchedTerms.push(...hits);
    }
  }

  const affected = { region_ids: [] as string[], corridor_ids: [] as string[], exit_ids: [] as string[] };
  const needsHumanReview: string[] = [];
  const seen = new Set<string>();

  // 区域匹配：优先按名称，其次按 ID
  for (const region of scenario.regions) {
    if (seen.has(region.id)) continue;
    if (normalized.includes(region.name) || lower.includes(region.id.toLowerCase())) {
      affected.region_ids.push(region.id);
      seen.add(region.id);
      matchedTerms.push(region.name);
    }
  }
  for (const exit of scenario.exits) {
    if (normalized.includes(exit.name) || lower.includes(exit.id.toLowerCase())) {
      affected.exit_ids.push(exit.id);
      matchedTerms.push(exit.name);
    } else {
      // "B 出口" 这类简写
      const short = exit.id.replace(/^E_/, '');
      if (new RegExp(`${short}\\s*号?\\s*出口`, 'i').test(normalized)) {
        affected.exit_ids.push(exit.id);
        matchedTerms.push(`${short}号出口`);
      }
    }
  }
  for (const corridor of scenario.corridors) {
    if (normalized.includes(corridor.name) || lower.includes(corridor.id.toLowerCase())) {
      affected.corridor_ids.push(corridor.id);
      matchedTerms.push(corridor.name);
    }
  }

  if (type === 'other') needsHumanReview.push('无法从文本判定事件类型，请选择事件类型');
  if (affected.region_ids.length === 0 && affected.corridor_ids.length === 0 && affected.exit_ids.length === 0) {
    needsHumanReview.push('无法从文本判定受影响区域/通道/出口，请手动选择影响范围');
  }
  if (type === 'fire' && affected.exit_ids.length === 0 && affected.region_ids.length === 0) {
    needsHumanReview.push('火灾事件缺少位置信息，禁止直接关闭任何通路');
  }

  const confidence = Math.min(1, matchedTerms.length * 0.2 + (type === 'other' ? 0 : 0.4));

  return {
    type,
    description: normalized.slice(0, 200) || '未提供描述',
    severity,
    affected,
    matched_terms: [...new Set(matchedTerms)],
    confidence: Number(confidence.toFixed(2)),
    needs_human_review: needsHumanReview,
    raw_text: normalized,
  };
}
