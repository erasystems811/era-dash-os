import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, PieChart, Pie, Cell } from 'recharts';
import { api } from '../api.js';
import Loading from '../components/Loading.jsx';
import StatCard, { Delta } from '../components/StatCard.jsx';

function formatMoney(n) {
  return `NGN ${Number(n || 0).toLocaleString()}`;
}

function formatMoneyShort(n) {
  const v = Number(n || 0);
  if (v >= 1000000) return `NGN ${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `NGN ${(v / 1000).toFixed(1)}K`;
  return `NGN ${v.toLocaleString()}`;
}

function formatDay(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short' });
}

function formatMonth(m) {
  const [y, mo] = m.split('-');
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

const SEGMENT_COLORS = { new: '#b4700f', repeat: '#1b2a4a', vip: '#b8964f' };

// Chidera, 2026-09-16: "let feedback tab feel like the customer tab and
// have a crm tab and customer tab seperate cause customer can reach 2000
// and make crm tab too long, so let crm only be recent chat and customer
// tab be all customers and then the crm how can it be looked it per month
// and as a cummulative/ like feedback" -- split out of what used to be one
// Customers.jsx: the cumulative stat cards/charts (always visible, same
// shape as Feedback's own stat row) plus a Recent (7 days)/By month tab
// pair, exactly matching Feedback.jsx's own structure. The full customer
// LIST (which can genuinely reach thousands of rows) lives on its own,
// separate Customers.jsx page instead of loading here every time.
export default function Crm() {
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState(null);
  const [monthly, setMonthly] = useState(null);
  const [view, setView] = useState('recent');

  useEffect(() => {
    api.get('/customers/stats').then(setStats);
    api.get('/customers/recent').then(setRecent);
    api.get('/customers/monthly').then(setMonthly);
  }, []);

  if (!stats || !recent || !monthly) return <Loading />;

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
          <h1>CRM</h1>
          <p className="subtitle">How your customer base is doing -- cumulative, and trending by month. For the full customer list, see Customers.</p>
        </div>
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

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, alignItems: 'stretch', marginBottom: 20 }}>
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

      <div className="tab-row" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={view === 'recent' ? '' : 'secondary'} onClick={() => setView('recent')}>
          Recent (7 days)
        </button>
        <button className={view === 'monthly' ? '' : 'secondary'} onClick={() => setView('monthly')}>
          By month
        </button>
      </div>

      {view === 'recent' && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Phone number</th>
                <th>Last order</th>
                <th>Orders</th>
                <th>Total spend</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {recent.map((c) => (
                <tr key={c.id}>
                  <td>{c.name || '(no name on file)'}</td>
                  <td>{c.phone_number || '—'}</td>
                  <td>{new Date(c.last_order_at).toLocaleString()}</td>
                  <td>{c.order_count}</td>
                  <td>{formatMoney(c.total_spend)}</td>
                  <td>{c.segment && <span className={`badge ${c.segment}`}>{c.segment}</span>}</td>
                  <td>
                    <Link to={`/conversations/${c.id}`} className="btn secondary" style={{ padding: '4px 10px', fontSize: 13 }}>
                      Text
                    </Link>
                  </td>
                </tr>
              ))}
              {!recent.length && (
                <tr>
                  <td colSpan={7} className="empty-state">
                    No customer activity in the last 7 days.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === 'monthly' && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>New customers</th>
                <th>Repeat customers</th>
                <th>Orders</th>
                <th>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m.month}>
                  <td>{formatMonth(m.month)}</td>
                  <td>{m.new_customers}</td>
                  <td>{m.repeat_customers}</td>
                  <td>{m.total_orders}</td>
                  <td>{formatMoney(m.revenue)}</td>
                </tr>
              ))}
              {!monthly.length && (
                <tr>
                  <td colSpan={5} className="empty-state">
                    Nothing yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
