import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const EVENTS = [
  { value: 'problem', label: 'Problem -- staff flagged something on a step' },
  { value: 'blocked', label: 'Blocked -- a run is stuck, needs a manager' },
  { value: 'missing', label: 'Missing -- a task went unstarted past due' },
  { value: 'late', label: 'Late -- clocked in after shift start' },
  { value: 'variance', label: 'Variance' },
  { value: 'daily_summary', label: 'Daily summary' },
];

const EMPTY = { event: 'blocked', channel: 'whatsapp', target: '', quiet_hours: '' };

export default function AlertRoutes() {
  const [list, setList] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);

  function load() {
    api.get('/alert-routes').then(setList);
  }
  useEffect(load, []);

  async function add(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/alert-routes', form);
      setForm(EMPTY);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(id) {
    await api.delete(`/alert-routes/${id}`);
    load();
  }

  if (!list) return null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Alerts</h1>
          <p className="subtitle">Where each kind of alert goes. At most one per event per day, and quiet hours are honoured for everything except "blocked".</p>
        </div>
      </div>

      <div className="card">
        {list.length ? (
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Channel</th>
                <th>Target</th>
                <th>Quiet hours</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td>{EVENTS.find((e) => e.value === r.event)?.label || r.event}</td>
                  <td>{r.channel}</td>
                  <td className="mono">{r.target}</td>
                  <td>{r.quiet_hours || '-'}</td>
                  <td>
                    <button className="danger" onClick={() => remove(r.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">No alert routes set -- alerts fall back to the business's own owner_phone until you add one.</div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Add a route</h3>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={add}>
          <div className="field">
            <label>Event</label>
            <select value={form.event} onChange={(e) => setForm({ ...form, event: e.target.value })}>
              {EVENTS.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Channel</label>
              <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Email (not yet sent -- WhatsApp is the only channel that actually delivers today)</option>
                <option value="dashboard">Dashboard (not yet shown anywhere -- WhatsApp is the only channel that actually delivers today)</option>
              </select>
            </div>
            <div className="field">
              <label>Target (phone or email)</label>
              <input value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} required />
            </div>
          </div>
          <div className="field" style={{ maxWidth: 320 }}>
            <label>Quiet hours (e.g. 22:00-07:00, blank = none)</label>
            <input value={form.quiet_hours} onChange={(e) => setForm({ ...form, quiet_hours: e.target.value })} placeholder="22:00-07:00" />
          </div>
          <button type="submit">Add</button>
        </form>
      </div>
    </div>
  );
}
