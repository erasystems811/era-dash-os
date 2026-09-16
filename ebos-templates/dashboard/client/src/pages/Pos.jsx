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

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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

// Chidera, 2026-09-16: a client wants his real in-store Moniepoint POS sales
// (not just money that comes in through the bot) visible in the dashboard,
// as an actual record list -- not just a revenue number. See
// engine/webhook-moniepoint.js for how a row lands here, and pos-sync-config
// for the toggle. There's deliberately no per-transaction customer column:
// Moniepoint's docs never confirmed a POS sale carries customer identity,
// only amount/reference/time -- adding a fake or misleading column would be
// worse than leaving it out.
export default function Pos() {
  const [transactions, setTransactions] = useState(null);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    api.get('/pos-transactions').then(setTransactions);
    api.get('/pos-transactions/stats').then(setStats);
  }, []);

  if (!transactions || !stats) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>POS</h1>
          <p className="subtitle">Real terminal sales, synced automatically from Moniepoint.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 20 }}>
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
          label="Total POS Revenue"
          value={formatMoneyShort(stats.totalRevenue)}
          hint={`${stats.totalTransactions.toLocaleString()} transactions`}
        />
        <StatCard
          iconBg="rgba(184, 150, 79, 0.16)"
          iconColor="var(--gold)"
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4" />
              <path d="M8 2v4" />
              <path d="M3 10h18" />
            </svg>
          }
          label="Today's Revenue"
          value={formatMoneyShort(stats.todayRevenue)}
          hint={`${stats.todayTransactions.toLocaleString()} transactions today`}
        />
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Transactions</h3>
        <table>
          <thead>
            <tr>
              <th>Reference</th>
              <th>Amount</th>
              <th>Date & time</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((t) => (
              <tr key={t.id}>
                <td>{t.provider_reference}</td>
                <td>{formatMoney(t.amount)}</td>
                <td>{formatDateTime(t.occurred_at)}</td>
              </tr>
            ))}
            {transactions.length === 0 && (
              <tr>
                <td colSpan={3} className="hint">
                  No POS transactions synced yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
