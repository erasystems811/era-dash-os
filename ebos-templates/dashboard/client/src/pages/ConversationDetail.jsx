import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';
import Loading from '../components/Loading.jsx';

export default function ConversationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { staff } = useStaff();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [takingOver, setTakingOver] = useState(false);
  const [returningToBot, setReturningToBot] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const bottomRef = useRef(null);

  function load() {
    api.get(`/conversations/${id}`).then(setData);
  }
  // Chidera, 2026-09-24: "when a staff text it update live on conversation
  // but when a customer reply it doesnt automatically show up until page is
  // refreshed" -- staff's own messages only ever looked "live" because
  // send()/takeOver()/returnToBot() below each call load() themselves right
  // after posting. An inbound customer reply arrives over the WhatsApp
  // webhook straight into the database with nothing pushing it to an
  // already-open browser tab, so without a poll it just sits there until
  // someone manually reloads. Same order of magnitude as InHouse.jsx's own
  // queue poll (15s) -- a staff chat doesn't need push-grade latency.
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [id]);

  // Staff opening a thread care about the newest message, not the oldest --
  // without this the scrollable .thread div (index.css) starts at its
  // native top-of-content position, so every open meant scrolling down
  // manually. Re-fires on every message-count change too, so it also jumps
  // to the bottom after sending a reply or taking over.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [data?.messages?.length]);

  if (!data) return <Loading />;
  const { customer, messages } = data;

  async function returnToBot() {
    setReturningToBot(true);
    try {
      await api.post(`/conversations/${id}/return-to-bot`);
      load();
    } finally {
      setReturningToBot(false);
    }
  }

  async function takeOver() {
    setTakingOver(true);
    try {
      await api.post(`/conversations/${id}/take-over`);
      load();
    } finally {
      setTakingOver(false);
    }
  }

  // Chidera, 2026-09-16: "delete the chat even in back end" -- a real,
  // permanent delete (routes/api.js's DELETE /customers/:id), not an
  // archive. Own-tier-gated confirm here on top of the server's own
  // requireEditorApi, since this can't be undone once it's gone.
  async function deleteConversation() {
    if (!window.confirm('Permanently delete this entire conversation and customer record? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await api.delete(`/customers/${id}`);
      navigate('/conversations');
    } catch (err) {
      setSendError(err.message);
      setDeleting(false);
    }
  }

  async function send(e) {
    e.preventDefault();
    if (!draft.trim()) return;
    setSendError(null);
    setSending(true);
    try {
      await api.post(`/conversations/${id}/send`, { text: draft.trim() });
      setDraft('');
      load();
    } catch (err) {
      setSendError(err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {customer.name || customer.phone_number || customer.channel_id}
            <span className={`badge ${customer.channel}`}>{customer.channel}</span>
          </h1>
          <p className="subtitle">
            Handled by <strong>{customer.handled_by}</strong>
            {customer.handover_reason ? ` — ${customer.handover_reason}` : ''}
          </p>
        </div>
        <div className="button-row" style={{ gap: 8 }}>
          {canEdit(staff) && (
            <button className="danger secondary" onClick={deleteConversation} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete conversation'}
            </button>
          )}
          <Link to="/conversations" className="btn secondary" style={{ padding: '8px 14px', border: '1px solid var(--border)', borderRadius: 8 }}>
            Back
          </Link>
        </div>
      </div>

      {customer.handled_by === 'staff' && (
        <div className="card">
          <button onClick={returnToBot} disabled={returningToBot}>
            {returningToBot ? 'Returning to bot...' : 'Return to bot'}
          </button>
        </div>
      )}

      <div className="card">
        <div className="thread">
          {/* A message that failed and got auto-retried (engine/flow.js's
              retryFailedSendAsTemplate) never actually reached the customer
              -- showing it as its own bubble read as "sent twice" even
              though only the retry (delivery_status 'retried', kept below)
              really went out. Found live, 2026-09-03: Chidera saw "hello"
              twice in a row here and asked why -- the customer's phone
              never had two, only this thread did. The retry bubble's own
              "Resent" badge is the only visible trace now, not a second
              bubble with identical text. */}
          {messages
            .filter((m) => m.delivery_status !== 'failed')
            .map((m) => (
              <div key={m.id} className={`bubble ${m.sender === 'customer' ? 'customer' : m.sender === 'bot' ? 'bot' : 'staff'}`}>
                {m.body}
                <div className="meta">
                  {m.sender} &middot; {new Date(m.created_at).toLocaleString()}
                  {m.delivery_status === 'retried' && (
                    <span className="badge" style={{ marginLeft: 6 }} title="This didn't deliver the first time, so it was automatically sent again">
                      Resent
                    </span>
                  )}
                </div>
              </div>
            ))}
          {!messages.filter((m) => m.delivery_status !== 'failed').length && <div className="empty-state">No messages yet.</div>}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="card">
        {customer.handled_by === 'bot' ? (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              The bot is still handling this conversation. Take over first so it goes quiet and doesn't reply to the
              customer while you're typing.
            </p>
            <button onClick={takeOver} disabled={takingOver}>
              {takingOver ? 'Taking over...' : 'Take over from bot'}
            </button>
          </>
        ) : (
          <>
            {sendError && <div className="error-banner">{sendError}</div>}
            <form onSubmit={send} className="reply-form" style={{ display: 'flex', gap: 10 }}>
              <textarea
                rows={2}
                style={{ flex: 1 }}
                placeholder={`Type a reply to send on ${customer.channel === 'instagram' ? 'Instagram' : 'WhatsApp'}...`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={sending}
              />
              <button type="submit" disabled={sending || !draft.trim()}>
                {sending ? 'Sending...' : 'Send'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
