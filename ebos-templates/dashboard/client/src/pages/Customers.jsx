import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import Loading from '../components/Loading.jsx';

function formatMoney(n) {
  return `NGN ${Number(n || 0).toLocaleString()}`;
}

// Chidera, 2026-09-24: "birthday is showing as invalid date." Root cause,
// confirmed live: customers.birthday is a Postgres `date` column, which
// pg's default driver hands back as a real JS Date object, not a plain
// string -- res.json() then serialises it as a FULL ISO timestamp
// ("2026-09-21T00:00:00.000Z"), not "2026-09-21". Splitting that on '-'
// grabbed "21T00:00:00.000Z" as the day, Number()'d it to NaN, and built
// an Invalid Date. Slicing to the first 10 characters first handles both
// shapes -- a plain date string is already 10 characters, so this is a
// no-op for it either way.
function formatBirthday(d) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(day));
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Chidera, 2026-09-16: "have a crm tab and customer tab seperate cause
// customer can reach 2000 and make crm tab too long... customer tab be all
// customers" -- this used to also carry CRM's stat cards and charts (see
// Crm.jsx now), which meant every visit re-fetched and rendered those on
// top of a list that can genuinely reach thousands of rows. Just the full,
// searchable list here now -- nothing else to load or render first.
export default function Customers() {
  const [customers, setCustomers] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    api.get('/customers').then(setCustomers);
  }, []);

  if (!customers) return <Loading />;

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
              <th>Status</th>
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
                <td>{c.segment && <span className={`badge ${c.segment}`}>{c.segment}</span>}</td>
                <td>
                  <Link to={`/conversations/${c.id}`} className="btn secondary" style={{ padding: '4px 10px', fontSize: 13 }}>
                    Text
                  </Link>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="hint">
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
