/**
 * SkyGuard 指挥大屏（/command-center）。
 *
 * 设计原则：
 *  - 所有内容来自后端真实 API（/api/v1/safety/*），页面本身不做任何安全判定；
 *  - 颜色永远与文字/原因同时出现，不单独依靠颜色传达状态；
 *  - 已验证方案与候选方案在视觉上严格区分；
 *  - REJECT 下不显示任何绿色路线，DEGRADED 下不把过期数据当成实时状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import safetyApi from '../../services/safetyApi';
import type {
  AuditEntry,
  DemoRunResult,
  EvacuationPlan,
  EvacuationRoute,
  ProviderStatus,
  SafetyIncident,
  SafetyRegion,
  SafetyScenarioSummary,
  ScenarioMap,
  SafetyStateName,
  SafetyStatus,
  SafetyValidationResult,
} from '../../services/safetyApi';
import { AppstoreOutlined, RadarChartOutlined, EyeOutlined, SafetyCertificateOutlined, AlertOutlined, HistoryOutlined, SettingOutlined, AimOutlined } from '@ant-design/icons';
import MvpPanels from './MvpPanels';
import PerceptionReplayPanel from './PerceptionReplayPanel';
import './CommandCenterPage.css';

const STATE_LABEL: Record<SafetyStateName, string> = {
  NORMAL: '常态运行',
  REROUTE: '重规划中',
  DEGRADED: '感知降级',
  REJECT: '安全拒绝',
};

const RISK_LABEL: Record<string, string> = {
  normal: '正常',
  watch: '关注',
  high: '高风险',
  critical: '极高风险',
  unknown: '未知',
};

const POLL_INTERVAL_MS = 5000;

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function formatSince(iso: string | null | undefined): string {
  if (!iso) return '无';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s 前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min 前`;
  return `${(seconds / 3600).toFixed(1)}h 前`;
}

export default function CommandCenterPage() {
  const [layers, setLayers] = useState({landmarks: true, regions: true, risks: true, corridors: true, validated: true, candidate: true, incidents: true});
  const [showLayers, setShowLayers] = useState(false);
  const [videoRegion, setVideoRegion] = useState<string | null>(null);
  const [mapZoom, setMapZoom] = useState(1);
  const [mapCenter, setMapCenter] = useState<{x:number; y:number} | null>(null);
  const [showBackdrop, setShowBackdrop] = useState(true);
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null);
  const [status, setStatus] = useState<SafetyStatus | null>(null);
  const [scenario, setScenario] = useState<SafetyScenarioSummary | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedDemo, setSelectedDemo] = useState<string>('');
  const [demoResult, setDemoResult] = useState<DemoRunResult | null>(null);
  const [nlText, setNlText] = useState('');
  const [draftSummary, setDraftSummary] = useState<string | null>(null);
  const [incidentForm, setIncidentForm] = useState({
    type: 'fire',
    severity: 'critical',
    target: '',
    description: '',
  });

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextAudit] = await Promise.all([safetyApi.status(), safetyApi.audit(40)]);
      setStatus(nextStatus);
      setAudit(nextAudit);
      setError(null);
    } catch (caught) {
      setError(`无法读取安全状态，当前显示的是上次取得的数据，不能视为实时：${(caught as Error).message}`);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [nextScenario, nextProviders] = await Promise.all([safetyApi.scenario(), safetyApi.providers()]);
        if (cancelled) return;
        setScenario(nextScenario);
        setProviders(nextProviders);
        setSelectedDemo(current => current || nextScenario.demo_scenarios[0]?.id || '');
        const firstExit = nextScenario.exits[0];
        setIncidentForm(current => current.target || !firstExit
          ? current
          : { ...current, target: `exit:${firstExit.id}`, description: `${firstExit.name}附近报火情` });
      } catch (caught) {
        if (!cancelled) setError(`无法加载场景：${(caught as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refresh();
    };
    // 首次拉取放到定时器回调里，避免在 effect 体内同步触发状态更新
    const initial = setTimeout(tick, 0);
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);

  const runAction = useCallback(
    async (name: string, action: () => Promise<unknown>, successMessage: string) => {
      setBusy(name);
      setNotice(null);
      try {
        await action();
        setNotice(successMessage);
        await refresh();
      } catch (caught) {
        const message = (caught as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error
          ?.message;
        setNotice(`操作失败：${message ?? (caught as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  if (!status) {
    return (
      <div className="cc-root cc-loading">
        <p>{error ?? '正在连接安全决策服务…'}</p>
        {error ? (
          <button type="button" onClick={() => void refresh()}>
            重试
          </button>
        ) : null}
      </div>
    );
  }

  const plan = !error && status.state.state !== 'REJECT' && status.state.validated_route_display_allowed ? status.plan : null;
  const candidate = !error && status.state.candidate_route_display_allowed ? status.candidate_plan : null;
  const displayPlan = plan ?? candidate;
  const isCandidate = !plan && Boolean(candidate);
  const selectRegion = (id: string) => { const region = status.regions.find(item => item.id === id); setSelectedRegion(id); if (region) { setMapCenter(centreOf(region)); setMapZoom(value => Math.max(value, 1.5)); } };

  return (
    <div className="cc-root">
      <nav className="cc-sidebar" aria-label="指挥中心导航">
        {[
          { icon: <AppstoreOutlined />, label: '总览', target: 'overview' },
          { icon: <RadarChartOutlined />, label: '态势监控', target: 'situation' },
          { icon: <EyeOutlined />, label: 'AI 感知', target: 'sensors' },
          { icon: <AimOutlined />, label: '感知回放', target: 'perception-replay' },
          { icon: <SafetyCertificateOutlined />, label: '可信决策', target: 'decision' },
          { icon: <AlertOutlined />, label: '事件管理', target: 'incidents' },
          { icon: <HistoryOutlined />, label: '审计记录', target: 'audit' },
          { icon: <SettingOutlined />, label: '演示场景', target: 'demos' },
        ].map(item => <a key={item.target} href={`#${item.target}`} title={item.label} aria-label={item.label}>{item.icon}</a>)}
      </nav>
      <header className="cc-topbar" id="overview">
        <div className="cc-brand">
          <span className="cc-brand-mark">SkyGuard</span>
          <span className="cc-brand-sub">可信安全决策指挥大屏</span>
        </div>
        {error ? <div className="cc-state-badge cc-bad" role="status"><strong>连接中断</strong><span>状态不可确认</span></div> : <StateBadge state={status.state.state} headline={status.state.headline} />}
        <div className="cc-meta">
          <span title={status.scenario.notice}>{status.scenario.name}</span>
          <span>v{status.versions.scenario}</span>
          <span>约束版本 {status.versions.constraint}</span>
          <span>观测版本 {status.versions.observation}</span>
          <span className={status.inference_health.healthy ? 'cc-ok' : 'cc-bad'}>
            推理链路 {status.inference_health.healthy ? '正常' : `异常（${status.inference_health.reason ?? '未知'}）`}
          </span>
        </div>
      </header>

      {status.scenario.notice ? <div className="cc-disclaimer">⚠ {status.scenario.notice}</div> : null}
      {error ? <div className="cc-banner cc-banner-error">{error}</div> : null}
      {notice ? <div className="cc-banner">{notice}</div> : null}

      <div className="cc-grid">
        {/* ---------------- 左列：感知输入 ---------------- */}
        <section className="cc-panel cc-col-left" id="sensors">
          <PanelTitle title="感知输入" subtitle="人群观测与 provider 状态" />
          <div className="cc-actions">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void runAction(
                  'simulate',
                  () =>
                    safetyApi.simulate(
                      scenario?.simulation_baseline
                        ?? Object.fromEntries(
                          (scenario?.regions ?? []).map(region => [region.id, { count: 0, confidence: 1 }]),
                        ),
                    ),
                  '已写入模拟观测（标记为 simulation）并重新规划',
                )
              }
            >
              写入模拟观测
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void refresh()}>
              刷新
            </button>
          </div>

          <ProviderList providers={providers} />

          <h4 className="cc-subtitle">各区域观测</h4>
          <table className="cc-table">
            <thead>
              <tr>
                <th>区域</th>
                <th>人数</th>
                <th>密度</th>
                <th>置信度</th>
                <th>时效</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              {status.regions.map(region => {
                const observation = status.observations.find(item => item.region_id === region.id);
                const risk = status.risks.find(item => item.regionId === region.id);
                return (
                  <tr key={region.id} className={`risk-${risk?.level ?? 'unknown'}`}>
                    <td>
                      {region.name}
                      <span className="cc-muted"> {region.id}</span>
                    </td>
                    <td>{observation ? observation.estimated_count : '—'}</td>
                    <td>
                      {observation ? observation.estimated_density.toFixed(2) : '—'}
                      <span className="cc-muted"> 人/m²</span>
                    </td>
                    <td>{observation ? observation.confidence.toFixed(2) : '—'}</td>
                    <td>{formatSince(observation?.observed_at)}</td>
                    <td>
                      <span className={`cc-tag source-${observation?.source ?? 'none'}`}>
                        {observation ? ({ simulation: '模拟', recorded_video: '录像', live_video: '实时' } as const)[observation.source] : '无数据'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="cc-muted cc-small">
            面积来源：{status.regions.map(region => region.area_provenance).filter((value, index, array) => array.indexOf(value) === index).join(' / ')}
            ；摄像机标定：{status.regions.map(region => region.camera.calibration_status).filter((value, index, array) => array.indexOf(value) === index).join(' / ')}
          </p>
        </section>

        {/* ---------------- 中列：态势图 ---------------- */}
        <section className="cc-panel cc-col-center" id="situation">
          <div className="cc-kpis">
            <div><span>感知区域</span><strong>{status.regions.length}</strong><small>个区域</small></div>
            <div><span>观测人数</span><strong>{status.observations.length ? status.observations.reduce((sum, item) => sum + item.estimated_count, 0) : '—'}</strong><small>{status.state.state === 'DEGRADED' ? '数据可能过期' : '观测值'}</small></div>
            <div><span>高风险区域</span><strong>{status.risks.some(risk => risk.trusted) ? (status.risk_summary.counts.high ?? 0) + (status.risk_summary.counts.critical ?? 0) : '—'}</strong><small>{status.risks.some(risk => risk.trusted) ? '个区域' : '无可信观测'}</small></div>
            <div><span>可信方案</span><strong className={!error && status.state.publishable ? 'cc-ok' : 'cc-bad'}>{!error && status.state.publishable ? '可发布' : '不可发布'}</strong><small>{status.state.state}</small></div>
            <div><span>推理链路</span><strong className={status.inference_health.healthy ? 'cc-ok' : 'cc-bad'}>{status.inference_health.healthy ? '正常' : '异常'}</strong><small>健康状态</small></div>
          </div>
          <PanelTitle
            title="区域态势与疏散路线"
            subtitle={`时限 ${status.scenario.horizon_minutes} 分钟 · ${displayPlan ? `方案 ${displayPlan.plan_id}` : '暂无方案'}`}
          />
          <div className="cc-map-wrap"><div className="cc-map-caption"><strong>场馆态势</strong><span>{scenario?.map?.caption ?? '合成场景 · 区域未空间标定'}</span></div><NetworkMap map={scenario?.map} status={status} selectedRegion={selectedRegion} onSelectRegion={selectRegion} allowRoutes={!error} zoom={mapZoom} setZoom={setMapZoom} center={mapCenter} setCenter={setMapCenter} showBackdrop={showBackdrop} layers={layers} />
            <div className="cc-map-tools" aria-label="地图工具"><button type="button" title="放大" aria-label="放大地图" disabled={mapZoom >= 1.5} onClick={() => setMapZoom(value => Math.min(1.5, value + .25))}>+</button><button type="button" title="缩小" aria-label="缩小地图" disabled={mapZoom <= 1} onClick={() => setMapZoom(value => Math.max(1, value - .25))}>−</button><button type="button" onClick={() => setShowLayers(value => !value)} aria-expanded={showLayers} title="选择地图图层">图层</button><button type="button" onClick={() => { setMapZoom(1); setMapCenter(null); setSelectedRegion(null); }} title="重置视图">复位</button></div>
            {showLayers ? <div className="cc-layer-menu"><label><input type="checkbox" checked={showBackdrop} onChange={() => setShowBackdrop(value => !value)} />概念底图</label>{([['landmarks','场景地标'],['regions','模拟区域'],['risks','风险区域'],['corridors','通道与出口'],['validated','已验证路线'],['candidate','候选路线'],['incidents','事件标记']] as const).map(([key,label]) => <label key={key}><input type="checkbox" checked={layers[key]} onChange={() => setLayers(value => ({...value,[key]: !value[key]}))} />{label}</label>)}</div> : null}
            {selectedRegion ? <div className="cc-map-detail"><strong>{status.regions.find(region => region.id === selectedRegion)?.name}</strong><span>风险：{RISK_LABEL[status.risks.find(risk => risk.regionId === selectedRegion)?.level ?? 'unknown']}</span><span>人数：{status.risks.find(risk => risk.regionId === selectedRegion)?.count ?? '—'} · 密度：{status.risks.find(risk => risk.regionId === selectedRegion)?.density?.toFixed(2) ?? '—'}</span><span>置信度：{status.risks.find(risk => risk.regionId === selectedRegion)?.confidence ?? '—'} · 时效：{formatSince(status.observations.find(item => item.region_id === selectedRegion)?.observed_at)}</span><span>来源：{status.observations.find(item => item.region_id === selectedRegion)?.source ?? '无数据'}</span><button type="button" onClick={() => setSelectedRegion(null)}>关闭</button></div> : null}</div>
          <Legend isCandidate={isCandidate} hasPlan={Boolean(displayPlan)} />
          <div className="cc-route-summary">
            {displayPlan ? (
              <>
                <span className={isCandidate ? 'cc-badge cc-badge-warn' : 'cc-badge cc-badge-ok'}>
                  {isCandidate ? '候选方案 · 未通过校验' : '已验证方案'}
                </span>
                <span>
                  已分配 {displayPlan.evacuated_persons} / {displayPlan.total_persons} 人
                </span>
                <span className={displayPlan.unresolved_persons > 0 ? 'cc-bad' : 'cc-ok'}>
                  未解决 {displayPlan.unresolved_persons} 人
                </span>
                <span>方式：时间扩展最大流（含容量与时限约束）</span>
              </>
            ) : (
              <span className="cc-bad">当前无可展示方案（{error ? '连接中断，无法确认当前状态' : status.state.headline}）</span>
            )}
          </div>
          <div className="cc-center-bottom"><div className="cc-bottom-card"><h4>安全决策引擎</h4><div className="cc-state-strip cc-process">{[
              ['感知', status.observations.length ? `${status.risks.filter(risk => risk.trusted).length}/${status.regions.length} 可信` : '暂无观测'],
              ['风险', status.risks.some(risk => risk.trusted) ? `最高：${RISK_LABEL[status.risk_summary.highest] ?? '未知'}` : '无可信评估'],
              ['规划', displayPlan ? (isCandidate ? '候选方案' : '方案已生成') : '暂无方案'],
              ['校验', status.validation ? (status.validation.valid ? '已通过' : '未通过') : '暂无结果'],
              ['发布', !error && status.state.publishable ? '允许发布' : '禁止发布'],
            ].map(([label, value]) => <span key={label}><b>{label}</b><small>{value}</small></span>)}</div><p>{status.state.headline}</p></div><div className="cc-bottom-card"><h4>疏散任务状态</h4><p>方案 {displayPlan?.plan_id ?? '暂无'} · {isCandidate ? '候选方案，尚未通过校验' : status.validation?.valid && plan ? '已通过独立校验' : '暂无有效校验'}</p><p>已分配 {displayPlan?.evacuated_persons ?? '—'} 人 · 未解决 {displayPlan?.unresolved_persons ?? '—'} 人</p><ExitAllocation status={status} plan={displayPlan} /></div></div>
          {displayPlan && displayPlan.unresolved.length > 0 ? (
            <ul className="cc-unresolved">
              {displayPlan.unresolved.map(item => (
                <li key={item.region_id}>
                  未解决：{item.region_id} 尚有 {item.persons} 人 —— {item.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {/* ---------------- 右列：决策与操作 ---------------- */}
        <section className="cc-panel cc-col-right" id="decision">
          <div className="cc-video"><h4>视频与感知画面 <span className="cc-muted">视频源未接入</span></h4><div className="cc-video-empty"><EyeOutlined /><strong>{status.regions.find(region => region.id === videoRegion)?.name ?? '请选择监测区域'}</strong><span>无可播放视频 · 非实时画面</span></div><div className="cc-video-thumbs" aria-label="选择监测区域">{status.regions.slice(0,4).map(region => <button type="button" key={region.id} className={videoRegion === region.id ? 'selected' : ''} aria-pressed={videoRegion === region.id} onClick={() => setVideoRegion(region.id)}><EyeOutlined /><span>{region.name}</span><small>未接入</small></button>)}</div><div className="cc-video-foot">来源：未配置视频流 · 时间：—</div></div>
          <h4 className="cc-subtitle">风险告警 · {status.incidents.length} 条</h4><div className="cc-alert-summary">{status.incidents.length ? status.incidents.slice(0,4).map(incident => <button key={incident.id} type="button" onClick={() => { const c = status.corridors.find(item => incident.affected.corridor_ids.includes(item.id)); const e = status.exits.find(item => incident.affected.exit_ids.includes(item.id)); const id = incident.affected.region_ids[0] ?? c?.from_region_id ?? e?.region_id; if (id) selectRegion(id); }}><span className={`cc-alert-dot severity-${incident.severity}`} /><strong>{incident.type}</strong><span>{formatAffected(incident.affected)}</span><small>{incident.status} · {formatTime(incident.reported_at)}</small></button>) : <p className="cc-muted">暂无事件告警</p>}</div>
          <PanelTitle title="决策状态" subtitle={`进入于 ${formatTime(status.state_entered_at)}`} />
          <div className={`cc-state-block state-${status.state.state}`}>
            <div className="cc-state-name">
              {status.state.state} · {STATE_LABEL[status.state.state]}
            </div>
            <div className="cc-state-headline">{error ? '连接中断，决策状态无法确认' : status.state.headline}</div>
            <div className="cc-decision-summary"><span>不可信区域 <strong>{status.risks.filter(risk => !risk.trusted).length}</strong> / {status.regions.length}</span><span>发布状态 <strong>{!error && status.state.publishable ? '允许' : '禁止'}</strong></span><span>人工介入 <strong>{status.state.requires_operator_action ? '需要' : '未要求'}</strong></span></div>
            <details className="cc-technical"><summary>技术详情 · {status.state.reasons.length} 条原因</summary><ul className="cc-reasons">
              {status.state.reasons.map((reason, index) => (
                <li key={`${reason.code}-${index}`} className={`severity-${reason.severity}`}>
                  <code>{reason.code}</code> {reason.message}
                </li>
              ))}
            </ul></details>
            <div className="cc-state-flags">
              <span>可发布：{!error && status.state.publishable ? '是' : '否'}</span>
              <span>需人工介入：{status.state.requires_operator_action ? '是' : '否'}</span>
              <span>最后一次有效观测：{formatSince(status.state.last_valid_observation_at)}</span>
            </div>
          </div>

          <h4 className="cc-subtitle">独立校验结果</h4>
          <ValidationPanel validation={status.validation} candidateShown={isCandidate} />

          <h4 className="cc-subtitle">出口分配</h4>
          <ExitAllocation status={status} plan={displayPlan} />

          <h4 className="cc-subtitle" id="incidents">事件管理</h4>
          <IncidentPanel
            incidents={status.incidents}
            onLocate={incident => {
              const corridor = status.corridors.find(item => incident.affected.corridor_ids.includes(item.id));
              const exit = status.exits.find(item => incident.affected.exit_ids.includes(item.id));
              const regionId = incident.affected.region_ids[0] ?? corridor?.from_region_id ?? exit?.region_id;
              if (regionId) { selectRegion(regionId); document.getElementById('situation')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
            }}
            busy={busy}
            onConfirm={id =>
              void runAction(`confirm-${id}`, () => safetyApi.confirmIncident(id), '事件已确认，已重新规划并校验')
            }
            onResolve={id =>
              void runAction(`resolve-${id}`, () => safetyApi.resolveIncident(id), '事件已解除，旧方案已失效并重新规划')
            }
          />
          <div className="cc-incident-form">
            <div className="cc-form-row">
              <select
                aria-label="事件类型"
                value={incidentForm.type}
                onChange={event => setIncidentForm({ ...incidentForm, type: event.target.value })}
              >
                <option value="fire">火灾</option>
                <option value="corridor_closure">通道关闭</option>
                <option value="crowd_surge">人流激增</option>
                <option value="sensor_failure">感知设备故障</option>
                <option value="other">其他</option>
              </select>
              <select
                aria-label="影响范围"
                value={incidentForm.target}
                onChange={event => setIncidentForm({ ...incidentForm, target: event.target.value })}
              >
                {status.exits.map(exit => (
                  <option key={exit.id} value={`exit:${exit.id}`}>
                    出口 {exit.name}
                  </option>
                ))}
                {status.corridors.map(corridor => (
                  <option key={corridor.id} value={`corridor:${corridor.id}`}>
                    通道 {corridor.name}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              aria-label="事件描述"
              value={nlText || incidentForm.description}
              onChange={event => {
                setNlText(event.target.value);
                setIncidentForm({ ...incidentForm, description: event.target.value });
              }}
              rows={2}
            />
            <div className="cc-form-row">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void runAction(
                    'parse',
                    async () => {
                      const draft = await safetyApi.parseIncident(textOf(incidentForm, nlText));
                      setDraftSummary(
                        `草稿：${draft.type} / ${draft.severity} / 影响 ${formatAffected(draft.affected)}` +
                          (draft.needs_human_review.length > 0
                            ? ` · 需人工确认：${draft.needs_human_review.join('；')}`
                            : ''),
                      );
                    },
                    '已生成事件草稿（不会改变任何约束）',
                  )
                }
              >
                解析文本
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void runAction('incident-report', () => safetyApi.createIncident({
                  type: incidentForm.type, description: incidentForm.description || '大屏登记事件', severity: incidentForm.severity,
                  affected: affectedOf(incidentForm.target), confirm_immediately: false, source: 'operator',
                }), '事件已登记，等待确认')}
              >登记待确认</button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void runAction(
                    'incident',
                    () =>
                      safetyApi.createIncident({
                        type: incidentForm.type,
                        description: incidentForm.description || '大屏登记事件',
                        severity: incidentForm.severity,
                        affected: affectedOf(incidentForm.target),
                        confirm_immediately: true,
                        source: 'operator',
                      }),
                    '事件已登记并确认，系统已重新规划与校验',
                  )
                }
              >
                登记并确认事件
              </button>
            </div>
            {draftSummary ? <p className="cc-muted cc-small">{draftSummary}</p> : null}
          </div>

          <h4 className="cc-subtitle" id="demos">演示场景</h4>
          <div className="cc-form-row">
            <select
              aria-label="演示场景"
              value={selectedDemo}
              onChange={event => setSelectedDemo(event.target.value)}
            >
              {(scenario?.demo_scenarios ?? []).map(demo => (
                <option key={demo.id} value={demo.id}>
                  {demo.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy !== null || !selectedDemo}
              onClick={() =>
                void runAction(
                  'demo',
                  async () => {
                    const result = await safetyApi.runDemo(selectedDemo);
                    setDemoResult(result);
                  },
                  '演示已执行',
                )
              }
            >
              运行演示
            </button>
          </div>
          {demoResult ? (
            <p className={`cc-small ${demoResult.matched ? 'cc-ok' : 'cc-bad'}`}>
              期望 {demoResult.expected_state} / 实际 {demoResult.actual_state} ·{' '}
              {demoResult.matched ? '一致' : '不一致'}
            </p>
          ) : null}

          <h4 className="cc-subtitle" id="audit">事件时间线（审计）</h4>
          <ul className="cc-timeline">
            {audit.slice(0, 12).map(entry => (
              <li key={entry.id} className={`audit-${entry.result}`}>
                <span className="cc-time">{formatTime(entry.ts)}</span>
                <span className="cc-actor">{entry.actor}</span>
                <span>{entry.summary}</span>
              </li>
            ))}
            {audit.length === 0 ? <li className="cc-muted">暂无审计记录</li> : null}
          </ul>
        </section>
      </div>
      <div id="perception-replay">
        <PerceptionReplayPanel />
      </div>
      <MvpPanels
        selectedRegion={selectedRegion}
        onSelectRegion={id => { if (id) selectRegion(id); }}
      />
    </div>
  );
}

function textOf(form: { description: string }, text: string): string {
  return (text || form.description || '').trim();
}

function formatAffected(affected: { region_ids: string[]; corridor_ids: string[]; exit_ids: string[] }): string {
  const parts = [
    ...affected.region_ids.map(id => `区域 ${id}`),
    ...affected.corridor_ids.map(id => `通道 ${id}`),
    ...affected.exit_ids.map(id => `出口 ${id}`),
  ];
  return parts.length > 0 ? parts.join('、') : '未识别';
}

function affectedOf(target: string): { region_ids: string[]; corridor_ids: string[]; exit_ids: string[] } {
  const [kind, id] = target.split(':');
  if (kind === 'exit') return { region_ids: [], corridor_ids: [], exit_ids: [id] };
  if (kind === 'corridor') return { region_ids: [], corridor_ids: [id], exit_ids: [] };
  return { region_ids: [id], corridor_ids: [], exit_ids: [] };
}

function PanelTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="cc-panel-title">
      <h3>{title}</h3>
      <span>{subtitle}</span>
    </div>
  );
}

function StateBadge({ state, headline }: { state: SafetyStateName; headline: string }) {
  return (
    <div className={`cc-state-badge state-${state}`} role="status">
      <strong>{state}</strong>
      <span>{STATE_LABEL[state]}</span>
      <em>{headline}</em>
    </div>
  );
}

function ProviderList({ providers }: { providers: ProviderStatus[] }) {
  if (providers.length === 0) return <p className="cc-muted">正在探测感知 provider…</p>;
  return (
    <ul className="cc-providers">
      {providers.map(provider => (
        <li key={provider.id} className={provider.available ? 'cc-ok' : 'cc-bad'}>
          <div>
            <strong>{provider.kind}</strong> · {provider.model_version}
          </div>
          <div className="cc-small">
            {provider.available ? '可用' : '不可用'} · 本机验证：
            {provider.verified_on_this_host ? '是' : '否'}
          </div>
          {provider.checks.some(check => !check.ok) ? <details><summary>查看诊断信息</summary>{provider.checks.filter(check => !check.ok).map(check => <div key={check.name} className="cc-small cc-muted">{check.name}：{check.detail}</div>)}</details> : null}
        </li>
      ))}
    </ul>
  );
}

function ValidationPanel({
  validation,
  candidateShown,
}: {
  validation: SafetyValidationResult | null;
  candidateShown: boolean;
}) {
  if (!validation) {
    return <p className="cc-muted">尚无校验记录。</p>;
  }
  return (
    <div className="cc-validation">
      <div className={validation.valid ? 'cc-badge cc-badge-ok' : 'cc-badge cc-badge-bad'}>
        {validation.valid ? '通过独立校验' : '未通过独立校验'}
      </div>
      <div className="cc-small cc-muted">
        校验于 {formatTime(validation.checked_at)} · {validation.checks_run.length} 项检查
      </div>
      {validation.violations.length > 0 ? (
        <ul className="cc-violations">
          {validation.violations.map((violation, index) => (
            <li key={`${violation.code}-${index}`} className={`severity-${violation.severity}`}>
              <code>{violation.code}</code> {violation.message}
            </li>
          ))}
        </ul>
      ) : null}
      {candidateShown && !validation.valid ? (
        <p className="cc-small cc-bad">当前展示的是候选方案，仅供人工研判，未经安全验证。</p>
      ) : null}
    </div>
  );
}

function ExitAllocation({ status, plan }: { status: SafetyStatus; plan: EvacuationPlan | null }) {
  return (
    <table className="cc-table">
      <thead>
        <tr>
          <th>出口</th>
          <th>有效状态</th>
          <th>容量（人/分）</th>
          <th>分配</th>
        </tr>
      </thead>
      <tbody>
        {status.exits.map(exit => {
          const allocated = plan ? (plan.exit_totals.find(item => item.exit_id === exit.id)?.persons ?? 0) : '—';
          const closed = exit.effective_status !== 'open' || !exit.usable;
          return (
            <tr key={exit.id} className={closed ? 'cc-closed' : undefined}>
              <td>
                {exit.name}
                <span className="cc-muted"> {exit.id}</span>
              </td>
              <td>
                {exit.effective_status}
                {exit.blocked_by_incident_id ? <span className="cc-muted"> (事件)</span> : null}
              </td>
              <td>{exit.capacity_per_min ?? '未知'}</td>
              <td>{allocated}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function IncidentPanel({
  incidents,
  onLocate,
  busy,
  onConfirm,
  onResolve,
}: {
  incidents: SafetyIncident[];
  onLocate: (incident: SafetyIncident) => void;
  busy: string | null;
  onConfirm: (id: string) => void;
  onResolve: (id: string) => void;
}) {
  if (incidents.length === 0) return <p className="cc-muted">当前无事件。</p>;
  return (
    <ul className="cc-incidents">
      {incidents.map(incident => (
        <li key={incident.id} className={`incident-${incident.status}`}>
          <div>
            <strong>{incident.type}</strong> · {incident.description}
          </div>
          <div className="cc-small cc-muted">
            状态 {incident.status} · 影响 {formatAffected(incident.affected)} · 上报 {formatTime(incident.reported_at)}
          </div>
          <div className="cc-form-row">
            {(incident.affected.region_ids.length + incident.affected.corridor_ids.length + incident.affected.exit_ids.length) > 0 ? <button type="button" onClick={() => onLocate(incident)}>定位关联区域</button> : null}
            {incident.status === 'reported' ? (
              <button type="button" disabled={busy !== null} onClick={() => onConfirm(incident.id)}>
                确认事件
              </button>
            ) : null}
            {incident.status === 'confirmed' ? (
              <button type="button" disabled={busy !== null} onClick={() => onResolve(incident.id)}>
                解除事件
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Legend({ isCandidate, hasPlan }: { isCandidate: boolean; hasPlan: boolean }) {
  return (
    <div className="cc-legend">
      <span className="legend-swatch validated" /> 已验证路线{hasPlan && !isCandidate ? '（当前显示）' : ''}
      <span className="legend-swatch candidate" /> 候选路线（未校验）
      <span className="legend-swatch closed" /> 已关闭通道/出口
      <span className="legend-swatch unknown" /> 状态未知
    </div>
  );
}

// ---------------------------------------------------------------------------
// 态势图
// ---------------------------------------------------------------------------

interface RouteGroup {
  key: string;
  fromRegionId: string;
  exitId: string;
  persons: number;
  points: Array<{ x: number; y: number }>;
  earliestMinute: number;
  latestMinute: number;
}

function centreOf(region: SafetyRegion): { x: number; y: number } {
  return { x: region.geometry.x + region.geometry.width / 2, y: region.geometry.y + region.geometry.height / 2 };
}

function groupRoutes(
  plan: EvacuationPlan | null,
  regions: SafetyRegion[],
  exits: SafetyStatus['exits'],
): RouteGroup[] {
  if (!plan) return [];
  const regionById = new Map(regions.map(region => [region.id, region]));
  const exitById = new Map(exits.map(exit => [exit.id, exit]));
  const groups = new Map<string, RouteGroup>();

  for (const route of plan.routes as EvacuationRoute[]) {
    const key = `${route.from_region_id}->${route.exit_id}`;
    const existing = groups.get(key);
    const points = buildRoutePoints(route, regionById, exitById);
    if (existing) {
      existing.persons += route.persons;
      existing.earliestMinute = Math.min(existing.earliestMinute, route.depart_minute);
      existing.latestMinute = Math.max(existing.latestMinute, route.arrive_minute);
      continue;
    }
    groups.set(key, {
      key,
      fromRegionId: route.from_region_id,
      exitId: route.exit_id,
      persons: route.persons,
      points,
      earliestMinute: route.depart_minute,
      latestMinute: route.arrive_minute,
    });
  }
  return [...groups.values()];
}

function buildRoutePoints(
  route: EvacuationRoute,
  regionById: Map<string, SafetyRegion>,
  exitById: Map<string, SafetyStatus['exits'][number]>,
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const origin = regionById.get(route.from_region_id);
  if (origin) points.push(centreOf(origin));
  for (const step of route.steps) {
    const region = regionById.get(step.to_region_id);
    if (region) points.push(centreOf(region));
  }
  const exit = exitById.get(route.exit_id);
  if (exit) {
    const region = regionById.get(exit.region_id);
    if (region) {
      points.push({
        x: region.geometry.x + region.geometry.width,
        y: region.geometry.y + region.geometry.height / 2,
      });
    }
  }
  return points;
}

function NetworkMap({ map, status, selectedRegion, onSelectRegion, allowRoutes, zoom, setZoom, center, setCenter, showBackdrop, layers }: { map?: ScenarioMap; allowRoutes: boolean; status: SafetyStatus; selectedRegion: string | null; onSelectRegion: (id: string) => void; zoom: number; setZoom: (value: number) => void; center: {x:number; y:number} | null; setCenter: (value: {x:number; y:number}) => void; showBackdrop: boolean; layers: {landmarks:boolean; regions:boolean; risks:boolean; corridors:boolean; validated:boolean; candidate:boolean; incidents:boolean} }) {
  const dragging = useRef<{x:number; y:number; centerX:number; centerY:number; scaleX:number; scaleY:number} | null>(null);
  const plan = status.plan;
  const candidate = status.candidate_plan;
  const showValidated = allowRoutes && Boolean(plan) && status.state.state !== 'REJECT' && status.state.validated_route_display_allowed;
  const showCandidate = allowRoutes && !showValidated && Boolean(candidate) && status.state.candidate_route_display_allowed;
  const activePlan = showValidated ? plan : showCandidate ? candidate : null;

  const bounds = useMemo(() => {
    let maxX = 0;
    let maxY = 0;
    for (const region of status.regions) {
      maxX = Math.max(maxX, region.geometry.x + region.geometry.width);
      maxY = Math.max(maxY, region.geometry.y + region.geometry.height);
    }
    return { width: maxX + 40, height: maxY + 40 };
  }, [status.regions]);

  const routes = useMemo(
    () => groupRoutes(activePlan, status.regions, status.exits),
    [activePlan, status.regions, status.exits],
  );

  const regionById = new Map(status.regions.map(region => [region.id, region]));

  // 把路线经过的通道高亮出来
  const highlighted = new Set<string>();
  for (const route of activePlan?.routes ?? []) {
    for (const step of route.steps) highlighted.add(step.corridor_id);
  }

  return (
    <svg
      className="cc-map"
      viewBox={`${(center?.x ?? bounds.width / 2) - bounds.width / zoom / 2} ${(center?.y ?? bounds.height / 2) - bounds.height / zoom / 2} ${bounds.width / zoom} ${bounds.height / zoom}`}
      onWheel={event => { const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return; const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()); const next = Math.max(1, Math.min(3, zoom * (event.deltaY < 0 ? 1.25 : .8))); const current = center ?? {x:bounds.width/2,y:bounds.height/2}; setCenter({x:point.x + (current.x-point.x)*zoom/next,y:point.y + (current.y-point.y)*zoom/next}); setZoom(next); }}
      onPointerDown={event => { if (event.button !== 0) return; const matrix=event.currentTarget.getScreenCTM(); if (!matrix) return; dragging.current={x:event.clientX,y:event.clientY,centerX:center?.x ?? bounds.width/2,centerY:center?.y ?? bounds.height/2,scaleX:matrix.a,scaleY:matrix.d}; }}
      onPointerMove={event => { const drag=dragging.current; if (drag) setCenter({x:drag.centerX-(event.clientX-drag.x)/drag.scaleX,y:drag.centerY-(event.clientY-drag.y)/drag.scaleY}); }}
      onPointerUp={() => { dragging.current=null; }} onPointerCancel={() => { dragging.current=null; }}
      role="img"
      aria-label="区域态势与疏散路线示意图"
    >
      <defs><marker id="route-arrow-valid" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#38ec83" /></marker><marker id="route-arrow-candidate" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#ffc166" /></marker></defs>
      <rect x={0} y={0} width={bounds.width} height={bounds.height} className="map-bg" />
      {showBackdrop && map?.backdrop ? <><image href={map.backdrop} x={0} y={0} width={bounds.width} height={bounds.height} preserveAspectRatio="xMidYMid slice" /><rect x={0} y={0} width={bounds.width} height={bounds.height} fill="#091310" opacity={map.backdrop_opacity ?? 0.48} /></> : null}

      {layers.landmarks && (map?.landmarks?.length ?? 0) > 0 ? <g className="map-landmarks" aria-label="场景地标，未空间标定">{(map?.landmarks ?? []).map(landmark => <g key={landmark.name}><circle cx={landmark.x * bounds.width} cy={landmark.y * bounds.height} r="3" /><text x={landmark.x * bounds.width + 7} y={landmark.y * bounds.height - 5}>{landmark.name}</text></g>)}</g> : null}
      {layers.corridors && status.corridors.map(corridor => {
        const from = regionById.get(corridor.from_region_id);
        const to = regionById.get(corridor.to_region_id);
        if (!from || !to) return null;
        const start = centreOf(from);
        const end = centreOf(to);
        const className =
          corridor.effective_status === 'closed' || !corridor.usable
            ? 'map-corridor map-corridor-closed'
            : corridor.effective_status === 'unknown'
              ? 'map-corridor map-corridor-unknown'
              : highlighted.has(corridor.id)
                ? 'map-corridor map-corridor-active'
                : 'map-corridor';
        return (
          <g key={corridor.id}>
            <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} className={`${className} ${selectedRegion && (corridor.from_region_id === selectedRegion || corridor.to_region_id === selectedRegion) ? 'map-related' : ''}`} />
            <title>
              {corridor.name} · 状态 {corridor.effective_status} · 容量 {corridor.capacity_per_min ?? '未知'} 人/分 ·{' '}
              {corridor.status_reason}
            </title>
            {selectedRegion && (corridor.from_region_id === selectedRegion || corridor.to_region_id === selectedRegion) ? <text x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 - 4} className="map-label">{corridor.id}</text> : null}
          </g>
        );
      })}

      {layers.regions && status.regions.map(region => {
        const risk = status.risks.find(item => item.regionId === region.id);
        const geometry = region.geometry;
        return (
          <g key={region.id} role="button" tabIndex={0} aria-label={`查看${region.name}详情`} onClick={() => onSelectRegion(region.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') onSelectRegion(region.id); }} className={selectedRegion === region.id ? 'map-selected' : selectedRegion ? 'map-dimmed' : ''}>
            <rect
              x={geometry.x}
              y={geometry.y}
              width={geometry.width}
              height={geometry.height}
              rx={10}
              className={`map-region risk-${layers.risks ? risk?.level ?? 'unknown' : 'unknown'}`}
            />
            <circle cx={centreOf(region).x} cy={centreOf(region).y} r={5} className={`map-node risk-${risk?.level ?? 'unknown'}`} />
            <text x={geometry.x + 12} y={geometry.y + 26} className="map-region-name">
              {region.name}
            </text>
            <text x={geometry.x + 12} y={geometry.y + 46} className="map-region-info">
              风险 {RISK_LABEL[risk?.level ?? 'unknown']}
              {risk && !risk.trusted ? '（数据不可信）' : ''}
            </text>
            <title>
              {region.name} · {risk?.count ?? '无数据'} 人 · 密度 {risk?.density?.toFixed(2) ?? '无数据'} · 置信度 {risk?.confidence ?? '无数据'} · 时间 {formatSince(risk?.observedAt)} · 面积 {region.area_m2} m² ({region.area_provenance}) · 摄像机标定{' '}
              {region.camera.calibration_status}
            </title>
          </g>
        );
      })}

      {layers.corridors && status.exits.map((exit, index) => {
        const region = regionById.get(exit.region_id);
        if (!region) return null;
        const y = region.geometry.y + region.geometry.height / 2 + index * 14 - 20;
        const x = region.geometry.x + region.geometry.width;
        return (
          <g key={exit.id}>
            <rect
              x={x - 6}
              y={y - 6}
              width={12}
              height={12}
              className={`map-exit ${exit.effective_status === 'open' && exit.usable ? 'map-exit-open' : 'map-exit-closed'}`}
            />
            <text x={x + 10} y={y + 4} className="map-exit-label">
              {exit.id}
            </text>
            <title>
              出口 {exit.name} · {exit.effective_status} · 容量 {exit.capacity_per_min ?? '未知'} 人/分
            </title>
          </g>
        );
      })}

      {layers.incidents && status.incidents.filter(incident => incident.status === 'confirmed' || incident.status === 'reported').map(incident => { const id = incident.affected.region_ids[0] ?? status.corridors.find(c => incident.affected.corridor_ids.includes(c.id))?.from_region_id ?? status.exits.find(e => incident.affected.exit_ids.includes(e.id))?.region_id; const region = status.regions.find(item => item.id === id); if (!region) return null; const point = centreOf(region); return <g key={incident.id}><circle cx={point.x+12} cy={point.y-12} r="6" className="map-incident" /><title>{incident.type} · {incident.description}</title></g>; })}
      {((showValidated && layers.validated) || (showCandidate && layers.candidate)) && routes.map(route => (
        <g key={route.key}>
          <polyline
            points={route.points.map(point => `${point.x},${point.y}`).join(' ')}
            className={showValidated ? 'map-route map-route-validated' : 'map-route map-route-candidate'}
            fill="none" markerEnd={showValidated ? 'url(#route-arrow-valid)' : 'url(#route-arrow-candidate)'}
          />
          <title>
            {route.fromRegionId} → {route.exitId} · {route.persons} 人 · t{route.earliestMinute}–{route.latestMinute} 分钟 ·{' '}
            {showValidated ? '已通过独立校验' : '候选方案，未通过校验'}
          </title>
        </g>
      ))}

      {routes.length > 0 && ((showValidated && layers.validated) || (showCandidate && layers.candidate))
        ? routes.map(route => {
            const last = route.points[route.points.length - 1];
            return (
              <text key={`${route.key}-label`} x={last.x - 46} y={last.y - 8} className="map-route-label">
                {route.persons}人
              </text>
            );
          })
        : null}
    </svg>
  );
}
