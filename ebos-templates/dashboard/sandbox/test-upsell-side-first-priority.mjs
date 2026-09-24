// Chidera, 2026-09-24: "if youll recommend a side, then the side should
// be first and its either side then protein then drink or protein then
// snack then drink...and recommendation should depend on what is needed
// for that customer." Two priority tracks: an order genuinely missing a
// side gets offered side FIRST (ahead of protein/drink); an order that
// already has one skips straight past side to protein, then snack, then
// drink instead. Confirms both tracks directly against nextUpsellGroup's
// own real logic (via finishItemsCollection, same as any other order),
// not just the side-needed happy path test-upsell-multiselect-quantity.mjs
// already covers.
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
  await pool.query(`insert into product (name, description, price, category, availability_type) values ('Puff Puff', 'd', 500, 'Snack', 'stock')`);
  const { rows: sideProductRows } = await pool.query(`select id, price from product where name = 'Fried Plantain'`);
  const { rows: mainRows } = await pool.query(`select id, price from product where name = 'Jollof Rice and Chicken'`);

  // === Track A: order genuinely missing a side -- offered FIRST. ===
  const customerA = await flow.findOrCreateCustomer({ phoneNumber: '2348012359101', channel: 'whatsapp' });
  customerA.channel = 'website';
  const { rows: orderA } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-SIDEFIRST-A', 'pickup', $2, 'new', 'pending', 'collect_info', 'whatsapp') returning *`,
    [customerA.id, mainRows[0].price]
  );
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [orderA[0].id, mainRows[0].id, mainRows[0].price]);
  await flow.finishItemsCollection(customerA, orderA[0], '');
  const { rows: msgA } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customerA.id]
  );
  assert(/would you like to add a side/i.test(msgA[0].body), 'Track A (no side yet): side is offered FIRST, ahead of protein/drink');

  // === Track B: order already has a real side -- side is skipped
  // entirely, the OTHER track (protein, then snack, then drink) applies. ===
  const customerB = await flow.findOrCreateCustomer({ phoneNumber: '2348012359102', channel: 'whatsapp' });
  customerB.channel = 'website';
  const { rows: orderB } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-SIDEFIRST-B', 'pickup', $2, 'new', 'pending', 'collect_info', 'whatsapp') returning *`,
    [customerB.id, mainRows[0].price + Number(sideProductRows[0].price)]
  );
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [orderB[0].id, mainRows[0].id, mainRows[0].price]);
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [orderB[0].id, sideProductRows[0].id, sideProductRows[0].price]);
  await flow.finishItemsCollection(customerB, orderB[0], '');
  const { rows: msgB1 } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customerB.id]
  );
  assert(/would you like to add a protein/i.test(msgB1[0].body), 'Track B (already has a side): protein is offered first instead -- side is never re-offered');
  assert(!/would you like to add a side/i.test(msgB1[0].body), 'and side itself is never asked about again -- already satisfied');

  // Decline protein -- Track B's next category is snack (not drink,
  // "protein then SNACK then drink"). Fresh from the DB before the next
  // call -- finishItemsCollection's own upsell branch only ever writes
  // pending_upsell_category/upsell_offered to the DB row, never mutates
  // the in-memory `order` object it was given, same "production always
  // re-fetches" reasoning every other sandbox test in this repo already
  // carves out.
  const { rows: pendingB } = await pool.query(`select pending_upsell_category from "order" where id = $1`, [orderB[0].id]);
  assert(pendingB[0].pending_upsell_category === 'protein', 'sanity check: protein really is what got offered and is now pending');
  await pool.query(`update "order" set pending_upsell_category = null where id = $1`, [orderB[0].id]);
  const { rows: freshOrderB } = await pool.query(`select * from "order" where id = $1`, [orderB[0].id]);
  await flow.finishItemsCollection(customerB, freshOrderB[0], '');
  const { rows: msgB2 } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customerB.id]
  );
  assert(/would you like to add a snack/i.test(msgB2[0].body), 'Track B, second offer: snack comes next, not drink -- matches "protein then snack then drink" exactly');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
