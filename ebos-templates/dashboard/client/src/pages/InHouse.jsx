import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

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
export default function InHouse() {
  const [serving, setServing] = useState(null);
  const [awaitingPayment, setAwaitingPayment] = useState(null);

  function load() {
    api.get('/dinein/orders/pending').then(setServing);
    api.get('/dinein/orders/serving').then(setAwaitingPayment);
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

  if (!serving || !awaitingPayment) return null;

  function table({ orders, emptyText, actionLabel, onAction }) {
    return (
      <table>
        <thead>
          <tr>
            <th>Table</th>
            <th>Order</th>
            <th>Total</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className="clickable" onClick={() => (window.location.href = `/orders/${o.id}`)}>
              <td>
                <Link to={`/orders/${o.id}`}>Table {o.table_label}</Link>
              </td>
              <td style={{ color: 'var(--text-muted)' }}>{o.items.map((i) => `${i.quantity}x ${i.name}`).join(', ')}</td>
              <td>NGN {Number(o.total || 0).toLocaleString()}</td>
              <td>
                <button className="secondary" onClick={(e) => onAction(e, o.id)}>
                  {actionLabel}
                </button>
              </td>
            </tr>
          ))}
          {!orders.length && (
            <tr>
              <td colSpan={4} className="empty-state">
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
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

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Serving</h3>
        <p className="subtitle" style={{ marginTop: 0 }}>
          Placed, waiting on the kitchen/bar.
        </p>
        {table({ orders: serving, emptyText: 'Nothing pending right now.', actionLabel: 'Served', onAction: markServed })}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Awaiting payment</h3>
        <p className="subtitle" style={{ marginTop: 0 }}>
          Served, not yet paid. A table can't close until this is empty.
        </p>
        {table({ orders: awaitingPayment, emptyText: 'Nothing awaiting payment.', actionLabel: 'Mark paid', onAction: markPaid })}
      </div>
    </div>
  );
}
