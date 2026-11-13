import type {
  EvacuationPlan,
  ProviderStatus,
  SafetyIncident,
  SafetyStateName,
  SafetyStatus,
  SafetyValidationResult,
} from '../../../services/safetyApi';
import { STATE_LABEL, formatAffected, formatTime } from '../commandCenterUtils';

export function PanelTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="cc-panel-title">
      <h3>{title}</h3>
      <span>{subtitle}</span>
    </div>
  );
}

export function StateBadge({ state, headline }: { state: SafetyStateName; headline: string }) {
  return (
    <div className={`cc-state-badge state-${state}`} role="status">
      <strong>{state}</strong>
      <span>{STATE_LABEL[state]}</span>
      <em>{headline}</em>
    </div>
  );
}

export function ProviderList({ providers }: { providers: ProviderStatus[] }) {
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

export function ValidationPanel({
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

export function ExitAllocation({ status, plan }: { status: SafetyStatus; plan: EvacuationPlan | null }) {
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

export function IncidentPanel({
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

export function Legend({ isCandidate, hasPlan }: { isCandidate: boolean; hasPlan: boolean }) {
  return (
    <div className="cc-legend">
      <span><i className="legend-swatch validated" /> 已验证路线{hasPlan && !isCandidate ? '（当前显示）' : ''}</span>
      <span><i className="legend-swatch candidate" /> 候选路线（未校验）</span>
      <span><i className="legend-swatch closed" /> 已关闭通道/出口</span>
      <span><i className="legend-swatch unknown" /> 状态未知</span>
    </div>
  );
}
