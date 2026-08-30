import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { PROOF_TYPES, PROOF_TYPE_LABELS, PROOF_CONFIG_FIELDS } from '../proofTypes.js';

// Per-person proof overrides for one step (build schema v2.0 section 3.7:
// "proof is a dial, not an accusation" -- a new hire on photos for a month,
// relaxed to a tap after a clean record, back to photos if a variance
// shows up). Kept as its own component, not inlined into TaskDetail.jsx --
// it manages its own open/closed + list state and would otherwise bloat an
// already-large page.

const EMPTY = { staff_id: '', proof_type: 'tap', config: {}, reason: '', expires_on: '' };

export default function StepOverrides({ taskId, stepId, staffList }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);

  function load() {
    api.get(`/tasks/${taskId}/steps/${stepId}/overrides`).then(setList);
  }
  useEffect(() => {
    if (open) load();
  }, [open]);

  function setConfigField(name, value) {
    setForm((f) => ({ ...f, config: { ...f.config, [name]: value } }));
  }

  async function add(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/tasks/${taskId}/steps/${stepId}/overrides`, form);
      setForm(EMPTY);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(staffId) {
    await api.delete(`/tasks/${taskId}/steps/${stepId}/overrides/${staffId}`);
    load();
  }

  const fields = PROOF_CONFIG_FIELDS[form.proof_type] || [];

  return (
    <div style={{ marginTop: 8 }}>
      <button className="secondary" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide overrides' : 'Overrides'}
      </button>

      {open && (
        <div style={{ marginTop: 10, border: '1px dashed var(--border)', borderRadius: 'var(--radius)', padding: 12 }}>
          {list === null ? null : list.length === 0 ? (
            <p className="hint" style={{ margin: '0 0 10px' }}>
              No per-person overrides on this step -- everyone uses the step's own proof type.
            </p>
          ) : (
            <table style={{ marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>Staff</th>
                  <th>Uses instead</th>
                  <th>Reason</th>
                  <th>Expires</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((o) => (
                  <tr key={o.staff_id}>
                    <td>{o.staff_name}</td>
                    <td>{PROOF_TYPE_LABELS[o.proof_type] || o.proof_type}</td>
                    <td>{o.reason}</td>
                    <td>{o.expires_on || 'Never'}</td>
                    <td>
                      <button className="danger" onClick={() => remove(o.staff_id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <strong style={{ fontSize: 13 }}>Add an override</strong>
          {error && <div className="error-banner">{error}</div>}
          <form onSubmit={add} style={{ marginTop: 8 }}>
            <div className="form-row">
              <div className="field">
                <label>Staff member</label>
                <select value={form.staff_id} onChange={(e) => setForm({ ...form, staff_id: e.target.value })} required>
                  <option value="">Choose...</option>
                  {staffList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Uses this proof instead</label>
                <select value={form.proof_type} onChange={(e) => setForm({ ...form, proof_type: e.target.value, config: {} })}>
                  {PROOF_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {PROOF_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {fields.length > 0 && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 10, marginBottom: 12 }}>
                {fields.map((f) => (
                  <div className="field" key={f.name}>
                    <label>{f.label}</label>
                    {f.type === 'textarea' ? (
                      <textarea rows={2} value={form.config[f.name] || ''} onChange={(e) => setConfigField(f.name, e.target.value)} />
                    ) : f.type === 'select' ? (
                      <select value={form.config[f.name] || f.options[0]} onChange={(e) => setConfigField(f.name, e.target.value)}>
                        {f.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input type={f.type} value={form.config[f.name] ?? f.default ?? ''} onChange={(e) => setConfigField(f.name, e.target.value)} />
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="field">
              <label>Reason -- shown to her, never a silent rule</label>
              <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder='e.g. "New this week -- photos until she settles in"' required />
            </div>
            <div className="field" style={{ maxWidth: 200 }}>
              <label>Expires (blank = permanent)</label>
              <input type="date" value={form.expires_on} onChange={(e) => setForm({ ...form, expires_on: e.target.value })} />
            </div>
            <button type="submit">Add override</button>
          </form>
        </div>
      )}
    </div>
  );
}
