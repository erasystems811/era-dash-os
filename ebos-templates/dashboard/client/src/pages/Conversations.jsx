import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';

// Human-readable time-since, for how long a handover has been waiting --
// staff scanning the attention queue care about "how stale is this", not
// an exact timestamp.
function timeSince(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function AllConversations() {
  const [conversations, setConversations] = useState(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);

  useEffect(() => {
    api.get('/conversations').then(setConversations);
  }, []);

  // The default list only ever shows the 200 most recently active customers
  // (see routes/api.js) -- this is how staff reach anyone who's gone quiet
  // long enough to have dropped out of that window. Debounced so typing
  // doesn't fire a request per keystroke; clearing the box drops back to the
  // normal cached list instead of an empty search result.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(() => {
      api.get(`/conversations/search?q=${encodeURIComponent(q)}`).then(setSearchResults);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  if (!conversations) return null;

  const rows = searchResults ?? conversations;

  return (
    <div>
      <div className="card">
        <input
          type="text"
          placeholder="Search by phone number or name..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', marginBottom: 14, border: '1px solid var(--border)', borderRadius: 8 }}
        />
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Channel</th>
              <th>Handled by</th>
              <th>Last message</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => (window.location.href = `/conversations/${c.id}`)}>
                <td>
                  <Link to={`/conversations/${c.id}`}>{c.name || c.phone_number || c.channel_id}</Link>
                </td>
                <td>
                  <span className={`badge ${c.channel}`}>{c.channel}</span>
                </td>
                <td>
                  <span className={`badge ${c.handled_by === 'staff' ? 'new' : 'active'}`}>{c.handled_by}</span>
                </td>
                <td style={{ color: 'var(--text-muted)' }}>{(c.last_message || '').slice(0, 70)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={4} className="empty-state">
                  {searchResults ? 'No matching customers.' : 'No conversations yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Two different SHAPES of "needs a person" in one list (spec C1) --
// a customer handover (routes/api.js's own signal) and an unaccepted
// delivery offer (engine/delivery-dispatch.js's escalation sweep), tagged
// by `kind` rather than forced to look like the same thing. A delivery row
// routes to the order, never /conversations/:id -- there is no
// conversation to open for an offer nobody accepted.
function NeedsAttention() {
  const { staff } = useStaff();
  const editable = canEdit(staff);
  const [rows, setRows] = useState(null);

  function load() {
    api.get('/conversations/needs-attention').then(setRows);
  }
  useEffect(load, []);

  async function cancelOffer(id, e) {
    e.stopPropagation();
    await api.post(`/delivery/offers/${id}/cancel`);
    load();
  }

  async function resolveCallback(callbackTaskId, e) {
    e.stopPropagation();
    await api.post(`/voice/callbacks/${callbackTaskId}/resolve`);
    load();
  }

  if (!rows) return null;

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Who</th>
            <th>Channel</th>
            <th>Reason</th>
            <th>Waiting</th>
            {editable && <th></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isDelivery = r.kind === 'delivery';
            const href = isDelivery ? `/orders/${r.order_id}` : `/conversations/${r.id}`;
            return (
              <tr key={`${r.kind}-${r.id}`} className="clickable" onClick={() => (window.location.href = href)}>
                <td>
                  <Link to={href}>{isDelivery ? `Order ${r.order_reference} (${r.zone_name})` : r.name || r.phone_number || r.channel_id}</Link>
                </td>
                <td>{isDelivery ? <span className="badge new">delivery</span> : <span className={`badge ${r.channel}`}>{r.channel}</span>}</td>
                <td style={{ color: 'var(--text-muted)' }}>{r.reason || '(taken over from the app)'}</td>
                <td>
                  <span className="badge new">{timeSince(r.at)}</span>
                </td>
                {editable && (
                  <td>
                    {isDelivery && (
                      <button className="secondary" onClick={(e) => cancelOffer(r.id, e)}>
                        Cancel offer
                      </button>
                    )}
                    {r.kind === 'callback' && (
                      <button className="secondary" onClick={(e) => resolveCallback(r.callback_task_id, e)}>
                        Mark resolved
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
          {!rows.length && (
            <tr>
              <td colSpan={editable ? 5 : 4} className="empty-state">Nothing waiting on staff right now.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Reaching out first, not replying -- for a new lead or a customer who's
// gone quiet, where there's no existing thread to type into. Goes out as
// the approved "business_outreach" template server-side (see
// engine/flow.js's sendOutreachMessage) so it works even outside the normal
// 24h reply window; this form just collects the number and the message.
function MessageCustomer() {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);

  async function send(e) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      const res = await api.post('/conversations/outreach', { phone_number: phone, message });
      window.location.href = `/conversations/${res.conversation_id}`;
    } catch (err) {
      setError(err.message);
      setSending(false);
    }
  }

  if (!open) {
    return (
      <div className="card" style={{ width: 'fit-content' }}>
        <button onClick={() => setOpen(true)}>Message a customer</button>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Message a customer</h3>
      <p className="subtitle">Reach out first -- works even if they've never messaged this number before.</p>
      {error && <div className="error-banner">{error}</div>}
      <form onSubmit={send}>
        <div className="form-row">
          <div className="field">
            <label>Their WhatsApp number</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="2348..." required />
          </div>
        </div>
        <div className="field">
          <label>Message</label>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} required />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={sending}>
            {sending ? 'Sending...' : 'Send'}
          </button>
          <button type="button" className="secondary" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

export default function Conversations() {
  const [tab, setTab] = useState('all');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Conversations</h1>
          <p className="subtitle">Every customer thread, bot and staff turns, WhatsApp style.</p>
        </div>
      </div>
      <MessageCustomer />
      <div className="card" style={{ display: 'flex', gap: 8, padding: 6, width: 'fit-content' }}>
        <button className={tab === 'all' ? '' : 'secondary'} onClick={() => setTab('all')}>
          All conversations
        </button>
        <button className={tab === 'attention' ? '' : 'secondary'} onClick={() => setTab('attention')}>
          Needs attention
        </button>
      </div>
      {tab === 'all' ? <AllConversations /> : <NeedsAttention />}
    </div>
  );
}
