/**
 * 工作人员移动端任务页（/staff）。
 * 仅展示指派给当前登录工作人员的工单；所有状态变更走后端 API 与权限校验。
 */
import { useCallback, useEffect, useState } from 'react';
import mvpApi, { type WorkOrder } from '../services/mvpApi';
import './StaffPage.css';

const STATUS_LABEL: Record<string, string> = {
  ASSIGNED: '待接单',
  ACCEPTED: '已接单',
  IN_PROGRESS: '执行中',
  COMPLETED: '已完成',
  FAILED: '已失败',
  PENDING_APPROVAL: '待审批',
  APPROVED: '已批准',
  REJECTED: '已拒绝',
};

function errorMessage(error: unknown): string {
  const response = (error as { response?: { data?: { error?: { message?: string } } } }).response;
  return response?.data?.error?.message ?? (error as Error).message;
}

export default function StaffPage() {
  const [staffId, setStaffId] = useState(() => localStorage.getItem('staff_id') ?? '');
  const [staffName, setStaffName] = useState(() => localStorage.getItem('staff_name') ?? '');
  const [token, setToken] = useState(() => localStorage.getItem('staff_token') ?? '');
  const [idInput, setIdInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ orderId: string; count: string; confidence: string; note: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!staffId) return;
    try {
      const list = await mvpApi.workOrders();
      setOrders(list.filter(order => order.assigned_staff_id === staffId));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [staffId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!feedback) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && busy === null) setFeedback(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [feedback, busy]);

  async function login() {
    setBusy('login');
    setError(null);
    try {
      const session = await mvpApi.staffLogin(idInput.trim(), codeInput.trim());
      localStorage.setItem('staff_token', session.access_token);
      localStorage.setItem('staff_id', session.staff_id);
      localStorage.setItem('staff_name', session.username);
      setToken(session.access_token);
      setStaffId(session.staff_id);
      setStaffName(session.username);
      setCodeInput('');
      setNotice('登录成功');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  function logout() {
    localStorage.removeItem('staff_token');
    localStorage.removeItem('staff_id');
    localStorage.removeItem('staff_name');
    setToken('');
    setStaffId('');
    setStaffName('');
    setOrders([]);
  }

  async function act(key: string, action: () => Promise<unknown>, message: string): Promise<boolean> {
    setBusy(key);
    setError(null);
    setNotice(null);
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
  }

  async function submitFeedback() {
    if (!feedback) return;
    const count = Number(feedback.count);
    const confidence = Number(feedback.confidence);
    if (!Number.isFinite(count) || count < 0 || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      setError('请填写有效的人数和 0~1 置信度');
      return;
    }
    const ok = await act('feedback', () => mvpApi.complete(feedback.orderId, {
      note: feedback.note || '现场反馈',
      observation: { count, confidence, valid: true },
    }), '反馈已提交，指挥中心将重新评估');
    if (ok) setFeedback(null);
  }

  if (!token) {
    return (
      <main className="staff-root">
        <section className="staff-card">
          <h1>SkyGuard 工作人员任务</h1>
          <p className="staff-muted">使用场景名册中的工号与演示登录码登录。真实部署需替换为正式身份系统。</p>
          <label>工号<input value={idInput} onChange={event => setIdInput(event.target.value)} placeholder="STF-02" /></label>
          <label>登录码<input value={codeInput} onChange={event => setCodeInput(event.target.value)} placeholder="演示登录码" inputMode="numeric" /></label>
          {error ? <p className="staff-error" role="alert">{error}</p> : null}
          <button type="button" disabled={busy !== null || !idInput || !codeInput} onClick={() => void login()}>
            {busy === 'login' ? '登录中…' : '登录'}
          </button>
          <a href="/">返回指挥大屏</a>
        </section>
      </main>
    );
  }

  return (
    <main className="staff-root">
      <header className="staff-header">
        <div>
          <h1>我的任务</h1>
          <p className="staff-muted">{staffName}（{staffId}）</p>
        </div>
        <div className="staff-header-actions">
          <button type="button" onClick={() => void refresh()} disabled={busy !== null}>刷新</button>
          <button type="button" onClick={logout}>退出</button>
        </div>
      </header>

      {notice ? <p className="staff-notice">{notice}</p> : null}
      {error ? <p className="staff-error" role="alert">{error}</p> : null}

      <section className="staff-orders">
        {orders.map(order => (
          <article key={order.id} className={`staff-order status-${order.status.toLowerCase()} ${order.stale ? 'stale' : ''}`}>
            <header>
              <span className="staff-chip">{STATUS_LABEL[order.status] ?? order.status}</span>
              <strong>{order.title}</strong>
              <span className="staff-muted small">{order.id} · {order.region_id ?? '—'} · 优先级 {order.priority}</span>
            </header>
            <p>{order.description}</p>
            {order.stale ? <p className="staff-error small">⚠ {order.stale_reason}</p> : null}
            <div className="staff-actions">
              {order.status === 'ASSIGNED' ? (
                <button type="button" disabled={busy !== null} onClick={() => void act('accept', () => mvpApi.accept(order.id), '已接单')}>接单</button>
              ) : null}
              {order.status === 'ACCEPTED' ? (
                <button type="button" disabled={busy !== null} onClick={() => void act('start', () => mvpApi.start(order.id), '已开始执行')}>开始执行</button>
              ) : null}
              {order.status === 'IN_PROGRESS' ? (
                <>
                  <button type="button" className="primary" disabled={busy !== null} onClick={() => setFeedback({ orderId: order.id, count: '', confidence: '0.95', note: '' })}>提交反馈</button>
                  <button type="button" className="danger" disabled={busy !== null} onClick={() => {
                    const reason = window.prompt('失败原因', '现场无法进入') ?? '';
                    if (reason.trim()) void act('fail', () => mvpApi.fail(order.id, reason), '已上报失败');
                  }}>无法执行</button>
                </>
              ) : null}
              {['COMPLETED', 'FAILED'].includes(order.status) ? (
                <span className="staff-muted small">任务已结束{order.feedback ? `：${order.feedback.note}` : ''}</span>
              ) : null}
            </div>
          </article>
        ))}
        {orders.length === 0 ? <p className="staff-muted">当前没有指派给你的任务。</p> : null}
      </section>

      {feedback ? (
        <div className="staff-modal" role="dialog" aria-labelledby="staff-feedback-title">
          <div className="staff-modal-card">
            <h2 id="staff-feedback-title">提交现场反馈</h2>
            <label>现场人数<input value={feedback.count} onChange={event => setFeedback({ ...feedback, count: event.target.value })} inputMode="numeric" /></label>
            <label>置信度（0~1）<input value={feedback.confidence} onChange={event => setFeedback({ ...feedback, confidence: event.target.value })} inputMode="decimal" /></label>
            <label>说明<textarea rows={3} value={feedback.note} onChange={event => setFeedback({ ...feedback, note: event.target.value })} /></label>
            <div className="staff-actions">
              <button type="button" className="primary" disabled={busy !== null} onClick={() => void submitFeedback()}>提交并完成</button>
              <button type="button" onClick={() => setFeedback(null)}>取消</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
