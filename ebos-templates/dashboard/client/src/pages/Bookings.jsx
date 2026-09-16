import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Loading from '../components/Loading.jsx';

// A restaurant (this sample business) has no bookings, only orders -- this
// page is here because booking-mode businesses (apartment/car_rental/
// lashes_nails) use the same schema and need it. Full calendar view (per
// the build schema's section 8.1/6.2) is worth building once one of those
// business types is actually onboarded; a plain list is enough to prove
// the data model works today.
export default function Bookings() {
  const [bookings, setBookings] = useState(null);

  useEffect(() => {
    api.get('/bookings').then(setBookings);
  }, []);

  if (!bookings) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Bookings</h1>
          <p className="subtitle">For booking-led business types (apartment, car rental, lashes and nails).</p>
        </div>
      </div>
      <div className="card">
        {bookings.length ? (
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Customer</th>
                <th>Item</th>
                <th>Date</th>
                <th>Status</th>
                <th>Payment</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id}>
                  <td>{b.reference}</td>
                  <td>{b.customer_name || b.customer_phone}</td>
                  <td>{b.product_name}</td>
                  <td>
                    {b.date}
                    {b.end_date ? ` – ${b.end_date}` : ''} {b.time || ''}
                  </td>
                  <td>
                    <span className={`badge ${b.status}`}>{b.status}</span>
                  </td>
                  <td>
                    <span className={`badge ${b.payment_status}`}>{b.payment_status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">This business doesn't take bookings, only orders.</div>
        )}
      </div>
    </div>
  );
}
