import { Fragment, useState } from 'react';
import { api } from './api';
import { Field, Loading, Notice, StatusBadge, money, useLoad } from './ui';

// ------------------------------------------------------------------ list
export function ClaimsList({ user, onOpen }) {
  const staff = user.role !== 'claimant';
  const [status, setStatus] = useState('');
  const state = useLoad(() => api('GET', '/claims' + (status ? `?status=${status}` : '')), [status]);

  return (
    <section>
      <div className="row between">
        <h2>{staff ? 'All claims' : 'My claims'}</h2>
        {staff && (
          <select data-testid="status-filter" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {['APPROVED', 'REJECTED', 'APPEAL_FILED', 'UNDER_APPEAL_REVIEW', 'CLOSED'].map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>
            ))}
          </select>
        )}
      </div>
      <Loading state={state} />
      {state.data && state.data.length === 0 && <p className="muted" data-testid="no-claims">No claims yet.</p>}
      {state.data && state.data.length > 0 && (
        <table data-testid="claims-table">
          <thead>
            <tr>
              <th>#</th>{staff && <th>Claimant</th>}<th>Policy</th><th>Type</th><th>Details</th><th>Amount</th><th>Submitted</th><th>Status</th><th>Appeal</th>
            </tr>
          </thead>
          <tbody>
            {state.data.map((c) => (
              <tr key={c.claimId} className="clickable" data-testid={`claim-row-${c.claimId}`} onClick={() => onOpen(c.claimId)}>
                <td>{c.claimId}</td>
                {staff && <td>{c.claimantName}</td>}
                <td>{c.policyNo}</td>
                <td>{c.productName}</td>
                <td>{c.headline}</td>
                <td>{money(c.amount)}</td>
                <td>{c.submittedOn}</td>
                <td><StatusBadge status={c.status} /></td>
                <td>{c.appealStatus ? <StatusBadge status={c.appealStatus} /> : <span className="muted">-</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ new claim
const today = () => new Date().toISOString().slice(0, 10);
const defaultFor = (f) => (f.type === 'boolean' ? Boolean(f.default) : '');

// The form is built from the selected policy's insurance category: its date label, its own
// questions (text / choice / yes-no) and the documents that category accepts.
export function NewClaim({ onCreated }) {
  const policies = useLoad(() => api('GET', '/policies'), []);
  const types = useLoad(() => api('GET', '/product-types'), []);
  const [form, setForm] = useState({ policyId: '', amount: '', incidentDate: today(), values: {}, documents: [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const policy = policies.data && (policies.data.find((p) => String(p.policyId) === String(form.policyId)) || policies.data[0]);
  const product = policy && types.data && types.data.find((t) => t.code === policy.productType);
  const valueOf = (f) => form.values[f.key] ?? defaultFor(f);
  const setValue = (key, v) => setForm((f) => ({ ...f, values: { ...f.values, [key]: v } }));
  const toggleDoc = (d) => setForm((f) => ({ ...f, documents: f.documents.includes(d) ? f.documents.filter((x) => x !== d) : [...f.documents, d] }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = { policyId: policy.policyId, amount: form.amount, incidentDate: form.incidentDate, documents: form.documents };
      product.fields.forEach((f) => { body[f.key] = valueOf(f); });
      const claim = await api('POST', '/claims', body);
      onCreated(claim.claimId);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Submit a claim</h2>
      <Loading state={policies} />
      <Loading state={types} />
      {policy && product && (
        <form className="card form" onSubmit={submit}>
          <Notice>{error}</Notice>
          <Field label="Policy">
            <select data-testid="claim-policy" value={policy.policyId}
              onChange={(e) => setForm((f) => ({ ...f, policyId: e.target.value, values: {}, documents: [] }))}>
              {policies.data.map((p) => (
                <option key={p.policyId} value={p.policyId}>{p.policyNo} - {p.productName}{p.insuredItem ? ` (${p.insuredItem})` : ''}</option>
              ))}
            </select>
          </Field>
          <p className="muted" data-testid="claim-type">{product.name} &middot; sum insured {money(policy.sumInsured)}</p>
          <Field label="Claim amount (INR)">
            <input data-testid="claim-amount" type="number" min="1" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} required />
          </Field>
          <Field label={product.incidentLabel}>
            <input data-testid="claim-date" type="date" max={today()} value={form.incidentDate} onChange={(e) => setForm((f) => ({ ...f, incidentDate: e.target.value }))} required />
          </Field>
          {product.fields.map((f) =>
            f.type === 'boolean' ? (
              <label className="check" key={f.key}>
                <input data-testid={`field-${f.key}`} type="checkbox" checked={Boolean(valueOf(f))} onChange={(e) => setValue(f.key, e.target.checked)} />
                {f.label}
              </label>
            ) : f.type === 'select' ? (
              <Field key={f.key} label={f.label}>
                <select data-testid={`field-${f.key}`} value={valueOf(f)} onChange={(e) => setValue(f.key, e.target.value)} required={f.required}>
                  <option value="">Select...</option>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </Field>
            ) : (
              <Field key={f.key} label={f.label}>
                <input data-testid={`field-${f.key}`} value={valueOf(f)} onChange={(e) => setValue(f.key, e.target.value)} required={f.required} />
              </Field>
            )
          )}
          <fieldset>
            <legend>Documents attached</legend>
            {Object.entries(product.documents).map(([key, label]) => (
              <label className="check" key={key}>
                <input data-testid={`doc-${key}`} type="checkbox" checked={form.documents.includes(key)} onChange={() => toggleDoc(key)} />
                {label}
              </label>
            ))}
          </fieldset>
          <button data-testid="claim-submit" className="primary" disabled={busy}>{busy ? 'Evaluating...' : 'Submit claim'}</button>
        </form>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ detail
function Facts({ claim }) {
  const d = claim.details;
  const p = claim.product;
  return (
    <dl className="facts">
      <dt>Claimant</dt><dd>{claim.claimantName}</dd>
      <dt>Insurance</dt><dd data-testid="claim-product">{claim.productName}</dd>
      <dt>Policy</dt><dd>{claim.policyNo}{claim.insuredItem ? ` - ${claim.insuredItem}` : ''} (sum insured {money(claim.sumInsured)})</dd>
      <dt>Amount</dt><dd>{money(claim.amount)}</dd>
      <dt>{p.incidentLabel}</dt><dd>{d.incidentDate}</dd>
      {p.fields.map((f) => (
        <Fragment key={f.key}>
          <dt>{f.type === 'boolean' ? 'Declaration' : f.label}</dt>
          <dd>{f.type === 'boolean' ? `${f.label}: ${d[f.key] ? 'Yes' : 'No'}` : d[f.key] || '-'}</dd>
        </Fragment>
      ))}
      <dt>Documents</dt><dd>{d.documents.length ? d.documents.map((k) => p.documents[k] || k).join(', ') : 'none'}</dd>
      <dt>Submitted</dt><dd>{claim.submittedOn}{claim.decidedOn ? `, decided ${claim.decidedOn}` : ''}</dd>
    </dl>
  );
}

function Reasons({ claim }) {
  if (claim.status === 'APPROVED' || claim.status === 'CLOSED') {
    if (!claim.reasons.length) return <Notice kind="success">All policy clauses were satisfied.</Notice>;
  }
  if (!claim.reasons.length) return null;
  return (
    <div>
      <h3>Why this was rejected - and what would change it</h3>
      <ul className="reasons">
        {claim.reasons.map((r) => (
          <li key={r.reasonId} data-testid="reason-item">
            <div><strong>{r.ruleCode}</strong> {r.description}</div>
            <div className="cf" data-testid="counterfactual">{r.counterfactual}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AppealBlock({ claim, user, reload }) {
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const w = claim.appealWindow;

  async function file(e) {
    e.preventDefault();
    setError('');
    try {
      await api('POST', `/claims/${claim.claimId}/appeal`, { notes });
      setNotes('');
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      {claim.appeal && (
        <div className="card" data-testid="appeal-info">
          <h3>Appeal <StatusBadge status={claim.appeal.status} testId="appeal-status" /></h3>
          <p>Filed on {claim.appeal.filedOn}: {claim.appeal.notes}</p>
          {claim.appeal.resolution && <p><strong>Decision ({claim.appeal.resolvedOn}):</strong> {claim.appeal.resolution}</p>}
        </div>
      )}
      {user.role === 'claimant' && w && w.canAppeal && (
        <form className="card form" onSubmit={file}>
          <h3>Appeal this decision</h3>
          <p className="muted" data-testid="appeal-window">You have {w.daysLeft} day(s) left to appeal (until {w.deadline}).</p>
          <Notice>{error}</Notice>
          <Field label="Why should this be reconsidered?">
            <textarea data-testid="appeal-notes" rows="4" value={notes} onChange={(e) => setNotes(e.target.value)} required />
          </Field>
          <button data-testid="appeal-submit" className="primary">File appeal</button>
        </form>
      )}
      {user.role === 'claimant' && w && !w.canAppeal && <Notice kind="info">The appeal window closed on {w.deadline}.</Notice>}
    </div>
  );
}

function StaffActions({ claim, user, reload }) {
  const [error, setError] = useState('');
  const [decision, setDecision] = useState(claim.status === 'APPROVED' ? 'reject' : 'approve');
  const [why, setWhy] = useState('');
  const [appealDecision, setAppealDecision] = useState('approve');
  const [appealWhy, setAppealWhy] = useState('');
  if (user.role !== 'adjuster') return null;
  const appeal = claim.appeal;

  const run = (fn) => async (e) => {
    e && e.preventDefault();
    setError('');
    try {
      await fn();
      setWhy('');
      setAppealWhy('');
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="card" data-testid="staff-actions">
      <h3>Adjuster actions</h3>
      <Notice>{error}</Notice>

      {appeal && appeal.status === 'FILED' && (
        <button data-testid="appeal-start" className="primary" onClick={run(() => api('POST', `/appeals/${appeal.appealId}/start-review`))}>
          Start appeal review
        </button>
      )}
      {appeal && appeal.status === 'UNDER_REVIEW' && (
        <form className="form" onSubmit={run(() => api('POST', `/appeals/${appeal.appealId}/decision`, { decision: appealDecision, justification: appealWhy }))}>
          <Field label="Appeal decision">
            <select data-testid="appeal-decision" value={appealDecision} onChange={(e) => setAppealDecision(e.target.value)}>
              <option value="approve">Uphold appeal (approve claim)</option>
              <option value="deny">Deny appeal (close claim)</option>
            </select>
          </Field>
          <Field label="Justification">
            <textarea data-testid="appeal-justification" rows="3" value={appealWhy} onChange={(e) => setAppealWhy(e.target.value)} required />
          </Field>
          <button data-testid="appeal-decide" className="primary">Record decision</button>
        </form>
      )}

      {(claim.status === 'APPROVED' || claim.status === 'REJECTED') && (
        <form className="form" onSubmit={run(() => api('POST', `/claims/${claim.claimId}/override`, { decision, justification: why }))}>
          <Field label="Override automated decision">
            <select data-testid="override-decision" value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="approve">Approve</option>
              <option value="reject">Reject</option>
            </select>
          </Field>
          <Field label="Justification (recorded in the audit log)">
            <textarea data-testid="override-justification" rows="3" value={why} onChange={(e) => setWhy(e.target.value)} required />
          </Field>
          <button data-testid="override-submit">Apply override</button>
        </form>
      )}

      {claim.status === 'APPROVED' && (
        <button data-testid="payout-submit" className="primary" onClick={run(() => api('POST', `/claims/${claim.claimId}/payout`))}>
          Mark payout completed
        </button>
      )}
    </div>
  );
}

export function ClaimDetail({ claimId, user, onBack }) {
  const state = useLoad(() => api('GET', `/claims/${claimId}`), [claimId]);
  const claim = state.data;
  return (
    <section>
      <button className="link" data-testid="back" onClick={onBack}>&larr; Back</button>
      <Loading state={state} />
      {claim && (
        <>
          <div className="row between">
            <h2>Claim #{claim.claimId}</h2>
            <StatusBadge status={claim.status} testId="claim-status" />
          </div>
          <Facts claim={claim} />
          <Reasons claim={claim} />
          <AppealBlock claim={claim} user={user} reload={state.reload} />
          <StaffActions claim={claim} user={user} reload={state.reload} />
          {claim.auditTrail && (
            <div>
              <h3>Audit trail</h3>
              <table data-testid="audit-trail">
                <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
                <tbody>
                  {claim.auditTrail.map((a) => (
                    <tr key={a.logId}><td>{a.loggedAt.replace('T', ' ').slice(0, 16)}</td><td>{a.actor}</td><td>{a.action}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
