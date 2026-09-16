import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, PieChart, Pie, Cell } from 'recharts';
import { api } from '../api.js';
import Loading from '../components/Loading.jsx';

function formatMoney(n) {
  return `NGN ${Number(n || 0).toLocaleString()}`;
}

function formatMoneyShort(n) {
  const v = Number(n || 0);
  if (v >= 1000000) return `NGN ${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `NGN ${(v / 1000).toFixed(1)}K`;
  return `NGN ${v.toLocaleString()}`;
}

function formatBirthday(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(day));
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function formatDay(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short' });
}

function Delta({ pct }) {
  if (pct === null || pct === undefined) return <span className="hint">vs last month</span>;
  const up = pct >= 0;
  return (
    <span style={{ color: up ? 'var(--success)' : 'var(--danger)', fontSize: 12.5, fontWeight: 600 }}>
      {up ? '↑' : '↓'} {Math.abs(pct)}% <span className="hint" style={{ fontWeight: 400 }}>vs last month</span>
    </span>
  );
}

function StatCard({ iconBg, iconColor, icon, label, value, delta }) {
  return (
    <div className="card" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ width: 40, height: 40, borderRadius: '50%', background: iconBg, color: iconColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </div>
      <div className="hint" style={{ margin: 0 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700 }}>{value}</div>
      {delta}
    </div>
  );
}

const SEGMENT_COLORS = { new: '#b4700f', repeat: '#1b2a4a', vip: '#b8964f' };

// Chidera, 2026-09-16, from a client's own CRM mockup: stats/segments/
// charts are real, buildable from data we already have -- see routes/api.js's
// /customers/stats for exactly how New/Repeat/VIP and the "vs last month"
// deltas are defined. The mockup's "WhatsApp Automation" panel (automated
// triggered messages) was deliberately NOT built here -- that's a separate
// feature with its own real stakes (Meta template approval, the same daily
// messaging limit already discussed), left for a later decision rather
// than built silently alongside a dashboard redesign.
export default function Customers() {
  const [customers, setCustomers] = useState(null);
  const [stats, setStats] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    api.get('/customers').then(setCustomers);
    api.get('/customers/stats').then(setStats);
  }, []);

  if (!customers || !stats) return <Loading />;

  const filtered = search.trim()
    ? customers.filter((c) => (c.name || '').toLowerCase().includes(search.toLowerCase()) || (c.phone_number || '').includes(search.trim()))
    : customers;

  const segmentData = [
    { key: 'new', name: 'New', value: stats.segments.new },
    { key: 'repeat', name: 'Repeat', value: stats.segments.repeat },
    { key: 'vip', name: 'VIP', value: stats.segments.vip },
  ].filter((s) => s.value > 0);
  const segmentTotal = stats.segments.new + stats.segments.repeat + stats.segments.vip;

  const chartData = stats.daily.map((d) => ({ day: formatDay(d.day), New: d.newCustomers, Repeat: d.repeatCustomers }));

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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 20 }}>
        <StatCard
          iconBg="var(--success-soft)"
          iconColor="var(--success)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          }
          label="Total Customers"
          value={stats.totalCustomers.toLocaleString()}
          delta={<Delta pct={stats.deltas.newCustomersPct} />}
        />
        <StatCard
          iconBg="rgba(184, 150, 79, 0.16)"
          iconColor="var(--gold)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          }
          label="Repeat Customers"
          value={stats.repeatCustomers.toLocaleString()}
          delta={<span className="hint">of {stats.totalCustomers.toLocaleString()} total</span>}
        />
        <StatCard
          iconBg="var(--accent-soft)"
          iconColor="var(--accent)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 20V10" />
              <path d="M18 20V4" />
              <path d="M6 20v-4" />
            </svg>
          }
          label="Retention Rate"
          value={`${stats.retentionRate}%`}
          delta={<span className="hint">repeat customers / customers who've ordered</span>}
        />
        <StatCard
          iconBg="var(--success-soft)"
          iconColor="var(--success)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          }
          label="Total Revenue"
          value={formatMoneyShort(stats.totalRevenue)}
          delta={<Delta pct={stats.deltas.revenuePct} />}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, alignItems: 'stretch' }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Customer Overview</h3>
          <p className="hint" style={{ marginTop: -8 }}>New vs repeat customers, last 7 days</p>
          {chartData.length === 0 ? (
            <p className="hint">No completed orders in the last 7 days yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" fontSize={12} stroke="var(--text-muted)" />
                <YAxis fontSize={12} stroke="var(--text-muted)" allowDecimals={false} />
                <Tooltip />
                <Line type="monotone" dataKey="New" stroke="var(--success)" strokeWidth={2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="Repeat" stroke="var(--gold)" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Customer Segments</h3>
          {segmentTotal === 0 ? (
            <p className="hint">No customers with orders yet.</p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={segmentData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2}>
                    {segmentData.map((s) => (
                      <Cell key={s.key} fill={SEGMENT_COLORS[s.key]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                {segmentData.map((s) => (
                  <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: SEGMENT_COLORS[s.key], marginRight: 8 }} />
                      {s.name}
                    </span>
                    <span className="hint">{Math.round((s.value / segmentTotal) * 100)}%</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Recent Customers</h3>
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
