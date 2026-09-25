// Chidera, 2026-09-25 (live report): "when bot auto confirm i think the
// kanban card should have a paid sign if not staff may not know how to
// confirm that they have paid." A split payment auto-confirmed via a
// real Paystack/Monnify/Moniepoint webhook (confirmOrderPayment, never a
// staff click) used to leave nothing on the /orders/serving card saying
// so -- an order stays on this board until EVERY split is confirmed, so
// a genuinely already-paid share could sit there with no visible sign of
// it. Confirms GET /api/dinein/orders/serving now returns confirmed_amount,
// the real sum of every confirmed order_payment for that order.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3993';
process.env.SESSION_SECRET = 'testsecret';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3993';

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

  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@samplerestaurant.test', password: 'testpass123' }),
  });
  const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert(loginRes.status === 200 && !!cookie, 'staff login succeeded, got a real session cookie');

  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '50', 'qrpaidbadge50') returning id`, [branchId]);
  const { rows: prodRows } = await pool.query(`insert into product (name, price, category, branch_id) values ('Jollof Rice', 3500, 'MAINS', $1) returning id, price`, [branchId]);
  const customer1 = await flow.findOrCreateCustomer({ phoneNumber: '2348013390150', channel: 'whatsapp' });
  const customer2 = await flow.findOrCreateCustomer({ phoneNumber: '2348013390151', channel: 'whatsapp' });

  const { rows: sessionRows } = await pool.query(
    `insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning *`,
    [tableRows[0].id, branchId, customer1.id]
  );
  const session = sessionRows[0];
  await pool.query(`insert into table_session_guest (session_id, customer_id) values ($1, $2) on conflict do nothing`, [session.id, customer2.id]);

  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, session_id, table_id, branch_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel, payment_mode, served_at)
     values ($1, $2, $3, $4, 'REF-PAIDBADGE50', 'table', 8000, 'preparation', 'pending', 'fulfilment', 'dinein', 'at_table', now()) returning *`,
    [customer1.id, session.id, tableRows[0].id, branchId]
  );
  const order = orderRows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, $3, $4)`, [order.id, prodRows[0].id, prodRows[0].price, customer1.id]);
  await pool.query(`insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, 4500, $3)`, [order.id, prodRows[0].id, customer2.id]);

  // === 1. Before any payment -- no badge, confirmed_amount is 0. ===
  const before = await (await fetch(`${BASE}/api/dinein/orders/serving`, { headers: { cookie } })).json();
  const cardBefore = before.find((o) => o.id === order.id);
  assert(Boolean(cardBefore), 'the order shows up in the serving list');
  assert(Number(cardBefore.confirmed_amount) === 0, `nothing confirmed yet (got ${cardBefore.confirmed_amount})`);

  // === 2. Customer 1's own split (₦3500) auto-confirms via a real
  // payment (createOrderPayment + confirmOrderPayment, same flow a real
  // webhook drives) -- the order stays on the board (customer 2's own
  // ₦4500 share still unpaid), but confirmed_amount now reflects it. ===
  const payment1 = await flow.createOrderPayment(order, [customer1.id], customer1.id);
  await flow.confirmOrderPayment(payment1.id);

  const after = await (await fetch(`${BASE}/api/dinein/orders/serving`, { headers: { cookie } })).json();
  const cardAfter = after.find((o) => o.id === order.id);
  assert(Boolean(cardAfter), 'the order is STILL on the board -- customer 2\'s own share is not paid yet, so the whole order never auto-completed');
  assert(Number(cardAfter.confirmed_amount) === 3500, `confirmed_amount reflects the real ₦3500 already auto-confirmed for this order (got ${cardAfter.confirmed_amount})`);
  assert(Number(cardAfter.confirmed_amount) < Number(cardAfter.total), 'and it\'s genuinely less than the order\'s own total -- a partial, not the whole thing');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
