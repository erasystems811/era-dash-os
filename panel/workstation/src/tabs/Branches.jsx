import React, { useState } from 'react';

const EMPTY = {
  name: '',
  address: '',
  area: '',
  phone_number: '',
  whatsapp_number: '',
  instagram_handle: '',
  operating_hours: '',
  timezone: 'Africa/Lagos',
};

// Primary branch is whichever row sits first in the array -- matches
// scripts/lib/ebos-seed.mjs's own positional sqlBool(i === 0) logic for
// is_primary, on purpose: keeping position as the single source of truth
// avoids a separate is_primary field in this form ever disagreeing with
// what actually gets written to the database.
function moveToFront(list, i) {
  if (i === 0) return list;
  const next = [...list];
  const [moved] = next.splice(i, 1);
  next.unshift(moved);
  return next;
}

export default function Branches({ branches, setBranches }) {
  const [form, setForm] = useState(EMPTY);
  const [dragIndex, setDragIndex] = useState(null);

  function add(e) {
    e.preventDefault();
    setBranches([...branches, form]);
    setForm(EMPTY);
  }

  function remove(i) {
    setBranches(branches.filter((_, idx) => idx !== i));
  }

  function onDrop(i) {
    if (dragIndex === null || dragIndex === i) return;
    const next = [...branches];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(i, 0, moved);
    setBranches(next);
    setDragIndex(null);
  }

  return (
    <div>
      <h1>Branches</h1>
      <p className="subtitle">
        Extra locations for this business. Leave this empty for a single-location business -- it will use the address from the
        Business Details tab.
      </p>

      <div className="card">
        {branches.length ? (
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Address</th>
                <th>Area</th>
                <th>Phone</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {branches.map((b, i) => (
                <tr
                  key={i}
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(i)}
                  style={{ cursor: 'grab', opacity: dragIndex === i ? 0.4 : 1 }}
                >
                  <td>&#8942;&#8942;</td>
                  <td>{b.name}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{b.address}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{b.area}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{b.phone_number}</td>
                  <td>
                    {i === 0 ? (
                      <span
                        style={{
                          background: 'var(--success-soft)',
                          color: 'var(--success)',
                          padding: '3px 10px',
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        Primary
                      </span>
                    ) : (
                      <button type="button" className="secondary" onClick={() => setBranches(moveToFront(branches, i))}>
                        Make primary
                      </button>
                    )}
                  </td>
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
          <p style={{ color: 'var(--text-muted)' }}>No extra locations. Leave this empty for a single-location business.</p>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Add branch</h3>
        <form onSubmit={add}>
          <div className="form-row">
            <div className="field">
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label>Address</label>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} required />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Area (optional)</label>
              <input value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} />
            </div>
            <div className="field">
              <label>Phone number (optional)</label>
              <input value={form.phone_number} onChange={(e) => setForm({ ...form, phone_number: e.target.value })} />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>WhatsApp number (optional)</label>
              <input value={form.whatsapp_number} onChange={(e) => setForm({ ...form, whatsapp_number: e.target.value })} />
              <p className="hint">
                This is just a label for reference -- the real WhatsApp connection for this branch happens after the business is
                built, from the client list in Dash OS.
              </p>
            </div>
            <div className="field">
              <label>Instagram handle (optional)</label>
              <input value={form.instagram_handle} onChange={(e) => setForm({ ...form, instagram_handle: e.target.value })} />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Operating hours (optional)</label>
              <input
                value={form.operating_hours}
                onChange={(e) => setForm({ ...form, operating_hours: e.target.value })}
                placeholder="e.g. 9am - 10pm daily"
              />
            </div>
            <div className="field">
              <label>Timezone</label>
              <input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
            </div>
          </div>
          <button type="submit">Add branch</button>
        </form>
      </div>
    </div>
  );
}
