import { useState } from 'react';
import { api, session } from './api';
import { Field, Notice } from './ui';

const DEMO = [
  ['Claimant - Rohan Mehta', 'rohan@example.com'],
  ['Claimant - Anita Desai', 'anita@example.com'],
  ['Claims adjuster - Priya Nair', 'priya@insurer.com'],
  ['Auditor - Meera Shah', 'meera@insurer.com'],
];

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api('POST', '/auth/login', { email, password });
      session.save(res);
      onLogin(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <h1>Explainable Insurance Claims</h1>
        <p className="muted">Every rejection comes with the clause behind it, what would change the outcome, and a way to appeal.</p>
        <Notice>{error}</Notice>
        <Field label="Email">
          <input data-testid="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Password">
          <input data-testid="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <button data-testid="login-submit" className="primary" disabled={busy}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
        <div className="demo">
          <p className="muted">Demo accounts (password: <code>password123</code>)</p>
          {DEMO.map(([label, mail]) => (
            <button
              type="button"
              key={mail}
              className="link"
              data-testid={`demo-${mail.split('@')[0]}`}
              onClick={() => {
                setEmail(mail);
                setPassword('password123');
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
