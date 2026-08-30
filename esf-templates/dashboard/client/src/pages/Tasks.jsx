import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { DAY_CODES } from '../proofTypes.js';

const EMPTY = { name: '', assignTo: '', days: [], available_from: '', due_by: '', mode: 'chat' };

export default function Tasks() {
  const [list, setList] = useState(null);
  const [staffList, setStaffList] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);

  function load() {
    api.get('/tasks').then(setList);
  }
  useEffect(load, []);
  useEffect(() => {
    api.get('/staff').then((s) => setStaffList(s.filter((p) => p.active)));
  }, []);

  function toggleDay(day) {
    setForm((f) => ({ ...f, days: f.days.includes(day) ? f.days.filter((d) => d !== day) : [...f.days, day] }));
  }

  async function create(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/tasks', form);
      setForm(EMPTY);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const roles = [...new Set(staffList.map((s) => s.role))];

  if (!list) return null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Tasks</h1>
          <p className="subtitle">What staff get walked through, and who it's for. Nothing here is fixed -- design your own.</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : 'New task'}</button>
      </div>

      {showForm && (
        <div className="card">
          {error && <div className="error-banner">{error}</div>}
          <form onSubmit={create}>
            <div className="field">
              <label>Task name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label>Assign to</label>
              <select value={form.assignTo} onChange={(e) => setForm({ ...form, assignTo: e.target.value })}>
                <option value="">Everyone (every active staff member)</option>
                {roles.map((r) => (
                  <option key={r} value={`role:${r}`}>
                    Everyone with role: {r}
                  </option>
                ))}
                {staffList.map((s) => (
                  <option key={s.id} value={`staff:${s.id}`}>
                    {s.name} only ({s.role})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Days</label>
              <div className="day-picker">
                {DAY_CODES.map((d) => (
                  <label key={d}>
                    <input type="checkbox" checked={form.days.includes(d)} onChange={() => toggleDay(d)} />
                    {d}
                  </label>
                ))}
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Available from</label>
                <input type="time" value={form.available_from} onChange={(e) => setForm({ ...form, available_from: e.target.value })} required />
              </div>
              <div className="field">
                <label>Due by</label>
                <input type="time" value={form.due_by} onChange={(e) => setForm({ ...form, due_by: e.target.value })} required />
              </div>
            </div>
            <div className="field">
              <label>Delivery</label>
              <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                <option value="chat">Chat -- one step at a time, in order</option>
                <option value="form">Form -- a link to fill out all at once (no location/photo steps)</option>
              </select>
            </div>
            <button type="submit">Create task</button>
          </form>
        </div>
      )}

      <div className="card">
        {list.length ? (
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Assigned to</th>
                <th>Days</th>
                <th>Window</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => (window.location.href = `/tasks/${t.id}`)}>
                  <td>
                    <Link to={`/tasks/${t.id}`}>{t.name}</Link>
                  </td>
                  <td>{t.assignment}</td>
                  <td>{t.days}</td>
                  <td>
                    {t.available_from} - {t.due_by}
                  </td>
                  <td>
                    <span className={`badge ${t.active ? 'active' : 'inactive'}`}>{t.active ? 'active' : 'inactive'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">No tasks yet -- create your first above.</div>
        )}
      </div>
    </div>
  );
}
