import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useScope, scopeQuery } from '../ScopeContext.jsx';
import Loading from '../components/Loading.jsx';

// Owner/manager only (see routes/api.js's requireEditorApi on every
// /feedback/* route -- never in PIN_NAV/IN_HOUSE_NAV, same tier as Roles
// and numbers / Activity log). Chidera 2026-09-11: "the manager sees in
// dashboard averages and can see per month on another side... he can see
// individual customer feedback but the individual is for a week only...
// he can see feedback per month and cummulative."
//
// Three views, one page:
// - Three stat cards up top: cumulative (all-time) averages -- always
//   visible regardless of which tab is open below.
// - "Recent" tab: individual responses from the last 7 days only (a
//   display filter, not a delete -- the averages above and the monthly
//   table both still include everything, forever).
// - "By month" tab: one row per calendar month, so a manager can tell if
//   the experience is trending up or down over time.
//
// A star rating of 2 or below on any question is flagged red in the
// Recent list -- Chidera 2026-09-11: "let negative experiences be flagged
// red so if manager wants they can reach out."
const NEGATIVE_THRESHOLD = 2;

function stars(n) {
  if (n == null) return '--';
  return '⭐'.repeat(n) + '☆'.repeat(5 - n);
}

function isNegative(row) {
  return [row.experience_rating, row.food_rating, row.service_rating].some((r) => r != null && r <= NEGATIVE_THRESHOLD);
}

function avg(n) {
  return n == null ? '--' : Number(n).toFixed(1);
}

export default function Feedback() {
  const { scope } = useScope();
  const [channel, setChannel] = useState('all');
  const [summary, setSummary] = useState(null);
  const [recent, setRecent] = useState(null);
  const [monthly, setMonthly] = useState(null);
  const [view, setView] = useState('recent');
  // Chidera, 2026-09-16: "if a business does not have in house or dine in
  // why does feedback dashboard make room for it on toogle?" -- the
  // channel filter used to always offer "In House only" even for a
  // business with the dine-in add-on off, where no feedback could ever
  // actually be tagged dinein. Same on/off source every other dine-in-gated
  // piece of UI already reads (routes/api.js's /dinein-config).
  const [dineinEnabled, setDineinEnabled] = useState(false);
  // A silent-forever blank page used to be the only symptom of a real
  // backend bug here (found live, 2026-09-11, Chidera: "the page is empti
  // its meant to have cards") -- /feedback/recent 500'd on every load, and
  // with no .catch, `recent` just never left its initial null, so the
  // `if (!summary || !recent || !monthly) return null` guard below kept
  // rendering nothing forever with no visible error at all.
  const [error, setError] = useState(null);

  function load() {
    setError(null);
    const branchQ = scopeQuery(scope);
    const q = branchQ ? (channel === 'all' ? branchQ : `${branchQ}&channel=${channel}`) : channel === 'all' ? '' : `?channel=${channel}`;
    api.get(`/feedback/summary${q}`).then(setSummary).catch((err) => setError(err.message));
    api.get(`/feedback/recent${q}`).then(setRecent).catch((err) => setError(err.message));
    api.get(`/feedback/monthly${q}`).then(setMonthly).catch((err) => setError(err.message));
  }
  useEffect(() => {
    setSummary(null);
    setRecent(null);
    setMonthly(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, scope]);
  useEffect(() => {
    api.get('/dinein-config').then((c) => setDineinEnabled(Boolean(c?.enabled)));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!summary || !recent || !monthly) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Feedback</h1>
          <p className="subtitle">How was your experience? How was the food? How was the service? -- 1 to 5 stars, asked right after every order is done.</p>
        </div>
        <select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="all">All orders</option>
          {dineinEnabled && <option value="online">Online only</option>}
          {dineinEnabled && <option value="dinein">In House only</option>}
        </select>
      </div>

      <div className="stat-row">
        <div className="stat-card">
          <div className="value">{avg(summary.experience)}</div>
          <div className="label">Experience (avg)</div>
        </div>
        <div className="stat-card">
          <div className="value">{avg(summary.food)}</div>
          <div className="label">Food (avg)</div>
        </div>
        <div className="stat-card">
          <div className="value">{avg(summary.service)}</div>
          <div className="label">Service (avg)</div>
        </div>
        <div className="stat-card">
          <div className="value">{summary.total}</div>
          <div className="label">Cumulative responses</div>
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
                <th>When</th>
                <th>Channel</th>
                <th>Order</th>
                <th>Customer</th>
                <th>Experience</th>
                <th>Food</th>
                <th>Service</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((f) => (
                <tr key={f.id} style={isNegative(f) ? { background: 'rgba(197, 69, 43, 0.08)' } : undefined}>
                  <td>{new Date(f.created_at).toLocaleString()}</td>
                  <td>
                    <span className={`badge ${f.channel === 'dinein' ? 'new' : 'active'}`}>{f.channel === 'dinein' ? 'in house' : 'online'}</span>
                  </td>
                  <td>
                    <Link to={`/orders/${f.order_id}`}>{f.order_reference}</Link>
                  </td>
                  <td>{f.customer_name || f.customer_phone}</td>
                  <td style={f.experience_rating != null && f.experience_rating <= NEGATIVE_THRESHOLD ? { color: 'var(--hot, #C5452B)', fontWeight: 600 } : undefined}>
                    {stars(f.experience_rating)}
                  </td>
                  <td style={f.food_rating != null && f.food_rating <= NEGATIVE_THRESHOLD ? { color: 'var(--hot, #C5452B)', fontWeight: 600 } : undefined}>
                    {stars(f.food_rating)}
                  </td>
                  <td style={f.service_rating != null && f.service_rating <= NEGATIVE_THRESHOLD ? { color: 'var(--hot, #C5452B)', fontWeight: 600 } : undefined}>
                    {stars(f.service_rating)}
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{f.comment || '--'}</td>
                </tr>
              ))}
              {!recent.length && (
                <tr>
                  <td colSpan={8} className="empty-state">
                    No feedback in the last 7 days.
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
                <th>Experience (avg)</th>
                <th>Food (avg)</th>
                <th>Service (avg)</th>
                <th>Responses</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m.month}>
                  <td>{m.month}</td>
                  <td>{avg(m.experience)}</td>
                  <td>{avg(m.food)}</td>
                  <td>{avg(m.service)}</td>
                  <td>{m.total}</td>
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
