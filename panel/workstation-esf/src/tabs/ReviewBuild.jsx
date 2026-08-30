import React, { useRef, useState } from 'react';
import { api } from '../api.js';
import { buildProofConfig } from '../proofTypes.js';

function validate(draft) {
  const problems = [];
  if (!draft.business.name) problems.push('Business name is required (Business details tab).');
  if (!draft.owner.email) problems.push('Owner email is required (Business details tab).');
  if (!draft.staff.length) problems.push('Add at least one staff member (Staff tab).');
  if (!draft.tasks.length) problems.push('Add at least one task (Tasks & steps tab).');
  if (draft.tasks.some((t) => !t.steps.length)) problems.push('Every task needs at least one step (Tasks & steps tab).');
  return problems;
}

// Turns the tab state (arrays, raw step config fields, an "assignTo" combo
// box) into exactly the shape scripts/lib/esf-seed.mjs's buildEsfSeedSql
// expects -- same job routes/tasks.js's buildProofConfig does for a live
// PATCH, just run client-side here since nothing exists to PATCH yet.
function toSeed(draft) {
  const assignedPhone = (t) => (t.assignTo.startsWith('staff:') ? t.assignTo.slice(6) : null);
  const role = (t) => (t.assignTo.startsWith('role:') ? t.assignTo.slice(5) : null);

  return {
    business: {
      name: draft.business.name,
      timezone: draft.business.timezone,
      lat: draft.business.lat || null,
      lng: draft.business.lng || null,
      radius_m: draft.business.radius_m || null,
      owner_phone: draft.business.owner_phone || null,
    },
    owner: { email: draft.owner.email },
    staff: draft.staff,
    tasks: draft.tasks.map((t, i) => ({
      name: t.name,
      assigned_phone: assignedPhone(t),
      role: role(t),
      seq: i + 1,
      days: t.days.join(','),
      available_from: t.available_from,
      due_by: t.due_by,
      mode: t.mode,
      steps: t.steps.map((s, si) => ({
        seq: si + 1,
        instruction: s.instruction,
        proof_type: s.proof_type,
        proof_config: buildProofConfig(s.proof_type, s.config),
        on_problem: s.on_problem,
        optional: s.optional,
        requires_prev: true,
        clock_action: s.clock_action,
      })),
    })),
  };
}

export default function ReviewBuild({ draft }) {
  const [building, setBuilding] = useState(false);
  const [log, setLog] = useState('');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const pollRef = useRef(null);

  const problems = validate(draft);

  async function build() {
    setError(null);
    setResult(null);
    setLog('');
    setBuilding(true);
    try {
      const seed = toSeed(draft);
      const { jobId } = await api.post('/api/workstation-esf/build', {
        businessName: draft.businessName,
        subdomain: draft.subdomain,
        size: draft.size,
        whatsapp: draft.whatsapp,
        ...seed,
      });
      pollRef.current = setInterval(async () => {
        const job = await api.get(`/api/jobs/${jobId}`);
        setLog(job.log || '');
        if (job.status !== 'running') {
          clearInterval(pollRef.current);
          setBuilding(false);
          if (job.status === 'done') {
            const urlMatch = job.log.match(/App:\s+(\S+)/);
            const loginMatch = job.log.match(/Owner login:\s+(\S+)\s+\/\s+(\S+)/);
            setResult({
              url: urlMatch ? urlMatch[1] : null,
              email: loginMatch ? loginMatch[1] : null,
              password: loginMatch ? loginMatch[2] : null,
            });
          } else {
            setError('Build failed -- see the log below for what went wrong.');
          }
        }
      }, 2000);
    } catch (err) {
      setBuilding(false);
      setError(err.message);
    }
  }

  return (
    <div>
      <h1>Review & build</h1>
      <p className="subtitle">One click turns everything on the other tabs into a real, live, physically isolated business.</p>

      {!result && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Summary</h3>
          <p>
            <strong>{draft.business.name || '(no name yet)'}</strong>
          </p>
          <p>Owner: {draft.owner.email || '—'}</p>
          <p>
            {draft.staff.length} staff member(s), {draft.tasks.length} task(s), {draft.tasks.reduce((n, t) => n + t.steps.length, 0)} step(s) total.
          </p>
        </div>
      )}

      {!result && problems.length > 0 && (
        <div className="error-banner">
          <strong>Before you can build:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {result && (
        <div className="success-banner">
          <strong>{draft.business.name} is live.</strong>
          <p style={{ margin: '8px 0 4px' }}>
            Web address:{' '}
            <a href={result.url} target="_blank" rel="noreferrer">
              {result.url}
            </a>
          </p>
          <p style={{ margin: '4px 0' }}>
            Owner login: <code>{result.email}</code> / <code>{result.password}</code>
          </p>
          <p style={{ margin: '8px 0 0' }}>
            Shown once — save it now. WhatsApp connects from the client list back in Dash OS, once you have the Meta credentials ready.
          </p>
        </div>
      )}

      {!result && (
        <button onClick={build} disabled={building || problems.length > 0}>
          {building ? 'Building...' : 'Build this business'}
        </button>
      )}

      {(building || log) && !result && (
        <div className="card" style={{ marginTop: 20 }}>
          <h3 style={{ marginTop: 0 }}>Progress</h3>
          <div className="log-box">{log || '(starting...)'}</div>
        </div>
      )}
    </div>
  );
}
