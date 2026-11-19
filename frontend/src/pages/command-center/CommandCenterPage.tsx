/**
 * SkyGuard 指挥大屏（/command-center）。
 *
 * 设计原则：
 *  - 所有内容来自后端真实 API（/api/v1/safety/*），页面本身不做任何安全判定；
 *  - 颜色永远与文字/原因同时出现，不单独依靠颜色传达状态；
 *  - 已验证方案与候选方案在视觉上严格区分；
 *  - REJECT 下不显示任何绿色路线，DEGRADED 下不把过期数据当成实时状态。
 */
import { useCallback, useEffect, useState } from 'react';
import safetyApi from '../../services/safetyApi';
import type {
  AuditEntry,
  ProviderStatus,
  SafetyScenarioSummary,
  SafetyStatus,
} from '../../services/safetyApi';
import { AppstoreOutlined, RadarChartOutlined, EyeOutlined, SafetyCertificateOutlined, AlertOutlined, HistoryOutlined, SettingOutlined, AimOutlined, TeamOutlined, ApiOutlined } from '@ant-design/icons';
import MvpPanels from './MvpPanels';
import PerceptionReplayPanel from './PerceptionReplayPanel';
import './CommandCenterPage.css';
import ThemeSettings, { useWorkspaceTheme } from './ThemeSettings';
import { MAP_FOCUS_ZOOM, MAP_MAX_ZOOM, MAP_MIN_ZOOM, MAP_ZOOM_STEP, RISK_LABEL, STATE_LABEL, affectedOf, centreOf, formatAffected, formatSince, formatTime, textOf } from './commandCenterUtils';
import { ExitAllocation, IncidentPanel, Legend, PanelTitle, ProviderList, StateBadge, ValidationPanel } from './components/Panels';
import NetworkMap from './components/NetworkMap';

const POLL_INTERVAL_MS = 5000;
const NAV_ITEMS = [
  { icon: <AppstoreOutlined />, label: '总览', target: 'overview' },
  { icon: <RadarChartOutlined />, label: '态势监控', target: 'situation' },
  { icon: <EyeOutlined />, label: 'AI 感知', target: 'sensors' },
  { icon: <AimOutlined />, label: '感知回放', target: 'perception-replay' },
  { icon: <SafetyCertificateOutlined />, label: '可信决策', target: 'decision' },
  { icon: <AlertOutlined />, label: '事件管理', target: 'incidents' },
  { icon: <HistoryOutlined />, label: '审计记录', target: 'audit' },
  { icon: <SettingOutlined />, label: '演示场景', target: 'operations' },
] as const;

