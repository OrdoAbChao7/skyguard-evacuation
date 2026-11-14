import type { SafetyRegion, SafetyStateName } from '../../services/safetyApi';

export const STATE_LABEL: Record<SafetyStateName, string> = {
  NORMAL: '常态运行',
  REROUTE: '重规划中',
  DEGRADED: '感知降级',
  REJECT: '安全拒绝',
};

export const RISK_LABEL: Record<string, string> = {
  normal: '正常',
  watch: '关注',
  high: '高风险',
  critical: '极高风险',
  unknown: '未知',
};

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function formatSince(iso: string | null | undefined): string {
  if (!iso) return '无';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '时间未知';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s 前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min 前`;
  return `${(seconds / 3600).toFixed(1)}h 前`;
}

export function textOf(form: { description: string }, text: string): string {
  return (text || form.description || '').trim();
}

export function formatAffected(affected: { region_ids: string[]; corridor_ids: string[]; exit_ids: string[] }): string {
  const parts = [
    ...affected.region_ids.map(id => `区域 ${id}`),
    ...affected.corridor_ids.map(id => `通道 ${id}`),
    ...affected.exit_ids.map(id => `出口 ${id}`),
  ];
  return parts.length > 0 ? parts.join('、') : '未识别';
}

export function affectedOf(target: string): { region_ids: string[]; corridor_ids: string[]; exit_ids: string[] } {
  const [kind, id] = target.split(':');
  if (kind === 'exit') return { region_ids: [], corridor_ids: [], exit_ids: [id] };
  if (kind === 'corridor') return { region_ids: [], corridor_ids: [id], exit_ids: [] };
  return { region_ids: [id], corridor_ids: [], exit_ids: [] };
}

export const MAP_MIN_ZOOM = 1;
export const MAP_MAX_ZOOM = 3;
export const MAP_ZOOM_STEP = 0.25;
export const MAP_WHEEL_FACTOR = 1.25;
export const MAP_FOCUS_ZOOM = 1.5;
export const MAP_DRAG_CLICK_THRESHOLD_PX = 4;

export function centreOf(region: SafetyRegion): { x: number; y: number } {
  return { x: region.geometry.x + region.geometry.width / 2, y: region.geometry.y + region.geometry.height / 2 };
}
