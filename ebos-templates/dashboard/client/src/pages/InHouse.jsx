import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

// The dedicated home for in-house-scoped staff (staff.work_area ===
// 'in_house') -- Chidera 2026-09-11: "i need a era-demo.erasystems.com.ng/
// in-house link that opend the management for the in house guest, so
// staffs arent confused and i can just give them their part to manage."
// Also reachable by an owner/manager from Orders.jsx's In House tab; the
// data and actions are identical either way, this is just the one real
// place they live now (lifted out of DineIn.jsx's own "Pending orders"
// card, which showed the exact same list buried inside table/QR setup).
export default function InHouse() {
  const [orders, setOrders] = useState(null);

  function load() {
    api.get('/dinein/orders/pending').then(setOrders);
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
    await api.post(`/orders/${orderId}/status`, { status: 'completed' });
    load();
  }

  if (!orders) return null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>In House</h1>
          <p className="subtitle">Dine-in orders placed and waiting on the kitchen/bar. Oldest first.</p>
        </div>
      </div>

      <div className="card">
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
                  <button className="secondary" onClick={(e) => markServed(e, o.id)}>
                    Mark fulfilled
                  </button>
                </td>
              </tr>
            ))}
            {!orders.length && (
              <tr>
                <td colSpan={4} className="empty-state">
                  Nothing pending right now.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
