import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

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

function NeedsAttention() {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    api.get('/conversations/needs-attention').then(setRows);
  }, []);

  if (!rows) return null;

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Customer</th>
            <th>Channel</th>
            <th>Reason</th>
            <th>Waiting</th>
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
              <td style={{ color: 'var(--text-muted)' }}>{c.handover_reason || '(taken over from the app)'}</td>
              <td>
                <span className="badge new">{timeSince(c.handover_at)}</span>
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={4} className="empty-state">Nothing waiting on staff right now.</td>
            </tr>
          )}
        </tbody>
      </table>
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
