import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

function formatMoney(n) {
  return `NGN ${Number(n || 0).toLocaleString()}`;
}

function formatBirthday(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(day));
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Chidera, 2026-09-16: a customer database with real spend history and
// birthdays, no bulk-send capability anywhere on it -- "Text" below opens
// one real conversation (same page Conversations already uses), on
// purpose. Mass marketing was explicitly ruled out, not just left undone:
// "the system shouldnt allow them do such if they want to text one person
// its differnt."
export default function Customers() {
  const [customers, setCustomers] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    api.get('/customers').then(setCustomers);
  }, []);

  if (!customers) return null;

  const filtered = search.trim()
    ? customers.filter((c) => (c.name || '').toLowerCase().includes(search.toLowerCase()) || (c.phone_number || '').includes(search.trim()))
    : customers;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Customers</h1>
          <p className="subtitle">Every customer, their spend, and their birthday -- for celebrating them, not for mass messaging.</p>
        </div>
        <a className="btn" href="/api/customers/export" download>
          Download CSV
        </a>
      </div>

      <div className="card">
        <input placeholder="Search by name or phone number" value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: 16 }} />
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone number</th>
              <th>Birthday</th>
              <th>Orders</th>
              <th>Total spend</th>
              <th>Average spend</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.id}>
                <td>{c.name || '(no name on file)'}</td>
                <td>{c.phone_number || '—'}</td>
                <td>{formatBirthday(c.birthday) || '—'}</td>
                <td>{c.order_count}</td>
                <td>{formatMoney(c.total_spend)}</td>
                <td>{formatMoney(c.average_spend)}</td>
                <td>
                  <Link to={`/conversations/${c.id}`} className="btn secondary" style={{ padding: '4px 10px', fontSize: 13 }}>
                    Text
                  </Link>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="hint">
                  No customers found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
