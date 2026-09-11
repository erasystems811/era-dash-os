import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';

const EMPTY = { branch_id: '', label: '', seats: '' };

// Stage 1 of EBOS-Addon-Schema-Dine-In.md's own build order: tables + QR
// generation only. Scan handling, the menu page, ordering and feedback
// (stages 2-7) don't exist yet -- this page is deliberately just "set up
// your tables and print their codes" for now.
export default function DineIn() {
  const { staff } = useStaff();
  const editable = canEdit(staff);
  const [config, setConfig] = useState(null);
  const [tables, setTables] = useState(null);
  const [branches, setBranches] = useState([]);
  const [feedback, setFeedback] = useState(null);
  const [pendingOrders, setPendingOrders] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY);
  // false = not printing, 'all' = every table, or a table id -- one table's
  // QR code needs its own print (Chidera 2026-09-11: "each table is to have
  // their own print qr sheet cause its one per table na" -- a single
  // replaced/damaged card, or a table added after the initial batch, is a
  // one-card reprint, not the whole sheet again).
  const [printMode, setPrintMode] = useState(false);

  function load() {
    api.get('/dinein-config').then(setConfig);
    api.get('/dinein/tables').then(setTables);
    api.get('/branches').then(setBranches);
    api.get('/dinein/feedback').then(setFeedback);
    api.get('/dinein/orders/pending').then(setPendingOrders);
  }
  useEffect(load, []);

  async function actionFeedback(id) {
    await api.post(`/dinein/feedback/${id}/action`);
    load();
  }

  // Reuses the exact same close-out every other order already gets
  // (routes/api.js's POST /orders/:id/status) -- not a second, dine-in-only
  // path that could drift out of sync with what "completed" means anywhere
  // else in EBOS.
  async function markServed(id) {
    await api.post(`/orders/${id}/status`, { status: 'completed' });
    load();
  }

  const showBranchPicker = branches.length > 1;

  async function addTable(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/dinein/tables', {
        branch_id: form.branch_id || branches[0]?.id,
        label: form.label,
        seats: form.seats ? Number(form.seats) : null,
      });
      setForm(EMPTY);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  function startEdit(t) {
    setEditingId(t.id);
    setEditForm({ label: t.label, seats: t.seats || '', status: t.status });
  }

  async function saveEdit(id) {
    setError(null);
    try {
      await api.post(`/dinein/tables/${id}`, { label: editForm.label, seats: editForm.seats ? Number(editForm.seats) : null, status: editForm.status });
      setEditingId(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function regenerateQr(id) {
    await api.post(`/dinein/tables/${id}/regenerate-qr`);
    load();
  }

  async function closeTable(id) {
    setError(null);
    try {
      await api.post(`/dinein/tables/${id}/close`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeTable(id) {
    setError(null);
    try {
      await api.delete(`/dinein/tables/${id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!config || !tables) return null;

  if (printMode) {
    const printTables = printMode === 'all' ? tables : tables.filter((t) => t.id === printMode);
    const single = printMode !== 'all' && printTables.length === 1 ? printTables[0] : null;
    return (
      <div>
        <div className="page-header no-print">
          <div>
            <h1>{single ? `Table ${single.label} QR code` : 'QR sheet'}</h1>
            <p className="subtitle">
              {single ? 'Print, cut, and set out on this table.' : 'One card per table -- print, cut, and set out on the tables.'}
            </p>
          </div>
          <button className="secondary" onClick={() => setPrintMode(false)}>
            Back
          </button>
          <button onClick={() => window.print()}>Print</button>
        </div>
        <div className="qr-sheet">
          {printTables.map((t) => (
            <div key={t.id} className="qr-card">
              {t.qr_data_url ? <img src={t.qr_data_url} alt="" /> : <p>No WhatsApp number set for this branch yet.</p>}
              <div className="qr-card-label">Table {t.label}</div>
            </div>
          ))}
        </div>
        <style>{`
          .qr-sheet { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
          .qr-card { border: 1px solid #ccc; border-radius: 10px; padding: 16px; text-align: center; }
          .qr-card img { width: 100%; max-width: 220px; }
          .qr-card-label { font-size: 22px; font-weight: 700; margin-top: 8px; }
          @media print {
            .no-print { display: none !important; }
            .qr-sheet { grid-template-columns: repeat(2, 1fr); }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Dine-in</h1>
          <p className="subtitle">Tables, QR codes, and how the room orders from their seat.</p>
        </div>
        {tables.length > 0 && (
          <button className="secondary" onClick={() => setPrintMode('all')}>
            Print QR sheet
          </button>
        )}
      </div>

      {!config.enabled && (
        <div className="card">
          <p className="hint" style={{ marginBottom: 0 }}>
            Dine-in isn't switched on for this business yet -- reach out to ERA to turn it on. Tables set up here are ready the
            moment it is.
          </p>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {pendingOrders && pendingOrders.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Pending orders</h3>
          <p className="subtitle">Placed, waiting on the kitchen/bar. Oldest first.</p>
          <table>
            <thead>
              <tr>
                <th>Table</th>
                <th>Order</th>
                <th>Total</th>
                {editable && <th></th>}
              </tr>
            </thead>
            <tbody>
              {pendingOrders.map((o) => (
                <tr key={o.id}>
                  <td>Table {o.table_label}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{o.items.map((i) => `${i.quantity}x ${i.name}`).join(', ')}</td>
                  <td>NGN {Number(o.total || 0).toLocaleString()}</td>
                  {editable && (
                    <td>
                      <button className="secondary" onClick={() => markServed(o.id)}>
                        Served
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Table</th>
              {showBranchPicker && <th>Branch</th>}
              <th>Seats</th>
              <th>Status</th>
              <th>QR</th>
              {editable && <th></th>}
            </tr>
          </thead>
          <tbody>
            {tables.map((t) =>
              editingId === t.id ? (
                <tr key={t.id}>
                  <td colSpan={showBranchPicker ? 6 : 5}>
                    <div className="form-row">
                      <div className="field">
                        <label>Table label</label>
                        <input value={editForm.label} onChange={(e) => setEditForm({ ...editForm, label: e.target.value })} />
                      </div>
                      <div className="field">
                        <label>Seats</label>
                        <input type="number" min="0" value={editForm.seats} onChange={(e) => setEditForm({ ...editForm, seats: e.target.value })} />
                      </div>
                      <div className="field" style={{ maxWidth: 160 }}>
                        <label>Status</label>
                        <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}>
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                        </select>
                      </div>
                    </div>
                    <button onClick={() => saveEdit(t.id)} style={{ marginRight: 8 }}>
                      Save
                    </button>
                    <button className="secondary" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={t.id}>
                  <td>Table {t.label}</td>
                  {showBranchPicker && <td>{t.branch_name}</td>}
                  <td>{t.seats || '--'}</td>
                  <td>
                    <span className={`badge ${t.status === 'active' ? 'active' : 'disabled'}`}>{t.status}</span>
                    {t.has_open_session && (
                      <span className="badge new" style={{ marginLeft: 6 }}>
                        seated
                      </span>
                    )}
                  </td>
                  <td>
                    {t.qr_data_url ? (
                      <>
                        <img src={t.qr_data_url} alt="" style={{ height: 44, width: 44, display: 'block', marginBottom: 4 }} />
                        <button className="secondary" onClick={() => setPrintMode(t.id)}>
                          Print
                        </button>
                      </>
                    ) : (
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>no number set</span>
                    )}
                  </td>
                  {editable && (
                    <td style={{ display: 'flex', gap: 8 }}>
                      {t.has_open_session && (
                        <button className="secondary" onClick={() => closeTable(t.id)}>
                          Close table
                        </button>
                      )}
                      <button className="secondary" onClick={() => startEdit(t)}>
                        Edit
                      </button>
                      <button className="secondary" onClick={() => regenerateQr(t.id)}>
                        New QR
                      </button>
                      <button className="danger" onClick={() => removeTable(t.id)}>
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              )
            )}
            {!tables.length && (
              <tr>
                <td colSpan={showBranchPicker ? 6 : 5} className="empty-state">
                  No tables yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {feedback && feedback.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Feedback</h3>
          <p className="subtitle">Newest first, negative first. A "Not good" rating is already in the Needs-a-person queue too.</p>
          <table>
            <thead>
              <tr>
                <th>Table</th>
                <th>Rating</th>
                <th>Said</th>
                <th>Ordered</th>
                {editable && <th></th>}
              </tr>
            </thead>
            <tbody>
              {feedback.map((f) => (
                <tr key={f.id}>
                  <td>{f.table_label}</td>
                  <td>
                    <span className={`badge ${f.score === 'bad' ? 'disabled' : f.score === 'alright' ? 'new' : 'active'}`}>{f.score}</span>
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{f.comment || '--'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{f.ordered || '--'}</td>
                  {editable && (
                    <td>
                      {f.status !== 'actioned' && (
                        <button className="secondary" onClick={() => actionFeedback(f.id)}>
                          Mark actioned
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editable && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Add table</h3>
          <form onSubmit={addTable}>
            <div className="form-row">
              <div className="field">
                <label>Table label</label>
                <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. 7 or Terrace 2" required />
              </div>
              <div className="field">
                <label>Seats</label>
                <input type="number" min="0" value={form.seats} onChange={(e) => setForm({ ...form, seats: e.target.value })} />
              </div>
              {showBranchPicker && (
                <div className="field">
                  <label>Branch</label>
                  <select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })} required>
                    <option value="">Select a branch</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <button type="submit">Add table</button>
          </form>
        </div>
      )}
    </div>
  );
}
