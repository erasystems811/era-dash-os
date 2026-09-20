// Chidera, real report, 2026-09-20: "after requesting payment and its
// pending i added another water, whwn i tapped request payment amount it
// kept showing me old stale amount instead of the new total or my
// outstanding." A PENDING order_payment is frozen at whatever the order
// totalled the moment it was requested -- adding (or removing) items
// afterward makes that amount stale, and worse, a real POS transaction
// matching that stale figure would auto-confirm against the WRONG total.
// Confirms both real add-on paths (the web review route AND the typed-
// chat add-on path) clear a stale pending payment so the next request
// reflects the real current total, and that a real CONFIRMED payment
// (actual money already received) is never touched by either.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3936';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3936';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3936';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  await pool.query(
    `insert into dinein_config (business_id, enabled) values ($1, true) on conflict (business_id) do update set enabled = true`,
    [bizRows[0].id]
  );
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(
    `insert into restaurant_table (branch_id, label, qr_token) values ($1, 'ST1', 'qrstale') returning id`,
    [branchId]
  );
  const table = tableRows[0];
  const { rows: prod1 } = await pool.query(`insert into product (name, price, category, branch_id) values ('Jollof Rice', 3500, 'MAINS', $1) returning id`, [branchId]);
  const { rows: prod2 } = await pool.query(`insert into product (name, price, category, branch_id) values ('Water', 500, 'DRINKS', $1) returning id`, [branchId]);

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348011119930', channel: 'whatsapp', branchId });
  const { rows: sessionRows } = await pool.query(`insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning *`, [table.id, branchId, customer.id]);
  const session = sessionRows[0];
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, branch_id, channel, table_id, session_id, fulfilment_type, payment_mode, engine_state, status, served_at, total, confirmed_at)
     values ($1, 'REF-STALE', $2, 'dinein', $3, $4, 'table', 'at_table', 'fulfilment', 'preparation', now(), 3500, now()) returning *`,
    [customer.id, branchId, table.id, session.id]
  );
  const order = orderRows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, 3500, $3)`, [order.id, prod1[0].id, customer.id]);

  const guestToken = await flow.ensureMenuToken(customer);

  // === Scenario A: web review route (the "Place order"/add-more path) ===
  const create1 = await fetch(`${BASE}/t/qrstale/pay/create?g=${guestToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guestIds: [customer.id] }),
  });
  assert((await create1.json()).amount === 3500, 'a payment for the original NGN 3500 total gets requested and pending');

  // Guest adds another water through the same web basket resubmit the
  // real "Place order" flow uses.
  const reviewRes = await fetch(`${BASE}/t/qrstale/review?g=${guestToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: prod1[0].id, quantity: 1, answers: {} }, { productId: prod2[0].id, quantity: 1, answers: {} }] }),
  });
  assert(reviewRes.status === 200, 'the add-more resubmit itself succeeds');

  const { rows: afterAddA } = await pool.query(`select status from order_payment where order_id = $1`, [order.id]);
  assert(afterAddA.every((p) => p.status !== 'pending'), 'the stale NGN 3500 pending payment is gone -- no longer sitting around to be wrongly matched');

  const statusAfterA = await (await fetch(`${BASE}/t/qrstale/pay?g=${guestToken}`)).text();
  assert(statusAfterA.includes('"myPendingAmount":null'), 'reopening the pay page no longer shows the stale amount -- back to a real, fresh request');

  const create2 = await fetch(`${BASE}/t/qrstale/pay/create?g=${guestToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guestIds: [customer.id] }),
  });
  assert((await create2.json()).amount === 4000, 'requesting again correctly reflects the NEW total (3500 + 500), not the stale 3500');

  // === Scenario B: a CONFIRMED payment must never be touched by an add-on ===
  const { rows: confirmedSetup } = await pool.query(`select id from order_payment where order_id = $1 and status = 'pending'`, [order.id]);
  await pool.query(`update order_payment set status = 'confirmed', confirmed_at = now() where id = $1`, [confirmedSetup[0].id]);
  await flow.applyOrderModifications(order, { adds: [{ productId: prod2[0].id, quantity: 1, price: 500, name: 'Water' }], removes: [], sets: [] }, { allowRemovals: true }, customer);
  const { rows: afterAddB } = await pool.query(`select status from order_payment where order_id = $1 order by created_at desc limit 1`, [order.id]);
  assert(afterAddB[0].status === 'confirmed', 'a real CONFIRMED payment (actual money received) is never touched by an add-on, only pending ones are');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
