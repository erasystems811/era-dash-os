import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';
import { useScope, scopeQuery } from '../ScopeContext.jsx';
import Loading from '../components/Loading.jsx';

const EMPTY = { name: '', phone_number: '', email: '', password: '', role: 'manager', branch_id: '' };
const EMPTY_PIN = { name: '', pin: '', work_area: '' };

export default function StaffPage() {
  const { staff } = useStaff();
  const { scope } = useScope();
  const editable = canEdit(staff);
  const isOwner = staff?.role === 'owner';
  // A branch-locked manager can still add their own branch's PIN staff
  // (editable alone governs that form below), but only the owner or an
  // unlocked ("general") manager can create another manager or owner
  // account -- Chidera's own words, 2026-09-03: "branch manager cant
  // create a new manager or owner but general manager... can create
  // branch managers." Same signal as the server's own check
  // (routes/api.js's POST /staff): branch_id null means owner or general
  // manager, not "not locked to a branch" for its own sake.
  const canManageOwnersAndManagers = editable && !staff?.branch_id;
  const [list, setList] = useState(null);
  const [branches, setBranches] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [pinForm, setPinForm] = useState(EMPTY_PIN);
  const [error, setError] = useState(null);
  const [pinError, setPinError] = useState(null);
  // Work area (Online/In House) only means anything once dine-in is on --
  // Chidera 2026-09-11: "theyll be 2 types of staff for people with dine
  // in toggle on." Genuinely inert (the field doesn't even render) while
  // it's off, same rule Layout.jsx's own add-on nav items follow.
  const [dineinEnabled, setDineinEnabled] = useState(false);

  function load() {
    api.get('/staff').then(setList);
    api.get('/branches').then(setBranches);
    api.get('/dinein-config').then((c) => setDineinEnabled(Boolean(c?.enabled)));
  }
  useEffect(load, []);

  // Same "invisible below two branches" rule as everywhere else branch UI
  // lives -- a single-location business never sees a branch column or
  // picker here at all.
  const showBranches = branches.length > 1;

  // Who a PIN account gets created under: the acting manager's own lock,
  // or (for an owner) whichever single branch they're currently scoped to
  // via the sidebar switcher. A PIN account always belongs to exactly one
  // branch -- see routes/api.js's POST /staff/pin -- so this form simply
  // doesn't render for an owner viewing "All orders"/"Compare branches",
  // same "don't show a control that can't do anything yet" rule as the
  // scope switcher itself.
  const pinBranchId = staff?.branch_id || (scope && scope !== 'all' ? scope : null);
  const pinBranchName = branches.find((b) => b.id === pinBranchId)?.name;

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

  async function addPin(e) {
    e.preventDefault();
    setPinError(null);
    try {
      await api.post(`/staff/pin${scopeQuery(pinBranchId)}`, pinForm);
      setPinForm(EMPTY_PIN);
      load();
    } catch (err) {
      setPinError(err.message);
    }
  }

  async function resetPin(person) {
    const pin = window.prompt(`New 4-digit PIN for ${person.name}:`);
    if (!pin) return;
    setPinError(null);
    try {
      await api.post(`/staff/${person.id}/pin${scopeQuery(pinBranchId)}`, { pin });
      load();
    } catch (err) {
      setPinError(err.message);
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

  if (!list) return <Loading />;

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
              <th>Login</th>
              <th>Phone</th>
              <th>Role</th>
              {showBranches && <th>Branch</th>}
              {dineinEnabled && <th>Work area</th>}
              <th>Status</th>
              <th>Handover alerts</th>
              {editable && <th></th>}
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.auth_type === 'pin' ? <span className="badge">PIN</span> : p.email}</td>
                <td>{p.phone_number}</td>
                <td>{p.role}</td>
                {showBranches && (
                  <td>
                    {isOwner && p.auth_type !== 'pin' ? (
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
                {dineinEnabled && (
                  <td>{p.work_area === 'online' ? 'Online' : p.work_area === 'in_house' ? 'In House' : 'All'}</td>
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
                  <td style={{ display: 'flex', gap: 8 }}>
                    {p.auth_type === 'pin' && (
                      <button className="secondary" onClick={() => resetPin(p)}>
                        Reset PIN
                      </button>
                    )}
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

      {canManageOwnersAndManagers && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Add manager or owner</h3>
          <p className="subtitle">A real login with their own email and password -- for whoever runs a branch or the whole business.</p>
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

      {editable && pinBranchId && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Add staff with a PIN{pinBranchName ? ` -- ${pinBranchName}` : ''}</h3>
          <p className="subtitle">
            No email needed -- they sign in on the shared dashboard device with their name and this 4-digit PIN. They only ever see
            Orders, Catalogue, Conversations, Knowledge base, and Documents.
          </p>
          {dineinEnabled && (
            <p className="subtitle">
              With dine-in on, you can lock a PIN account to just Online orders or just In House -- leave it "All" for the usual
              full view.
            </p>
          )}
          {pinError && <div className="error-banner">{pinError}</div>}
          <form onSubmit={addPin}>
            <div className="form-row">
              <div className="field">
                <label>Name</label>
                <input value={pinForm.name} onChange={(e) => setPinForm({ ...pinForm, name: e.target.value })} required />
              </div>
              <div className="field" style={{ maxWidth: 160 }}>
                <label>4-digit PIN</label>
                <input
                  value={pinForm.pin}
                  onChange={(e) => setPinForm({ ...pinForm, pin: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                  inputMode="numeric"
                  pattern="\d{4}"
                  maxLength={4}
                  required
                />
              </div>
              {dineinEnabled && (
                <div className="field" style={{ maxWidth: 180 }}>
                  <label>Work area</label>
                  <select value={pinForm.work_area} onChange={(e) => setPinForm({ ...pinForm, work_area: e.target.value })}>
                    <option value="">All (default)</option>
                    <option value="online">Online only</option>
                    <option value="in_house">In House only</option>
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
