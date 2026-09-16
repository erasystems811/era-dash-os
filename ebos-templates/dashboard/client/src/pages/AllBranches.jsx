import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Loading from '../components/Loading.jsx';

function naira(amount) {
  return `₦${Number(amount).toLocaleString()}`;
}

function busiestHourText(hour) {
  if (!hour) return '–';
  const start = new Date(hour.start);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const fmt = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fmt(start)} to ${fmt(end)} · ${hour.count} order${hour.count === 1 ? '' : 's'}`;
}

// No order rail here on purpose -- nobody works two kitchens at once, and a
// combined ticket board across branches is unusable. This is comparison
// only: the thing an owner with several locations genuinely can't see
// today, side by side.
export default function AllBranches() {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    api.get('/branches/summary').then(setRows);
  }, []);

  if (!rows) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Compare branches</h1>
          <p className="subtitle">Today's numbers, side by side. For live order-by-order work, switch to one branch.</p>
        </div>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Branch</th>
              <th>Orders today</th>
              <th>Revenue today</th>
              <th>Busiest hour</th>
              <th>Deliveries in progress</th>
              <th>Needs a person</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="mono">{r.ordersToday}</td>
                <td className="mono">{naira(r.revenueToday)}</td>
                <td className="mono">{busiestHourText(r.busiestHour)}</td>
                <td className="mono">{r.deliveriesInProgress}</td>
                <td className="mono">{r.needsAttention}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6} className="empty-state">
                  No branches yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
