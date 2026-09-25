// Chidera, 2026-09-25: "let upsell only be protein and drink or side and
// drink now no more snack, and only 2 upsell" -- then, same day, a
// correction: "i already said make it, protein and drink or side and
// drink protein is more important than side." Still exactly one of
// {protein, side} paired with drink, never both -- but the PICK between
// them is no longer gated on side presence, it's protein presence
// checked first: an order missing both gets protein (the tie breaker),
// not side; an order that already has protein but is missing a side
// still gets side, same as before.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3959';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3959';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3959';

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

  await pool.query(`insert into product (name, description, price, category, availability_type) values ('Zobo', 'd', 1200, 'Drinks', 'stock')`);
  await pool.query(`insert into product (name, description, price, category, availability_type) values ('Fried Plantain', 'd', 1000, 'Side', 'stock')`);
  await pool.query(`insert into product (name, description, price, category, availability_type) values ('Suya Skewer', 'd', 1500, 'Protein', 'stock')`);
  const { rows: proteinProductRows } = await pool.query(`select id, price from product where name = 'Suya Skewer'`);
  const { rows: mainRows } = await pool.query(`select id, price from product where name = 'Jollof Rice and Chicken'`);

  // === Track A: order missing BOTH protein and side -- protein wins the
  // tie, offered FIRST (not side), then drink. ===
  const customerA = await flow.findOrCreateCustomer({ phoneNumber: '2348012359101', channel: 'whatsapp' });
  customerA.channel = 'website';
  const { rows: orderA } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-SIDEFIRST-A', 'pickup', $2, 'new', 'pending', 'collect_info', 'whatsapp') returning *`,
    [customerA.id, mainRows[0].price]
  );
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [orderA[0].id, mainRows[0].id, mainRows[0].price]);
  await flow.finishItemsCollection(customerA, orderA[0], '');
  const { rows: msgA1 } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customerA.id]
  );
  assert(/would you like to add a protein/i.test(msgA1[0].body), 'Track A (missing both protein and side): protein is offered FIRST -- it\'s more important than side');

  // Decline protein -- Track A's next (and last, cap is 2 now) category is
  // drink, never side (protein already "won" this order's one non-drink
  // slot). Fresh from the DB before the next call, same reasoning as
  // Track B's own equivalent step below.
  const { rows: pendingA } = await pool.query(`select pending_upsell_category from "order" where id = $1`, [orderA[0].id]);
  assert(pendingA[0].pending_upsell_category === 'protein', 'sanity check: protein really is what got offered and is now pending');
  await pool.query(`update "order" set pending_upsell_category = null where id = $1`, [orderA[0].id]);
  const { rows: freshOrderA } = await pool.query(`select * from "order" where id = $1`, [orderA[0].id]);
  await flow.finishItemsCollection(customerA, freshOrderA[0], '');
  const { rows: msgA2 } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customerA.id]
  );
  assert(/would you like to add a drink/i.test(msgA2[0].body), 'Track A, second (and last) offer: drink, never side -- matches "protein and drink" exactly');

  // === Track B: order already HAS protein, missing a side -- side is
  // what's offered (protein correctly skipped, already satisfied), then
  // drink. Proves the side track still fires at all now that protein is
  // checked first. ===
  const customerB = await flow.findOrCreateCustomer({ phoneNumber: '2348012359102', channel: 'whatsapp' });
  customerB.channel = 'website';
  const { rows: orderB } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-SIDEFIRST-B', 'pickup', $2, 'new', 'pending', 'collect_info', 'whatsapp') returning *`,
    [customerB.id, mainRows[0].price + Number(proteinProductRows[0].price)]
  );
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [orderB[0].id, mainRows[0].id, mainRows[0].price]);
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [orderB[0].id, proteinProductRows[0].id, proteinProductRows[0].price]);
  await flow.finishItemsCollection(customerB, orderB[0], '');
  const { rows: msgB1 } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customerB.id]
  );
  assert(/would you like to add a side/i.test(msgB1[0].body), 'Track B (already has protein): side is offered instead -- protein is never re-offered');
  assert(!/would you like to add a protein/i.test(msgB1[0].body), 'and protein itself is never asked about again -- already satisfied');

  // Decline side -- Track B's next (and last, cap is 2 now) category is
  // drink. Fresh from the DB before the next call -- finishItemsCollection's
  // own upsell branch only ever writes pending_upsell_category/
  // upsell_offered to the DB row, never mutates the in-memory `order`
  // object it was given, same "production always re-fetches" reasoning
  // every other sandbox test in this repo already carves out.
  const { rows: pendingB } = await pool.query(`select pending_upsell_category from "order" where id = $1`, [orderB[0].id]);
  assert(pendingB[0].pending_upsell_category === 'side', 'sanity check: side really is what got offered and is now pending');
  await pool.query(`update "order" set pending_upsell_category = null where id = $1`, [orderB[0].id]);
  const { rows: freshOrderB } = await pool.query(`select * from "order" where id = $1`, [orderB[0].id]);
  await flow.finishItemsCollection(customerB, freshOrderB[0], '');
  const { rows: msgB2 } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customerB.id]
  );
  assert(/would you like to add a drink/i.test(msgB2[0].body), 'Track B, second (and last) offer: drink -- matches "side and drink" exactly');

  // === Cap check: exactly 2 upsells total, never a 3rd offer. ===
  const { rows: pendingB2 } = await pool.query(`select pending_upsell_category, upsell_offered from "order" where id = $1`, [orderB[0].id]);
  assert(pendingB2[0].pending_upsell_category === 'drink', 'sanity check: drink really is what got offered and is now pending');
  assert(pendingB2[0].upsell_offered.length === 2, 'exactly 2 categories offered so far (side, drink)');
  await pool.query(`update "order" set pending_upsell_category = null where id = $1`, [orderB[0].id]);
  const { rows: freshOrderB2 } = await pool.query(`select * from "order" where id = $1`, [orderB[0].id]);
  await flow.finishItemsCollection(customerB, freshOrderB2[0], '');
  const { rows: msgB3 } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customerB.id]
  );
  assert(!/would you like to add/i.test(msgB3[0].body), 'no 3rd upsell offer -- cap of 2 is respected');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
