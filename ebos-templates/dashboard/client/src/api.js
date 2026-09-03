async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Extra fields on an error response (e.g. { error, noZoneMatch: true })
    // used to be thrown away here -- only the message string survived, so a
    // caller had no way to tell "this specific, recoverable case" apart
    // from any other failure without fragile message-text matching.
    const err = new Error(data?.error || `Request failed (${res.status})`);
    Object.assign(err, data || {});
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body || {}) }),
  delete: (path) => request(path, { method: 'DELETE' }),
};
