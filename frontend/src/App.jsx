import { useEffect, useState } from 'react';
import { session } from './api';
import Login from './Login';
import { ClaimDetail, ClaimsList, NewClaim } from './Claims';
import { AppealsQueue, AuditLog, Dashboard, Rules } from './Staff';

const NAV = {
  claimant: [['claims', 'My claims'], ['new', 'New claim']],
  adjuster: [['claims', 'Claims'], ['appeals', 'Appeals'], ['rules', 'Rules'], ['audit', 'Audit log']],
  auditor: [['dashboard', 'Dashboard'], ['claims', 'Claims'], ['rules', 'Rules'], ['audit', 'Audit log']],
};
const ROLE_LABEL = { claimant: 'Claimant', adjuster: 'Claims adjuster', auditor: 'Auditor' };

export default function App() {
  const [user, setUser] = useState(() => (session.load() ? session.load().user : null));
  const [page, setPage] = useState('claims');
  const [claimId, setClaimId] = useState(null);

  useEffect(() => {
    const expired = () => setUser(null);
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, []);

  if (!user) {
    return <Login onLogin={(u) => { setPage(NAV[u.role][0][0]); setClaimId(null); setUser(u); }} />;
  }

  const go = (p) => { setPage(p); setClaimId(null); };
  const open = (id) => { setPage('claims'); setClaimId(id); };
  const logout = () => { session.clear(); setUser(null); };

  let body;
  if (claimId) body = <ClaimDetail claimId={claimId} user={user} onBack={() => setClaimId(null)} />;
  else if (page === 'new') body = <NewClaim onCreated={open} />;
  else if (page === 'appeals') body = <AppealsQueue onOpen={open} />;
  else if (page === 'rules') body = <Rules user={user} />;
  else if (page === 'audit') body = <AuditLog />;
  else if (page === 'dashboard') body = <Dashboard />;
  else body = <ClaimsList user={user} onOpen={open} />;

  return (
    <>
      <header>
        <strong>Explainable Insurance Claims</strong>
        <nav>
          {NAV[user.role].map(([key, label]) => (
            <button key={key} data-testid={`nav-${key}`} className={page === key && !claimId ? 'active' : ''} onClick={() => go(key)}>{label}</button>
          ))}
        </nav>
        <span className="who">
          <span data-testid="whoami">{user.name} &middot; {ROLE_LABEL[user.role]}</span>
          <button data-testid="logout" onClick={logout}>Sign out</button>
        </span>
      </header>
      <main>{body}</main>
    </>
  );
}
