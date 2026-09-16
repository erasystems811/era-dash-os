import React, { useState } from 'react';
import { api } from '../api.js';
import { compressImageToDataUrl } from '../imageUpload.js';

const EMPTY = { name: '', description: '', price: '', availability_type: 'stock', duration_minutes: '' };

export default function Catalogue({ catalogue, setCatalogue, businessType }) {
  const [form, setForm] = useState(EMPTY);
  const [dragIndex, setDragIndex] = useState(null);
  const [bulkText, setBulkText] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState(null);

  function add(e) {
    e.preventDefault();
    setCatalogue([...catalogue, { ...form, price: Number(form.price) }]);
    setForm(EMPTY);
  }

  function remove(i) {
    setCatalogue(catalogue.filter((_, idx) => idx !== i));
  }

  function onDrop(i) {
    if (dragIndex === null || dragIndex === i) return;
    const next = [...catalogue];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(i, 0, moved);
    setCatalogue(next);
    setDragIndex(null);
  }

  function appendParsed(items) {
    setCatalogue([...catalogue, ...items.map((i) => ({ ...i, availability_type: 'stock', duration_minutes: '' }))]);
  }

  async function bulkImportText(e) {
    e.preventDefault();
    setBulkError(null);
    setBulkBusy(true);
    try {
      const { items } = await api.post('/api/workstation/parse-menu', { text: bulkText });
      appendParsed(items);
      setBulkText('');
    } catch (err) {
      setBulkError(err.message);
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkImportPhoto(e) {
    const file = e.target.files[0];
    if (!file) return;
    setBulkError(null);
    setBulkBusy(true);
    try {
      const dataUrl = await compressImageToDataUrl(file);
      const [header, base64] = dataUrl.split(',');
      const mediaType = header.match(/data:(.*);base64/)[1];
      const { items } = await api.post('/api/workstation/parse-menu', { image: { mediaType, base64 } });
      appendParsed(items);
    } catch (err) {
      setBulkError(err.message);
    } finally {
      setBulkBusy(false);
      e.target.value = '';
    }
  }

  const noun = { restaurant: 'menu item', apartment: 'property', car_rental: 'vehicle', lashes_nails: 'service' }[businessType] || 'item';

  return (
    <div>
      <h1>Catalogue</h1>
      <p className="subtitle">The {noun} list the bot orders or books from. Drag rows to reorder how customers see them.</p>

      <div className="card">
        {catalogue.length ? (
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Description</th>
                <th>Price</th>
                <th>Availability rule</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {catalogue.map((item, i) => (
                <tr
                  key={i}
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(i)}
                  style={{ cursor: 'grab', opacity: dragIndex === i ? 0.4 : 1 }}
                >
                  <td>&#8942;&#8942;</td>
                  <td>{item.name}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{item.description}</td>
                  <td>{item.price}</td>
                  <td>{item.availability_type}</td>
                  <td>
                    <button type="button" className="danger" onClick={() => remove(i)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: 'var(--text-muted)' }}>No items yet. Add the first one below.</p>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Bulk import</h3>
        <p className="hint">Paste the whole list as it already exists, or upload a photo of a printed one.</p>
        {bulkError && <div className="error-banner">{bulkError}</div>}
        <form onSubmit={bulkImportText}>
          <div className="field">
            <textarea
              rows={4}
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
              Upload a photo
              <input type="file" accept="image/*" onChange={bulkImportPhoto} disabled={bulkBusy} style={{ display: 'none' }} />
            </label>
          </div>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Add {noun}</h3>
        <form onSubmit={add}>
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
          <div className="field">
            <label>Description</label>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
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
          <button type="submit">Add</button>
        </form>
      </div>
    </div>
  );
}
