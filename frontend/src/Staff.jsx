import { useState } from 'react';
import { api, session } from './api';
import { Loading, Notice, StatusBadge, money, useLoad } from './ui';

// ------------------------------------------------------------------ appeals queue (adjuster)
export function AppealsQueue({ onOpen }) {
  const state = useLoad(() => api('GET', '/appeals'), []);
  return (
    <section>
      <h2>Appeals</h2>
      <Loading state={state} />
      {state.data && state.data.length === 0 && <p className="muted">No appeals have been filed.</p>}
      {state.data && state.data.length > 0 && (
        <table data-testid="appeals-table">
          <thead><tr><th>Appeal</th><th>Claim</th><th>Claimant</th><th>Amount</th><th>Rejected clauses</th><th>Filed</th><th>Status</th></tr></thead>
          <tbody>
            {state.data.map((a) => (
              <tr key={a.appealId} className="clickable" data-testid={`appeal-row-${a.appealId}`} onClick={() => onOpen(a.claimId)}>
                <td>{a.appealId}</td><td>#{a.claimId}</td><td>{a.claimantName}</td><td>{money(a.claimAmount)}</td>
                <td>{a.rejectedClauses.join(', ')}</td><td>{a.filedOn}</td><td><StatusBadge status={a.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ rules
function describe(c) {
  const when = c.appliesWhen ? ` (only when ${c.appliesWhen.field} is ${String(c.appliesWhen.equals)})` : '';
  const name = c.fieldLabel || c.field;
  switch (c.type) {
    case 'FIELD_IN_LIST': return `${name} must be one of: ${c.values.join(', ')}${when}`;
    case 'FIELD_NOT_IN_LIST': return `${name} must not be: ${c.values.join(', ')}${when}`;
    case 'FIELD_FLAG': return `Requires that ${c.requirement}${when}`;
    case 'REQUIRED_DOCUMENT': return `Document required: ${c.label || c.document}${when}`;
    case 'FILING_DEADLINE': return `File within ${c.days} days of the incident${when}`;
    case 'WAITING_PERIOD': return `Cover starts ${c.days} days after the policy start${when}`;
    case 'MAX_AMOUNT': return c.limit !== undefined ? `Amount must not exceed ${money(c.limit)}${when}` : `Amount must not exceed the sum insured${when}`;
    case 'POLICY_ACTIVE': return 'Incident must fall within the policy period';
    default: return c.type;
  }
}

function RuleRow({ rule, canEdit, reload, setError }) {
  const [msg, setMsg] = useState(rule.rejectMsg);
  const save = async (patch) => {
    setError('');
    try {
      await api('PUT', `/rules/${rule.ruleId}`, patch);
      reload();
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <tr data-testid={`rule-row-${rule.ruleId}`}>
      <td>{rule.clauseCode}</td>
      <td>{describe(rule.condition)}</td>
      <td>
        {canEdit ? (
          <div className="row">
            <input data-testid={`rule-msg-${rule.ruleId}`} value={msg} onChange={(e) => setMsg(e.target.value)} />
            <button disabled={msg === rule.rejectMsg} onClick={() => save({ rejectMsg: msg })}>Save</button>
          </div>
        ) : rule.rejectMsg}
      </td>
      <td>
        <input data-testid={`rule-active-${rule.ruleId}`} type="checkbox" checked={rule.active} disabled={!canEdit} onChange={(e) => save({ active: e.target.checked })} />
      </td>
    </tr>
  );
}

export function Rules({ user }) {
  const state = useLoad(() => api('GET', '/rules'), []);
  const [error, setError] = useState('');
  const groups = {};
  (state.data || []).forEach((r) => {
    const key = `${r.policyNo} \u00b7 ${r.productName}`;
    groups[key] = [...(groups[key] || []), r];
  });
  return (
    <section>
      <h2>Policy rules</h2>
      <p className="muted">Rules are stored as data, so a clause can be edited or switched off without redeploying the system. Every change is written to the audit log.</p>
      <Notice>{error}</Notice>
      <Loading state={state} />
      {Object.entries(groups).map(([heading, rules]) => (
        <div key={heading}>
          <h3>{heading}</h3>
          <table>
            <thead><tr><th>Clause</th><th>Condition</th><th>Rejection message</th><th>Active</th></tr></thead>
            <tbody>
              {rules.map((r) => <RuleRow key={r.ruleId} rule={r} canEdit={user.role === 'adjuster'} reload={state.reload} setError={setError} />)}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

// ------------------------------------------------------------------ audit log
export function AuditLog() {
  const state = useLoad(() => api('GET', '/audit?limit=200'), []);
  return (
    <section>
      <h2>Audit log</h2>
      <Loading state={state} />
      {state.data && (
        <table data-testid="audit-table">
          <thead><tr><th>When</th><th>Claim</th><th>Who</th><th>What</th></tr></thead>
          <tbody>
            {state.data.map((a) => (
              <tr key={a.logId}>
                <td>{a.loggedAt.replace('T', ' ').slice(0, 16)}</td><td>{a.claimId ? `#${a.claimId}` : '-'}</td><td>{a.actor}</td><td>{a.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ auditor dashboard
const Card = ({ label, value, testId }) => (
  <div className="stat"><div className="stat-value" data-testid={testId}>{value}</div><div className="muted">{label}</div></div>
);

export function Dashboard() {
  const state = useLoad(() => api('GET', '/reports/summary'), []);
  const [error, setError] = useState('');

  async function download() {
    setError('');
    try {
      const res = await fetch('/api/reports/claims.csv', { headers: { Authorization: `Bearer ${session.token()}` } });
      if (!res.ok) throw new Error('Could not download the report');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'claims.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
  }

  const r = state.data;
  const max = r ? Math.max(1, ...Object.values(r.byStatus)) : 1;
  return (
    <section>
      <div className="row between">
        <h2>Compliance dashboard</h2>
        <button data-testid="download-csv" onClick={download}>Download claims (CSV)</button>
      </div>
      <Notice>{error}</Notice>
      <Loading state={state} />
      {r && (
        <>
          <div className="stats">
            <Card label="Total claims" value={r.totalClaims} testId="stat-total" />
            <Card label="Rejection rate" value={`${r.rejectionRate}%`} testId="stat-rejection-rate" />
            <Card label="Open appeals" value={r.appeals.open} testId="stat-open-appeals" />
            <Card label="Appeal approval rate" value={`${r.appeals.approvalRate}%`} testId="stat-appeal-approval" />
            <Card label="Avg appeal resolution (days)" value={r.appeals.avgResolutionDays ?? '-'} testId="stat-avg-days" />
            <Card label="Manual overrides" value={r.overrides} testId="stat-overrides" />
          </div>
          <h3>Claims by insurance type</h3>
          <table data-testid="by-product">
            <thead><tr><th>Insurance type</th><th>Claims</th><th>Auto-rejected</th></tr></thead>
            <tbody>{r.byProduct.map((p) => <tr key={p.code}><td>{p.name}</td><td>{p.claims}</td><td>{p.rejected}</td></tr>)}</tbody>
          </table>
          <h3>Claims by status</h3>
          <div className="bars">
            {Object.entries(r.byStatus).map(([s, n]) => (
              <div className="bar-row" key={s}>
                <span className="bar-label">{s.replace(/_/g, ' ').toLowerCase()}</span>
                <span className="bar" style={{ width: `${(n / max) * 100}%` }} />
                <span>{n}</span>
              </div>
            ))}
          </div>
          <h3>Most common rejection clauses</h3>
          {r.topRejectionClauses.length === 0 ? <p className="muted">No rejections yet.</p> : (
            <table data-testid="top-clauses">
              <thead><tr><th>Clause</th><th>Times triggered</th></tr></thead>
              <tbody>{r.topRejectionClauses.map((c) => <tr key={c.clauseCode}><td>{c.clauseCode}</td><td>{c.count}</td></tr>)}</tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
