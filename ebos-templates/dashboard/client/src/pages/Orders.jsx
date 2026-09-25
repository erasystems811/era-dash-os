import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useScope, scopeQuery } from '../ScopeContext.jsx';
import AllBranches from './AllBranches.jsx';
import { useStaff, canEdit, isPinTier, workAreaOf } from '../StaffContext.jsx';
import { nextStageFor, ORDER_COLUMNS as COLUMNS, isRecentlyCompleted } from '../orderStages.js';
import Loading from '../components/Loading.jsx';

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
  const [zones, setZones] = useState(null);
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [items, setItems] = useState([]); // [{productId, quantity}]
  const [pickProductId, setPickProductId] = useState('');
  const [pickQuantity, setPickQuantity] = useState(1);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/catalogue').then(setProducts);
    api.get('/delivery/zones').then(setZones);
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

  // Grouped by category so this stays pickable once a menu grows past a
  // handful of items -- Chidera's call, 2026-09-03: "when the menu becomes
  // up to 100 items it wont be easy to pick anymore". "Other" (uncategorised
  // products) sorts last, everything else alphabetically, so the list is
  // scannable instead of whatever order they happen to have been created in.
  const productsByCategory = new Map();
  for (const p of products || []) {
    const cat = p.category || 'Other';
    if (!productsByCategory.has(cat)) productsByCategory.set(cat, []);
    productsByCategory.get(cat).push(p);
  }
  const categoryGroups = [...productsByCategory.entries()].sort(([a], [b]) => {
    if (a === 'Other') return 1;
    if (b === 'Other') return -1;
    return a.localeCompare(b);
  });

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!phone.trim()) return setError('A phone number is required.');
    if (!items.length) return setError('Add at least one item.');
    if (!address.trim()) return setError('A delivery address is required.');
    if (zones?.length && !zoneId) return setError('Pick a delivery area.');
    setSaving(true);
    try {
      const order = await api.post('/orders', {
        phone: phone.trim(),
        address: address.trim(),
        zoneId: zoneId || undefined,
        items,
      });
      onCreated(order);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!products || !zones) return <Loading />;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Create delivery order</h3>
      <p className="hint">
        For a delivery that didn't come in on WhatsApp/Instagram/a call -- a landline order, a walk-in. This gets created already marked
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
            <label>Delivery address</label>
            <input value={address} onChange={(e) => setAddress(e.target.value)} required />
          </div>
        </div>

        {zones.length > 0 && (
          <div className="form-row">
            <div className="field">
              <label>Delivery area</label>
              <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} required>
                <option value="">Choose an area...</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name} ({naira(z.customer_fee)})
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <label>Items</label>
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="field">
            <select value={pickProductId} onChange={(e) => setPickProductId(e.target.value)}>
              <option value="">Choose an item...</option>
              {categoryGroups.map(([category, items]) => (
                <optgroup key={category} label={category}>
                  {items.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({naira(p.price)})
                    </option>
                  ))}
                </optgroup>
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

  // Online/In House split -- owner/manager only (Chidera 2026-09-11: "this
  // 2 tab thing should only be on manger or owner side, not for staffs
  // now"). A work_area-scoped staff account never sees this switcher at
  // all: 'online' lands here too but with a server-already-filtered
  // `orders` (lib/auth.js's scopeToWorkArea), and 'in_house' never reaches
  // this page in the first place (App.jsx redirects it to /in-house).
  const [dineinEnabled, setDineinEnabled] = useState(false);
  // Chidera, 2026-09-16: "why is there a ring rider in the card when
  // delivery is not toggled on" -- the button only ever checked the
  // ORDER's own fulfilment_type === 'delivery' (a real value even when the
  // business has no own-rider system at all -- a delivery order can exist
  // without ERA's Delivery add-on being switched on), never whether this
  // business's delivery mode is actually 'own_riders'. Ringing a rider on
  // a business with zero riders configured would either no-op or error.
  const [ownRidersEnabled, setOwnRidersEnabled] = useState(false);
  const [activeTab, setActiveTab] = useState('online');
  // Chidera, 2026-09-17: "the link is meant to open the specific kanban
  // inside for that order not the pipeline surface" -- the "ready to
  // prepare" staff alert links here with ?order=<id> (flow.js's
  // completePayment); once the board's own data has loaded, scroll that
  // one card into view and outline it briefly so staff land right on it
  // instead of hunting for it among everything else in the pipeline.
  useEffect(() => {
    if (!orders) return;
    const orderId = new URLSearchParams(window.location.search).get('order');
    if (!orderId) return;
    const el = document.getElementById(`order-${orderId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('highlight');
    const timeout = setTimeout(() => el.classList.remove('highlight'), 4000);
    return () => clearTimeout(timeout);
  }, [orders]);
  // Two real pipelines, not one -- Chidera 2026-09-11: "confirming payment
  // is different from marking served so there should be 2 piplines."
  // 'serving' = not yet served_at (a Served button). 'awaitingPayment' =
  // served, not yet paid (a Mark paid button). See InHouse.jsx's own
  // comment for the full reasoning -- this tab mirrors it exactly, just
  // inline instead of its own page.
  const [inHouseServing, setInHouseServing] = useState(null);
  const [inHouseAwaitingPayment, setInHouseAwaitingPayment] = useState(null);
  // Same as InHouse.jsx's own dashboard card (routes/dinein.js's
  // /stats/today) -- Chidera, 2026-09-25: "can in house have its own
  // dashboard, with cash collected."
  const [inHouseStats, setInHouseStats] = useState(null);
  const showTabs = dineinEnabled && !isPinTier(staff);

  function loadInHouse() {
    // Swallowed on failure, not surfaced -- an 'online'-scoped staff
    // session is server-blocked from this (lib/auth.js's scopeToWorkArea
    // gate on /dinein), and showTabs already keeps them from ever seeing
    // anything that would depend on it.
    api
      .get('/dinein/orders/pending')
      .then(setInHouseServing)
      .catch(() => setInHouseServing([]));
    api
      .get('/dinein/orders/serving')
      .then(setInHouseAwaitingPayment)
      .catch(() => setInHouseAwaitingPayment([]));
    api
      .get('/dinein/stats/today')
      .then(setInHouseStats)
      .catch(() => setInHouseStats(null));
  }

  function load() {
    const q = scopeQuery(scope);
    api.get(`/orders${q}`).then(setOrders);
    api.get(`/orders/stats/today${q}`).then(setToday);
    api.get('/dinein-config').then((c) => setDineinEnabled(Boolean(c?.enabled)));
    api.get('/delivery-config').then((c) => setOwnRidersEnabled(c?.mode === 'own_riders'));
    loadInHouse();
  }

  async function markInHouseServed(e, orderId) {
    e.preventDefault();
    e.stopPropagation();
    await api.post(`/dinein/orders/${orderId}/served`);
    loadInHouse();
  }

  async function markInHousePaid(e, orderId) {
    e.preventDefault();
    e.stopPropagation();
    await api.post(`/orders/${orderId}/status`, { status: 'completed' });
    loadInHouse();
  }

  // e.preventDefault/stopPropagation on every one of these -- each docket
  // card is itself a <Link> to the order's detail page, and these buttons
  // live right on the card (Chidera's call: "i want the button at the
  // surface not when kanban is opened"), so a click on the button must
  // never also trigger the card's own navigation.
  async function advanceStatus(e, orderId, next) {
    e.preventDefault();
    e.stopPropagation();
    await api.post(`/orders/${orderId}/status`, { status: next });
    load();
  }

  async function confirmPayment(e, orderId) {
    e.preventDefault();
    e.stopPropagation();
    await api.post(`/orders/${orderId}/confirm-payment`);
    load();
  }

  // A real push can still get lost -- a battery-killed browser, a dropped
  // connection -- and staff shouldn't have to wait out the automatic
  // timeout re-broadcast for a second try (Chidera's report, 2026-09-03:
  // "it didnt even ring atall this time"). Result text shown right on the
  // card, not a reload -- ringing a rider never changes the order's own
  // status, so there's nothing for `load()` to refresh.
  const [ringResult, setRingResult] = useState({});
  async function ringRider(e, orderId) {
    e.preventDefault();
    e.stopPropagation();
    setRingResult((prev) => ({ ...prev, [orderId]: 'Ringing...' }));
    let message;
    try {
      const result = await api.post(`/orders/${orderId}/ring-rider`, {});
      message =
        result.mode === 'broadcast'
          ? 'Re-pinged every on-duty rider.'
          : result.delivered
            ? `Reminder sent to ${result.riderName}.`
            : `${result.riderName} has no working notification right now -- call them directly.`;
    } catch (err) {
      message = err.message;
    }
    setRingResult((prev) => ({ ...prev, [orderId]: message }));
    setTimeout(() => setRingResult((prev) => ({ ...prev, [orderId]: undefined })), 6000);
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

  if (!orders) return <Loading />;

  // channel !== 'dinein' is the one real split between the two worlds --
  // everything else (branch, status, payment) already applies equally to
  // both. Used for the kanban itself and every stat card above it, so an
  // owner's Online tab genuinely never shows a dine-in order mixed in.
  const onlineOrders = orders.filter((o) => o.channel !== 'dinein');
  const cancelled = onlineOrders.filter((o) => o.status === 'cancelled').length;
  // 'confirmation' is the same "needs a look" state ORDER_COLUMNS already
  // hints at -- an unread-style count, not every order, same reasoning as
  // In House's own badge below (a queue depth, not a total).
  const onlineNeedsAttention = onlineOrders.filter((o) => o.status === 'confirmation').length;
  // Both pipelines count toward the one tab badge -- either one means
  // something needs a look, and the tab itself (not the badge) is where
  // the split into "Serving" vs "Awaiting payment" actually shows.
  const inHouseCount = (inHouseServing || []).length + (inHouseAwaitingPayment || []).length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Orders</h1>
          <p className="subtitle">Every order that has come in through the bot or the dashboard.</p>
        </div>
        {activeTab === 'online' && canEdit(staff) && !showNewOrder && (
          <button onClick={() => setShowNewOrder(true)}>Create delivery order</button>
        )}
      </div>

      {showTabs && (
        <div className="tab-row" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button className={activeTab === 'online' ? '' : 'secondary'} onClick={() => setActiveTab('online')}>
            Online
            {onlineNeedsAttention > 0 && (
              <span className="badge new" style={{ marginLeft: 8 }}>
                {onlineNeedsAttention}
              </span>
            )}
          </button>
          <button className={activeTab === 'in_house' ? '' : 'secondary'} onClick={() => setActiveTab('in_house')}>
            In House
            {inHouseCount > 0 && (
              <span className="badge new" style={{ marginLeft: 8 }}>
                {inHouseCount}
              </span>
            )}
          </button>
        </div>
      )}

      {activeTab === 'in_house' && showTabs && inHouseStats && (
        <div className="card" style={{ maxWidth: 560 }}>
          <h3 style={{ marginTop: 0 }}>Today</h3>
          <div className="figs">
            <div className="fig">
              <span>Tables served</span>
              <strong className="mono">{inHouseStats.tablesServed}</strong>
            </div>
            <div className="fig">
              <span>Collected</span>
              <strong className="mono">{naira(inHouseStats.collected)}</strong>
            </div>
            <div className="fig">
              <span>Cash</span>
              <strong className="mono">{naira(inHouseStats.cash)}</strong>
            </div>
            <div className="fig">
              <span>Card</span>
              <strong className="mono">{naira(inHouseStats.card)}</strong>
            </div>
            <div className="fig">
              <span>Transfer</span>
              <strong className="mono">{naira(inHouseStats.transfer)}</strong>
            </div>
            {inHouseStats.other > 0 && (
              <div className="fig">
                <span>Other (link/POS)</span>
                <strong className="mono">{naira(inHouseStats.other)}</strong>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'in_house' && showTabs && (
        <div className="board" style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 8 }}>
          {[
            {
              key: 'serving',
              label: 'Serving',
              hint: 'waiting on the kitchen/bar',
              orders: inHouseServing || [],
              emptyText: 'Nothing pending right now.',
              actionLabel: 'Served',
              onAction: markInHouseServed,
            },
            {
              key: 'awaiting-payment',
              label: 'Awaiting payment',
              hint: "served, table can't close until paid",
              orders: inHouseAwaitingPayment || [],
              emptyText: 'Nothing awaiting payment.',
              actionLabel: 'Mark paid',
              onAction: markInHousePaid,
            },
          ].map((col) => (
            <div key={col.key} className="board-column" style={{ minWidth: 260, flex: '0 0 260px' }}>
              <div className="lane-head">
                <h2>{col.label}</h2>
                <span className="count mono">{col.orders.length}</span>
                <p className="hint">{col.hint}</p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {col.orders.map((o) => (
                  <Link key={o.id} id={`order-${o.id}`} to={`/orders/${o.id}`} className="docket">
                    <div className="row1">
                      <span className="no mono">Table {o.table_label}</span>
                    </div>
                    {o.items?.length > 0 && (
                      <ul>
                        {o.items.map((item, i) => {
                          // newQty -- Chidera, 2026-09-20: "on the staff
                          // card let there be a clear demarcation for
                          // add on." Same diff InHouse.jsx's own dine-in
                          // board shows -- this is the same data, just a
                          // second surface for it (Orders.jsx's own In
                          // House tab).
                          const newQty = item.newQty || 0;
                          return (
                            <li key={i}>
                              <b>{item.quantity}</b> {item.name}
                              {item.answers?.length > 0 && (
                                <span className="hint"> ({item.answers.map((a) => a.answer).join(', ')})</span>
                              )}
                              {newQty === item.quantity ? (
                                <span className="new-badge">NEW</span>
                              ) : newQty > 0 ? (
                                <span className="new-part"> ({newQty} new)</span>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <div className="foot">
                      <span className="total mono">NGN {Number(o.total || 0).toLocaleString()}</span>
                    </div>
                    <button style={{ marginTop: 8, width: '100%' }} onClick={(e) => col.onAction(e, o.id)}>
                      {col.actionLabel}
                    </button>
                  </Link>
                ))}
                {!col.orders.length && <div className="empty">{col.emptyText}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'online' && (
        <>
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
          <div className="value">{onlineOrders.length}</div>
          <div className="label">Total orders</div>
        </div>
        <div className="stat-card">
          <div className="value">
            {onlineOrders.filter((o) => o.payment_status !== 'accepted' && o.payment_status !== 'confirmed').length}
          </div>
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
          const colOrders = onlineOrders.filter((o) => o.status === col.key && (col.key !== 'completed' || isRecentlyCompleted(o)));
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
                    <Link key={o.id} id={`order-${o.id}`} to={`/orders/${o.id}`} className="docket">
                      <div className="row1">
                        <span className="no mono">{o.reference}</span>
                        {o.customer_channel && <span className={`chan ${o.customer_channel}`}>{o.customer_channel}</span>}
                        <span className={`waiting mono ${waiting.level}`}>{waiting.text}</span>
                      </div>
                      <p className="who">{o.customer_name || o.customer_phone}</p>
                      {o.rider_name && <p className="hint">{o.rider_name} accepted order</p>}
                      {o.items?.length > 0 && (
                        <ul>
                          {o.items.map((item, i) => (
                            <li key={i}>
                              <b>{item.quantity}</b> {item.name}
                              {item.answers?.length > 0 && (
                                <span className="hint"> ({item.answers.map((a) => a.answer).join(', ')})</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="foot">
                        <span className="total mono">NGN {Number(o.total).toLocaleString()}</span>
                        <span className={`badge ${o.payment_status}`}>{o.payment_status}</span>
                      </div>
                      {canEdit(staff) &&
                        (o.status === 'confirmation'
                          ? o.payment_status !== 'confirmed' &&
                            o.payment_status !== 'accepted' && (
                              <button style={{ marginTop: 8, width: '100%' }} onClick={(e) => confirmPayment(e, o.id)}>
                                Confirm payment received
                              </button>
                            )
                          : nextStageFor(o) && (
                              <button style={{ marginTop: 8, width: '100%' }} onClick={(e) => advanceStatus(e, o.id, nextStageFor(o).next)}>
                                {nextStageFor(o).label}
                              </button>
                            ))}
                      {canEdit(staff) && ownRidersEnabled && o.status === 'ready' && o.fulfilment_type === 'delivery' && (
                        <button style={{ marginTop: 8, width: '100%' }} className="secondary" onClick={(e) => ringRider(e, o.id)}>
                          Ring rider
                        </button>
                      )}
                      {ringResult[o.id] && <p className="hint">{ringResult[o.id]}</p>}
                    </Link>
                  );
                })}
                {!colOrders.length && <div className="empty">Nothing here.</div>}
              </div>
            </div>
          );
        })}
      </div>
        </>
      )}
    </div>
  );
}
