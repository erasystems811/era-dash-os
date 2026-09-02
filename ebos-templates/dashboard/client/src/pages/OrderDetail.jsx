import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';
import { nextStageFor } from '../orderStages.js';

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

  if (!data) return null;
  const { order, items, customer, documents, delivery, deliveryAssignment } = data;

  async function releaseDelivery(e) {
    e.preventDefault();
    setOverrideError(null);
    setOverrideBusy(true);
    try {
      await api.post(`/delivery/assignments/${deliveryAssignment.id}/release`, { reason: overrideReason.trim() });
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
          {/* Own-riders only -- a human override for when the normal code
              hand-off can't happen (customer lost the code, phone died,
              gave it to a neighbour). Never available once it's already
              closed out, one way or another. */}
          {canEdit(staff) && deliveryAssignment && !['DELIVERED', 'FAILED'].includes(deliveryAssignment.status) && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <p className="hint" style={{ marginTop: 0 }}>
                Customer lost the code, or the rider can't reach them to confirm? Release this delivery with a reason -- the rider still gets
                paid.
              </p>
              {overrideError && <div className="error-banner">{overrideError}</div>}
              <form onSubmit={releaseDelivery} style={{ display: 'flex', gap: 10 }}>
                <input
                  style={{ flex: 1 }}
                  placeholder="Reason (e.g. customer lost the code)"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  required
                />
                <button type="submit" className="secondary" disabled={overrideBusy}>
                  {overrideBusy ? 'Releasing...' : 'Release delivery'}
                </button>
              </form>
            </div>
          )}
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

      {canEdit(staff) && !['completed', 'cancelled'].includes(order.status) && (() => {
        const next = nextStageFor(order);
        return (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Update status</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              Currently: <span className={`badge ${order.status}`}>{order.status}</span>
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              {next && <button onClick={() => advanceStatus(next.next)}>{next.label}</button>}
              <button className="secondary" onClick={cancelOrder}>
                Cancel order
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
