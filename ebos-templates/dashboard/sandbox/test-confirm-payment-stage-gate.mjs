// Chidera, 2026-09-25: "remove that confirm payment received button from
// every other stage, it should only be in first confirmation stage, let
// staff not be able to manually confirm payment at other stages except
// confirmation stage." Verifies POST /orders/:id/confirm-payment
// (routes/api.js) enforces this server-side, not just a hidden button --
// succeeds for an order genuinely at the confirmation stage, refuses one
// at any other stage and leaves payment_status untouched.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3947';
process.env.SESSION_SECRET = 'testsecret';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3947';

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

  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@samplerestaurant.test', password: 'testpass123' }),
  });
  const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert(loginRes.status === 200 && !!cookie, 'staff login succeeded, got a real session cookie');
  const authed = (url) => fetch(url, { method: 'POST', headers: { cookie } });

  const { rows: custRows } = await pool.query(`insert into customers (phone_number) values ('2348077770008') returning id`);
  const customerId = custRows[0].id;

  // === 1. At the confirmation stage: allowed ===
  const { rows: confRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state)
     values ($1, 'REF-GATE-1', 'pickup', 1000, 'confirmation', 'pending', 'confirm_payment') returning id`,
    [customerId]
  );
  const okRes = await authed(`${BASE}/api/orders/${confRows[0].id}/confirm-payment`);
  assert(okRes.status === 200, `confirming at the confirmation stage succeeds (got ${okRes.status})`);
  const { rows: afterOk } = await pool.query(`select payment_status from "order" where id = $1`, [confRows[0].id]);
  assert(afterOk[0].payment_status === 'confirmed', 'payment_status actually flipped to confirmed');

  // === 2. At a LATER stage (preparation), with payment somehow still pending: refused ===
  const { rows: prepRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state)
     values ($1, 'REF-GATE-2', 'pickup', 1000, 'preparation', 'pending', 'fulfilment') returning id`,
    [customerId]
  );
  const blockedRes = await authed(`${BASE}/api/orders/${prepRows[0].id}/confirm-payment`);
  assert(blockedRes.status === 409, `confirming at the preparation stage is refused (got ${blockedRes.status})`);
  const { rows: afterBlocked } = await pool.query(`select payment_status from "order" where id = $1`, [prepRows[0].id]);
  assert(afterBlocked[0].payment_status === 'pending', 'payment_status was NOT touched by the refused attempt');

  // === 3. At the 'ready' stage: also refused ===
  const { rows: readyRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state)
     values ($1, 'REF-GATE-3', 'pickup', 1000, 'ready', 'pending', 'fulfilment') returning id`,
    [customerId]
  );
  const blockedRes2 = await authed(`${BASE}/api/orders/${readyRows[0].id}/confirm-payment`);
  assert(blockedRes2.status === 409, `confirming at the ready stage is also refused (got ${blockedRes2.status})`);

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
