import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import Loading from '../components/Loading.jsx';

// The dedicated home for in-house-scoped staff (staff.work_area ===
// 'in_house') -- Chidera 2026-09-11: "i need a era-demo.erasystems.com.ng/
// in-house link that opend the management for the in house guest, so
// staffs arent confused and i can just give them their part to manage."
// Also reachable by an owner/manager from Orders.jsx's In House tab.
//
// Two real pipelines, not one -- Chidera 2026-09-11: "confirming payment
// is different from marking served so there should be 2 piplines, the
// fist one shows kanban with served button and the next one marks paid."
// Pipeline one (served_at is null): a round just placed, nothing's gone
// out to the table yet -- "Served" is the only way out. Pipeline two
// (served_at set): served, still owed -- "Mark paid" is what actually
// closes it out (POST /orders/:id/status, same close-out every other
// order gets). Adding items to an already-served order sends it back to
// pipeline one automatically (engine/flow.js's applyOrderModifications) --
// "some people dont order just once they just keep ordering and adding."
// Side-by-side columns, not stacked -- Chidera 2026-09-11: "serving and
// awaiting payment should be in a horizontal arrangement not vertical,
// maybe a pipeline" -- same board/board-column/docket layout as Orders.jsx's
// own kanban, so this reads as one real pipeline, not two disconnected
// lists.
function naira(amount) {
  return `₦${Number(amount).toLocaleString()}`;
}

export default function InHouse() {
  const [serving, setServing] = useState(null);
  const [awaitingPayment, setAwaitingPayment] = useState(null);
  // Chidera, 2026-09-25: "can in house have its own dashboard, with cash
  // collected" -- always dine-in-only regardless of who's viewing (see
  // routes/dinein.js's /stats/today of its own comment for why this
  // couldn't just reuse /orders/stats/today's existing in_house branch).
  const [stats, setStats] = useState(null);

  function load() {
    api.get('/dinein/orders/pending').then(setServing);
    api.get('/dinein/orders/serving').then(setAwaitingPayment);
    api.get('/dinein/stats/today').then(setStats);
  }
  useEffect(() => {
    load();
    // A floor/counter queue, not something worth a manual refresh click --
    // same order of magnitude as Layout.jsx's own add-on config polling.
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  async function markServed(e, orderId) {
    e.preventDefault();
    e.stopPropagation();
    await api.post(`/dinein/orders/${orderId}/served`);
    load();
  }

  async function markPaid(e, orderId) {
    e.preventDefault();
    e.stopPropagation();
    await api.post(`/orders/${orderId}/status`, { status: 'completed' });
    load();
  }

  if (!serving || !awaitingPayment) return <Loading />;

  function column(key, label, hint, orders, emptyText, actionLabel, onAction) {
    return (
      <div key={key} className="board-column" style={{ minWidth: 260, flex: '0 0 260px' }}>
        <div className="lane-head">
          <h2>{label}</h2>
          <span className="count mono">{orders.length}</span>
          <p className="hint">{hint}</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          {orders.map((o) => (
            <Link key={o.id} to={`/orders/${o.id}`} className="docket">
              <div className="row1">
                <span className="no mono">Table {o.table_label}</span>
              </div>
              {o.items?.length > 0 && (
                <ul>
                  {o.items.map((item, i) => {
                    // newQty -- Chidera, 2026-09-11: "on the staff card
                    // let there be a clear demarcation for add on, so
                    // they know what has been served and what has just
                    // been added on." Diffed server-side (routes/
                    // dinein.js's itemsWithServedDiff) against a
                    // snapshot taken the moment "Served" was last
                    // tapped -- 0 means this line hasn't changed since;
                    // the whole quantity means it's a genuinely new
                    // line; anything in between is a mix (some already
                    // out, more just ordered).
                    const newQty = item.newQty || 0;
                    const servedQty = item.quantity - newQty;
                    return (
                      <li key={i}>
                        {newQty === 0 ? (
                          <>
                            <b>{item.quantity}</b> {item.name}
                          </>
                        ) : newQty === item.quantity ? (
                          <>
                            <b>{item.quantity}</b> {item.name}
                            <span className="new-badge">NEW</span>
                          </>
                        ) : (
                          <>
                            <b>{item.quantity}</b> {item.name}
                            <span className="new-part">({newQty} new)</span>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="foot">
                <span className="total mono">NGN {Number(o.total || 0).toLocaleString()}</span>
              </div>
              <button style={{ marginTop: 8, width: '100%' }} onClick={(e) => onAction(e, o.id)}>
                {actionLabel}
              </button>
            </Link>
          ))}
          {!orders.length && <div className="empty">{emptyText}</div>}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>In House</h1>
          <p className="subtitle">Dine-in orders, oldest first.</p>
        </div>
      </div>

      {stats && (
        <div className="card" style={{ maxWidth: 560 }}>
          <h3 style={{ marginTop: 0 }}>Today</h3>
          <div className="figs">
            <div className="fig">
              <span>Tables served</span>
              <strong className="mono">{stats.tablesServed}</strong>
            </div>
            <div className="fig">
              <span>Collected</span>
              <strong className="mono">{naira(stats.collected)}</strong>
            </div>
            <div className="fig">
              <span>Cash</span>
              <strong className="mono">{naira(stats.cash)}</strong>
            </div>
            <div className="fig">
              <span>Card</span>
              <strong className="mono">{naira(stats.card)}</strong>
            </div>
            <div className="fig">
              <span>Transfer</span>
              <strong className="mono">{naira(stats.transfer)}</strong>
            </div>
            {stats.other > 0 && (
              <div className="fig">
                <span>Other (link/POS)</span>
                <strong className="mono">{naira(stats.other)}</strong>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="board" style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 8 }}>
        {column('serving', 'Serving', 'waiting on the kitchen/bar', serving, 'Nothing pending right now.', 'Served', markServed)}
        {column(
          'awaiting-payment',
          'Awaiting payment',
          "served, table can't close until paid",
          awaitingPayment,
          'Nothing awaiting payment.',
          'Mark paid',
          markPaid
        )}
      </div>
    </div>
  );
}
