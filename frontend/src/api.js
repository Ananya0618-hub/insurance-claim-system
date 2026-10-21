const KEY = 'claims-session';

export const session = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(KEY));
    } catch {
      return null;
    }
  },
  save(value) {
    localStorage.setItem(KEY, JSON.stringify(value));
  },
  clear() {
    localStorage.removeItem(KEY);
  },
  token() {
    const s = session.load();
    return s ? s.token : null;
  },
};

export async function api(method, path, body) {
  const token = session.token();
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) {
      session.clear();
      window.dispatchEvent(new Event('session-expired'));
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}