export default function CommandCenterPage() {
  const workspaceTheme = useWorkspaceTheme();
  const [activeNav, setActiveNav] = useState<string>('overview');
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
  const [nlText, setNlText] = useState('');
  const [draftSummary, setDraftSummary] = useState<string | null>(null);
  const [incidentForm, setIncidentForm] = useState({
    type: 'fire',
    severity: 'critical',
    target: '',
    description: '',
  });
  // 实时流适配器状态来自 /safety/providers；浏览器不能直接播放 RTSP，
  // 这里只说明服务端推理链路是否可用，不伪装成可播放画面。
  const liveProvider = providers.find(provider => provider.kind === 'live_video');

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
      <div className="cc-root cc-loading" style={workspaceTheme.style} data-theme={workspaceTheme.mode}>
        <span className="cc-loading-ring" aria-hidden="true" />
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
  const selectRegion = (id: string) => { const region = status.regions.find(item => item.id === id); setSelectedRegion(id); if (region) { setMapCenter(centreOf(region)); setMapZoom(value => Math.max(value, MAP_FOCUS_ZOOM)); } };

  return (
    <div className="cc-root" style={workspaceTheme.style} data-theme={workspaceTheme.mode}>
      <h1 className="cc-sr-only">SkyGuard 可信安全决策指挥中心</h1>
      <nav className="cc-sidebar" aria-label="指挥中心导航">
        <div className="cc-sidebar-brand" aria-hidden="true"><SafetyCertificateOutlined /></div>
        {NAV_ITEMS.map(item => (
          <a
            key={item.target}
            href={`#${item.target}`}
            title={item.label}
            aria-label={item.label}
            aria-current={activeNav === item.target ? 'page' : undefined}
            className={activeNav === item.target ? 'active' : undefined}
            onClick={() => setActiveNav(item.target)}
          >
            {item.icon}<span>{item.label}</span>
          </a>
        ))}
      </nav>
      <header className="cc-topbar" id="overview">
        <div className="cc-brand">
          <span className="cc-brand-emblem" aria-hidden="true"><SafetyCertificateOutlined /></span>
          <span className="cc-brand-copy">
            <span className="cc-brand-mark">SKYGUARD</span>
            <span className="cc-brand-sub">可信安全决策指挥中心</span>
          </span>
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
        <ThemeSettings {...workspaceTheme} />
      </header>

      {status.scenario.notice ? <div className="cc-disclaimer"><AlertOutlined aria-hidden="true" />{status.scenario.notice}</div> : null}
      {error ? <div className="cc-banner cc-banner-error">{error}</div> : null}
      {notice ? <div className="cc-banner">{notice}</div> : null}

      <div className="cc-kpis" role="group" aria-label="关键指标">
        <div className="cc-kpi">
          <span className="cc-kpi-icon" aria-hidden="true"><AppstoreOutlined /></span>
          <div><span>感知区域</span><strong>{status.regions.length}</strong><small>个区域</small></div>
        </div>
        <div className="cc-kpi">
          <span className="cc-kpi-icon" aria-hidden="true"><TeamOutlined /></span>
          <div>
            <span>观测人数</span>
            <strong>{status.observations.length ? status.observations.reduce((sum, item) => sum + item.estimated_count, 0) : '—'}</strong>
            <small>{status.state.state === 'DEGRADED' ? '数据可能过期' : '观测值'}</small>
          </div>
        </div>
        <div className="cc-kpi" data-tone="warn">
          <span className="cc-kpi-icon" aria-hidden="true"><AlertOutlined /></span>
          <div>
            <span>高风险区域</span>
            <strong>{status.risks.some(risk => risk.trusted) ? (status.risk_summary.counts.high ?? 0) + (status.risk_summary.counts.critical ?? 0) : '—'}</strong>
            <small>{status.risks.some(risk => risk.trusted) ? '个区域' : '无可信观测'}</small>
          </div>
        </div>
        <div className="cc-kpi" data-value="text" data-tone={!error && status.state.publishable ? 'ok' : 'bad'}>
          <span className="cc-kpi-icon" aria-hidden="true"><SafetyCertificateOutlined /></span>
          <div>
            <span>可信方案</span>
            <strong>{!error && status.state.publishable ? '可发布' : '不可发布'}</strong>
            <small>方案状态 {status.state.state}</small>
          </div>
        </div>
        <div className="cc-kpi" data-value="text" data-tone={status.inference_health.healthy ? 'ok' : 'bad'}>
          <span className="cc-kpi-icon" aria-hidden="true"><ApiOutlined /></span>
          <div>
            <span>推理链路</span>
            <strong>{status.inference_health.healthy ? '正常' : '异常'}</strong>
            <small>健康状态</small>
          </div>
        </div>
      </div>

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
          <div className="cc-observations" role="region" aria-label="各区域观测表" tabIndex={0}><table className="cc-table">
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
          </table></div>
          <p className="cc-muted cc-small">
            面积来源：{status.regions.map(region => region.area_provenance).filter((value, index, array) => array.indexOf(value) === index).join(' / ')}
            ；摄像机标定：{status.regions.map(region => region.camera.calibration_status).filter((value, index, array) => array.indexOf(value) === index).join(' / ')}
          </p>
        </section>

        {/* ---------------- 中列：态势图 ---------------- */}
        <section className="cc-panel cc-col-center" id="situation">
          <PanelTitle
            title="区域态势与疏散路线"
            subtitle={`时限 ${status.scenario.horizon_minutes} 分钟 · ${displayPlan ? `方案 ${displayPlan.plan_id}` : '暂无方案'}`}
          />
          <div className="cc-map-wrap"><NetworkMap map={scenario?.map} status={status} selectedRegion={selectedRegion} onSelectRegion={selectRegion} allowRoutes={!error} zoom={mapZoom} setZoom={setMapZoom} center={mapCenter} setCenter={setMapCenter} showBackdrop={showBackdrop} layers={layers} />
            <div className="cc-map-tools" aria-label="地图工具"><button type="button" title="放大" aria-label="放大地图" disabled={mapZoom >= MAP_MAX_ZOOM} onClick={() => setMapZoom(value => Math.min(MAP_MAX_ZOOM, value + MAP_ZOOM_STEP))}>+</button><button type="button" title="缩小" aria-label="缩小地图" disabled={mapZoom <= MAP_MIN_ZOOM} onClick={() => setMapZoom(value => Math.max(MAP_MIN_ZOOM, value - MAP_ZOOM_STEP))}>−</button><button type="button" onClick={() => setShowLayers(value => !value)} aria-expanded={showLayers} title="选择地图图层">图层</button><button type="button" onClick={() => { setMapZoom(MAP_MIN_ZOOM); setMapCenter(null); setSelectedRegion(null); }} title="重置视图">复位</button></div>
            {showLayers ? <div className="cc-layer-menu"><label><input type="checkbox" checked={showBackdrop} onChange={() => setShowBackdrop(value => !value)} />概念底图</label>{([['landmarks','场景地标'],['regions','模拟区域'],['risks','风险区域'],['corridors','通道与出口'],['validated','已验证路线'],['candidate','候选路线'],['incidents','事件标记']] as const).map(([key,label]) => <label key={key}><input type="checkbox" checked={layers[key]} onChange={() => setLayers(value => ({...value,[key]: !value[key]}))} />{label}</label>)}</div> : null}
            {selectedRegion ? <div className="cc-map-detail"><strong>{status.regions.find(region => region.id === selectedRegion)?.name}</strong><span>风险：{RISK_LABEL[status.risks.find(risk => risk.regionId === selectedRegion)?.level ?? 'unknown']}</span><span>人数：{status.risks.find(risk => risk.regionId === selectedRegion)?.count ?? '—'} · 密度：{status.risks.find(risk => risk.regionId === selectedRegion)?.density?.toFixed(2) ?? '—'}</span><span>置信度：{status.risks.find(risk => risk.regionId === selectedRegion)?.confidence ?? '—'} · 时效：{formatSince(status.observations.find(item => item.region_id === selectedRegion)?.observed_at)}</span><span>来源：{status.observations.find(item => item.region_id === selectedRegion)?.source ?? '无数据'}</span><button type="button" onClick={() => setSelectedRegion(null)}>关闭</button></div> : null}</div>
          <div className="cc-map-caption"><strong>场馆态势</strong><span>{scenario?.map?.caption ?? '合成场景 · 区域未空间标定'} · 行：门区 / 滩顶 / 生态 / 亲水 · 点选区域查看详情</span></div>
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
          <h4 className="cc-subtitle">风险告警 · {status.incidents.length} 条</h4><div className="cc-alert-summary">{status.incidents.length ? status.incidents.slice(0,4).map(incident => <button key={incident.id} type="button" onClick={() => { const c = status.corridors.find(item => incident.affected.corridor_ids.includes(item.id)); const e = status.exits.find(item => incident.affected.exit_ids.includes(item.id)); const id = incident.affected.region_ids[0] ?? c?.from_region_id ?? e?.region_id; if (id) selectRegion(id); }}><span className={`cc-alert-dot severity-${incident.severity}`} /><strong>{incident.type}</strong><span>{formatAffected(incident.affected)}</span><small>{incident.status} · {formatTime(incident.reported_at)}</small></button>) : <p className="cc-muted">暂无事件告警</p>}</div>
          <div className="cc-video"><h4>视频与感知画面 <span className="cc-muted">{liveProvider?.verified_on_this_host ? '实时流本机已跑通' : liveProvider?.available ? '实时流适配器可用' : '视频源未接入'}</span></h4><div className="cc-video-empty"><span className="cc-video-signal" aria-hidden="true"><EyeOutlined /></span><strong>{status.regions.find(region => region.id === videoRegion)?.name ?? '请选择监测区域'}</strong><span>{liveProvider?.available ? '服务端可读 RTSP/RTMP · 浏览器不回放 RTSP' : '无可播放视频 · 非实时画面'}</span><small className={liveProvider?.available ? 'cc-video-online' : 'cc-video-offline'}>{liveProvider?.available ? 'STREAM ADAPTER READY' : 'SIGNAL OFFLINE'}</small></div><div className="cc-video-thumbs" aria-label="选择监测区域">{status.regions.slice(0,4).map(region => <button type="button" key={region.id} className={videoRegion === region.id ? 'selected' : ''} aria-pressed={videoRegion === region.id} onClick={() => setVideoRegion(region.id)}><EyeOutlined /><span>{region.name}</span><small>未接入</small></button>)}</div><div className="cc-video-foot">{liveProvider?.available ? '来源：实时流适配器（OpenCV/FFmpeg） · 浏览器播放需 HLS/WebRTC 网关' : '来源：未配置视频流 · 时间：—'}</div></div>

          <h4 className="cc-subtitle">出口分配</h4>
          <ExitAllocation status={status} plan={displayPlan} />

          <h4 className="cc-subtitle" id="incidents">事件管理</h4>
          <IncidentPanel
            incidents={status.incidents}
            onLocate={incident => {
              const corridor = status.corridors.find(item => incident.affected.corridor_ids.includes(item.id));
              const exit = status.exits.find(item => incident.affected.exit_ids.includes(item.id));
              const regionId = incident.affected.region_ids[0] ?? corridor?.from_region_id ?? exit?.region_id;
              if (regionId) {
                selectRegion(regionId);
                const reduceMotion = typeof window.matchMedia === 'function'
                  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                document.getElementById('situation')?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
              }
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
      <section className="cc-lower" aria-label="业务闭环与感知回放">
        <div className="cc-section-head">
          <div>
            <span className="cc-eyebrow">OPERATIONS WORKSPACE</span>
            <h2>业务闭环与感知回放</h2>
            <p>从感知证据到工单闭环的可审计链路；所有面板数据均来自后端 API，前端不做安全判定。</p>
          </div>
          <div className="cc-section-meta">
            <span><i aria-hidden="true" />只读大屏</span>
            <span>Agent 仅创建待审批工单</span>
          </div>
        </div>
        <div id="perception-replay">
          <PerceptionReplayPanel />
        </div>
        <MvpPanels
          selectedRegion={selectedRegion}
          onSelectRegion={id => { if (id) selectRegion(id); }}
          onDataChanged={() => void refresh()}
        />
      </section>
      <footer className="cc-footer">
        <span>SKYGUARD · 研究原型</span>
        <span>不得用于真实应急指挥 · 安全判定由后端安全内核完成</span>
        <span className="cc-footer-version">SCENARIO v{status.versions.scenario}</span>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 态势图
// ---------------------------------------------------------------------------
