// Same shape as client/src/api.js -- pointed at the rider's own API prefix
// (/rider/api), which carries its own session cookie, never the staff
// dashboard's.
async function request(path, options = {}) {
  const res = await fetch(`/rider/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body || {}) }),
};
