import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';

const EMPTY = { name: '', phone_number: '', email: '', password: '', role: 'staff', branch_id: '' };

export default function StaffPage() {
  const { staff } = useStaff();
  const editable = canEdit(staff);
  const isOwner = staff?.role === 'owner';
  const [list, setList] = useState(null);
  const [branches, setBranches] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);

  function load() {
    api.get('/staff').then(setList);
    api.get('/branches').then(setBranches);
  }
  useEffect(load, []);

  // Same "invisible below two branches" rule as everywhere else branch UI
  // lives -- a single-location business never sees a branch column or
  // picker here at all.
  const showBranches = branches.length > 1;

  async function add(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/staff', { ...form, branch_id: form.branch_id || null });
      setForm(EMPTY);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleStatus(person) {
    await api.post(`/staff/${person.id}/status`, { status: person.status === 'active' ? 'disabled' : 'active' });
    load();
  }

  async function toggleHandoverAlerts(person) {
    setError(null);
    try {
      await api.post(`/staff/${person.id}/handover-alerts`, { handover_alerts: !person.handover_alerts });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function changeBranch(person, branchId) {
    setError(null);
    try {
      await api.post(`/staff/${person.id}/branch`, { branch_id: branchId || null });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!list) return null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Roles and numbers</h1>
          <p className="subtitle">Who can log in, and what they can edit. Any unrecognised WhatsApp number is a customer.</p>
        <p className="subtitle">Turn on handover alerts for anyone who should get pinged on WhatsApp when the bot hands off a chat. When one of them replies, the others are told they've taken it over.</p>
        {showBranches && (
          <p className="subtitle">A staff member locked to a branch only ever sees that branch's own board -- no switcher, no other branch's data, anywhere in their dashboard.</p>
        )}
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Role</th>
              {showBranches && <th>Branch</th>}
              <th>Status</th>
              <th>Handover alerts</th>
              {editable && <th></th>}
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.email}</td>
                <td>{p.phone_number}</td>
                <td>{p.role}</td>
                {showBranches && (
                  <td>
                    {isOwner ? (
                      <select value={p.branch_id || ''} onChange={(e) => changeBranch(p, e.target.value)}>
                        <option value="">All branches</option>
                        {branches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      p.branch_name || 'All branches'
                    )}
                  </td>
                )}
                <td>
                  <span className={`badge ${p.status}`}>{p.status}</span>
                </td>
                <td>
                  {editable ? (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
                      <input
                        type="checkbox"
                        checked={!!p.handover_alerts}
                        disabled={!p.phone_number}
                        title={!p.phone_number ? 'Add a phone number first' : ''}
                        onChange={() => toggleHandoverAlerts(p)}
                      />
                      {p.handover_alerts ? 'On' : 'Off'}
                    </label>
                  ) : (
                    p.handover_alerts ? 'On' : 'Off'
                  )}
                </td>
                {editable && (
                  <td>
                    <button className="secondary" onClick={() => toggleStatus(p)}>
                      {p.status === 'active' ? 'Disable' : 'Re-enable'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editable && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Add staff</h3>
          {error && <div className="error-banner">{error}</div>}
          <form onSubmit={add}>
            <div className="form-row">
              <div className="field">
                <label>Name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="field">
                <label>Phone number</label>
                <input value={form.phone_number} onChange={(e) => setForm({ ...form, phone_number: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Email (their login)</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              </div>
              <div className="field">
                <label>Temporary password</label>
                <input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
              </div>
            </div>
            <div className="form-row">
              <div className="field" style={{ maxWidth: 220 }}>
                <label>Role</label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="staff">Staff</option>
                  <option value="manager">Manager</option>
                  <option value="owner">Owner</option>
                </select>
              </div>
              {showBranches && (
                <div className="field" style={{ maxWidth: 220 }}>
                  <label>Branch</label>
                  <select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })}>
                    <option value="">All branches</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <button type="submit">Add staff</button>
          </form>
        </div>
      )}
    </div>
  );
}
