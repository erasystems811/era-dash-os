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

// Same stage vocabulary as orderStages.js's kanban board, plus 'new' -- the
// one stage that board deliberately never renders a column for (a draft
// order still being built through chat), which is exactly the case a
// needs-attention row with no order yet, or an order that hasn't moved past
// its own default, falls into.
const STAGE_LABELS = {
  new: 'New',
  confirmation: 'Confirmation',
  preparation: 'Preparation',
  ready: 'Ready',
  delivery: 'Delivery',
  in_transit: 'In transit',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

// A search that matches nothing, where the query itself looks like a phone
// number, means "this person has never messaged us" -- not a dead end
// anymore. Digits, +, spaces and dashes only (a name search never satisfies
// this), and at least 7 digits so "080" while someone's still typing
// doesn't show it prematurely.
function looksLikePhoneNumber(q) {
  return /^[+\d][\d\s-]{6,}$/.test(q.trim());
}

function AllConversations() {
  const [conversations, setConversations] = useState(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api.get('/conversations').then(setConversations);
  }, []);

  async function startConversation() {
    setStarting(true);
    try {
      const res = await api.post('/conversations/start', { phone_number: query.trim() });
      window.location.href = `/conversations/${res.conversation_id}`;
    } catch {
      setStarting(false);
    }
  }

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
                  {searchResults && looksLikePhoneNumber(query) ? (
                    <button onClick={startConversation} disabled={starting}>
                      {starting ? 'Starting...' : `Start a conversation with ${query.trim()}`}
                    </button>
                  ) : searchResults ? (
                    'No matching customers.'
                  ) : (
                    'No conversations yet.'
                  )}
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

  async function resolveWaiterCall(id, e) {
    e.stopPropagation();
    await api.post(`/dinein/waiter-calls/${id}/resolve`);
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
            <th>Stage</th>
            <th>Reason</th>
            <th>Waiting</th>
            {editable && <th></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isDelivery = r.kind === 'delivery';
            const isWaiterCall = r.kind === 'waiter_call';
            // A waiter call has no customer conversation to open at all --
            // just a table that needs a person, so this row isn't a link
            // anywhere, unlike every other kind here.
            const href = isDelivery ? `/orders/${r.order_id}` : isWaiterCall ? null : `/conversations/${r.id}`;
            return (
              <tr key={`${r.kind}-${r.id}`} className={href ? 'clickable' : ''} onClick={href ? () => (window.location.href = href) : undefined}>
                <td>
                  {href ? (
                    <Link to={href}>{isDelivery ? `Order ${r.order_reference} (${r.zone_name})` : r.name || r.phone_number || r.channel_id}</Link>
                  ) : (
                    r.name
                  )}
                </td>
                <td>
                  {isDelivery ? (
                    <span className="badge new">delivery</span>
                  ) : isWaiterCall ? (
                    <span className="badge new">dine-in</span>
                  ) : (
                    <span className={`badge ${r.channel}`}>{r.channel}</span>
                  )}
                </td>
                <td>{r.stage && <span className="badge active">{STAGE_LABELS[r.stage] || r.stage}</span>}</td>
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
                    {isWaiterCall && (
                      <button className="secondary" onClick={(e) => resolveWaiterCall(r.id, e)}>
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
              <td colSpan={editable ? 6 : 5} className="empty-state">Nothing waiting on staff right now.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Everyone the bot is currently answering on its own -- handled_by='bot',
// nobody's stepped in. Filtered client-side out of the same /conversations
// list AllConversations already fetches (it already returns handled_by on
// every row), rather than a second endpoint for what's really just one
// column's value.
function ActiveConversations() {
  const [conversations, setConversations] = useState(null);

  useEffect(() => {
    api.get('/conversations').then(setConversations);
  }, []);

  if (!conversations) return null;
  // A completed order isn't ongoing work any more -- Chidera's call,
  // 2026-09-03: "if an order is completed it goes to all conversations
  // back". Doesn't touch AllConversations at all, so it's still there,
  // just not cluttering the tab meant for "still being worked on".
  const rows = conversations.filter((c) => c.handled_by === 'bot' && c.stage !== 'completed');

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Customer</th>
            <th>Channel</th>
            <th>Stage</th>
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
              <td>{c.stage && <span className="badge active">{STAGE_LABELS[c.stage] || c.stage}</span>}</td>
              <td style={{ color: 'var(--text-muted)' }}>{(c.last_message || '').slice(0, 70)}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={4} className="empty-state">No conversation the bot is currently handling.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function Conversations() {
  const [tab, setTab] = useState('attention');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Conversations</h1>
          <p className="subtitle">Every customer thread, bot and staff turns, WhatsApp style.</p>
        </div>
      </div>
      <div className="card" style={{ display: 'flex', gap: 8, padding: 6, width: 'fit-content' }}>
        <button className={tab === 'attention' ? '' : 'secondary'} onClick={() => setTab('attention')}>
          Needs attention
        </button>
        <button className={tab === 'active' ? '' : 'secondary'} onClick={() => setTab('active')}>
          Active
        </button>
        <button className={tab === 'all' ? '' : 'secondary'} onClick={() => setTab('all')}>
          All conversations
        </button>
      </div>
      {tab === 'attention' && <NeedsAttention />}
      {tab === 'active' && <ActiveConversations />}
      {tab === 'all' && <AllConversations />}
    </div>
  );
}
