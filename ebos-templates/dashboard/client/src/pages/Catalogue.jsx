import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { compressImageToDataUrl } from '../imageUpload.js';
import Loading from '../components/Loading.jsx';

const EMPTY = { name: '', description: '', price: '', availability_type: 'stock', duration_minutes: '', category: '', image_data_url: '' };
const UNCATEGORIZED = 'Uncategorized';

// Groups by category (a bulk import's own section headings, or whatever
// staff typed manually) so a large catalogue reads as the sections it
// actually has, not one flat list -- the whole point of carrying category
// through at all is making a specific item quick to find here.
//
// Chidera, 2026-09-16: "it only got category right, it scattered the
// rest... the actual menu should be up as organized" -- this used to
// re-sort everything alphabetically (both category order and item order
// within a category), which silently discarded the real menu's own
// layout. A real menu is rarely alphabetical: a "combos" or "chef's
// specials" section usually belongs first regardless of its name, and
// items within a section are ordered on purpose. The API now returns
// items in `position` order (reading order of the original menu, or
// append-order for anything added by hand -- see routes/api.js's
// /catalogue and /catalogue/bulk-import) -- preserve that order here
// instead of re-sorting it away. Items with no category
// ("Uncategorized") still sort last regardless of where they first
// appeared -- there's no "original position" for a catch-all bucket.
function groupByCategory(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.category || UNCATEGORIZED;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === UNCATEGORIZED) return 1;
    if (b === UNCATEGORIZED) return -1;
    return 0; // keep first-appearance order otherwise -- Array.prototype.sort is stable
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
  // Chidera, 2026-09-16: "let it never happen again" -- after finding a
  // menu photo that displayed blurry because the source was only 225x225.
  // Soft warning, not a block: a small/cropped photo is sometimes the only
  // one a business has, so this flags it before it goes live rather than
  // refusing the upload outright.
  const [photoWarning, setPhotoWarning] = useState(null);
  // Per-item customization questions (water: room temp or cold, rice:
  // peppered or not, ...) -- opt-in per item on purpose, per Chidera
  // 2026-09-10: some restaurants want this, some don't (pre-made meals,
  // nothing to ask). Loaded alongside the rest of an item's edit form
  // rather than a separate page, since it's only ever edited in that
  // context.
  const [questions, setQuestions] = useState([]);
  const [newQuestion, setNewQuestion] = useState('');
  const [questionError, setQuestionError] = useState(null);
  // A combo/special offer is created here, not "marked" onto an ordinary
  // item -- Chidera 2026-09-10: "a special offer is a combo so it should
  // be created not marked... with form style adding the items in the deal
  // and how much and name of deal." Its own name, its own bundled price,
  // and a real list of what's included, picked from the existing
  // catalogue -- posted to POST /catalogue/combo (routes/api.js).
  const [comboForm, setComboForm] = useState({ name: '', price: '', items: [{ productId: '', quantity: 1 }] });
  const [comboError, setComboError] = useState(null);

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

  function setComboItemRow(idx, patch) {
    setComboForm((f) => ({ ...f, items: f.items.map((row, i) => (i === idx ? { ...row, ...patch } : row)) }));
  }
  function addComboItemRow() {
    setComboForm((f) => ({ ...f, items: [...f.items, { productId: '', quantity: 1 }] }));
  }
  function removeComboItemRow(idx) {
    setComboForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
  }

  async function addCombo(e) {
    e.preventDefault();
    setComboError(null);
    const usableItems = comboForm.items.filter((row) => row.productId);
    if (!usableItems.length) {
      setComboError('Pick at least one item for the deal.');
      return;
    }
    try {
      await api.post('/catalogue/combo', {
        name: comboForm.name,
        price: comboForm.price,
        items: usableItems.map((row) => ({ productId: row.productId, quantity: Number(row.quantity) || 1 })),
      });
      setComboForm({ name: '', price: '', items: [{ productId: '', quantity: 1 }] });
      load();
    } catch (err) {
      setComboError(err.message);
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
    setNewQuestion('');
    api.get(`/catalogue/${p.id}/questions`).then(setQuestions);
  }

  async function addQuestion(productId) {
    if (!newQuestion.trim()) return;
    setQuestionError(null);
    try {
      const q = await api.post(`/catalogue/${productId}/questions`, { question: newQuestion.trim() });
      setQuestions((qs) => [...qs, q]);
      setNewQuestion('');
    } catch (err) {
      // Found live, 2026-09-10: this used to fail with no feedback at all
      // on error -- looked exactly like the click did nothing, with no way
      // to tell "it didn't save" from "I forgot to click the button".
      setQuestionError(err.message);
    }
  }

  async function removeQuestion(questionId) {
    setQuestionError(null);
    try {
      await api.delete(`/catalogue/questions/${questionId}`);
      setQuestions((qs) => qs.filter((q) => q.id !== questionId));
    } catch (err) {
      setQuestionError(err.message);
    }
  }

  async function onItemPhoto(e, setter) {
    const file = e.target.files[0];
    if (!file) return;
    setter((f) => ({ ...f, image_data_url: '' }));
    setPhotoWarning(null);
    // Compressed client-side (same fix as Settings.jsx's logo/cover photo)
    // -- a raw phone photo here hit the exact same "too large" failure,
    // just for a product photo instead of the business's own branding.
    const { dataUrl, isLowRes } = await compressImageToDataUrl(file, { squareCrop: true });
    setter((f) => ({ ...f, image_data_url: dataUrl }));
    if (isLowRes) {
      setPhotoWarning('This photo is quite small -- it may look blurry on the menu. A closer, higher-resolution photo of the dish will look sharper.');
    }
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

  if (!items) return <Loading />;

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
                        {photoWarning && <p className="hint" style={{ color: 'var(--warn, #b4700f)' }}>{photoWarning}</p>}
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
                    <div className="form-row">
                      <div className="field" style={{ width: '100%' }}>
                        <label>Ask customers about this item</label>
                        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: -4 }}>
                          Optional -- if this item has choices customers should be asked about (water: room temperature
                          or cold, rice: peppered or not), add them here. Leave empty and the bot won't ask anything
                          extra for this item. Saves right away when you click "Add question" -- separate from the
                          Save button below, which only saves name/price/photo.
                        </p>
                        {questionError && <div className="error-banner">{questionError}</div>}
                        {questions.map((q) => (
                          <div key={q.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <span style={{ flex: 1 }}>{q.question}</span>
                            <button type="button" className="danger" onClick={() => removeQuestion(q.id)}>
                              Remove
                            </button>
                          </div>
                        ))}
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input
                            value={newQuestion}
                            onChange={(e) => setNewQuestion(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                addQuestion(p.id);
                              }
                            }}
                            placeholder="e.g. Room temperature or cold?"
                            style={{ flex: 1 }}
                          />
                          <button type="button" className="secondary" onClick={() => addQuestion(p.id)} disabled={!newQuestion.trim()}>
                            Add question
                          </button>
                        </div>
                      </div>
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
                {photoWarning && <p className="hint" style={{ color: 'var(--warn, #b4700f)' }}>{photoWarning}</p>}
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

      {editable && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Add special offer / combo</h3>
          <p className="subtitle">A deal made of real menu items, its own name, its own bundled price.</p>
          {comboError && <div className="error-banner">{comboError}</div>}
          <form onSubmit={addCombo}>
            <div className="form-row">
              <div className="field">
                <label>Deal name</label>
                <input value={comboForm.name} onChange={(e) => setComboForm({ ...comboForm, name: e.target.value })} placeholder="e.g. Family Feast" required />
              </div>
              <div className="field">
                <label>Deal price</label>
                <input type="number" step="0.01" min="0" value={comboForm.price} onChange={(e) => setComboForm({ ...comboForm, price: e.target.value })} required />
              </div>
            </div>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600 }}>Items in this deal</label>
            {comboForm.items.map((row, idx) => (
              <div className="form-row" key={idx} style={{ alignItems: 'center' }}>
                <div className="field" style={{ flex: 2 }}>
                  <select value={row.productId} onChange={(e) => setComboItemRow(idx, { productId: e.target.value })} required>
                    <option value="">Select an item...</option>
                    {(items || [])
                      .filter((p) => !p.is_combo)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="field" style={{ maxWidth: 90 }}>
                  <input type="number" min="1" value={row.quantity} onChange={(e) => setComboItemRow(idx, { quantity: e.target.value })} placeholder="Qty" />
                </div>
                {comboForm.items.length > 1 && (
                  <button type="button" className="secondary" onClick={() => removeComboItemRow(idx)}>
                    Remove
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="link-button" style={{ marginBottom: 12 }} onClick={addComboItemRow}>
              + Add another item
            </button>
            <div>
              <button type="submit">Create special offer</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
