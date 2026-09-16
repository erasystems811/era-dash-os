import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import Loading from '../components/Loading.jsx';

// "Receipts" here means the real payment-proof photos customers actually
// sent (and staff confirmed against), not a system-generated document --
// Chidera 2026-09-11: "receipts on dashboard are the actual payment proofs
// that the customers send that they confirm not ai generated pdf". This
// used to list engine/documents.js's createReceipt() rows (a rendered
// order-total page, generated automatically the moment payment cleared) --
// removed entirely, since it was never the real proof, just a restatement
// of the order.
export default function Documents() {
  const [proofs, setProofs] = useState(null);

  useEffect(() => {
    api.get('/documents').then(setProofs);
  }, []);

  if (!proofs) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Receipts</h1>
          <p className="subtitle">Every payment-proof photo a customer has sent, newest first.</p>
        </div>
      </div>
      <div className="card">
        {proofs.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            {proofs.map((p) => (
              <div key={p.id} style={{ width: 180 }}>
                <a href={p.data_url} target="_blank" rel="noreferrer">
                  <img src={p.data_url} alt="Payment proof" style={{ width: '100%', height: 160, objectFit: 'cover', borderRadius: 8, display: 'block' }} />
                </a>
                <div style={{ marginTop: 6, fontSize: 13 }}>
                  <Link to={`/orders/${p.order_id}`}>{p.reference}</Link>
                </div>
                <div className="hint" style={{ marginTop: 2 }}>
                  {p.customer_name || p.customer_phone} &middot; {new Date(p.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-state">No payment proof sent yet.</p>
        )}
      </div>
    </div>
  );
}
