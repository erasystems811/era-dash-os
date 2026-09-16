import React, { useRef, useState } from 'react';
import { api } from '../api.js';

function validate(draft) {
  const problems = [];
  if (!draft.business.name) problems.push('Business name is required (Business details tab).');
  if (!draft.owner.name) problems.push('Owner name is required (Business details tab).');
  if (!draft.owner.email) problems.push('Owner email is required (Business details tab).');
  if (!draft.catalogue.length) problems.push('Add at least one catalogue item (Catalogue tab).');
  if (!draft.botFields.length) problems.push('Add at least one question for the bot to ask (Train the bot tab).');
  // Mirrors branch.name/branch.address's own "not null" constraints in
  // schema.sql -- catching a blank one here means a bad build fails fast
  // in the UI, not with a much less legible raw Postgres error deep
  // inside create-client.mjs's SQL apply step.
  (draft.branches || []).forEach((b, i) => {
    if (!b.name) problems.push(`Branch ${i + 1} needs a name (Branches tab).`);
    if (!b.address) problems.push(`Branch ${i + 1} needs an address (Branches tab).`);
  });
  return problems;
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
      const { jobId } = await api.post('/api/workstation/build', draft);
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
      <p className="subtitle">One click turns everything on the other tabs into a real, live business.</p>

      {!result && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Summary</h3>
          <p>
            <strong>{draft.business.name || '(no name yet)'}</strong> &mdash; {draft.business.type}
          </p>
          <p>
            Owner: {draft.owner.name || '—'} ({draft.owner.email || '—'})
          </p>
          <p>
            {draft.catalogue.length} catalogue item(s), {draft.botFields.length} question(s) trained, {draft.knowledgeBase?.length || 0}{' '}
            knowledge base entries.
          </p>
          <p>
            {draft.branches?.length
              ? `${draft.branches.length} branch(es), primary: ${draft.branches[0].name}.`
              : 'No extra branches -- single-location business.'}
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
            Shown once — save it now. WhatsApp and payment connect from the client list back in Dash OS, once you have those accounts
            ready.
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
