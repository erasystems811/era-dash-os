import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useScope, scopeQuery } from '../ScopeContext.jsx';
import AllBranches from './AllBranches.jsx';
import { useStaff, canEdit } from '../StaffContext.jsx';

const COLUMNS = [
  { key: 'new', label: 'New', hint: 'oldest first' },
  { key: 'confirmed', label: 'Confirmed', hint: 'awaiting kitchen' },
  { key: 'ready', label: 'Ready', hint: 'awaiting pickup/rider' },
  { key: 'delivery', label: 'Delivery', hint: 'rider or pickup' },
  { key: 'completed', label: 'Completed', hint: '' },
];

// Purely a visual affordance -- a long unattended wait means something
// different at different stages, but a single flat threshold is the
// simplest honest rule without inventing a per-column config surface for
// what's ultimately just a coloured hint, not a real business rule.
function waitingSince(createdAt) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 60000));
  const text = minutes < 1 ? 'just now' : `${minutes} min`;
  const level = minutes >= 20 ? 'hot' : minutes >= 10 ? 'warm' : '';
  return { text, level };
}

function naira(amount) {
  return `₦${Number(amount).toLocaleString()}`;
}

function answeredInText(seconds) {
  if (seconds == null) return '–';
  if (seconds < 60) return `${seconds} sec`;
  return `${Math.round(seconds / 60)} min`;
}

