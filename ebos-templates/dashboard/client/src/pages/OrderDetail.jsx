import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';

const STATUSES = ['new', 'confirmed', 'ready', 'delivery', 'completed', 'cancelled'];

export default function OrderDetail() {
  const { id } = useParams();
  const { staff } = useStaff();
  const [data, setData] = useState(null);
  const [readySent, setReadySent] = useState(false);

  function load() {
    api.get(`/orders/${id}`).then(setData);
  }
  useEffect(load, [id]);

  if (!data) return null;
  const { order, items, customer, documents, delivery } = data;

  async function updateStatus(e) {
    await api.post(`/orders/${id}/status`, { status: e.target.value });
    load();
  }

  async function confirmPayment() {
    await api.post(`/orders/${id}/confirm-payment`);
    load();
  }

  async function notifyReady() {
    await api.post(`/orders/${id}/notify-ready`);
    setReadySent(true);
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{order.reference}</h1>
          <p className="subtitle">
            Engine state: {order.engine_state} &middot; Payment: <span className={`badge ${order.payment_status}`}>{order.payment_status}</span>
          </p>
        </div>
        <Link to="/" className="btn secondary" style={{ padding: '8px 14px', border: '1px solid var(--border)', borderRadius: 8 }}>
          Back to orders
        </Link>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Customer</h3>
        <p>
          {customer?.name || customer?.phone_number} &middot; {customer?.phone_number}
        </p>
        <p>
          Fulfilment: <strong>{order.fulfilment_type}</strong>
          {order.fulfilment_type === 'delivery' && customer?.address ? ` — ${customer.address}` : ''}
        </p>
        {order.fulfilment_type === 'pickup' &&
          order.engine_state === 'fulfilment' &&
          !['completed', 'cancelled'].includes(order.status) &&
          canEdit(staff) && (
            <button onClick={notifyReady} disabled={readySent}>
              {readySent ? 'Customer notified' : 'Notify ready for pickup'}
            </button>
          )}
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
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.name}</td>
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

      {(order.payment_proof_url || (canEdit(staff) && order.payment_status !== 'confirmed' && order.payment_status !== 'accepted')) && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Payment</h3>
          {order.payment_proof_url ? (
            <a href={order.payment_proof_url} target="_blank" rel="noreferrer">
              <img src={order.payment_proof_url} alt="Payment proof" style={{ maxWidth: 260, borderRadius: 8, display: 'block', marginBottom: 12 }} />
            </a>
          ) : (
            <p className="hint">No proof of payment submitted yet.</p>
          )}
          {canEdit(staff) && order.payment_status !== 'confirmed' && order.payment_status !== 'accepted' && (
            <button onClick={confirmPayment}>Confirm payment received</button>
          )}
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

      {documents.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Documents</h3>
          {documents.map((d) => (
            <a key={d.id} href={d.url} target="_blank" rel="noreferrer" style={{ marginRight: 12 }}>
              {d.type}
            </a>
          ))}
        </div>
      )}

      {canEdit(staff) && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Update status</h3>
          <div className="field" style={{ maxWidth: 220 }}>
            <select value={order.status} onChange={updateStatus}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
