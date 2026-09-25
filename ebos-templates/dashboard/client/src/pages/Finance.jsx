import React, { useEffect, useState } from 'react';
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

function StatCard({ iconBg, iconColor, icon, label, value, hint }) {
  return (
    <div className="card" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ width: 40, height: 40, borderRadius: '50%', background: iconBg, color: iconColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </div>
      <div className="hint" style={{ margin: 0 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700 }}>{value}</div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

// Last 12 calendar months, most recent first, as {value: 'YYYY-MM', label:
// 'September 2026'} -- paired with "All time" (value: '') as the two modes
// /finance/summary itself understands.
function monthOptions() {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < 12; i++) {
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    out.push({ value, label });
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

// Chidera, 2026-09-24: "the way its looking we need a finance dashboard,
// convert pos tab to that instead, it should be able to measure total cash
// collected(all time and any month), outstanding, total revenue(all time
// and each month)... revenue from top 10 best sellers(all time and any
// month)." Was Pos.jsx, a single-purpose Moniepoint-terminal-sales list --
// folded in as its own section here, since the money question this page
// answers is bigger than terminal sales alone.
// Chidera, 2026-09-25, follow-up: "seperate pos and finance dashboard
// then, i dont think pos sync is even possible" -- POS split back out
// into its own page (Pos.jsx) again. This page is back to purely the
// bot's own cash/revenue/outstanding/best-sellers.
export default function Finance() {
  const [month, setMonth] = useState('');
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    setSummary(null);
    const q = month ? `?month=${month}` : '';
    api.get(`/finance/summary${q}`).then(setSummary);
  }, [month]);

  if (!summary) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Finance</h1>
          <p className="subtitle">Real money in and out -- cash collected, revenue, and what's still owed.</p>
        </div>
        <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All time</option>
          {monthOptions().map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 20 }}>
        <StatCard
          iconBg="var(--success-soft)"
          iconColor="var(--success)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4" />
              <path d="M8 2v4" />
              <path d="M3 10h18" />
            </svg>
          }
          label="Total revenue"
          value={formatMoneyShort(summary.revenue)}
          hint="Orders actually paid for, this window"
        />
        <StatCard
          iconBg="rgba(184, 150, 79, 0.16)"
          iconColor="var(--gold)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1v22" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          }
          label="Cash collected"
          value={formatMoneyShort(summary.cashCollected)}
          hint="Recorded from Mark paid, dine-in"
        />
        <StatCard
          iconBg="rgba(198, 40, 40, 0.12)"
          iconColor="#c62828"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
          }
          label="Outstanding"
          value={formatMoneyShort(summary.outstanding)}
          hint="Placed, not yet paid, this window"
        />
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Top 10 best sellers</h3>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Quantity sold</th>
              <th>Revenue</th>
            </tr>
          </thead>
          <tbody>
            {summary.topSellers.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td>{s.quantity.toLocaleString()}</td>
                <td>{formatMoney(s.revenue)}</td>
              </tr>
            ))}
            {summary.topSellers.length === 0 && (
              <tr>
                <td colSpan={3} className="hint">
                  No paid orders yet in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
