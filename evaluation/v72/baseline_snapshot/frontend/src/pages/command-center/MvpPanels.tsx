/**
 * 指挥中心 MVP 面板：预测、摄像头、Agent 调查、工作人员、审批与工单闭环。
 * 所有动态数据均来自后端 API；前端不写死演示结果。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AimOutlined } from '@ant-design/icons';
import mvpApi, { type AgentRun, type MvpDashboard, type MultiRegionAnalysis, type V70ForecastPreview, type V70JointPreview, type WorkOrder } from '../../services/mvpApi';
import safetyApi, { type V70MpcPreview } from '../../services/safetyApi';
import './MvpPanels.css';

interface Props {
  selectedRegion: string | null;
  onSelectRegion: (id: string | null) => void;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING_APPROVAL: '待审批',
  APPROVED: '已批准',
  REJECTED: '已拒绝',
  ASSIGNED: '已派发',
  ACCEPTED: '已接单',
  IN_PROGRESS: '执行中',
  COMPLETED: '已完成',
  FAILED: '失败',
};

const TYPE_LABEL: Record<string, string> = {
  scene_verification: '现场核查',
  crowd_control: '人流疏导',
  corridor_check: '通道确认',
  camera_observation: '摄像补充',
  uav_observation: '无人机观察',
};

function errorMessage(error: unknown): string {
  const response = (error as { response?: { data?: { error?: { message?: string } | string } } }).response;
  const data = response?.data?.error;
  if (typeof data === 'string') return data;
  if (data?.message) return data.message;
  return (error as Error).message;
}

function fmtTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('zh-CN', { hour12: false });
}

function pct(value: number | null): string {
  return value === null ? '—' : value.toFixed(3);
}

export default function MvpPanels({ selectedRegion, onSelectRegion }: Props) {
  const [dashboard, setDashboard] = useState<MvpDashboard | null>(null);
  const [experiments, setExperiments] = useState<Awaited<ReturnType<typeof mvpApi.experiments>> | null>(null);
  const [multi, setMulti] = useState<MultiRegionAnalysis | null>(null);
  const [v70, setV70] = useState<{
    forecast: V70ForecastPreview;
    joint: V70JointPreview;
    mpc: V70MpcPreview;
  } | null>(null);
  const [v70Busy, setV70Busy] = useState(false);
  const [v70Error, setV70Error] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [agentRegion, setAgentRegion] = useState<string>(selectedRegion ?? '');
  const [run, setRun] = useState<AgentRun | null>(null);
  const [orderFilter, setOrderFilter] = useState<'all' | 'pending' | 'active' | 'closed'>('all');
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const [staffIdInput, setStaffIdInput] = useState('');
  const [staffCodeInput, setStaffCodeInput] = useState('');
  const [staffSession, setStaffSession] = useState(() => {
    try {
      return {
        token: localStorage.getItem('staff_token') ?? '',
        id: localStorage.getItem('staff_id') ?? '',
        name: localStorage.getItem('staff_name') ?? '',
      };
    } catch {
      return { token: '', id: '', name: '' };
    }
  });
  const [feedback, setFeedback] = useState<{ orderId: string; count: string; confidence: string; note: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await mvpApi.dashboard();
      setDashboard(next);
      setError(null);
    } catch (caught) {
      setError(`无法读取 MVP 态势：${errorMessage(caught)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const loadV70 = useCallback(async () => {
    const region = selectedRegion ?? dashboard?.predictions[0]?.region_id ?? '';
    if (!region) {
      setV70Error('请先选择一个区域');
      return;
    }
    setV70Busy(true);
    setV70Error(null);
    try {
      const [forecast, joint, mpc] = await Promise.all([
        mvpApi.v70Forecast(region, 5),
        mvpApi.v70Joint(region),
        safetyApi.v70Mpc(),
      ]);
      setV70({ forecast, joint, mpc });
    } catch (caught) {
      setV70Error(`V7 预览失败：${errorMessage(caught)}`);
    } finally {
      setV70Busy(false);
    }
  }, [selectedRegion, dashboard]);

  useEffect(() => {
    mvpApi.experiments().then(setExperiments).catch(() => setExperiments(null));
  }, []);

  useEffect(() => {
    const load = () => {
      mvpApi.multiRegion(selectedRegion ?? undefined).then(setMulti).catch(() => setMulti(null));
    };
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [selectedRegion]);

  useEffect(() => {
    if (selectedRegion) setAgentRegion(selectedRegion);
  }, [selectedRegion]);

  useEffect(() => {
    if (!feedback) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && busy === null) setFeedback(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [feedback, busy]);

  const act = useCallback(async (key: string, action: () => Promise<unknown>, message: string): Promise<boolean> => {
    setBusy(key);
    setNotice(null);
    setError(null);
    try {
      await action();
      setNotice(message);
      await refresh();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const regions = dashboard?.safety.regions ?? [];
  const shownRun = run ?? dashboard?.agent_runs?.[0] ?? null;
  const orders = useMemo(() => {
    const list = dashboard?.work_orders ?? [];
    if (orderFilter === 'pending') return list.filter(order => order.status === 'PENDING_APPROVAL');
    if (orderFilter === 'active') {
      return list.filter(order => ['APPROVED', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'].includes(order.status));
    }
    if (orderFilter === 'closed') return list.filter(order => ['COMPLETED', 'FAILED', 'REJECTED'].includes(order.status));
    return list;
  }, [dashboard, orderFilter]);

  const mode = dashboard?.agentarts.mode ?? 'LOCAL_DEMO';
  const modeClass = mode === 'AGENTARTS_CONNECTED' ? 'ok' : mode === 'AGENTARTS_UNAVAILABLE' ? 'bad' : 'warn';
  const connectivity = dashboard?.agentarts.connectivity;
  const connectivityLabel = connectivity === 'reachable'
    ? '可达'
    : connectivity === 'unreachable'
      ? '不可达'
      : connectivity === 'misconfigured'
        ? '配置不完整'
        : '未探测';
  const closureVerified = dashboard?.agentarts.business_closure?.verified === true;

  async function loginStaff() {
    const session = await mvpApi.staffLogin(staffIdInput.trim(), staffCodeInput.trim());
    localStorage.setItem('staff_token', session.access_token);
    localStorage.setItem('staff_id', session.staff_id);
    localStorage.setItem('staff_name', session.username);
    setStaffSession({ token: session.access_token, id: session.staff_id, name: session.username });
    setStaffCodeInput('');
  }

  function logoutStaff() {
    localStorage.removeItem('staff_token');
    localStorage.removeItem('staff_id');
    localStorage.removeItem('staff_name');
    setStaffSession({ token: '', id: '', name: '' });
  }

  async function submitFeedback() {
    if (!feedback) return;
    const count = Number(feedback.count);
    const confidence = Number(feedback.confidence);
    if (!Number.isFinite(count) || count < 0) {
      setError('反馈人数必须是非负数字');
      return;
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      setError('置信度必须在 0~1 之间');
      return;
    }
    const ok = await act('feedback', () => mvpApi.complete(feedback.orderId, {
      note: feedback.note || '现场反馈',
      observation: { count, confidence, valid: true },
    }), '反馈已提交，系统已触发重新评估');
    if (ok) setFeedback(null);
  }

  function renderOrderActions(order: WorkOrder) {
    const isAssignedToMe = order.assigned_staff_id === staffSession.id && Boolean(staffSession.token);
    switch (order.status) {
      case 'PENDING_APPROVAL':
        return (
          <div className="mvp-actions">
            <button type="button" disabled={busy !== null} onClick={() => void act('approve', () => mvpApi.approve(order.id, '控制台审批通过'), `已批准 ${order.id}`)}>批准</button>
            <button type="button" className="danger" disabled={busy !== null} onClick={() => {
              const note = window.prompt('拒绝原因', '当前资源不足') ?? '';
              if (note.trim()) void act('reject', () => mvpApi.reject(order.id, note), `已拒绝 ${order.id}`);
            }}>拒绝</button>
          </div>
        );
      case 'APPROVED':
        return (
          <div className="mvp-actions">
            <button type="button" disabled={busy !== null} onClick={() => void act('assign', () => mvpApi.assign(order.id), `已派发 ${order.id}`)}>自动派发</button>
          </div>
        );
      case 'ASSIGNED':
        return (
          <div className="mvp-actions">
            <button type="button" disabled={busy !== null || !isAssignedToMe} title={isAssignedToMe ? '' : '需以被指派的工作人员身份登录'} onClick={() => void act('accept', () => mvpApi.accept(order.id), `已接单 ${order.id}`)}>接单</button>
          </div>
        );
      case 'ACCEPTED':
        return (
          <div className="mvp-actions">
            <button type="button" disabled={busy !== null || !isAssignedToMe} onClick={() => void act('start', () => mvpApi.start(order.id), `开始执行 ${order.id}`)}>开始执行</button>
          </div>
        );
      case 'IN_PROGRESS':
        return (
          <div className="mvp-actions">
            <button type="button" disabled={busy !== null || !isAssignedToMe} onClick={() => setFeedback({ orderId: order.id, count: '', confidence: '0.95', note: '' })}>提交反馈并完成</button>
            <button type="button" className="danger" disabled={busy !== null || !isAssignedToMe} onClick={() => {
              const reason = window.prompt('失败原因', '现场无法进入') ?? '';
              if (reason.trim()) void act('fail', () => mvpApi.fail(order.id, reason), `已标记失败 ${order.id}`);
            }}>标记失败</button>
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <section className="mvp" aria-label="MVP 业务闭环">
      <header className="mvp-header">
        <div>
          <h2>现场协同管理</h2>
          <p>{dashboard?.scenario.name ?? '加载中'} · {dashboard?.scenario.venue?.name ?? ''}</p>
        </div>
        <div className="mvp-header-right">
          <span className={`mvp-mode ${modeClass}`}>{mode === 'AGENTARTS_CONNECTED' ? 'AGENTARTS CONNECTED' : mode === 'AGENTARTS_UNAVAILABLE' ? 'AGENTARTS UNAVAILABLE' : 'LOCAL DEMO'}</span>
          <span className="mvp-muted">{dashboard?.agentarts.detail ?? '本地演示模式'}</span>
          {dashboard?.agentarts.runtime_requested === 'agentarts' && (
            <span className="mvp-muted" title="平台可达性只说明网络探测结果，不代表完整业务闭环已验证">
              可达性 {connectivityLabel} · 业务闭环 {closureVerified ? '已验证' : '未验证'}
            </span>
          )}
          {dashboard?.state_store?.enabled && (
            <span className="mvp-muted" title={dashboard.state_store.path ?? ''}>
              状态快照 rev {dashboard.state_store.revision}{dashboard.state_store.writable ? '' : ' · 只读'}
            </span>
          )}
          <a className="mvp-link" href="/staff">工作人员移动端</a>
          <button type="button" disabled={busy !== null} onClick={() => void act('demo-A', async () => {
            const result = await mvpApi.runDemo('A_normal');
            setRun(result.run);
          }, '一键推演 A 完成')}>推演 A</button>
          <button type="button" disabled={busy !== null} onClick={() => void act('demo-B', async () => {
            const result = await mvpApi.runDemo('B_surge');
            setRun(result.run);
          }, '一键推演 B 完成')}>推演 B</button>
          <button type="button" disabled={busy !== null} onClick={() => void act('demo-C', async () => {
            const result = await mvpApi.runDemo('C_untrusted');
            setRun(result.run);
          }, '一键推演 C 完成')}>推演 C</button>
          <button type="button" disabled={busy !== null} onClick={() => void act('reset', async () => {
            await mvpApi.reset();
            setRun(null);
            setFeedback(null);
          }, '演示已重置')}>重置</button>
          <button type="button" onClick={() => void refresh()} disabled={busy !== null}>刷新</button>
        </div>
      </header>

      {dashboard?.scenario.notice ? <p className="mvp-disclaimer">⚠ {dashboard.scenario.notice}</p> : null}
      {notice ? <p className="mvp-notice">{notice}</p> : null}
      {error ? <p className="mvp-error" role="alert">{error}</p> : null}

      <div className="mvp-grid">
        {/* Agent 控制台 */}
        <section className="mvp-panel mvp-span-2">
          <div className="mvp-panel-title">
            <h3>Agent 控制台</h3>
            <span>{shownRun ? `${shownRun.run_id} · ${shownRun.status}` : '尚未运行'}</span>
          </div>
          <div className="mvp-row">
            <label>
              调查区域
              <select value={agentRegion} onChange={event => setAgentRegion(event.target.value)}>
                <option value="">请选择区域</option>
                {regions.map(region => (
                  <option key={region.id} value={region.id}>{region.name}（{region.id}）</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="primary"
              disabled={busy !== null || !agentRegion}
              onClick={() => void act('agent', async () => {
                const result = await mvpApi.runAgent(agentRegion, 'console_manual');
                setRun(result);
              }, 'Agent 运行完成')}
            >
              {busy === 'agent' ? '运行中…' : '运行 Agent'}
            </button>
            {shownRun ? <span className={`mvp-chip ${shownRun.status === 'completed' ? 'ok' : shownRun.status === 'failed' ? 'bad' : 'warn'}`}>{shownRun.status}</span> : null}
          </div>

          {shownRun ? (
            <>
              <p className="mvp-summary">{shownRun.summary}</p>
              <div className="mvp-kpis">
                <div><span>安全状态</span><strong>{shownRun.state?.state ?? '—'}</strong></div>
                <div><span>信息缺口</span><strong>{shownRun.investigation.required ? '是' : '否'}</strong></div>
                <div><span>调查轮次</span><strong>{shownRun.investigation.rounds.length}</strong></div>
                <div><span>工具调用</span><strong>{shownRun.trace.length}</strong></div>
                <div><span>信念熵</span><strong>{shownRun.entropy_before_bits ?? '—'} → {shownRun.entropy_after_bits ?? '—'}</strong></div>
                <div><span>预期风险</span><strong>{pct(shownRun.risk_before)} → {pct(shownRun.risk_after)}</strong></div>
              </div>
              <div className="mvp-belief">
                <span>后验：</span>
                {shownRun.belief_after.map(item => (
                  <span key={item.hypothesis_id} className="mvp-chip">{item.label} {item.probability.toFixed(3)}</span>
                ))}
                <span className="mvp-muted">停止原因：{shownRun.investigation.stopped_reason ?? '—'}</span>
              </div>

              {shownRun.investigation.rounds.map(round => (
                <div key={round.round} className="mvp-round">
                  <h4>第 {round.round} 轮 · 选择 {round.selected_action_id ?? '无'}（{round.selected_kind ?? '—'}）→ {round.outcome ?? '—'}{round.pending ? ' · 待人工证据' : ''}</h4>
                  <table className="mvp-table">
                    <thead><tr><th>动作</th><th>VoI</th><th>信息增益</th><th>Δ风险</th><th>时间</th><th>资源</th><th>可用</th></tr></thead>
                    <tbody>
                      {round.decision.evaluations.map(evaluation => (
                        <tr key={evaluation.action_id} className={evaluation.action_id === round.selected_action_id ? 'selected' : ''}>
                          <td>{evaluation.label}</td>
                          <td>{evaluation.score === null ? '—' : evaluation.score.toFixed(3)}</td>
                          <td>{evaluation.information_gain_bits.toFixed(3)}</td>
                          <td>{evaluation.risk_reduction.toFixed(3)}</td>
                          <td>{evaluation.time_cost_normalized.toFixed(2)}</td>
                          <td>{evaluation.resource_cost_normalized.toFixed(2)}</td>
                          <td>{evaluation.available ? '可用' : `不可用（${evaluation.unavailable_reason ?? '—'}）`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}

              <h4>工具调用 Trace</h4>
              <ul className="mvp-trace">
                {shownRun.trace.map(item => (
                  <li key={`${item.seq}-${item.tool}`} className={item.ok ? '' : 'failed'}>
                    <span className="mvp-muted">{item.seq}</span>
                    <code>{item.tool}</code>
                    <span>{item.result_summary}</span>
                    <span className="mvp-muted">{item.source} · {item.duration_ms}ms{item.confidence === null ? '' : ` · 置信 ${item.confidence}`}</span>
                  </li>
                ))}
              </ul>

              <h4>Agent 建议</h4>
              <ul className="mvp-list">
                {shownRun.recommendations.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
              <p className="mvp-muted mvp-small">{shownRun.limitations.join(' ')}</p>
            </>
          ) : (
            <div className="mvp-empty">
              <span className="mvp-empty-orbit" aria-hidden="true"><AimOutlined /></span>
              <strong>Agent 待命</strong>
              <span>选择调查区域并运行 Agent，查看调查决策、工具调用、信念更新与建议。Agent 只创建待审批工单，不会直接派发或控制现场资源。</span>
            </div>
          )}
        </section>

        {/* 预测 */}
        <section className="mvp-panel">
          <div className="mvp-panel-title"><h3>短时人流预测</h3><span>ema-linear-v1 · 5 分钟</span></div>
          <div className="mvp-cards">
            {(dashboard?.predictions ?? []).map(prediction => (
              <button
                type="button"
                key={prediction.region_id}
                className={`mvp-pred-card ${selectedRegion === prediction.region_id ? 'selected' : ''}`}
                onClick={() => onSelectRegion(prediction.region_id)}
              >
                <strong>{prediction.region_name}</strong>
                <span className="mvp-pred-value">
                  {prediction.current_count ?? '—'} → {prediction.predicted_count ?? '—'}
                  {prediction.interval ? <small>（{prediction.interval.lower}~{prediction.interval.upper}）</small> : null}
                </span>
                <span className={`mvp-chip ${prediction.trend.direction === 'rising' ? 'warn' : prediction.trend.direction === 'falling' ? 'ok' : ''}`}>
                  {prediction.trend.direction === 'rising' ? '↑ 上升' : prediction.trend.direction === 'falling' ? '↓ 下降' : prediction.trend.direction === 'stable' ? '→ 平稳' : '数据不足'}
                  {prediction.trend.rate_per_minute !== null ? ` ${prediction.trend.rate_per_minute}/min` : ''}
                </span>
                <span className="mvp-muted mvp-small">{prediction.sufficient ? `${prediction.input.points} 个可信观测` : '数据不足'} · {prediction.data_quality.note}</span>
              </button>
            ))}
            {(dashboard?.predictions ?? []).length === 0 ? <p className="mvp-muted">暂无预测数据</p> : null}
          </div>
        </section>

        {/* V7 研究预览（显式触发，只读） */}
        <section className="mvp-panel">
          <div className="mvp-panel-title"><h3>V7 研究预览</h3><span>预测 / 联合 VoI / MPC</span></div>
          <p className="mvp-muted mvp-small">
            研究级、合成参数未标定；只读，不改变安全状态；带预测到达的 MPC 步骤是条件投影，不声明“已验证”。
          </p>
          <button type="button" className="primary" onClick={() => void loadV70()} disabled={v70Busy}>
            {v70Busy ? '计算中…' : '运行 V7 预览'}
          </button>
          {v70Error ? <p className="mvp-muted mvp-small">{v70Error}</p> : null}
          {v70 ? (
            <div className="mvp-v70-grid">
              <div className="mvp-v70-card">
                <strong>集成预测</strong>
                {v70.forecast.available && v70.forecast.result ? (
                  <>
                    <span className="mvp-pred-value">
                      {v70.forecast.result.predicted}
                      <small>（{v70.forecast.result.interval95.lower}~{v70.forecast.result.interval95.upper}）</small>
                    </span>
                    <span className="mvp-muted mvp-small">
                      {v70.forecast.result.regime.label} · 可靠性 {v70.forecast.result.reliability.status}
                      {v70.forecast.result.reliability.reasons.length > 0 ? ` · ${v70.forecast.result.reliability.reasons.join('、')}` : ''}
                    </span>
                    <span className="mvp-muted mvp-small">候选：{v70.forecast.result.effective_methods.join(' / ')}</span>
                  </>
                ) : <span className="mvp-muted mvp-small">{v70.forecast.reason ?? '不可用'}</span>}
              </div>
              <div className="mvp-v70-card">
                <strong>联合 VoI</strong>
                {v70.joint.available && v70.joint.decision ? (
                  <>
                    <span className="mvp-muted mvp-small">
                      选择：{v70.joint.decision.selected.map(item => item.action_id).join(' → ') || '无'}
                    </span>
                    <span className="mvp-muted mvp-small">
                      预期风险降低 {v70.joint.decision.total_expected_risk_reduction.toFixed(4)} · 停止：{v70.joint.decision.stop_reason ?? '—'}
                    </span>
                    <span className="mvp-muted mvp-small">
                      相关性 {v70.joint.decision.config.correlation} · 参数来源 {v70.joint.decision.config.source}
                    </span>
                  </>
                ) : <span className="mvp-muted mvp-small">{v70.joint.reason ?? '不可用'}</span>}
              </div>
              <div className="mvp-v70-card">
                <strong>MPC 投影</strong>
                {v70.mpc.available && v70.mpc.projection ? (
                  <>
                    <span className="mvp-muted mvp-small">
                      {v70.mpc.steps?.length ?? 0} 控制步 · 完成 {v70.mpc.projection.completed_persons}/{v70.mpc.projection.total_input_persons}
                    </span>
                    <span className="mvp-muted mvp-small">
                      未疏散 {v70.mpc.projection.unserved_persons} · 完成时间 {v70.mpc.projection.makespan_minute} min
                    </span>
                    <span className="mvp-muted mvp-small">
                      队列 {v70.mpc.projection.total_queue_person_minutes.toFixed(0)} 人·分钟 · 第一步校验
                      {v70.mpc.steps?.[0]?.validation.performed
                        ? (v70.mpc.steps[0].validation.valid ? '通过' : '未通过')
                        : '未执行（条件投影）'}
                    </span>
                  </>
                ) : <span className="mvp-muted mvp-small">{v70.mpc.reason ?? '不可用'}</span>}
              </div>
            </div>
          ) : null}
        </section>

        {/* 摄像头 + 人员 */}
        <section className="mvp-panel mvp-cams">
          <div className="mvp-panel-title"><h3>摄像头状态</h3><span>{dashboard?.cameras.length ?? 0} 路</span></div>
          <ul className="mvp-health">
            {(dashboard?.cameras ?? []).map(camera => (
              <li key={camera.region_id}>
                <span className={`mvp-dot ${camera.state}`} aria-hidden="true" />
                <div>
                  <strong>{camera.region_name}</strong>
                  <span className="mvp-muted mvp-small">{camera.camera_id} · {camera.state} · {camera.reason}{camera.frame_drop_suspected ? ' · 疑似丢帧/断流' : ''}</span>
                </div>
                <span className="mvp-muted mvp-small">{camera.age_seconds === null ? '无观测' : `${camera.age_seconds}s 前`}</span>
              </li>
            ))}
          </ul>

          <div className="mvp-panel-title mvp-sub"><h3>工作人员</h3><span>{dashboard?.staff.length ?? 0} 人</span></div>
          <ul className="mvp-health">
            {(dashboard?.staff ?? []).map(member => (
              <li key={member.id}>
                <span className={`mvp-dot ${member.runtime_status === 'available' ? 'online' : member.runtime_status === 'busy' ? 'degraded' : 'offline'}`} aria-hidden="true" />
                <div>
                  <strong>{member.name}</strong>
                  <span className="mvp-muted mvp-small">{member.id} · {member.role} · {member.region_id}</span>
                </div>
                <span className="mvp-muted mvp-small">{member.runtime_status}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* 工单 */}
        <section className="mvp-panel mvp-span-3">
          <div className="mvp-panel-title">
            <h3>审批中心与工单</h3>
            <div className="mvp-tabs">
              {([['all', '全部'], ['pending', '待审批'], ['active', '执行中'], ['closed', '已结束']] as const).map(([key, label]) => (
                <button type="button" key={key} className={orderFilter === key ? 'active' : ''} onClick={() => setOrderFilter(key)}>{label}</button>
              ))}
            </div>
          </div>

          <div className="mvp-staff-session">
            {staffSession.token ? (
              <>
                <span>工作人员身份：<strong>{staffSession.name}</strong>（{staffSession.id}）</span>
                <button type="button" onClick={logoutStaff}>退出</button>
              </>
            ) : (
              <>
                <span className="mvp-muted">接单/执行/反馈需要工作人员登录（演示工号与登录码来自场景名册）。</span>
                <input aria-label="工作人员工号" placeholder="工号，如 STF-02" value={staffIdInput} onChange={event => setStaffIdInput(event.target.value)} />
                <input aria-label="工作人员登录码" placeholder="登录码，如 1002" value={staffCodeInput} onChange={event => setStaffCodeInput(event.target.value)} />
                <button type="button" disabled={busy !== null || !staffIdInput || !staffCodeInput} onClick={() => void act('staff-login', loginStaff, '工作人员登录成功')}>工作人员登录</button>
              </>
            )}
            {!localStorage.getItem('admin_token') ? <span className="mvp-muted mvp-small">审批需要管理员登录（/login）。</span> : null}
          </div>

          <div className="mvp-orders">
            {orders.map(order => (
              <article key={order.id} className={`mvp-order status-${order.status.toLowerCase()}`}>
                <header>
                  <span className={`mvp-chip ${order.status === 'COMPLETED' ? 'ok' : order.status === 'REJECTED' || order.status === 'FAILED' ? 'bad' : order.status === 'PENDING_APPROVAL' ? 'warn' : ''}`}>{STATUS_LABEL[order.status] ?? order.status}</span>
                  {order.stale ? <span className="mvp-chip bad">上下文已过期</span> : null}
                  <strong>{order.title}</strong>
                  <span className="mvp-muted mvp-small">{order.id} · {TYPE_LABEL[order.type] ?? order.type} · {order.region_id ?? '—'} · 优先级 {order.priority}</span>
                </header>
                <p className="mvp-small">{order.description}</p>
                <div className="mvp-order-meta">
                  <span>创建：{order.created_by.kind === 'agent' ? 'Agent' : order.created_by.username} · {fmtTime(order.created_at)}</span>
                  {order.assigned_staff_id ? <span>指派：{order.assigned_staff_id}</span> : null}
                  {order.approval ? <span>审批：{order.approval.decision} by {order.approval.by}</span> : null}
                  {order.feedback ? <span>反馈：{order.feedback.note}（{order.feedback.observation?.count ?? '—'} 人）</span> : null}
                  {order.stale ? <span className="mvp-error-inline">⚠ {order.stale_reason}</span> : null}
                </div>
                <div className="mvp-order-foot">
                  {renderOrderActions(order)}
                  {order.stale ? (
                    <button type="button" className="primary" disabled={busy !== null} onClick={() => void act('revalidate', () => mvpApi.revalidate(order.id, '控制台重新确认上下文'), `已重新确认 ${order.id}`)}>
                      重新确认上下文
                    </button>
                  ) : null}
                  <button type="button" className="ghost" onClick={() => setExpandedOrder(expandedOrder === order.id ? null : order.id)}>
                    {expandedOrder === order.id ? '收起流转' : '查看流转'}
                  </button>
                </div>
                {expandedOrder === order.id ? (
                  <ol className="mvp-history">
                    {order.history.map((event, index) => (
                      <li key={index}><span>{fmtTime(event.ts)}</span><strong>{STATUS_LABEL[event.status] ?? event.status}</strong><span className="mvp-muted">{event.actor} {event.note ?? ''}</span></li>
                    ))}
                  </ol>
                ) : null}
              </article>
            ))}
            {orders.length === 0 ? <p className="mvp-muted">当前筛选条件下没有工单。</p> : null}
          </div>
        </section>

        <section className="mvp-panel mvp-timeline-panel">
          <div className="mvp-panel-title"><h3>事件时间轴</h3><span>最近 {dashboard?.audit.length ?? 0} 条</span></div>
          <ol className="mvp-timeline">
            {(dashboard?.audit ?? []).slice(0, 12).map(entry => (
              <li key={entry.id} className={`result-${entry.result}`}>
                <span className="mvp-muted mvp-small">{fmtTime(entry.ts)}</span>
                <strong>{entry.action}</strong>
                <span>{entry.summary}</span>
                <span className="mvp-muted mvp-small">{entry.actor}（{entry.role}）</span>
              </li>
            ))}
            {(dashboard?.audit ?? []).length === 0 ? <li className="mvp-muted">暂无事件</li> : null}
          </ol>
        </section>

        <section className="mvp-panel mvp-bench">
          <div className="mvp-panel-title">
            <h3>竞赛基准结果</h3>
            <span>{experiments?.available ? `生成于 ${fmtTime(experiments.generated_at)}` : '尚未生成'}</span>
          </div>
          {experiments?.available ? (
            <>
              <div className="mvp-kpis">
                <div><span>VoI 风险降低</span><strong>{((experiments.experiments.voi as any)?.voi?.risk_reduction?.mean ?? '—')}</strong></div>
                <div><span>VoI 时间成本</span><strong>{((experiments.experiments.voi as any)?.voi?.time_cost?.mean ?? '—')} min</strong></div>
                <div><span>固定策略时间成本</span><strong>{((experiments.experiments.voi as any)?.fixed_priority?.time_cost?.mean ?? '—')} min</strong></div>
                <div><span>预测 5 分钟 MAE</span><strong>{((experiments.experiments.prediction as any)?.[1]?.mae_by_method?.adaptive?.mean ?? '—')}</strong></div>
                <div><span>预测 5 分钟覆盖率</span><strong>{((experiments.experiments.prediction as any)?.[1]?.interval_coverage ?? '—')}</strong></div>
                <div><span>业务闭环成功率</span><strong>{((experiments.experiments.business as any)?.success_rate ?? '—')}</strong></div>
                <div><span>校验器故障检出</span><strong>{((experiments.experiments.planning as any)?.fault_injection_detected ?? '—')} / {((experiments.experiments.planning as any)?.fault_injection_total ?? '—')}</strong></div>
                <div><span>Agent 延迟 p95</span><strong>{((experiments.experiments.latency as any)?.agent?.p95_ms ?? '—')} ms</strong></div>
              </div>
              <p className="mvp-muted mvp-small">{experiments.note} 报告：{experiments.report_path}</p>
            </>
          ) : <p className="mvp-muted">运行 `npm run benchmark:competition --prefix backend` 后在此展示摘要。</p>}
        </section>

        <section className="mvp-panel mvp-span-3">
          <div className="mvp-panel-title">
            <h3>多区域协同调查</h3>
            <span>{multi?.target_region_id ? `目标 ${multi.target_region_id}` : '加载中'}</span>
          </div>
          {multi?.available ? (
            <div className="mvp-multi">
              <div>
                <h4>区域调查优先级（传播风险 × 不确定性 × 中心性）</h4>
                <table className="mvp-table">
                  <thead><tr><th>区域</th><th>传播风险</th><th>不确定性</th><th>中心性</th><th>优先级</th></tr></thead>
                  <tbody>
                    {(multi.priorities ?? []).slice(0, 6).map(item => (
                      <tr key={item.regionId}>
                        <td><button type="button" className="mvp-link-button" onClick={() => onSelectRegion(item.regionId)}>{item.regionId}</button></td>
                        <td>{item.propagatedRisk.toFixed(3)}</td>
                        <td>{item.uncertainty}</td>
                        <td>{item.centrality.toFixed(2)}</td>
                        <td>{item.priority.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h4>联合 VoI 动作排序</h4>
                <table className="mvp-table">
                  <thead><tr><th>动作</th><th>VoI</th><th>覆盖区域</th><th>加权 Δ风险</th><th>加权 IG</th></tr></thead>
                  <tbody>
                    {(multi.decision?.evaluations ?? []).map(item => (
                      <tr key={item.action_id} className={item.action_id === multi.decision?.recommended_action_id ? 'selected' : ''}>
                        <td>{item.label}</td>
                        <td>{item.score === null ? '—' : item.score.toFixed(3)}</td>
                        <td>{item.covered_regions.map(region => region.region_id).join(' / ')}</td>
                        <td>{item.weighted_risk_reduction.toFixed(3)}</td>
                        <td>{item.weighted_information_gain_bits.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mvp-muted mvp-small">
                  推荐：{multi.decision?.recommended_action_id ?? '停止调查'}
                  {multi.decision?.recommended_covered_regions.length ? `；覆盖 ${multi.decision.recommended_covered_regions.join(' / ')}` : ''}
                  {multi.decision?.stop_reason ? `；停止原因 ${multi.decision.stop_reason}` : ''}
                </p>
                <p className="mvp-muted mvp-small">{multi.note}</p>
              </div>
            </div>
          ) : <p className="mvp-muted">{multi?.reason ?? '场景未配置调查策略'}</p>}
        </section>
      </div>

      {feedback ? (
        <div className="mvp-modal" role="dialog" aria-labelledby="mvp-feedback-title">
          <div className="mvp-modal-card">
            <h3 id="mvp-feedback-title">提交现场反馈 · {feedback.orderId}</h3>
            <label>现场人数<input value={feedback.count} onChange={event => setFeedback({ ...feedback, count: event.target.value })} inputMode="numeric" /></label>
            <label>置信度（0~1）<input value={feedback.confidence} onChange={event => setFeedback({ ...feedback, confidence: event.target.value })} inputMode="decimal" /></label>
            <label>反馈说明<textarea value={feedback.note} onChange={event => setFeedback({ ...feedback, note: event.target.value })} rows={3} /></label>
            <div className="mvp-actions">
              <button type="button" className="primary" disabled={busy !== null} onClick={() => void submitFeedback()}>提交并完成</button>
              <button type="button" onClick={() => setFeedback(null)}>取消</button>
            </div>
            <p className="mvp-muted mvp-small">反馈会写回安全域观测（来源 field_report）并触发重新评估。</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
