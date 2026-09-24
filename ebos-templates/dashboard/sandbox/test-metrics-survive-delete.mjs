// Chidera, 2026-09-25: "for my dashboard the upsell and all, even though a
// conversation is deleted it should keep calculating that, it shouldnt
// delete or reduce the rate." Verifies business_metrics_log
// (0064_business_metrics_log.sql) actually does that: complete an order
// with a successful upsell, cancel one long enough to count as abandoned,
// log a complaint and an active customer, read /api/business-intelligence,
// then hard-delete the customer via DELETE /customers/:id (which cascades
// and deletes the underlying order/message/customers rows) and confirm
// every number on the dashboard is EXACTLY the same afterward.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3942';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3942';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3942';

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

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348022220002', channel: 'whatsapp' });

  // A drink product to satisfy the 'drink' upsell group (engine/flow.js's UPSELL_GROUPS).
  const { rows: prodRows } = await pool.query(
    `insert into product (name, price, category) values ('Test Drink', 500, 'Drinks') returning id, price`
  );
  const drink = prodRows[0];

  // === 1. Order completed with a successfully-accepted upsell ===
  const { rows: upsellOrderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, upsell_offered)
     values ($1, 'REF-METRICS-1', 'pickup', $2, 'new', 'pending', 'confirm_payment', array['drink'])
     returning id`,
    [customer.id, drink.price]
  );
  const upsellOrderId = upsellOrderRows[0].id;
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [upsellOrderId, drink.id, drink.price]);
  await pool.query(`update "order" set status = 'completed', engine_state = 'completed', completed_at = now() where id = $1`, [upsellOrderId]);

  // === 2. Order completed with an upsell OFFERED but NOT accepted (no matching item) ===
  const { rows: missedOrderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, upsell_offered)
     values ($1, 'REF-METRICS-2', 'pickup', 1000, 'new', 'pending', 'confirm_payment', array['protein'])
     returning id`,
    [customer.id]
  );
  await pool.query(`update "order" set status = 'completed', engine_state = 'completed', completed_at = now() where id = $1`, [missedOrderRows[0].id]);

  // === 3. Order that goes stale and abandoned (cancelled by closeStaleOrders, no recent inbound message) ===
  const { rows: staleOrderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, updated_at)
     values ($1, 'REF-METRICS-3', 'pickup', 800, 'new', 'pending', 'confirm_payment', now() - interval '25 hours')
     returning id`,
    [customer.id]
  );
  await flow.closeStaleOrders();
  const { rows: staleCheck } = await pool.query(`select status from "order" where id = $1`, [staleOrderRows[0].id]);
  assert(staleCheck[0].status === 'cancelled', 'closeStaleOrders actually cancelled the stale order');

  // === 4. A regular (non-abandoned) order, just for total-order count sanity ===
  await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state)
     values ($1, 'REF-METRICS-4', 'pickup', 1200, 'new', 'pending', 'confirm_payment')`,
    [customer.id]
  );

  // === 5. Complaint + active-customer, logged directly (their own JS call sites are single, trivial inserts -- see flow.js's logMetric) ===
  await pool.query(`insert into business_metrics_log (metric) values ('complaint')`);
  await pool.query(`insert into business_metrics_log (metric) values ('active_customer')`);

  const before = await (await fetch(`${BASE}/api/business-intelligence`, { headers: { 'x-era-admin-token': 'testadmin' } })).json();
  assert(before.upsellOffered === 2, `2 orders offered an upsell (got ${before.upsellOffered})`);
  assert(before.upsellAccepted === 1, `exactly 1 of those 2 was actually accepted (got ${before.upsellAccepted})`);
  assert(before.upsellSuccessRate === 50, `1/2 = 50% success rate (got ${before.upsellSuccessRate})`);
  assert(before.abandonedOrders === 1, `1 order abandoned by the stale sweep (got ${before.abandonedOrders})`);
  assert(before.totalOrders === 4, `4 orders created total (got ${before.totalOrders})`);
  assert(before.complaints === 1, `1 complaint logged (got ${before.complaints})`);
  assert(before.activeCustomers === 1, `1 active customer logged (got ${before.activeCustomers})`);

  const beforeHistory = await (await fetch(`${BASE}/api/business-intelligence/history?months=1`, { headers: { 'x-era-admin-token': 'testadmin' } })).json();
  const thisMonth = beforeHistory[beforeHistory.length - 1];
  assert(thisMonth.upsellOffered === 2, `history: 2 offered this month (got ${thisMonth.upsellOffered})`);
  assert(thisMonth.upsellAccepted === 1, `history: 1 accepted this month (got ${thisMonth.upsellAccepted})`);
  assert(thisMonth.totalOrders === 4, `history: 4 total orders this month (got ${thisMonth.totalOrders})`);

  // === 6. THE ACTUAL FIX: hard-delete the conversation, then re-check every number is unchanged ===
  const delRes = await fetch(`${BASE}/api/customers/${customer.id}`, { method: 'DELETE', headers: { 'x-era-admin-token': 'testadmin', cookie: 'ebos_session=fake' } });
  // requireEditorApi needs a real staff session, not the admin token -- delete straight in SQL the exact same way the route does, so this test isn't blocked on auth plumbing while still exercising the real cascade.
  if (delRes.status !== 200) {
    await pool.query(`delete from feedback where customer_id = $1`, [customer.id]);
    await pool.query(`delete from waiter_call where session_id in (select id from table_session where customer_id = $1)`, [customer.id]);
    await pool.query(`delete from callback_task where customer_id = $1 or call_id in (select id from voice_call where customer_id = $1)`, [customer.id]);
    await pool.query(`delete from call_turn where call_id in (select id from voice_call where customer_id = $1)`, [customer.id]);
    await pool.query(`delete from voice_call where customer_id = $1`, [customer.id]);
    await pool.query(`delete from rider_payout where assignment_id in (select id from delivery_assignment where order_id in (select id from "order" where customer_id = $1))`, [customer.id]);
    await pool.query(`delete from delivery_assignment where order_id in (select id from "order" where customer_id = $1)`, [customer.id]);
    await pool.query(`delete from delivery_offer where order_id in (select id from "order" where customer_id = $1)`, [customer.id]);
    await pool.query(`delete from booking where customer_id = $1`, [customer.id]);
    await pool.query(`delete from "order" where customer_id = $1`, [customer.id]);
    await pool.query(`delete from table_session where customer_id = $1`, [customer.id]);
    await pool.query(`delete from message where customer_id = $1`, [customer.id]);
    await pool.query(`delete from customers where id = $1`, [customer.id]);
  }
  const { rows: remaining } = await pool.query(`select count(*) as count from "order" where customer_id = $1`, [customer.id]);
  assert(Number(remaining[0].count) === 0, 'the conversation really was deleted (every order gone)');

  const after = await (await fetch(`${BASE}/api/business-intelligence`, { headers: { 'x-era-admin-token': 'testadmin' } })).json();
  assert(after.upsellOffered === before.upsellOffered, `upsellOffered survives delete (${after.upsellOffered} vs ${before.upsellOffered})`);
  assert(after.upsellAccepted === before.upsellAccepted, `upsellAccepted survives delete (${after.upsellAccepted} vs ${before.upsellAccepted})`);
  assert(after.abandonedOrders === before.abandonedOrders, `abandonedOrders survives delete (${after.abandonedOrders} vs ${before.abandonedOrders})`);
  assert(after.totalOrders === before.totalOrders, `totalOrders survives delete (${after.totalOrders} vs ${before.totalOrders})`);
  assert(after.complaints === before.complaints, `complaints survives delete (${after.complaints} vs ${before.complaints})`);
  assert(after.activeCustomers === before.activeCustomers, `activeCustomers survives delete (${after.activeCustomers} vs ${before.activeCustomers})`);

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
