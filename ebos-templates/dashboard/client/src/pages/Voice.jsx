import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStaff, canEdit } from '../StaffContext.jsx';
import Loading from '../components/Loading.jsx';

function VoiceSettings({ config, setConfig }) {
  const { staff } = useStaff();
  const editable = canEdit(staff);
  const [form, setForm] = useState({
    transfer_numbers: (config.transfer_numbers || []).join(', '),
    greeting_override: config.greeting_override || '',
    max_minutes_per_month: config.max_minutes_per_month || '',
    recording_enabled: Boolean(config.recording_enabled),
    recording_retention_days: config.recording_retention_days || 30,
    hours_open: config.operating_hours?.open || '',
    hours_close: config.operating_hours?.close || '',
  });
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  async function save(e) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const updated = await api.post('/voice-config/settings', {
        transfer_numbers: form.transfer_numbers.split(',').map((s) => s.trim()).filter(Boolean),
        greeting_override: form.greeting_override || null,
        max_minutes_per_month: form.max_minutes_per_month ? Number(form.max_minutes_per_month) : null,
        recording_enabled: form.recording_enabled,
        recording_retention_days: Number(form.recording_retention_days) || 30,
        operating_hours: form.hours_open && form.hours_close ? { open: form.hours_open, close: form.hours_close } : null,
      });
      setConfig(updated);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      {!config.enabled && (
        <div className="card">
          <p className="hint" style={{ marginBottom: 0 }}>
            Voice ordering isn't switched on for this business yet -- reach out to ERA to turn it on. You can still fill in the
            settings below ahead of time.
          </p>
        </div>
      )}

      <form className="card" onSubmit={save} style={{ maxWidth: 480 }}>
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="hint" style={{ color: 'var(--accent)' }}>Saved.</div>}

        <label>
          Transfer numbers
          <input
            value={form.transfer_numbers}
            onChange={(e) => setForm({ ...form, transfer_numbers: e.target.value })}
            placeholder="e.g. 2348010000000, 2348020000000"
            disabled={!editable}
          />
        </label>
        <p className="hint">
          Staff phones to try, in order, when a call needs a real person. Leave empty and callers who need a person get a callback
          instead -- that's a fully working fallback, not a broken state.
        </p>

        <label>Opening hours</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <input type="time" value={form.hours_open} onChange={(e) => setForm({ ...form, hours_open: e.target.value })} disabled={!editable} />
          <span>to</span>
          <input type="time" value={form.hours_close} onChange={(e) => setForm({ ...form, hours_close: e.target.value })} disabled={!editable} />
        </div>
        <p className="hint">
          Same hours every day. Leave both blank and calls are answered any time. Outside these hours, callers are told when you
          open and get a callback instead of an order the kitchen can't cook yet.
        </p>

        <label>
          Greeting (optional)
          <input
            value={form.greeting_override}
            onChange={(e) => setForm({ ...form, greeting_override: e.target.value })}
            placeholder="Leave blank to use the default greeting"
            disabled={!editable}
          />
        </label>

        <label>
          Monthly minutes alert
          <input
            type="number"
            min="0"
            value={form.max_minutes_per_month}
            onChange={(e) => setForm({ ...form, max_minutes_per_month: e.target.value })}
            placeholder="e.g. 500"
            disabled={!editable}
          />
        </label>
        <p className="hint">Voice calls cost more than WhatsApp messages -- you get alerted if a month goes over this.</p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={form.recording_enabled}
            onChange={(e) => setForm({ ...form, recording_enabled: e.target.checked })}
            disabled={!editable}
          />
          Record calls
        </label>
        <p className="hint">
          Off by default. If turned on, callers are told at the start of the call that it may be recorded.
        </p>

        {form.recording_enabled && (
          <label>
            Keep recordings for (days)
            <input
              type="number"
              min="1"
              value={form.recording_retention_days}
              onChange={(e) => setForm({ ...form, recording_retention_days: e.target.value })}
              disabled={!editable}
            />
          </label>
        )}

        {editable && <button type="submit">Save</button>}
      </form>
    </div>
  );
}

