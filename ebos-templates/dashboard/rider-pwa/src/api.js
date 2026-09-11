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
  // Extra fields the server sends alongside `error` (e.g. alreadyDelivered)
  // are attached onto the thrown Error itself, not just its message -- a
  // caller needing to branch on WHY a request failed, not just show the
  // text, would otherwise have no way to get at them.
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), data || {});
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body || {}) }),
};
