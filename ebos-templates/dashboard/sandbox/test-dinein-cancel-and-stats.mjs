// Chidera, 2026-09-25:
// 1. "can in house have its own dashboard, with cash collected" --
//    verifies GET /dinein/stats/today (routes/dinein.js) returns a real
//    cash/card/transfer/other breakdown that sums to the total collected,
//    and is scoped to dine-in only (a non-dinein order must never count).
// 2. "why is there cancel order in the in house kanban orders pipeline is
//    staff meant to be able to camcel? isnt it meant to be a close table
//    thing?" -- verifies POST /orders/:id/status {status:'cancelled'} now
//    auto-closes the table_session the same way marking an order completed
//    already does, but ONLY once every order in that session is actually
//    settled (a table with another still-active order must NOT close).
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3944';
process.env.SESSION_SECRET = 'testsecret';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3944';

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
  const authed = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), cookie, 'Content-Type': 'application/json' } });

  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: custRows } = await pool.query(`insert into customers (phone_number, branch_id) values ('2348044440005', $1) returning id`, [branchId]);
  const customerId = custRows[0].id;

  async function newTableWithOrder(label, { status = 'preparation', paymentMethod, cashCollected, paymentStatus } = {}) {
    const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, $2, $3) returning id`, [branchId, label, `qr-${label}`]);
    const tableId = tableRows[0].id;
    const { rows: sessionRows } = await pool.query(`insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning *`, [tableId, branchId, customerId]);
    const { rows: orderRows } = await pool.query(
      `insert into "order" (customer_id, reference, branch_id, channel, table_id, session_id, fulfilment_type, payment_mode, engine_state, status, total, payment_status, payment_method, cash_collected)
       values ($1, $2, $3, 'dinein', $4, $5, 'table', 'at_table', 'fulfilment', $6, 1000, $7, $8, $9) returning *`,
      [customerId, `REF-${label}`, branchId, tableId, sessionRows[0].id, status, paymentStatus || 'pending', paymentMethod || null, cashCollected || null]
    );
    return { tableId, sessionId: sessionRows[0].id, order: orderRows[0] };
  }

  // === 1. /dinein/stats/today: a real cash/card/transfer/other breakdown ===
  await newTableWithOrder('S1', { paymentMethod: 'cash', paymentStatus: 'confirmed', cashCollected: 1000 });
  await newTableWithOrder('S2', { paymentMethod: 'card', paymentStatus: 'confirmed' });
  await newTableWithOrder('S3', { paymentMethod: 'transfer', paymentStatus: 'confirmed' });
  // Auto-confirmed via a real payment link/POS match -- payment_method never gets set for this path.
  await newTableWithOrder('S4', { paymentStatus: 'confirmed' });
  // Still awaiting payment -- not collected, but must still count toward
  // outstanding (a cancelled order's own value is deliberately excluded).
  await newTableWithOrder('S5', { paymentStatus: 'pending' });
  // A non-dinein order must never leak into these numbers.
  await pool.query(
    `insert into "order" (customer_id, reference, branch_id, channel, fulfilment_type, engine_state, status, total, payment_status, payment_method, cash_collected)
     values ($1, 'REF-ONLINE', $2, 'whatsapp', 'pickup', 'fulfilment', 'preparation', 5000, 'confirmed', 'cash', 5000)`,
    [customerId, branchId]
  );

  const stats = await (await authed(`${BASE}/api/dinein/stats/today`)).json();
  assert(stats.cash === 1000, `cash collected counted (got ${stats.cash})`);
  assert(stats.card === 1000, `card collected counted (got ${stats.card})`);
  assert(stats.transfer === 1000, `transfer collected counted (got ${stats.transfer})`);
  assert(stats.other === 1000, `auto-confirmed (no payment_method) counted as "other" (got ${stats.other})`);
  assert(stats.collected === 4000, `total collected is dine-in only, excludes the NGN5000 online order (got ${stats.collected})`);
  assert(stats.outstanding === 1000, `the still-pending table counts as outstanding, excludes the paid online order (got ${stats.outstanding})`);
  assert(stats.cash + stats.card + stats.transfer + stats.other === stats.collected, 'the four figures sum to exactly the total, no drift');
  assert(stats.tablesServed === 5, `5 dine-in tables counted today (got ${stats.tablesServed})`);

  // === 2. Cancelling a table's ONLY order closes the table automatically ===
  const solo = await newTableWithOrder('C1');
  const cancelRes = await authed(`${BASE}/api/orders/${solo.order.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelled' }) });
  assert(cancelRes.status === 200, 'cancel request succeeded');
  await new Promise((r) => setTimeout(r, 150)); // fire-and-forget closeTableSessionIfSettled
  const { rows: soloSession } = await pool.query(`select closed_at, closed_by from table_session where id = $1`, [solo.sessionId]);
  assert(soloSession[0].closed_at !== null && soloSession[0].closed_by === 'auto', "cancelling a table's only order auto-closes it, same as Mark paid already does");

  // === 3. Cancelling ONE of two active orders on a table must NOT close it ===
  const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, 'C2', 'qr-C2') returning id`, [branchId]);
  const tableId = tableRows[0].id;
  const { rows: sessionRows } = await pool.query(`insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning *`, [tableId, branchId, customerId]);
  const sessionId = sessionRows[0].id;
  const { rows: roundA } = await pool.query(
    `insert into "order" (customer_id, reference, branch_id, channel, table_id, session_id, fulfilment_type, payment_mode, engine_state, status, total, payment_status)
     values ($1, 'REF-C2A', $2, 'dinein', $3, $4, 'table', 'at_table', 'fulfilment', 'preparation', 1000, 'pending') returning *`,
    [customerId, branchId, tableId, sessionId]
  );
  const { rows: roundB } = await pool.query(
    `insert into "order" (customer_id, reference, branch_id, channel, table_id, session_id, fulfilment_type, payment_mode, engine_state, status, total, payment_status)
     values ($1, 'REF-C2B', $2, 'dinein', $3, $4, 'table', 'at_table', 'fulfilment', 'preparation', 1000, 'pending') returning *`,
    [customerId, branchId, tableId, sessionId]
  );
  await authed(`${BASE}/api/orders/${roundA[0].id}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelled' }) });
  await new Promise((r) => setTimeout(r, 150));
  const { rows: stillOpen } = await pool.query(`select closed_at from table_session where id = $1`, [sessionId]);
  assert(stillOpen[0].closed_at === null, 'a table with another still-active order stays open after cancelling just one round');
  // Now cancel the second (last) round too -- the table should close.
  await authed(`${BASE}/api/orders/${roundB[0].id}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelled' }) });
  await new Promise((r) => setTimeout(r, 150));
  const { rows: nowClosed } = await pool.query(`select closed_at, closed_by from table_session where id = $1`, [sessionId]);
  assert(nowClosed[0].closed_at !== null && nowClosed[0].closed_by === 'auto', 'cancelling the LAST outstanding round then closes the table');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