function timeSince(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const OUTCOME_LABEL = {
  order_placed: 'Order placed',
  enquiry_answered: 'Enquiry answered',
  handover_transferred: 'Transferred',
  handover_callback: 'Callback',
  abandoned: 'Abandoned',
  failed: 'Failed',
};

function CallDetail({ callId, onClose }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    setData(null);
    api.get(`/voice/calls/${callId}`).then(setData);
  }, [callId]);

  if (!data) return <Loading />;
  const { call, turns } = data;

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <strong>{call.customer_name || call.caller_number}</strong>
          <div className="hint">
            {call.caller_number} &middot; {new Date(call.started_at).toLocaleString()}
            {call.order_reference && (
              <>
                {' '}
                &middot; Order {call.order_reference}
              </>
            )}
          </div>
        </div>
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {turns.map((t) => (
          <div key={t.seq} style={{ textAlign: t.speaker === 'caller' ? 'left' : 'right' }}>
            <div
              style={{
                display: 'inline-block',
                maxWidth: '70%',
                padding: '6px 10px',
                borderRadius: 8,
                background: t.speaker === 'caller' ? 'var(--surface-alt)' : 'var(--accent-soft)',
              }}
            >
              {t.transcript}
              {t.confidence != null && (
                <span className="hint" style={{ display: 'block', fontSize: 11 }}>
                  confidence {Math.round(Number(t.confidence) * 100)}%
                </span>
              )}
            </div>
          </div>
        ))}
        {!turns.length && <p className="hint">No turns recorded for this call.</p>}
      </div>
    </div>
  );
}

function Calls() {
  const [calls, setCalls] = useState(null);
  const [selected, setSelected] = useState(null);

  function load() {
    api.get('/voice/calls').then(setCalls);
  }
  useEffect(load, []);

  if (!calls) return <Loading />;

  return (
    <div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Caller</th>
              <th>When</th>
              <th>Outcome</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => setSelected(c.id)}>
                <td>{c.customer_name || c.caller_number}</td>
                <td>{timeSince(c.started_at)}</td>
                <td>{c.outcome ? OUTCOME_LABEL[c.outcome] || c.outcome : <span className="hint">In progress</span>}</td>
                <td>{c.duration_seconds ? `${Math.round(c.duration_seconds / 60)}m` : '-'}</td>
              </tr>
            ))}
            {!calls.length && (
              <tr>
                <td colSpan={4} className="empty-state">
                  No calls yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {selected && <CallDetail callId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Usage() {
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    api.get('/voice/usage').then(setUsage);
  }, []);

  if (!usage) return <Loading />;

  const trend = usage.minutesThisMonth - usage.minutesLastMonth;

  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <div className="card" style={{ minWidth: 200 }}>
        <div className="label" style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>
          CALLS THIS MONTH
        </div>
        <div style={{ fontSize: 24, fontWeight: 800 }}>{usage.callsThisMonth}</div>
      </div>
      <div className="card" style={{ minWidth: 200 }}>
        <div className="label" style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>
          MINUTES THIS MONTH
        </div>
        <div style={{ fontSize: 24, fontWeight: 800 }}>{usage.minutesThisMonth}</div>
        <div className="hint">
          {trend === 0 ? 'Same as last month' : trend > 0 ? `Up ${trend}m from last month` : `Down ${Math.abs(trend)}m from last month`}
        </div>
      </div>
      <div className="card" style={{ minWidth: 200 }}>
        <div className="label" style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>
          ESTIMATED COST
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          Not available yet -- this fills in once a real telephony/voice provider is connected.
        </p>
      </div>
    </div>
  );
}

// Stages 1-5 of the voice ordering add-on. The toggle itself is
// ERA-admin-only (routes/api.js's POST /voice-config), everything else on
// this page is the restaurant's own to see/set. No real phone line is
// wired up yet (Stage 6+ -- a telephony provider, real speech recognition,
// and the actual cloned voice all still need Chidera's own decisions/
// inputs), so "Calls" and "Usage" are honestly empty until then, not
// placeholders pretending otherwise.
export default function Voice() {
  const [tab, setTab] = useState('settings');
  const [config, setConfig] = useState(null);

  useEffect(() => {
    api.get('/voice-config').then(setConfig);
  }, []);

  if (!config) return <Loading />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Voice</h1>
          <p className="subtitle">Callers to your existing number get answered automatically and can place an order by talking.</p>
        </div>
      </div>
      <div className="card" style={{ display: 'flex', gap: 8, padding: 6, width: 'fit-content' }}>
        <button className={tab === 'settings' ? '' : 'secondary'} onClick={() => setTab('settings')}>
          Settings
        </button>
        <button className={tab === 'calls' ? '' : 'secondary'} onClick={() => setTab('calls')}>
          Calls
        </button>
        <button className={tab === 'usage' ? '' : 'secondary'} onClick={() => setTab('usage')}>
          Usage
        </button>
      </div>
      {tab === 'settings' && <VoiceSettings config={config} setConfig={setConfig} />}
      {tab === 'calls' && <Calls />}
      {tab === 'usage' && <Usage />}
    </div>
  );
}