function busiestHourText(hour) {
  if (!hour) return '–';
  const start = new Date(hour.start);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const fmt = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fmt(start)} to ${fmt(end)} · ${hour.count} order${hour.count === 1 ? '' : 's'}`;
}

// For a delivery/order that came in some way other than a channel this
// system listens on itself (a landline call, a walk-in) -- Chidera's ask,
// 2026-09-02: "where can i book a delivery without a whatsapp order".
// Owner/manager only (matches routes/api.js's POST /orders gate); staff
// pick real items from the real catalogue and a real price, never type one
// in, same "never guess a price" principle as everywhere else an order
// gets priced.
function NewOrderForm({ onCreated, onCancel }) {
  const [products, setProducts] = useState(null);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [fulfilmentType, setFulfilmentType] = useState('delivery');
  const [address, setAddress] = useState('');
  const [items, setItems] = useState([]); // [{productId, quantity}]
  const [pickProductId, setPickProductId] = useState('');
  const [pickQuantity, setPickQuantity] = useState(1);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/catalogue').then(setProducts);
  }, []);

  function addItem() {
    if (!pickProductId) return;
    setItems((prev) => {
      const existing = prev.find((i) => i.productId === pickProductId);
      if (existing) {
        return prev.map((i) => (i.productId === pickProductId ? { ...i, quantity: i.quantity + Number(pickQuantity) } : i));
      }
      return [...prev, { productId: pickProductId, quantity: Number(pickQuantity) || 1 }];
    });
    setPickProductId('');
    setPickQuantity(1);
  }

  function removeItem(productId) {
    setItems((prev) => prev.filter((i) => i.productId !== productId));
  }

  const byId = new Map((products || []).map((p) => [p.id, p]));
  const subtotal = items.reduce((sum, i) => sum + Number(byId.get(i.productId)?.price || 0) * i.quantity, 0);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!phone.trim()) return setError('A phone number is required.');
    if (!items.length) return setError('Add at least one item.');
    if (fulfilmentType === 'delivery' && !address.trim()) return setError('A delivery address is required.');
    setSaving(true);
    try {
      const order = await api.post('/orders', {
        phone: phone.trim(),
        name: name.trim() || undefined,
        fulfilment_type: fulfilmentType,
        address: fulfilmentType === 'delivery' ? address.trim() : undefined,
        items,
      });
      onCreated(order);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!products) return null;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>New order</h3>
      <p className="hint">
        For an order that didn't come in on WhatsApp/Instagram/a call -- a landline order, a walk-in. This gets created already marked
        paid; use this only once payment is actually settled.
      </p>
      {error && <div className="error-banner">{error}</div>}
      <form onSubmit={submit}>
        <div className="form-row">
          <div className="field">
            <label>Customer phone number</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 2348010000000" required />
          </div>
          <div className="field">
            <label>Customer name (optional)</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <label>Fulfilment</label>
            <select value={fulfilmentType} onChange={(e) => setFulfilmentType(e.target.value)}>
              <option value="delivery">Delivery</option>
              <option value="pickup">Pickup</option>
            </select>
          </div>
          {fulfilmentType === 'delivery' && (
            <div className="field">
              <label>Delivery address</label>
              <input value={address} onChange={(e) => setAddress(e.target.value)} required />
            </div>
          )}
        </div>

        <label>Items</label>
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="field">
            <select value={pickProductId} onChange={(e) => setPickProductId(e.target.value)}>
              <option value="">Choose an item...</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({naira(p.price)})
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ maxWidth: 100 }}>
            <input type="number" min="1" value={pickQuantity} onChange={(e) => setPickQuantity(e.target.value)} />
          </div>
          <button type="button" className="secondary" onClick={addItem}>
            Add
          </button>
        </div>

        {items.length > 0 && (
          <ul style={{ marginBottom: 12 }}>
            {items.map((i) => (
              <li key={i.productId}>
                <b>{i.quantity}</b> {byId.get(i.productId)?.name} ({naira(Number(byId.get(i.productId)?.price || 0) * i.quantity)}){' '}
                <button type="button" className="link" onClick={() => removeItem(i.productId)}>
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {items.length > 0 && (
          <p className="hint">
            Items subtotal: {naira(subtotal)}. A delivery fee is added automatically if the address matches a set-up delivery zone.
          </p>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={saving}>
            {saving ? 'Creating...' : 'Create order'}
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

export default function Orders() {
  const { scope } = useScope();
  const { staff } = useStaff();
  const navigate = useNavigate();
  const [orders, setOrders] = useState(null);
  const [today, setToday] = useState(null);
  const [showNewOrder, setShowNewOrder] = useState(false);

  function load() {
    const q = scopeQuery(scope);
    api.get(`/orders${q}`).then(setOrders);
    api.get(`/orders/stats/today${q}`).then(setToday);
  }

  useEffect(() => {
    if (scope === 'all') return;
    setOrders(null);
    setToday(null);
    load();
  }, [scope]);

  // Changing scope changes the page, not just filters it -- comparing
  // branches is a different kind of view (no order rail, see AllBranches),
  // not a filtered version of this one.
  if (scope === 'all') return <AllBranches />;

  if (!orders) return null;

  const cancelled = orders.filter((o) => o.status === 'cancelled').length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Orders</h1>
          <p className="subtitle">Every order that has come in through the bot or the dashboard.</p>
        </div>
        {canEdit(staff) && !showNewOrder && <button onClick={() => setShowNewOrder(true)}>New order</button>}
      </div>

      {showNewOrder && (
        <NewOrderForm
          onCreated={(order) => {
            setShowNewOrder(false);
            navigate(`/orders/${order.id}`);
          }}
          onCancel={() => setShowNewOrder(false)}
        />
      )}

      <div className="stat-row">
        <div className="stat-card">
          <div className="value">{orders.length}</div>
          <div className="label">Total orders</div>
        </div>
        <div className="stat-card">
          <div className="value">{orders.filter((o) => o.payment_status !== 'accepted' && o.payment_status !== 'confirmed').length}</div>
          <div className="label">Awaiting payment</div>
        </div>
        <div className="stat-card">
          <div className="value">{cancelled}</div>
          <div className="label">Cancelled</div>
        </div>
      </div>

      {today && (
        <div className="card" style={{ maxWidth: 480 }}>
          <h3 style={{ marginTop: 0 }}>Today</h3>
          <div className="figs">
            <div className="fig">
              <span>Orders</span>
              <strong className="mono">{today.orders}</strong>
            </div>
            <div className="fig">
              <span>Collected</span>
              <strong className="mono">{naira(today.collected)}</strong>
            </div>
            <div className="fig">
              <span>Average</span>
              <strong className="mono">{naira(today.average)}</strong>
            </div>
            <div className="fig">
              <span>Answered in</span>
              <strong className="mono">{answeredInText(today.answeredSeconds)}</strong>
            </div>
            <div className="fig wide">
              <span>Busiest hour</span>
              <strong className="mono">{busiestHourText(today.busiestHour)}</strong>
            </div>
          </div>
        </div>
      )}

      <div className="board" style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 8 }}>
        {COLUMNS.map((col) => {
          const colOrders = orders.filter((o) => o.status === col.key);
          return (
            <div key={col.key} className="board-column" style={{ minWidth: 220, flex: '0 0 220px' }}>
              <div className="lane-head">
                <h2>{col.label}</h2>
                <span className="count mono">{colOrders.length}</span>
                {col.hint && <p className="hint">{col.hint}</p>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {colOrders.map((o) => {
                  const waiting = waitingSince(o.created_at);
                  return (
                    <Link key={o.id} to={`/orders/${o.id}`} className="docket">
                      <div className="row1">
                        <span className="no mono">{o.reference}</span>
                        {o.customer_channel && <span className={`chan ${o.customer_channel}`}>{o.customer_channel}</span>}
                        <span className={`waiting mono ${waiting.level}`}>{waiting.text}</span>
                      </div>
                      <p className="who">{o.customer_name || o.customer_phone}</p>
                      {o.items?.length > 0 && (
                        <ul>
                          {o.items.map((item, i) => (
                            <li key={i}>
                              <b>{item.quantity}</b> {item.name}
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="foot">
                        <span className="total mono">NGN {Number(o.total).toLocaleString()}</span>
                        <span className={`badge ${o.payment_status}`}>{o.payment_status}</span>
                      </div>
                    </Link>
                  );
                })}
                {!colOrders.length && <div className="empty">Nothing here.</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
