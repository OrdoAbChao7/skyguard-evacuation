/**
 * 算法人群仿真面板。
 *
 * 调用后端场景驱动仿真，把生成的合成观测写入安全域；前端只展示结果，
 * 不自行计算风险、不写死人数、不暗示真实数据。
 */
import { useState } from 'react';
import mvpApi, { type CrowdFlowSimulationResult } from '../../services/mvpApi';
import './CrowdSimulationPanel.css';

type Preset = 'normal' | 'gate_closure' | 'surge';

const PRESETS: Array<{ value: Preset; label: string; hint: string }> = [
  { value: 'normal', label: '正常疏散', hint: '从场景基线人数开始，沿最短路疏散' },
  { value: 'gate_closure', label: '闸口关闭', hint: '第 3 分钟关闭 3、4 号闸口，观察绕行' },
  { value: 'surge', label: '人群激增', hint: '第 3 分钟在 4 号门广场注入 3300 人' },
];

const STATE_LABEL: Record<string, string> = {
  NORMAL: '常态运行',
  REROUTE: '重新规划',
  DEGRADED: '感知降级',
  REJECT: '安全拒绝',
};

function errorMessage(error: unknown): string {
  const response = (error as { response?: { data?: { error?: { message?: string } | string } } }).response;
  const data = response?.data?.error;
  if (typeof data === 'string') return data;
  if (data?.message) return data.message;
  return (error as Error).message;
}

export default function CrowdSimulationPanel({ onChanged }: { onChanged?: () => void }) {
  const [preset, setPreset] = useState<Preset>('normal');
  const [result, setResult] = useState<CrowdFlowSimulationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasAdmin = typeof localStorage !== 'undefined' && Boolean(localStorage.getItem('admin_token'));
  const selected = PRESETS.find(item => item.value === preset) ?? PRESETS[0];

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await mvpApi.runCrowdFlowSimulation({ preset, minutes: 10, seed: 42 });
      setResult(next);
      onChanged?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mvp-panel mvp-span-3 crowd-sim-panel">
      <div className="mvp-panel-title">
        <h3>算法人群仿真</h3>
        <span className="crowd-sim-badge">合成数据 · 非实测</span>
      </div>
      <p className="mvp-muted mvp-small">
        按场景拓扑、通道/出口容量与最短路流量模型生成分钟级人数序列；不审批、不派发、不控制现场资源。
      </p>

      <div className="crowd-sim-controls">
        <select
          aria-label="仿真预设"
          value={preset}
          disabled={busy}
          onChange={event => setPreset(event.target.value as Preset)}
        >
          {PRESETS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <button
          type="button"
          className="primary"
          disabled={busy || !hasAdmin}
          title={hasAdmin ? '生成合成观测并写入安全域' : '需要管理员或安全运维登录'}
          onClick={() => void run()}
        >
          {busy ? '仿真中…' : '运行 10 分钟仿真'}
        </button>
        <span className="mvp-muted mvp-small">{selected.hint}</span>
        {!hasAdmin ? <span className="mvp-muted mvp-small">需要管理员或安全运维登录（/login）。</span> : null}
      </div>

      {error ? <p className="mvp-error-inline">{error}</p> : null}

      {result ? (
        <>
          <div className="crowd-sim-metrics">
            <div><span>初始人数</span><strong>{result.summary.initial_total}</strong></div>
            <div><span>已疏散</span><strong>{result.summary.evacuated}</strong></div>
            <div><span>场内</span><strong>{result.summary.remaining_inside}</strong></div>
            <div><span>通道在途</span><strong>{result.summary.in_transit}</strong></div>
            <div><span>无路可走</span><strong>{result.summary.stranded}</strong></div>
            <div><span>人数守恒</span><strong className={result.summary.conservation_ok ? 'ok' : 'bad'}>{result.summary.conservation_ok ? '通过' : '失败'}</strong></div>
            <div><span>峰值密度</span><strong>{result.summary.peak_density ? `${result.summary.peak_density.density} 人/m²` : '—'}</strong></div>
            <div><span>写入观测</span><strong>{result.observations_ingested}</strong></div>
            <div><span>安全状态</span><strong>{STATE_LABEL[result.state] ?? result.state}</strong></div>
          </div>

          <p className="mvp-muted mvp-small">
            峰值区域：{result.summary.peak_density ? `${result.summary.peak_density.region_name}（${result.summary.peak_density.count} 人）` : '—'}
            {' · '}容量受限样本 {result.summary.congested_samples}
            {' · '}运行 {result.run_id}
            {result.plan_id ? ` · 方案 ${result.plan_id}` : ''}
          </p>

          {result.summary.events.length > 0 ? (
            <ul className="crowd-sim-events">
              {result.summary.events.map(event => <li key={event}>{event}</li>)}
            </ul>
          ) : null}

          {result.summary.unresolved_regions.length > 0 ? (
            <p className="mvp-error-inline">
              未解决：{result.summary.unresolved_regions.map(item => `${item.region_id}×${item.count}`).join('，')}
            </p>
          ) : null}

          <div className="crowd-sim-timeline" aria-label="逐分钟仿真总量">
            {result.timeline.map(item => (
              <span key={item.minute} title={item.events.join('；') || undefined}>
                <b>{String(item.minute).padStart(2, '0')}′</b>
                场内 {item.totals.inside} · 在途 {item.totals.in_transit} · 已疏散 {item.totals.evacuated}
              </span>
            ))}
          </div>

          <p className="mvp-muted mvp-small">
            合成数据，不是实测，也不是视频推理结果；面积、容量与阈值均未现场标定。
          </p>
        </>
      ) : (
        <p className="mvp-muted mvp-small">尚未运行。仿真结果会以 `simulation` 来源写入观测，再由安全内核重新规划与校验。</p>
      )}
    </section>
  );
}
