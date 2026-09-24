import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useScope, scopeQuery } from '../ScopeContext.jsx';
import Loading from '../components/Loading.jsx';

// Human labels for every action lib/auth.js's logActivity call sites can
// record -- see routes/api.js for exactly where each one fires. Falls back
// to the raw action string for anything not listed, so a future action
// added server-side never renders as blank.
const ACTION_LABELS = {
  order_status_changed: 'Changed an order status',
  order_notified_ready: 'Marked an order ready',
  order_payment_confirmed: 'Confirmed a payment',
  // Chidera, 2026-09-24: "where is the released order reason stored?" --
  // routes/api.js's /orders/:id/release already logged it (logActivity's
  // detail.reason), but this page never rendered detail at all -- stored,
  // just nowhere a person could actually see it. Fixed by entityLink's own
  // new reasonNote below, not just this label.
  order_released: 'Released an order',
  order_rider_rung: 'Rang a rider',
  message_sent: 'Sent a message',
  conversation_taken_over: 'Took over a conversation from the bot',
  conversation_returned_to_bot: 'Handed a conversation back to the bot',
  staff_pin_created: 'Added a staff PIN account',
  staff_pin_reset: "Reset a staff member's PIN",
};

function entityLink(entry) {
  if (entry.entity_type === 'order') return <Link to={`/orders/${entry.entity_id}`}>Order</Link>;
  if (entry.entity_type === 'conversation') return <Link to={`/conversations/${entry.entity_id}`}>Conversation</Link>;
  if (entry.entity_type === 'staff' && entry.detail?.name) return entry.detail.name;
  return null;
}

// The one piece of detail worth a staff member actually reading in this
// list at a glance -- a release/override reason is the whole point of
// requiring one in the first place (accountability), so it has to be
// visible somewhere, not just sitting unread in the raw detail JSON.
function reasonNote(entry) {
  return entry.detail?.reason ? <span className="hint"> -- "{entry.detail.reason}"</span> : null;
}

export default function ActivityLog() {
  const { scope } = useScope();
  const [entries, setEntries] = useState(null);

  useEffect(() => {
    setEntries(null);
    api.get(`/activity-log${scopeQuery(scope)}`).then(setEntries);
  }, [scope]);

  if (!entries) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Activity log</h1>
          <p className="subtitle">Every major action staff have taken -- who did what, and when.</p>
        </div>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Staff</th>
              <th>Action</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.created_at).toLocaleString()}</td>
                <td>{e.staff_name || '—'}</td>
                <td>
                  {ACTION_LABELS[e.action] || e.action}
                  {reasonNote(e)}
                </td>
                <td>{entityLink(e)}</td>
              </tr>
            ))}
            {!entries.length && (
              <tr>
                <td colSpan={4} className="empty-state">
                  Nothing logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
