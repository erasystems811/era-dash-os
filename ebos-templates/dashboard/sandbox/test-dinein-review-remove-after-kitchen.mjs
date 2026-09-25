// Chidera, 2026-09-25: "if a table place an order and after it has been
// placed they tap change it and remove something instead of add, how will
// that be solved? cause kitchen would have already started preparing
// order and theyll get a price reduction for what has been placed?"
//
// Real gap: routes/dinein-menu.js's own POST /:qrToken/review does a
// whole-basket replace (delete every order_item, reinsert the resubmitted
// basket) with no guard at all for a round already confirmed and sent to
// the kitchen -- a table could resubmit a smaller basket and silently get
// a price reduction for food already being cooked, no staff awareness.
// Fixed: blocked (with a real handover) whenever the round was already
// confirmed AND the resubmit removes/reduces anything, same
// escalate-to-a-human treatment an already-paid order gets elsewhere.
//
// Set EBOS_TEST_PGLITE=1 to run against a real, throwaway, in-process
// Postgres (see lib/db.js) -- schema.sql is applied automatically.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3955';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3955';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3955';

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

  const { rows: prod1 } = await pool.query(`insert into product (name, description, price, availability_type) values ('Jollof Rice', 'desc', 1700, 'stock') returning id, price`);
  const { rows: prod2 } = await pool.query(`insert into product (name, description, price, availability_type) values ('Grilled Chicken', 'desc', 2500, 'stock') returning id, price`);
  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  await pool.query(
    `insert into dinein_config (business_id, enabled) values ($1, true)
     on conflict (business_id) do update set enabled = true`,
    [bizRows[0].id]
  );
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length
    ? existingBranch[0].id
    : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(
    `insert into restaurant_table (label, qr_token, branch_id) values ('Table 9', 'qr-remove-kitchen-1', $1) returning id`,
    [branchId]
  );
  const tableId = tableRows[0].id;
  const { rows: custRows } = await pool.query(
    `insert into customers (name, phone_number, channel, menu_token) values ('Table 9 Guest', '2348012390001', 'whatsapp', 'menutok-remove-kitchen-1') returning id`
  );
  const customerId = custRows[0].id;
  const { rows: sessionRows } = await pool.query(
    `insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning id`,
    [tableId, branchId, customerId]
  );
  const sessionId = sessionRows[0].id;

  // === 1. First-ever submission -- goes through fine, no confirm yet. ===
  const firstRes = await fetch(`${BASE}/t/qr-remove-kitchen-1/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [
      { productId: prod1[0].id, quantity: 1 },
      { productId: prod2[0].id, quantity: 1 },
    ] }),
  });
  assert(firstRes.status === 200, 'the first-ever submission for this table goes through fine');

  const { rows: orderRows } = await pool.query(`select * from "order" where table_id = $1 order by created_at desc limit 1`, [tableId]);
  const order = orderRows[0];

  // Simulate the table actually confirming this round (sent to the
  // kitchen), same as a real "Yes, confirm" tap would.
  await pool.query(`update "order" set confirmed_at = now() where id = $1`, [order.id]);

  // === 2. Resubmitting with the chicken removed -- must be BLOCKED. ===
  const removeRes = await fetch(`${BASE}/t/qr-remove-kitchen-1/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [
      { productId: prod1[0].id, quantity: 1 },
    ] }),
  });
  // handover()'s own transcript summary needs a real ANTHROPIC_API_KEY,
  // not available in this sandbox (same known gap as test-conversation.mjs)
  // -- it throws AFTER the real protection below has already happened
  // (reply sent, handled_by set), so the HTTP response here isn't the
  // reliable signal in this environment; the DB-level assertions below are.
  assert(removeRes.status !== 200, 'a removal from an already-confirmed round is refused, not silently applied as ok');

  const { rows: itemsAfter } = await pool.query(`select p.name from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`, [order.id]);
  assert(itemsAfter.some((i) => i.name === 'Grilled Chicken'), 'the item is NOT silently removed -- still on the real order');
  assert(itemsAfter.length === 2, 'both items still on the order, nothing quietly dropped');

  const { rows: orderAfter } = await pool.query(`select total from "order" where id = $1`, [order.id]);
  assert(Number(orderAfter[0].total) !== 1700, 'the total was NOT silently reduced to just the remaining item');

  const { rows: custAfter } = await pool.query(`select handled_by from customers where id = $1`, [customerId]);
  assert(custAfter[0].handled_by === 'staff', 'a real handover to staff was raised for this');

  const { rows: msgRows } = await pool.query(`select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 5`, [customerId]);
  assert(msgRows.some((m) => /gone to the kitchen/i.test(m.body)), 'the customer is told this round already went to the kitchen, not just refused silently');

  // === 3. Adding MORE to an already-confirmed round (no removal) still
  // works completely normally. ===
  const { rows: prod3 } = await pool.query(`insert into product (name, description, price, availability_type) values ('Zobo', 'desc', 800, 'stock') returning id, price`);
  const addRes = await fetch(`${BASE}/t/qr-remove-kitchen-1/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [
      { productId: prod1[0].id, quantity: 1 },
      { productId: prod2[0].id, quantity: 1 },
      { productId: prod3[0].id, quantity: 1 },
    ] }),
  });
  assert(addRes.status === 200, 'a pure addition on top of an already-confirmed round still goes through fine');
  const { rows: itemsAfterAdd } = await pool.query(`select p.name from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`, [order.id]);
  assert(itemsAfterAdd.some((i) => i.name === 'Zobo'), 'the new item was actually added');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
