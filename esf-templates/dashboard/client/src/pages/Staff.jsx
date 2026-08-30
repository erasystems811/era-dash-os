import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const EMPTY = { name: '', phone: '', role: '', shift_start: '', shift_end: '' };

export default function Staff() {
  const [list, setList] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);

  function load() {
    api.get('/staff').then(setList);
  }
  useEffect(load, []);

  async function add(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/staff', form);
      setForm(EMPTY);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleActive(person) {
    await api.post(`/staff/${person.id}/toggle-active`);
    load();
  }

  if (!list) return null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Staff</h1>
          <p className="subtitle">Everyone who gets messaged with tasks over WhatsApp. Roles are your own words -- there's no fixed list.</p>
        </div>
      </div>

      <div className="card">
        {list.length ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Role</th>
                <th>Shift</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="mono">{s.phone}</td>
                  <td>{s.role}</td>
                  <td>{s.shift_start || s.shift_end ? `${s.shift_start || ''} - ${s.shift_end || ''}` : '-'}</td>
                  <td>
                    <span className={`badge ${s.active ? 'active' : 'inactive'}`}>{s.active ? 'active' : 'inactive'}</span>
                  </td>
                  <td>
                    <button className="secondary" onClick={() => toggleActive(s)}>
                      {s.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">No staff yet -- add your first below.</div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Add staff member</h3>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={add}>
          <div className="form-row">
            <div className="field">
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label>WhatsApp phone (2348..., no plus, no leading zero)</label>
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} pattern="[0-9]{10,15}" required />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Role (e.g. sales, cashier, cleaner)</label>
              <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} required />
            </div>
            <div className="field">
              <label>Shift start</label>
              <input type="time" value={form.shift_start} onChange={(e) => setForm({ ...form, shift_start: e.target.value })} />
            </div>
            <div className="field">
              <label>Shift end</label>
              <input type="time" value={form.shift_end} onChange={(e) => setForm({ ...form, shift_end: e.target.value })} />
            </div>
          </div>
          <button type="submit">Add</button>
        </form>
      </div>
    </div>
  );
}
