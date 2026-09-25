import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';
import { nextStageFor, canCancelFrom } from '../orderStages.js';
import Loading from '../components/Loading.jsx';

export default function OrderDetail() {
  const { id } = useParams();
  const { staff } = useStaff();
  const [data, setData] = useState(null);

  function load() {
    api.get(`/orders/${id}`).then(setData);
  }
  useEffect(load, [id]);

  const [overrideReason, setOverrideReason] = useState('');
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState(null);

  if (!data) return <Loading />;
  const { order, items, customer, topups = [], paymentProofs = [], delivery, tableLabel, businessName } = data;

  // Chidera, 2026-09-21: "the docket is for kitchen people o so, hope it
  // has details a standard kitchen will need" -- grouped by station
  // (product.category, e.g. Mains/Drinks/Proteins) the same way the
  // Catalogue page already groups the menu, so a kitchen with more than a
  // couple of items can scan straight to their own section instead of
  // reading every line. Only groups when this business actually uses
  // categories at all (product.category's own schema comment: "never
  // invented") -- a flat list otherwise, not one lonely "Other" header.
  function groupByCategory(list) {
    if (!list.some((i) => i.category)) return [[null, list]];
    const groups = new Map();
    for (const item of list) {
      const key = item.category || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.entries()];
  }

  // Chidera, 2026-09-20: "that new sign on kanban should keep showing when
  // kanban is tapped open na so they can clarify... a sub section of add
  // on." The kanban card's own served-vs-new demarcation (InHouse.jsx/
  // Orders.jsx) was lost the moment staff actually tapped into an order's
  // full detail page -- same served_item_snapshot diff, reused here
  // instead of invented fresh, so the two views never disagree. A whole
  // line added since "Served" was last tapped goes in its own "Add on"
  // section; a mixed line (some already out, more just ordered) stays in
  // the main Items list with the same inline "(N new)" callout the kanban
  // card already uses, since splitting a single real line across two
  // sections would misstate what's actually one order for one dish.
  const snapshot = order.served_item_snapshot;
  const mainItems = [];
  const addOnItems = [];
  for (const item of items) {
    const servedQty = snapshot ? Number(snapshot[item.product_id] || 0) : item.quantity;
    const newQty = Math.max(0, item.quantity - servedQty);
    if (snapshot && newQty === item.quantity) addOnItems.push({ ...item, newQty: 0 });
    else mainItems.push({ ...item, newQty });
  }
  // A dine-in table not yet served has nothing to do with proof-of-payment
  // (dine-in pays after eating, POS/at-table -- never by sending proof) or
  // the pickup/delivery ready pipeline (a table never goes through it at
  // all) -- see markServed's own comment above.
  const dineinUnserved = order.channel === 'dinein' && !order.served_at;

  // Chidera, 2026-09-24, real live incident: a rider was stuck waiting on
  // a customer code that could never come (a test), with no way to close
  // the order out -- this used to only exist for own_riders orders that
  // had a real delivery_assignment row (routes/delivery.js's own
  // /assignments/:id/release). "Every order in transit should be able to
  // be released with reason" -- now order-scoped (routes/api.js's
  // /orders/:id/release), which still releases the real assignment
  // underneath when one exists (rider still gets paid), but no longer
  // requires one to exist at all.
  async function releaseDelivery(e) {
    e.preventDefault();
    setOverrideError(null);
    setOverrideBusy(true);
    try {
      await api.post(`/orders/${id}/release`, { reason: overrideReason.trim() });
      setOverrideReason('');
      load();
    } catch (err) {
      setOverrideError(err.message);
    } finally {
      setOverrideBusy(false);
    }
  }

  async function advanceStatus(next) {
    await api.post(`/orders/${id}/status`, { status: next });
    load();
  }

  async function cancelOrder() {
    await api.post(`/orders/${id}/status`, { status: 'cancelled' });
    load();
  }

  async function confirmPayment() {
    await api.post(`/orders/${id}/confirm-payment`);
    load();
  }

  // Chidera, 2026-09-24, real live report: "and why is the docket gold
  // and black?" -- on iPad screen, in the print preview. .no-print/
  // .printDocket were only ever hidden/shown via @media print, which
  // relies on the browser applying print styles before it generates the
  // preview -- Safari's iOS print preview doesn't reliably do that for a
  // page like this one, so what she saw was the app's own normal navy/
  // gold UI (sidebar, buttons) bleeding into what should have been an
  // isolated black-and-white docket. Toggling a real class synchronously,
  // right before window.print(), makes the swap happen as normal CSS
  // before the browser ever starts building a preview -- reliable
  // regardless of whether that browser's print-media timing is. A brief
  // on-screen flash to the docket-only view is the trade-off, gone the
  // instant the print dialog closes (or after 5s if a browser never
  // fires afterprint at all).
  // 2026-09-24, real live report: "on mobile it shows as colour" -- the
  // class add and window.print() were both synchronous, back to back,
  // with nothing forcing the browser to actually PAINT the new styles in
  // between. Desktop Chrome happened to always repaint in time; several
  // mobile browsers' print/share-sheet capture can run before that paint
  // completes, capturing the page still mid-transition (old navy/gold
  // colors still on screen for that one frame). Two nested
  // requestAnimationFrame callbacks is the standard way to guarantee a
  // real paint has happened before continuing -- the first rAF fires
  // before the NEXT paint, the second fires after it, so by the time this
  // one runs the class change is guaranteed visually applied.
  function printDocket() {
    document.body.classList.add('printing-docket');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.print();
      });
    });
    const cleanup = () => document.body.classList.remove('printing-docket');
    window.addEventListener('afterprint', cleanup, { once: true });
    setTimeout(cleanup, 5000);
  }

  async function confirmTopup(topupId) {
    await api.post(`/orders/${id}/topups/${topupId}/confirm`);
    load();
  }

  // Chidera, 2026-09-20: "when that kanban card is opened no need for
  // that confirmed payment button for served pipeline inside the
  // kanban, wven the mark as ready and the cancel order, the button
  // needed is mark as served." nextStageFor's whole ready/in_transit
  // pipeline is for pickup/delivery orders -- a dine-in table never
  // goes through it at all (payment/InHouse.jsx's own "Mark paid" is
  // what actually closes it out, not a status-advance click), and
  // "Confirm payment received" (proof-of-payment) doesn't apply either
  // since dine-in payment is POS/at-table, not proof-based. Same
  // /dinein/orders/:id/served endpoint InHouse.jsx's own button hits.
  async function markServed() {
    await api.post(`/dinein/orders/${id}/served`);
    load();
  }

  return (
    <div>
      <div className="no-print">
      <div className="page-header">
        <div>
          <h1>{order.reference}</h1>
          <p className="subtitle">
            Engine state: {order.engine_state} &middot; Payment: <span className={`badge ${order.payment_status}`}>{order.payment_status}</span>
          </p>
        </div>
        <div className="button-row" style={{ gap: 8 }}>
          <button className="secondary" onClick={printDocket} style={{ padding: '8px 14px' }}>
            Print docket
          </button>
          <Link to="/" className="btn secondary" style={{ padding: '8px 14px', border: '1px solid var(--border)', borderRadius: 8 }}>
            Back to orders
          </Link>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Customer</h3>
        <p>
          {customer?.name || customer?.phone_number} &middot; {customer?.phone_number}
        </p>
        <p style={{ marginBottom: 0 }}>
          Fulfilment: <strong>{order.fulfilment_type}</strong>
          {order.fulfilment_type === 'delivery' && customer?.address ? ` — ${customer.address}` : ''}
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Items</h3>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            {mainItems.map((i) => (
              <tr key={i.id}>
                <td>
                  {i.name}
                  {i.newQty > 0 && <span className="new-part"> ({i.newQty} new)</span>}
                  {i.answers?.length > 0 && (
                    <div className="hint" style={{ marginTop: 2 }}>
                      {i.answers.map((a, idx) => (
                        <div key={idx}>
                          {a.question}: <strong>{a.answer}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td>{i.quantity}</td>
                <td>{Number(i.price).toFixed(2)}</td>
              </tr>
            ))}
            {addOnItems.length > 0 && (
              <tr className="addon-section-head">
                <td colSpan={3}>Add on (after serving)</td>
              </tr>
            )}
            {addOnItems.map((i) => (
              <tr key={i.id}>
                <td>
                  {i.name}
                  <span className="new-badge">NEW</span>
                  {i.answers?.length > 0 && (
                    <div className="hint" style={{ marginTop: 2 }}>
                      {i.answers.map((a, idx) => (
                        <div key={idx}>
                          {a.question}: <strong>{a.answer}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td>{i.quantity}</td>
                <td>{Number(i.price).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {Number(order.delivery_fee) > 0 && (
          <p style={{ textAlign: 'right', color: '#6b7280', marginTop: 10, marginBottom: 0 }}>
            Delivery fee: NGN {Number(order.delivery_fee).toLocaleString()}
          </p>
        )}
        <p style={{ textAlign: 'right', fontWeight: 700, marginTop: 4 }}>Total: NGN {Number(order.total).toLocaleString()}</p>
      </div>

      {/* Chidera, 2026-09-25: "why is there payment received button when
          payment is auto confirmed? its if payment is manual itll need
          tapping." A dine-in table already closes itself out through
          InHouse.jsx's own Mark-paid flow (which records payment_method/
          cash_collected properly, see its own 2026-09-24 comment) or a
          real Paystack/Monnify/Moniepoint webhook auto-confirming --
          neither needs a bare "I'm sure this is paid" override button
          with no evidence behind it, and using this one instead of Mark
          paid would silently skip recording how it was actually paid.
          For dine-in, this card now only ever appears to review an
          actual submitted proof (a guest paying their own split share by
          bank transfer, still a real dine-in path) -- never the
          no-evidence fallback. Non-dine-in orders (online, proof-of-
          payment being the only path for some businesses) are unchanged. */}
      {!dineinUnserved &&
        (paymentProofs.length > 0 ||
          (order.channel !== 'dinein' && canEdit(staff) && order.payment_status !== 'confirmed' && order.payment_status !== 'accepted')) && (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Payment</h3>
            {paymentProofs.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
                {paymentProofs.map((p) => (
                  <a key={p.id} href={p.data_url} target="_blank" rel="noreferrer">
                    <img src={p.data_url} alt="Payment proof" style={{ maxWidth: 200, borderRadius: 8, display: 'block' }} />
                  </a>
                ))}
              </div>
            ) : (
              <p className="hint">No proof of payment submitted yet.</p>
            )}
            {canEdit(staff) && order.payment_status !== 'confirmed' && order.payment_status !== 'accepted' && (
              <button onClick={confirmPayment}>Confirm payment received</button>
            )}
          </div>
        )}

      {topups.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Top-ups</h3>
          {topups.map((t) => (
            <div
              key={t.id}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}
            >
              <div>
                {t.items.map((i) => `${i.quantity}x ${i.name}`).join(', ')}
                <div className="hint">
                  NGN {Number(t.amount).toLocaleString()} &middot; <span className={`badge ${t.payment_status}`}>{t.payment_status}</span>
                </div>
              </div>
              {canEdit(staff) && t.payment_status !== 'confirmed' && <button onClick={() => confirmTopup(t.id)}>Mark received</button>}
            </div>
          ))}
        </div>
      )}

      {delivery && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Delivery</h3>
          <p>
            Provider: {delivery.provider} &middot; Status: <span className={`badge ${delivery.status}`}>{delivery.status}</span>
          </p>
          {delivery.rider_name && <p>Rider: {delivery.rider_name} ({delivery.rider_phone})</p>}
        </div>
      )}

      {/* A human override for when the normal code hand-off can't happen
          (customer lost the code, phone died, gave it to a neighbour, or
          it was a test that never had a real code to give). Chidera,
          2026-09-24, real live incident: this used to only show for
          own_riders orders that had a real delivery_assignment row --
          "every order in transit should be able to be released with
          reason" -- so this is order.status-gated now, not
          deliveryAssignment-gated. If a real assignment does exist,
          releasing it here still pays the rider (routes/api.js's
          /orders/:id/release checks for one underneath). */}
      {canEdit(staff) && order.status === 'in_transit' && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Release order</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            Customer lost the code, the rider can't reach them, or this never had a real delivery to finish? Release it with a reason.
          </p>
          {overrideError && <div className="error-banner">{overrideError}</div>}
          <form onSubmit={releaseDelivery} className="button-row" style={{ gap: 10 }}>
            <input
              style={{ flex: 1, minWidth: 180 }}
              placeholder="Reason (e.g. customer lost the code)"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              required
            />
            <button type="submit" className="secondary" disabled={overrideBusy}>
              {overrideBusy ? 'Releasing...' : 'Release order'}
            </button>
          </form>
        </div>
      )}

      {canEdit(staff) && !['completed', 'cancelled'].includes(order.status) && (() => {
        // Chidera, 2026-09-20: dine-in never goes through the pickup/
        // delivery ready/in_transit pipeline nextStageFor drives -- the
        // only real next action for a table is getting served (payment
        // after that happens on the guest's own pay page or InHouse.jsx's
        // "Mark paid", not a status-advance click here).
        const next = order.channel === 'dinein' ? null : nextStageFor(order);
        return (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Update status</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              Currently: <span className={`badge ${order.status}`}>{order.status}</span>
            </p>
            <div className="button-row" style={{ gap: 8 }}>
              {dineinUnserved && <button onClick={markServed}>Mark as served</button>}
              {next && <button onClick={() => advanceStatus(next.next)}>{next.label}</button>}
              {canCancelFrom(order) && (
                <button className="secondary" onClick={cancelOrder}>
                  Cancel order
                </button>
              )}
            </div>
          </div>
        );
      })()}
      </div>

      {/* Chidera, 2026-09-21: "the orders placed that appear in the kanban
          for in house can it be printed from a docket?" -- staff's own
          browser print (whatever printer is already set up on their
          device), not a direct-to-receipt-printer integration yet (that
          needs a specific printer model to build against). Hidden on
          screen, the ONLY thing shown when the "Print docket" button
          above actually triggers a print (index.css's own @media print
          block hides everything else via .no-print). Reuses the exact
          same mainItems/addOnItems served-vs-new split the on-screen
          Items card above already computed, so the printed docket and
          what staff see on screen never disagree.
          "the docket is for kitchen people o so, hope it has details a
          standard kitchen will need" -- no price/total here on purpose,
          a kitchen ticket is about what to cook, not what's owed (that
          stays on the customer-facing invoice/receipt, routes/documents.js
          -- confirmed again after a brief back-and-forth: Chidera's own
          real reference photo of a real kitchen docket had no prices on
          it either). Grouped by station (category) when this business
          uses them, table number made the single biggest thing on the
          page since that's the first thing a kitchen scans for. */}
      <div className="printDocket">
        {businessName && <div className="docketBrand">{businessName}</div>}
        <div className="docketTable">
          {order.channel === 'dinein' && tableLabel ? `Table ${tableLabel}` : (order.fulfilment_type || order.channel || '').toUpperCase()}
        </div>
        <div className="docketMeta">
          {order.reference} &middot;{' '}
          {new Date(order.created_at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </div>
        <hr />
        {groupByCategory(mainItems).map(([category, group]) => (
          <div key={category || 'main'} className="docketGroup">
            {category && <div className="docketCategory">{category}</div>}
            {group.map((i) => (
              <div key={i.id} className="docketItem">
                <span className="docketQty">{i.quantity}&times;</span>
                <span className="docketName">
                  {i.name}
                  {i.newQty > 0 && <span className="docketNew"> NEW</span>}
                  {i.answers?.length > 0 && (
                    <div className="docketNote">
                      {i.answers.map((a, idx) => (
                        <div key={idx}>
                          {a.question}: {a.answer}
                        </div>
                      ))}
                    </div>
                  )}
                </span>
              </div>
            ))}
          </div>
        ))}
        {addOnItems.length > 0 && (
          <>
            <div className="docketAddonHead">Add on &middot; after serving</div>
            {groupByCategory(addOnItems).map(([category, group]) => (
              <div key={category || 'addon'} className="docketGroup">
                {category && <div className="docketCategory">{category}</div>}
                {group.map((i) => (
                  <div key={i.id} className="docketItem">
                    <span className="docketQty">{i.quantity}&times;</span>
                    <span className="docketName">
                      {i.name}
                      <span className="docketNew"> NEW</span>
                      {i.answers?.length > 0 && (
                        <div className="docketNote">
                          {i.answers.map((a, idx) => (
                            <div key={idx}>
                              {a.question}: {a.answer}
                            </div>
                          ))}
                        </div>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
        <div className="docketEraMark">Powered by ERA Systems</div>
      </div>
    </div>
  );
}
