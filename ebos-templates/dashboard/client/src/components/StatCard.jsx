import React from 'react';

// Chidera, 2026-09-16: "let feedback tab feel like the customer tab" --
// extracted out of Customers.jsx (now Crm.jsx) so Feedback's own stat row
// can use the exact same card, not a second, plainer version of the same
// idea.
export function Delta({ pct }) {
  if (pct === null || pct === undefined) return <span className="hint">vs last month</span>;
  const up = pct >= 0;
  return (
    <span style={{ color: up ? 'var(--success)' : 'var(--danger)', fontSize: 12.5, fontWeight: 600 }}>
      {up ? '↑' : '↓'} {Math.abs(pct)}% <span className="hint" style={{ fontWeight: 400 }}>vs last month</span>
    </span>
  );
}

export default function StatCard({ iconBg, iconColor, icon, label, value, delta }) {
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
