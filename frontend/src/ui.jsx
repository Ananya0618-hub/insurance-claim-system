import { useCallback, useEffect, useState } from 'react';

export const STATUS_LABEL = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  APPEAL_FILED: 'Appeal filed',
  UNDER_APPEAL_REVIEW: 'Under appeal review',
  CLOSED: 'Closed',
  FILED: 'Filed',
  DENIED: 'Denied',
};

export const money = (n) => '\u20b9' + Number(n).toLocaleString('en-IN');

export function StatusBadge({ status, testId }) {
  return (
    <span className={`badge badge-${status}`} data-testid={testId}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

export function Notice({ kind = 'error', children }) {
  if (!children) return null;
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'} data-testid={`notice-${kind}`}>
      {children}
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

// Loads data on mount / when deps change and exposes reload().
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const reload = useCallback(() => {
    let cancelled = false;
    fn()
      .then((data) => !cancelled && setState({ loading: false, error: '', data }))
      .catch((e) => !cancelled && setState({ loading: false, error: e.message, data: null }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => reload(), [reload]);
  return { ...state, reload };
}

export function Loading({ state }) {
  if (state.loading) return <p className="muted">Loading...</p>;
  if (state.error) return <Notice>{state.error}</Notice>;
  return null;
}
