import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const EMPTY = { name: '', description: '', price: '', availability_type: 'stock', duration_minutes: '', category: '', image_data_url: '' };
const UNCATEGORIZED = 'Uncategorized';

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Groups by category (a bulk import's own section headings, or whatever
// staff typed manually) so a large catalogue reads as the sections it
// actually has, not one flat list -- the whole point of carrying category
// through at all is making a specific item quick to find here. Items
// without a category ("Uncategorized") sort last, real categories
// alphabetically, items within a category alphabetically too.
function groupByCategory(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.category || UNCATEGORIZED;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === UNCATEGORIZED) return 1;
    if (b === UNCATEGORIZED) return -1;
    return a.localeCompare(b);
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function Catalogue() {
  // Every tier that can reach this page (owner/manager/PIN staff) can edit
  // it -- Chidera's call, 2026-09-03: "when i say they can see knowledge
  // base and catalogue it means they can edit it and work on it normally
  // not just view only". Kept as its own constant (not just deleting every
  // `editable &&` below) so the RBAC decision stays one documented line,
  // not scattered assumptions.
  const editable = true;
  const [items, setItems] = useState(null);
  const [pending, setPending] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [bulkText, setBulkText] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const [bulkError, setBulkError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY);
  const [editError, setEditError] = useState(null);

  function load() {
    api.get('/catalogue').then(setItems);
    api.get('/catalogue/import/pending').then(setPending);
  }
  useEffect(load, []);

  async function approveImport(id) {
    await api.post(`/catalogue/import/${id}/approve`);
    load();
  }
  async function rejectImport(id) {
    await api.post(`/catalogue/import/${id}/reject`);
    load();
  }
  async function approveAllImports() {
    for (const p of pending) await api.post(`/catalogue/import/${p.id}/approve`);
    load();
  }

  async function addItem(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/catalogue', form);
      setForm(EMPTY);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function bulkImportText(e) {
    e.preventDefault();
    setBulkError(null);
    setBulkResult(null);
    setBulkBusy(true);
    try {
      const result = await api.post('/catalogue/bulk-import', { text: bulkText });
      setBulkResult(result);
      setBulkText('');
      load();
    } catch (err) {
      setBulkError(err.message);
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkImportPhoto(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBulkError(null);
    setBulkResult(null);
    setBulkBusy(true);
    try {
      const images = await Promise.all(files.map(async (file) => ({ mediaType: file.type, base64: await readFileAsBase64(file) })));
      const result = await api.post('/catalogue/bulk-import', { images });
      setBulkResult(result);
      load();
    } catch (err) {
      setBulkError(err.message);
    } finally {
      setBulkBusy(false);
      e.target.value = '';
    }
  }

  async function toggle(id) {
    await api.post(`/catalogue/${id}/toggle`);
    load();
  }

  async function remove(id) {
    await api.delete(`/catalogue/${id}`);
    load();
  }

  function startEdit(p) {
    setEditingId(p.id);
    setEditError(null);
    setEditForm({
      name: p.name,
      description: p.description || '',
      price: p.price,
      availability_type: p.availability_type,
      duration_minutes: p.duration_minutes || '',
      category: p.category || '',
      image_data_url: p.image_data_url || '',
    });
  }

  async function onItemPhoto(e, setter) {
    const file = e.target.files[0];
    if (!file) return;
    setter((f) => ({ ...f, image_data_url: '' }));
    const dataUrl = await readFileAsDataUrl(file);
    setter((f) => ({ ...f, image_data_url: dataUrl }));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit(id) {
    setEditError(null);
    try {
      await api.post(`/catalogue/${id}`, editForm);
      setEditingId(null);
      load();
    } catch (err) {
      setEditError(err.message);
    }
  }

  if (!items) return null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Catalogue</h1>
          <p className="subtitle">The menu, service list, vehicle list, or property list the bot orders from.</p>
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Photo</th>
              <th>Name</th>
              <th>Description</th>
              <th>Price</th>
              <th>Availability rule</th>
              <th>Status</th>
              {editable && <th></th>}
            </tr>
          </thead>
          <tbody>
            {groupByCategory(items).map(([category, group]) => (
              <React.Fragment key={category}>
                <tr>
                  <td colSpan={editable ? 7 : 6} style={{ background: 'var(--surface-muted, rgba(127,127,127,0.08))', fontWeight: 600 }}>
                    {category} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({group.length})</span>
                  </td>
                </tr>
                {group.map((p) =>
                  editingId === p.id ? (
                <tr key={p.id}>
                  <td colSpan={editable ? 7 : 6}>
                    {editError && <div className="error-banner">{editError}</div>}
                    <div className="form-row">
                      <div className="field">
                        <label>Name</label>
                        <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                      </div>
                      <div className="field">
                        <label>Price</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={editForm.price}
                          onChange={(e) => setEditForm({ ...editForm, price: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="field">
                        <label>Description</label>
                        <input value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
                      </div>
                      <div className="field">
                        <label>Category</label>
                        <input
                          value={editForm.category}
                          onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
                          placeholder="e.g. Drinks"
                        />
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="field">
                        <label>Photo</label>
                        {editForm.image_data_url && (
                          <img src={editForm.image_data_url} alt="" style={{ height: 44, borderRadius: 4, display: 'block', marginBottom: 6 }} />
                        )}
                        <input type="file" accept="image/*" onChange={(e) => onItemPhoto(e, setEditForm)} />
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="field">
                        <label>Availability rule</label>
                        <select
                          value={editForm.availability_type}
                          onChange={(e) => setEditForm({ ...editForm, availability_type: e.target.value })}
                        >
                          <option value="stock">By stock</option>
                          <option value="time_slot">By time slot</option>
                          <option value="date">By date</option>
                        </select>
                      </div>
                      {editForm.availability_type === 'time_slot' && (
                        <div className="field">
                          <label>Slot duration (minutes)</label>
                          <input
                            type="number"
                            min="1"
                            value={editForm.duration_minutes}
                            onChange={(e) => setEditForm({ ...editForm, duration_minutes: e.target.value })}
                          />
                        </div>
                      )}
                    </div>
                    <button onClick={() => saveEdit(p.id)} style={{ marginRight: 8 }}>
                      Save
                    </button>
                    <button className="secondary" onClick={cancelEdit}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={p.id}>
                  <td>
                    {p.image_data_url ? (
                      <img src={p.image_data_url} alt="" style={{ height: 36, width: 36, objectFit: 'cover', borderRadius: 4 }} />
                    ) : (
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>none</span>
                    )}
                  </td>
                  <td>{p.name}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{p.description}</td>
                  <td>{Number(p.price).toLocaleString()}</td>
                  <td>{p.availability_type}</td>
                  <td>
                    <span className={`badge ${p.availability ? 'active' : 'disabled'}`}>{p.availability ? 'available' : 'unavailable'}</span>
                    {p.import_status && (
                      <span className="badge new" style={{ marginLeft: 6 }}>
                        {p.import_status === 'new' ? 'pending approval' : p.import_status === 'removed' ? 'pending removal' : 'change pending'}
                      </span>
                    )}
                  </td>
                  {editable && (
                    <td>
                      <button className="secondary" onClick={() => startEdit(p)} style={{ marginRight: 8 }}>
                        Edit
                      </button>
                      <button className="secondary" onClick={() => toggle(p.id)} style={{ marginRight: 8 }}>
                        {p.availability ? 'Mark unavailable' : 'Mark available'}
                      </button>
                      <button className="danger" onClick={() => remove(p.id)}>
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
                  )
                )}
              </React.Fragment>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={editable ? 7 : 6} className="empty-state">
                  No items yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editable && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Bulk import</h3>
          <p style={{ color: 'var(--text-muted)', marginTop: -6 }}>
            Paste your whole menu as it already exists, or upload photo(s) of a printed one (a multi-page menu can be
            several photos at once). A photo-based menu also gets forwarded to customers as-is instead of listed as
            text -- easier to read once there are a lot of items. Nothing goes live until you approve it below.
          </p>
          {bulkError && <div className="error-banner">{bulkError}</div>}
          {bulkResult && (
            <div className="success-banner">
              {bulkResult.new} new, {bulkResult.changed} changed, {bulkResult.removed} removed -- review below before it goes live.
            </div>
          )}
          <form onSubmit={bulkImportText}>
            <div className="field">
              <textarea
                rows={5}
                placeholder={'Jollof rice - 4500\nFried rice and chicken - 5000\nSuya wrap - 3000, spicy grilled beef'}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                disabled={bulkBusy}
              />
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="submit" disabled={bulkBusy || !bulkText.trim()}>
                {bulkBusy ? 'Reading...' : 'Import from text'}
              </button>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>or</span>
              <label className="btn secondary" style={{ border: '1px solid var(--border)', margin: 0 }}>
                Upload photo(s)
                <input type="file" accept="image/*" multiple onChange={bulkImportPhoto} disabled={bulkBusy} style={{ display: 'none' }} />
              </label>
            </div>
          </form>
        </div>
      )}

      {editable && pending && pending.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Pending review ({pending.length})</h3>
            <button onClick={approveAllImports}>Approve all</button>
          </div>
          <p style={{ color: 'var(--text-muted)' }}>From the last menu import -- nothing here reaches customers until approved.</p>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Change</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.id}>
                  <td>{p.import_status === 'changed' ? p.pending_name : p.name}</td>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {p.import_status === 'new' && (
                      <span className="badge active">
                        new item -- {Number(p.price).toLocaleString()}{p.category ? `, ${p.category}` : ''}
                      </span>
                    )}
                    {p.import_status === 'removed' && <span className="badge disabled">no longer on the menu</span>}
                    {p.import_status === 'changed' && (
                      <span className="badge new">
                        {[
                          p.name !== p.pending_name && `"${p.name}" -> "${p.pending_name}"`,
                          Number(p.price) !== Number(p.pending_price) && `${Number(p.price).toLocaleString()} -> ${Number(p.pending_price).toLocaleString()}`,
                          (p.category || null) !== (p.pending_category || null) && `${p.category || UNCATEGORIZED} -> ${p.pending_category || UNCATEGORIZED}`,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                    )}
                  </td>
                  <td>
                    <button onClick={() => approveImport(p.id)} style={{ marginRight: 8 }}>
                      Approve
                    </button>
                    <button className="secondary" onClick={() => rejectImport(p.id)}>
                      Reject
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editable && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Add item</h3>
          {error && <div className="error-banner">{error}</div>}
          <form onSubmit={addItem}>
            <div className="form-row">
              <div className="field">
                <label>Name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="field">
                <label>Price</label>
                <input type="number" step="0.01" min="0" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Description</label>
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>
              <div className="field">
                <label>Category</label>
                <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. Drinks" />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Photo</label>
                {form.image_data_url && <img src={form.image_data_url} alt="" style={{ height: 44, borderRadius: 4, display: 'block', marginBottom: 6 }} />}
                <input type="file" accept="image/*" onChange={(e) => onItemPhoto(e, setForm)} />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Availability rule</label>
                <select value={form.availability_type} onChange={(e) => setForm({ ...form, availability_type: e.target.value })}>
                  <option value="stock">By stock</option>
                  <option value="time_slot">By time slot</option>
                  <option value="date">By date</option>
                </select>
              </div>
              {form.availability_type === 'time_slot' && (
                <div className="field">
                  <label>Slot duration (minutes)</label>
                  <input type="number" min="1" value={form.duration_minutes} onChange={(e) => setForm({ ...form, duration_minutes: e.target.value })} />
                </div>
              )}
            </div>
            <button type="submit">Add item</button>
          </form>
        </div>
      )}
    </div>
  );
}
