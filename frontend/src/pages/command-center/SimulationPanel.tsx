/**
 * 时间轴仿真面板：把“观测进入 → 风险评估 → 规划校验 → 事件 → Agent → 人工”
 * 逐步展示出来。数据全部来自后端的合成仿真，前端不写死结果。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CaretRightOutlined,
  PauseOutlined,
  StepForwardOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import mvpApi, { type SimulationEvent, type SimulationStatus } from '../../services/mvpApi';
import './SimulationPanel.css';

interface Props {
  onChanged?: () => void;
}

const STATE_LABEL: Record<string, string> = {
  NORMAL: '常态运行',
  REROUTE: '重新规划',
  DEGRADED: '感知降级',
  REJECT: '安全拒绝',
};

const KIND_LABEL: Record<SimulationEvent['kind'], string> = {
  system: '系统',
  observation: '观测',
  plan: '规划',
  state: '状态',
  incident: '事件',
  agent: 'Agent',
  work_order: '工单',
  human: '人工',
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

export default function SimulationPanel({ onChanged }: Props) {
  const [status, setStatus] = useState<SimulationStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSequence = useRef<number>(-1);
  const logRef = useRef<HTMLOListElement | null>(null);
  const hasAdmin = typeof localStorage !== 'undefined' && Boolean(localStorage.getItem('admin_token'));

  const apply = useCallback((next: SimulationStatus) => {
    setStatus(next);
    if (next.sequence !== lastSequence.current) {
      lastSequence.current = next.sequence;
      onChanged?.();
    }
  }, [onChanged]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await mvpApi.simulation();
        if (!cancelled) {
          apply(next);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(`无法读取仿真状态：${errorMessage(caught)}`);
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apply]);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [status?.sequence]);

  const act = useCallback(async (key: string, action: () => Promise<SimulationStatus>) => {
    setBusy(key);
    setError(null);
    try {
      const next = await action();
      lastSequence.current = next.sequence;
      setStatus(next);
      onChanged?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }, [onChanged]);

  if (!status) {
    return (
      <section className="sim-panel sim-loading" aria-label="系统仿真">
        <strong>系统仿真</strong>
        <span>正在读取仿真状态…</span>
      </section>
    );
  }

  if (!status.available) {
    return (
      <section className="sim-panel" aria-label="系统仿真">
        <header className="sim-head">
          <div>
            <span className="sim-eyebrow">SYSTEM SIMULATION</span>
            <h3>系统仿真</h3>
          </div>
        </header>
        <p className="sim-muted">{status.reason ?? '当前场景未配置仿真剧本。'}</p>
      </section>
    );
  }

  const idle = !status.started_at;
  const finished = status.finished;
  const locked = busy !== null || !hasAdmin;
  const current = status.current;
  const activeId = current?.id ?? null;
  const percent = Math.round(status.progress * 100);
  const stateClass = status.state.toLowerCase();

  return (
    <section className={`sim-panel ${status.awaiting_human ? 'awaiting' : ''}`} aria-label="系统仿真">
      <header className="sim-head">
        <div className="sim-head-copy">
          <span className="sim-eyebrow">SYSTEM SIMULATION</span>
          <h3>
            系统仿真
            <span className="sim-tag">合成数据 · 非真实</span>
          </h3>
          <p className="sim-notice">{status.notice}</p>
        </div>
        <div className="sim-actions" role="group" aria-label="仿真控制">
          {idle || finished ? (
            <button
              type="button"
              className="sim-primary"
              disabled={locked}
              title={hasAdmin ? '' : '需要管理员登录 /login'}
              onClick={() => void act('start', () => mvpApi.startSimulation(true))}
            >
              <ThunderboltOutlined /> {finished ? '重新运行' : '启动仿真'}
            </button>
          ) : status.awaiting_human ? (
            <button type="button" className="sim-primary" disabled={locked} onClick={() => void act('resume', () => mvpApi.resumeSimulation())}>
              <CaretRightOutlined /> 继续仿真
            </button>
          ) : status.running ? (
            <button type="button" disabled={locked} onClick={() => void act('pause', () => mvpApi.pauseSimulation())}>
              <PauseOutlined /> 暂停
            </button>
          ) : (
            <button type="button" className="sim-primary" disabled={locked} onClick={() => void act('resume', () => mvpApi.resumeSimulation())}>
              <CaretRightOutlined /> 继续
            </button>
          )}
          {!idle && !finished ? (
            <>
              <button
                type="button"
                disabled={locked || status.running}
                title="暂停后逐条推进，便于讲解"
                onClick={() => void act('step', () => mvpApi.stepSimulation())}
              >
                <StepForwardOutlined /> 单步
              </button>
              <button type="button" className="sim-ghost" disabled={locked} onClick={() => void act('stop', () => mvpApi.stopSimulation())}>
                <StopOutlined /> 停止
              </button>
            </>
          ) : null}
        </div>
      </header>

      {!hasAdmin ? (
        <p className="sim-hint">启动仿真、审批与派发需要管理员身份，请先在 <a href="/login">/login</a> 登录。</p>
      ) : null}
      {error ? <p className="sim-error" role="alert">{error}</p> : null}

      <div className="sim-progress" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="sim-progress-meta">
        <span>{idle ? '尚未启动' : finished ? `已结束 · ${fmtTime(status.finished_at)}` : `第 ${Math.min(status.step_index, status.step_total)} / ${status.step_total} 步`}</span>
        <span>{percent}%</span>
      </div>

      <ol className="sim-steps" aria-label="仿真步骤">
        {status.steps.map(step => {
          const done = step.index <= status.step_index;
          const active = activeId === step.id && !idle && !finished;
          return (
            <li key={step.id} className={`${done ? 'done' : ''} ${active ? 'active' : ''}`} title={step.title}>
              <span className="sim-step-index">{String(step.index).padStart(2, '0')}</span>
              <span className="sim-step-phase">{step.phase}</span>
            </li>
          );
        })}
      </ol>

      <div className="sim-body">
        <div className="sim-phase-card">
          <div className="sim-phase-head">
            <span className={`sim-state ${stateClass}`}>{STATE_LABEL[status.state] ?? status.state}</span>
            <span className="sim-headline">{status.headline}</span>
          </div>
          {idle ? (
            <div className="sim-intro">
              <strong>启动后可以完整看到系统如何处理一条数据</strong>
              <p>
                按剧本依次写入全部区域的合成观测、触发风险评估与独立校验、登记出口关闭事件、运行 Agent 并创建待审批工单。
                全程不会自动审批、派发或控制任何现场资源。
              </p>
              <p className="sim-muted">
                观测有效期 90 秒；超过时效系统会按 fail-closed 降级。缺少观测时不会假装知道现场情况。
              </p>
            </div>
          ) : (
            <>
              <span className="sim-phase-label">
                {finished ? '剧本完成 · 最后一步' : current ? `第 ${current.index} / ${current.total} 步 · ${current.phase}` : '剧本完成'}
              </span>
              <strong className="sim-phase-title">{current?.title ?? '仿真已结束'}</strong>
              <p className="sim-narrative">{current?.narrative ?? '所有步骤已执行；合成数据不会自动变成真实结论。'}</p>
              {status.awaiting_human ? (
                <div className="sim-next">
                  <strong>需要人工操作</strong>
                  <ol>
                    {status.next_actions.map((action, index) => <li key={index}>{action}</li>)}
                  </ol>
                </div>
              ) : null}
              {finished ? (
                <p className="sim-footnote">
                  仿真已结束：合成观测不再更新，超过 90 秒有效期后系统会按 fail-closed 重新回到感知降级；这不是脚本失败。
                </p>
              ) : null}
            </>
          )}

          <dl className="sim-counts">
            <div><dt>当前状态</dt><dd className={`sim-state-text ${stateClass}`}>{STATE_LABEL[status.state] ?? status.state}</dd></div>
            <div><dt>观测区域</dt><dd>{status.counts.observations}</dd></div>
            <div><dt>不可信区域</dt><dd>{status.counts.untrusted_regions}</dd></div>
            <div><dt>待审批工单</dt><dd>{status.counts.pending_work_orders}<small> / {status.counts.work_orders}</small></dd></div>
            <div><dt>Agent 运行</dt><dd>{status.counts.agent_runs}</dd></div>
          </dl>
        </div>

        <div className="sim-log-card">
          <div className="sim-log-head">
            <strong>过程日志</strong>
            <span>{status.events.length} 条 · 按发生顺序</span>
          </div>
          <ol className="sim-log" ref={logRef}>
            {status.events.length === 0 ? (
              <li className="sim-log-empty">启动仿真后，这里会按时间显示观测写入、规划、状态变化、事件与 Agent 动作。</li>
            ) : status.events.map(event => (
              <li key={event.seq} className={`kind-${event.kind}`}>
                <time>{fmtTime(event.at)}</time>
                <span className="sim-kind">{KIND_LABEL[event.kind] ?? event.kind}</span>
                <div>
                  <strong>{event.title}</strong>
                  {event.detail ? <span>{event.detail}</span> : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
