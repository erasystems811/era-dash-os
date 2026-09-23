// Chidera, 2026-09-23: "im thinking handover be limited to 2 numbers max
// so no business can set more than 2 handover number." handoverRecipients
// (flow.js) has no branch scoping at all -- every staff member with
// handover_alerts = true, business-wide, gets every handover alert -- so
// this cap on routes/api.js's POST /staff/:id/handover-alerts is
// business-wide too, checked at the moment of turning it ON for someone
// who doesn't already have it.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3938';
process.env.SESSION_SECRET = 'testsecret';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3938';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // Same real-session pattern sandbox/test-served-item-diff.mjs already
  // uses -- POST /staff/:id/handover-alerts is requireEditorApi-gated,
  // not a bypass.
  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@samplerestaurant.test', password: 'testpass123' }),
  });
  const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert(loginRes.status === 200 && !!cookie, 'staff login succeeded, got a real session cookie');
  const authed = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), 'Content-Type': 'application/json', cookie } });

  async function makeStaff(name, phone) {
    const { rows } = await pool.query(
      `insert into staff (name, phone_number, role) values ($1, $2, 'manager') returning id`,
      [name, phone]
    );
    return rows[0].id;
  }

  const s1 = await makeStaff('Staff One', '2348011110001');
  const s2 = await makeStaff('Staff Two', '2348011110002');
  const s3 = await makeStaff('Staff Three', '2348011110003');

  const r1 = await authed(`${BASE}/api/staff/${s1}/handover-alerts`, { method: 'POST', body: JSON.stringify({ handover_alerts: true }) });
  assert(r1.status === 200, 'first staff member turning it on succeeds');

  const r2 = await authed(`${BASE}/api/staff/${s2}/handover-alerts`, { method: 'POST', body: JSON.stringify({ handover_alerts: true }) });
  assert(r2.status === 200, 'second staff member turning it on also succeeds -- the cap is 2, not 1');

  const r3 = await authed(`${BASE}/api/staff/${s3}/handover-alerts`, { method: 'POST', body: JSON.stringify({ handover_alerts: true }) });
  assert(r3.status === 400, 'a THIRD staff member turning it on is rejected -- the cap is enforced');
  const r3body = await r3.json();
  assert(/only 2 staff/i.test(r3body.error || ''), 'the error explains the actual cap, not a generic failure');

  const { rows: countAfter } = await pool.query(`select count(*)::int as n from staff where handover_alerts = true`);
  assert(countAfter[0].n === 2, 'still exactly 2 -- the rejected attempt never touched the database');

  // Redundant re-save of an already-on staff member must never be blocked
  // by its own count (it's not adding a NEW recipient).
  const r1again = await authed(`${BASE}/api/staff/${s1}/handover-alerts`, { method: 'POST', body: JSON.stringify({ handover_alerts: true }) });
  assert(r1again.status === 200, 're-saving an already-on staff member is never blocked by the cap, even while at 2');

  // Turning one off then a THIRD one on is fine -- the cap is a live count, not a lifetime limit.
  const rOff = await authed(`${BASE}/api/staff/${s1}/handover-alerts`, { method: 'POST', body: JSON.stringify({ handover_alerts: false }) });
  assert(rOff.status === 200, 'turning one off is always allowed regardless of the count');
  const r3retry = await authed(`${BASE}/api/staff/${s3}/handover-alerts`, { method: 'POST', body: JSON.stringify({ handover_alerts: true }) });
  assert(r3retry.status === 200, 'once one slot frees up, a new staff member can take it -- a live count, not a one-time lockout');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
