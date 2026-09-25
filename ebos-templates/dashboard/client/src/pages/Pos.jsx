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

// Chidera, 2026-09-25: "seperate pos and finance dashboard then, i dont
// think pos sync is even possible" -- was its own tab (Pos.jsx), folded
// into Finance.jsx on 2026-09-24 as a "POS terminal sales" section
// because the money question Finance answers is bigger than terminal
// sales alone. Pulled back out: real Moniepoint terminal transactions are
// a separate concern from the bot's own cash/revenue/outstanding
// (engine/webhook-moniepoint.js's own comment: "money collected FROM a
// customer through the bot" vs "sales that already happened on a
// physical terminal"), and worth its own page again rather than muddying
// Finance with a feature whose real-world reliability is still in
// question. The underlying sync itself (routes/api.js's pos-sync-config/
// pos-transactions, engine/webhook-moniepoint.js) is untouched -- this is
// only the dashboard page split back apart.
export default function Pos() {
  const [posEnabled, setPosEnabled] = useState(null);
  const [transactions, setTransactions] = useState(null);
  const [posStats, setPosStats] = useState(null);

  useEffect(() => {
    api.get('/pos-sync-config').then((c) => {
      const enabled = Boolean(c?.enabled);
      setPosEnabled(enabled);
      if (enabled) {
        api.get('/pos-transactions').then(setTransactions);
        api.get('/pos-transactions/stats').then(setPosStats);
      }
    });
  }, []);

  if (posEnabled === null) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>POS</h1>
          <p className="subtitle">Real in-store Moniepoint terminal sales, synced automatically.</p>
        </div>
      </div>

      {!posEnabled ? (
        <div className="card">
          <p className="hint" style={{ margin: 0 }}>
            POS sync isn't connected for this business yet -- reach out to ERA to set it up.
          </p>
        </div>
      ) : !posStats || !transactions ? (
        <Loading />
      ) : (
        <>
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
              label="Total POS revenue"
              value={formatMoneyShort(posStats.totalRevenue)}
              hint={`${posStats.totalTransactions.toLocaleString()} transactions`}
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
              label="Today's POS revenue"
              value={formatMoneyShort(posStats.todayRevenue)}
              hint={`${posStats.todayTransactions.toLocaleString()} transactions today`}
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
        </>
      )}
    </div>
  );
}
