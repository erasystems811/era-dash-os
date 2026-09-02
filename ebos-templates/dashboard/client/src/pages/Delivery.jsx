import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// Leaflet's default marker icon paths break once bundled (a well-known
// Leaflet+Vite gotcha -- the CSS references relative image paths that
// don't survive bundling) -- re-pointed at the real bundled asset URLs
// Vite gives these imports, once, before any marker on this page is ever
// created.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

const EMPTY_ZONE = { name: '', aliases: '', customer_fee: '', rider_payout: '', active: true };
const EMPTY_RIDER = { name: '', phone: '', bank_account_number: '', bank_code: '', account_name: '', pin: '' };

function naira(amount) {
  return `₦${Number(amount).toLocaleString()}`;
}

function Zones() {
  const { staff } = useStaff();
  const editable = canEdit(staff);
  const [zones, setZones] = useState(null);
  const [form, setForm] = useState(EMPTY_ZONE);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_ZONE);
  // The zone editor shows one field, "delivery fee to this area" -- it
  // writes the same number to both customer_fee and rider_payout (spec
  // B5: the rider is paid the full fee the customer paid, no margin taken
  // by default). Kept as two columns in the database so a restaurant can
  // later subsidise a far zone or take a small margin as a pure settings
  // change -- not exposed as two fields here yet since no business has
  // asked to split them.
  function feeToPayload(fee) {
    return { customer_fee: fee, rider_payout: fee };
  }

  function load() {
    api.get('/delivery/zones').then(setZones);
  }
  useEffect(load, []);

  async function add(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/delivery/zones', {
        name: form.name,
        aliases: form.aliases ? form.aliases.split(',').map((s) => s.trim()).filter(Boolean) : [],
        ...feeToPayload(form.customer_fee),
      });
      setForm(EMPTY_ZONE);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  function startEdit(z) {
    setEditingId(z.id);
    setEditForm({ name: z.name, aliases: (z.aliases || []).join(', '), customer_fee: z.customer_fee, rider_payout: z.rider_payout, active: z.active });
  }

  async function saveEdit(id) {
    await api.post(`/delivery/zones/${id}`, {
      name: editForm.name,
      aliases: editForm.aliases ? editForm.aliases.split(',').map((s) => s.trim()).filter(Boolean) : [],
      ...feeToPayload(editForm.customer_fee),
      active: editForm.active,
    });
    setEditingId(null);
    load();
  }

  async function toggleActive(z) {
    await api.post(`/delivery/zones/${z.id}`, { name: z.name, aliases: z.aliases, customer_fee: z.customer_fee, rider_payout: z.rider_payout, active: !z.active });
    load();
  }

  async function remove(id) {
    await api.delete(`/delivery/zones/${id}`);
    load();
  }

  if (!zones) return null;

  return (
    <div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Area</th>
              <th>Also known as</th>
              <th>Delivery fee</th>
              <th>Status</th>
              {editable && <th></th>}
            </tr>
          </thead>
          <tbody>
            {zones.map((z) =>
              editingId === z.id ? (
                <tr key={z.id}>
                  <td colSpan={editable ? 5 : 4}>
                    <div className="form-row">
                      <div className="field">
                        <label>Area name</label>
                        <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                      </div>
                      <div className="field">
                        <label>Delivery fee to this area</label>
                        <input type="number" min="0" value={editForm.customer_fee} onChange={(e) => setEditForm({ ...editForm, customer_fee: e.target.value })} />
                      </div>
                    </div>
                    <div className="field">
                      <label>Also known as (comma separated)</label>
                      <input value={editForm.aliases} onChange={(e) => setEditForm({ ...editForm, aliases: e.target.value })} placeholder="e.g. Wuse, Wuse Zone 2" />
                    </div>
                    <button onClick={() => saveEdit(z.id)} style={{ marginRight: 8 }}>
                      Save
                    </button>
                    <button className="secondary" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={z.id}>
                  <td>{z.name}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{(z.aliases || []).join(', ')}</td>
                  <td>{naira(z.customer_fee)}</td>
                  <td>
                    <span className={`badge ${z.active ? 'active' : 'disabled'}`}>{z.active ? 'active' : 'inactive'}</span>
                  </td>
                  {editable && (
                    <td>
                      <button className="secondary" onClick={() => startEdit(z)} style={{ marginRight: 8 }}>
                        Edit
                      </button>
                      <button className="secondary" onClick={() => toggleActive(z)} style={{ marginRight: 8 }}>
                        {z.active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button className="danger" onClick={() => remove(z.id)}>
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              )
            )}
            {!zones.length && (
              <tr>
                <td colSpan={editable ? 5 : 4} className="empty-state">
                  No delivery areas yet -- an order can't be dispatched to a rider until at least one exists.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editable && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Add delivery area</h3>
          {error && <div className="error-banner">{error}</div>}
          <form onSubmit={add}>
            <div className="form-row">
              <div className="field">
                <label>Area name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Gwarimpa" required />
              </div>
              <div className="field">
                <label>Delivery fee to this area</label>
                <input type="number" min="0" value={form.customer_fee} onChange={(e) => setForm({ ...form, customer_fee: e.target.value })} required />
              </div>
            </div>
            <div className="field">
              <label>Also known as (comma separated)</label>
              <input value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} placeholder="Other names customers use for this area" />
            </div>
            <button type="submit">Add area</button>
          </form>
        </div>
      )}
    </div>
  );
}

function Riders() {
  const { staff } = useStaff();
  const editable = canEdit(staff);
  const [riders, setRiders] = useState(null);
  const [form, setForm] = useState(EMPTY_RIDER);
  const [error, setError] = useState(null);
  const [resettingId, setResettingId] = useState(null);
  const [newPin, setNewPin] = useState('');

  function load() {
    api.get('/delivery/riders').then(setRiders);
  }
  useEffect(load, []);

  async function add(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/delivery/riders', form);
      setForm(EMPTY_RIDER);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function savePin(id) {
    setError(null);
    try {
      await api.post(`/delivery/riders/${id}`, { pin: newPin });
      setResettingId(null);
      setNewPin('');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleStatus(r) {
    await api.post(`/delivery/riders/${r.id}/status`, { status: r.status === 'suspended' ? 'off_duty' : 'suspended' });
    load();
  }

  async function remove(id) {
    await api.delete(`/delivery/riders/${id}`);
    load();
  }

  if (!riders) return null;

  return (
    <div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Bank details</th>
              <th>PIN</th>
              <th>Status</th>
              {editable && <th></th>}
            </tr>
          </thead>
          <tbody>
            {riders.map((r) => (
              <React.Fragment key={r.id}>
                <tr>
                  <td>{r.name}</td>
                  <td>{r.phone}</td>
                  <td>{r.hasBankDetails ? 'On file' : 'Not set'}</td>
                  <td>
                    {r.pin_locked_until && new Date(r.pin_locked_until) > new Date() ? (
                      <span className="badge disabled">Locked out</span>
                    ) : r.hasPin ? (
                      'Set'
                    ) : (
                      <span className="badge disabled">Not set</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${r.status === 'on_duty' ? 'active' : r.status === 'suspended' ? 'disabled' : ''}`}>{r.status}</span>
                  </td>
                  {editable && (
                    <td>
                      <button
                        className="secondary"
                        style={{ marginRight: 8 }}
                        onClick={() => {
                          setResettingId(resettingId === r.id ? null : r.id);
                          setNewPin('');
                        }}
                      >
                        {r.hasPin ? 'Reset PIN' : 'Set PIN'}
                      </button>
                      <button className="secondary" onClick={() => toggleStatus(r)} style={{ marginRight: 8 }}>
                        {r.status === 'suspended' ? 'Reinstate' : 'Suspend'}
                      </button>
                      <button className="danger" onClick={() => remove(r.id)}>
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
                {resettingId === r.id && (
                  <tr>
                    <td colSpan={editable ? 6 : 5}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          style={{ maxWidth: 140 }}
                          placeholder="New 4-6 digit PIN"
                          value={newPin}
                          onChange={(e) => setNewPin(e.target.value)}
                        />
                        <button onClick={() => savePin(r.id)}>Save</button>
                        <span className="hint">Tell {r.name} their new PIN directly -- it isn't sent anywhere.</span>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {!riders.length && (
              <tr>
                <td colSpan={editable ? 6 : 5} className="empty-state">
                  No riders added yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editable && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Add rider</h3>
          <p className="hint">
            They sign in to the rider app with this phone number and the PIN you set below -- tell them the PIN directly, it never goes
            anywhere else. Bank details are needed before they can be paid automatically -- optional for now if you're paying manually.
          </p>
          {error && <div className="error-banner">{error}</div>}
          <form onSubmit={add}>
            <div className="form-row">
              <div className="field">
                <label>Name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="field">
                <label>Phone number</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required />
              </div>
              <div className="field">
                <label>PIN (4-6 digits)</label>
                <input value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} required />
              </div>
            </div>
            <div className="form-row">
              <div className="field">
                <label>Bank account number</label>
                <input value={form.bank_account_number} onChange={(e) => setForm({ ...form, bank_account_number: e.target.value })} />
              </div>
              <div className="field">
                <label>Account name</label>
                <input value={form.account_name} onChange={(e) => setForm({ ...form, account_name: e.target.value })} />
              </div>
            </div>
            <button type="submit">Add rider</button>
          </form>
        </div>
      )}
    </div>
  );
}

// Every on-duty rider with a real position on file -- riders who haven't
// reported one yet (just signed up, or genuinely off duty) are left off
// entirely rather than plotted at some meaningless default point.
function LiveMap() {
  const mapDivRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const markersRef = React.useRef(new Map());
  const [error, setError] = useState(null);
  const [riderCount, setRiderCount] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let poll;

    async function init() {
      if (!mapDivRef.current) return;
      mapRef.current = L.map(mapDivRef.current).setView([9.0765, 7.3986], 12); // Abuja -- a reasonable default until real riders place it themselves
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(mapRef.current);
      await refresh();
      poll = setInterval(refresh, 15_000);
    }

    async function refresh() {
      try {
        const riders = await api.get('/delivery/riders');
        if (cancelled) return;
        const withPosition = riders.filter((r) => r.status === 'on_duty' && r.last_lat && r.last_lng);
        setRiderCount(withPosition.length);
        const seen = new Set();
        for (const r of withPosition) {
          seen.add(r.id);
          const position = [Number(r.last_lat), Number(r.last_lng)];
          const existing = markersRef.current.get(r.id);
          if (existing) {
            existing.setLatLng(position);
          } else {
            markersRef.current.set(r.id, L.marker(position).addTo(mapRef.current).bindPopup(r.name));
          }
        }
        // Drop the marker for anyone no longer on duty / no longer reporting.
        for (const [id, marker] of markersRef.current) {
          if (!seen.has(id)) {
            mapRef.current.removeLayer(marker);
            markersRef.current.delete(id);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    init();
    return () => {
      cancelled = true;
      clearInterval(poll);
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  if (error) return <div className="card error-banner">{error}</div>;

  return (
    <div className="card">
      <p className="hint" style={{ marginTop: 0 }}>
        {riderCount == null ? 'Loading...' : `${riderCount} on-duty rider${riderCount === 1 ? '' : 's'} reporting a position.`}
      </p>
      <div ref={mapDivRef} style={{ height: 480, borderRadius: 10 }} />
    </div>
  );
}

const PAYOUT_STATUS_LABEL = { PENDING: 'Pending', SENT: 'Sent', FAILED: 'Failed', PAID_MANUALLY: 'Paid' };

// payout_mode/provider/keys are the restaurant's own to set, once own_riders
// mode is already on (ERA's call) -- same trust level as the business
// already self-managing bank_name/bank_account_number in Settings today.
// Manual is the default and stays perfectly usable forever; automatic is an
// optimisation on top, never a requirement to use this feature at all.
// Automatic payout is switched off at the code level for now (not just this
// UI) -- routes/api.js's /delivery-config/payout refuses payout_mode:
// 'automatic' outright. This is a plain status notice, not a working
// toggle, until that's deliberately lifted.
function PayoutSettings() {
  const [config, setConfig] = useState(null);

  useEffect(() => {
    api.get('/delivery-config').then(setConfig);
  }, []);

  if (!config) return null;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Payout method</h3>
      <p className="hint" style={{ marginBottom: 0 }}>
        Manual for now -- every completed delivery lands on the list below, and you mark it paid yourself once you've sent the money.
        Automatic bank payouts aren't turned on yet.
      </p>
    </div>
  );
}

function Payouts() {
  const { staff } = useStaff();
  const editable = canEdit(staff);
  const [payouts, setPayouts] = useState(null);
  const [error, setError] = useState(null);

  function load() {
    api.get('/delivery/payouts').then(setPayouts);
  }
  useEffect(load, []);

  async function markPaid(id) {
    setError(null);
    try {
      await api.post(`/delivery/payouts/${id}/mark-paid`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!payouts) return null;

  const totalOwed = payouts.filter((p) => p.status === 'PENDING' || p.status === 'FAILED').reduce((sum, p) => sum + Number(p.amount), 0);

  return (
    <div>
      <PayoutSettings />
      {totalOwed > 0 && (
        <div className="card" style={{ maxWidth: 320 }}>
          <div className="label" style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>
            OUTSTANDING TO RIDERS
          </div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{naira(totalOwed)}</div>
        </div>
      )}
      <div className="card">
        {error && <div className="error-banner">{error}</div>}
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Rider</th>
              <th>Amount</th>
              <th>Status</th>
              {editable && <th></th>}
            </tr>
          </thead>
          <tbody>
            {payouts.map((p) => (
              <tr key={p.id}>
                <td>{p.order_reference}</td>
                <td>{p.rider_name}</td>
                <td>{naira(p.amount)}</td>
                <td>
                  <span className={`badge ${p.status === 'PAID_MANUALLY' || p.status === 'SENT' ? 'active' : p.status === 'FAILED' ? 'disabled' : 'new'}`}>
                    {PAYOUT_STATUS_LABEL[p.status] || p.status}
                  </span>
                  {p.error && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{p.error}</div>}
                </td>
                {editable && (
                  <td>
                    {(p.status === 'PENDING' || p.status === 'FAILED') && (
                      <button className="secondary" onClick={() => markPaid(p.id)}>
                        Mark paid
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {!payouts.length && (
              <tr>
                <td colSpan={editable ? 5 : 4} className="empty-state">
                  No payouts yet -- these appear the moment a rider accepts a delivery.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Delivery() {
  const [tab, setTab] = useState('zones');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Delivery</h1>
          <p className="subtitle">Your own riders, dispatched automatically when an order is marked ready.</p>
        </div>
      </div>
      <div className="card" style={{ display: 'flex', gap: 8, padding: 6, width: 'fit-content' }}>
        <button className={tab === 'zones' ? '' : 'secondary'} onClick={() => setTab('zones')}>
          Delivery areas
        </button>
        <button className={tab === 'riders' ? '' : 'secondary'} onClick={() => setTab('riders')}>
          Riders
        </button>
        <button className={tab === 'map' ? '' : 'secondary'} onClick={() => setTab('map')}>
          Live map
        </button>
        <button className={tab === 'payouts' ? '' : 'secondary'} onClick={() => setTab('payouts')}>
          Payouts
        </button>
      </div>
      {tab === 'zones' && <Zones />}
      {tab === 'riders' && <Riders />}
      {tab === 'map' && <LiveMap />}
      {tab === 'payouts' && <Payouts />}
    </div>
  );
}
