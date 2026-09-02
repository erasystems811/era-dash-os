import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';
import { useScope } from '../ScopeContext.jsx';

const EMPTY = {
  name: '',
  address: '',
  phone_number: '',
  operating_hours: '',
  area: '',
  whatsapp_number: '',
  instagram_handle: '',
  timezone: 'Africa/Lagos',
  status: 'active',
  is_primary: false,
};

const STATUS_LABEL = { active: 'Active', paused: 'Paused', closed: 'Closed' };

export default function Branches() {
  const { staff } = useStaff();
  const editable = canEdit(staff);
  const scopeCtx = useScope();
  const [branches, setBranches] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY);

  function load() {
    api.get('/branches').then(setBranches);
    // The sidebar's scope switcher (Layout.jsx) has its own copy of this
    // same list -- without this, adding a business's first or second
    // branch here would need a hard page reload before the switcher
    // appeared, which is exactly the "no downtime" this page exists to
    // guarantee for everything else.
    scopeCtx?.refreshBranches();
  }
  useEffect(load, []);

  async function add(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/branches', form);
      setForm(EMPTY);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(id) {
    await api.delete(`/branches/${id}`);
    load();
  }

  function startEdit(b) {
    setEditingId(b.id);
    setEditForm({
      name: b.name,
      address: b.address,
      phone_number: b.phone_number || '',
      operating_hours: b.operating_hours || '',
      area: b.area || '',
      whatsapp_number: b.whatsapp_number || '',
      instagram_handle: b.instagram_handle || '',
      timezone: b.timezone || 'Africa/Lagos',
      status: b.status || 'active',
      is_primary: b.is_primary || false,
    });
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(id) {
    await api.post(`/branches/${id}`, editForm);
    setEditingId(null);
    load();
  }

  if (!branches) return null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Branches</h1>
          <p className="subtitle">
            Only matters if you have more than one location. With two or more here, the bot asks customers which branch on every order and
            uses that branch's own address, hours and (once connected) number for that conversation.
          </p>
        </div>
      </div>

      <div className="card">
        {branches.map((b) =>
          editingId === b.id ? (
            <div key={b.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="form-row">
                <div className="field">
                  <label>Name</label>
                  <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                </div>
                <div className="field">
                  <label>Phone number</label>
                  <input value={editForm.phone_number} onChange={(e) => setEditForm({ ...editForm, phone_number: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <label>Address</label>
                <input value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} />
              </div>
              <div className="form-row">
                <div className="field">
                  <label>Area</label>
                  <input
                    value={editForm.area}
                    onChange={(e) => setEditForm({ ...editForm, area: e.target.value })}
                    placeholder="Used as the delivery-distance starting point"
                  />
                </div>
                <div className="field">
                  <label>Operating hours</label>
                  <input value={editForm.operating_hours} onChange={(e) => setEditForm({ ...editForm, operating_hours: e.target.value })} />
                </div>
              </div>
              <div className="form-row">
                <div className="field">
                  <label>WhatsApp number</label>
                  <input
                    value={editForm.whatsapp_number}
                    onChange={(e) => setEditForm({ ...editForm, whatsapp_number: e.target.value })}
                    placeholder="Not connected yet"
                  />
                </div>
                <div className="field">
                  <label>Instagram handle</label>
                  <input value={editForm.instagram_handle} onChange={(e) => setEditForm({ ...editForm, instagram_handle: e.target.value })} />
                </div>
              </div>
              <div className="form-row">
                <div className="field">
                  <label>Status</label>
                  <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}>
                    <option value="active">Active -- takes orders</option>
                    <option value="paused">Paused -- closed message, no orders</option>
                    <option value="closed">Closed</option>
                  </select>
                </div>
                <div className="field">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 22 }}>
                    <input
                      type="checkbox"
                      checked={editForm.is_primary}
                      onChange={(e) => setEditForm({ ...editForm, is_primary: e.target.checked })}
                    />
                    Primary branch (default location)
                  </label>
                </div>
              </div>
              <button onClick={() => saveEdit(b.id)} style={{ marginRight: 8 }}>
                Save
              </button>
              <button className="secondary" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          ) : (
            <div key={b.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                {b.name}
                {b.is_primary && <span className="badge primary">Primary</span>}
                {b.status !== 'active' && <span className={`badge ${b.status}`}>{STATUS_LABEL[b.status] || b.status}</span>}
              </div>
              <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{b.address}</div>
              {(b.phone_number || b.operating_hours) && (
                <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                  {b.phone_number}
                  {b.phone_number && b.operating_hours ? ' · ' : ''}
                  {b.operating_hours}
                </div>
              )}
              <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                WhatsApp: {b.whatsapp_number || 'Not connected yet'}
              </div>
              {editable && (
                <div style={{ marginTop: 8 }}>
                  <button className="secondary" onClick={() => startEdit(b)} style={{ marginRight: 8 }}>
                    Edit
                  </button>
                  <button className="danger" onClick={() => remove(b.id)}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          )
        )}
        {!branches.length && <div className="empty-state">No branches added -- this business is treated as a single location.</div>}
      </div>

      {editable && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Add branch</h3>
          {error && <div className="error-banner">{error}</div>}
          <form onSubmit={add}>
            <div className="form-row">
              <div className="field">
                <label>Name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Lugbe branch" required />
              </div>
              <div className="field">
                <label>Phone number</label>
                <input value={form.phone_number} onChange={(e) => setForm({ ...form, phone_number: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Address</label>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} required />
            </div>
            <div className="form-row">
              <div className="field">
                <label>Area</label>
                <input
                  value={form.area}
                  onChange={(e) => setForm({ ...form, area: e.target.value })}
                  placeholder="Used as the delivery-distance starting point"
                />
              </div>
              <div className="field">
                <label>Operating hours</label>
                <input value={form.operating_hours} onChange={(e) => setForm({ ...form, operating_hours: e.target.value })} />
              </div>
            </div>
            <button type="submit">Add branch</button>
          </form>
        </div>
      )}
    </div>
  );
}
