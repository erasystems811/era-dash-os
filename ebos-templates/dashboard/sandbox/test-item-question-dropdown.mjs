// Chidera, 2026-09-24: "for that peppered or not and cold or room
// temperature, can i have it as a dropdown they can choose, and an
// optional type extra note if they have extra, so they just only have to
// select, to reduce manual typing." A question with real options (the
// same product_question.options the web menu page's own qSheet already
// uses) now gets an interactive select-plus-optional-note bubble on the
// web chat page too, instead of a free-text ask -- confirms the offer, the
// real tap handler storing the composed "Option (note)" answer exactly
// like the web menu already does, and that a question with NO options
// still falls back to the plain-text ask, unchanged.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3962';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3962';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  const { rows: prodRows } = await pool.query(`insert into product (name, price, category) values ('Zobo Drink', 1200, 'DRINKS') returning id`);
  const productId = prodRows[0].id;
  await pool.query(
    `insert into product_question (product_id, question, options) values ($1, 'Cold or room temperature?', $2)`,
    [productId, ['Cold', 'Room temperature']]
  );
  const { rows: noOptionsProd } = await pool.query(`insert into product (name, price, category) values ('Jollof Rice', 3500, 'MAINS') returning id`);
  await pool.query(`insert into product_question (product_id, question) values ($1, 'Peppered or not?')`, [noOptionsProd[0].id]);

  // === 1. A question WITH real options -- interactive select bubble, not plain text. ===
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012371001', channel: 'whatsapp' });
  customer.channel = 'website';
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, status, engine_state) values ($1, 'REF-QDROPDOWN', 'new', 'collect_info') returning *`,
    [customer.id]
  );
  const order = orderRows[0];
  const { rows: itemRows } = await pool.query(
    'insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, 1200, $3) returning id',
    [order.id, productId, customer.id]
  );

  await flow.finishItemsCollection(customer, order, '', { preferTextForQuestions: true });
  const { rows: msg1 } = await pool.query(
    `select body, trigger, interactive from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customer.id]
  );
  assert(msg1[0].trigger === 'item_question_asked', 'tagged as the item question ask, same trigger as the plain-text version');
  assert(msg1[0].interactive?.type === 'item_question', 'a real interactive select bubble, not a plain-text question');
  assert(JSON.stringify(msg1[0].interactive.options) === JSON.stringify(['Cold', 'Room temperature']), 'carries the real options, straight from Catalogue');
  assert(/Cold or room temperature\?/.test(msg1[0].body), 'the real question text is still shown as the bubble body');
  assert(!/Just need a couple more details.*tap below/i.test(msg1[0].body), 'never redirected to the web menu link either -- answered right here');

  // === 2. The real tap: selecting "Cold" with an extra note. ===
  const tapRes = await fetch(`${process.env.PUBLIC_URL}/wa/${await flow.ensureMenuToken(customer)}/tap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemQuestionAnswer: { option: 'Cold', note: 'extra ice' } }),
  });
  assert(tapRes.status === 200, 'the select-plus-note tap is accepted');
  const { rows: itemAfter } = await pool.query(`select modification from order_item where id = $1`, [itemRows[0].id]);
  assert(itemAfter[0].modification === 'Cold or room temperature?: Cold (extra ice)', 'the composed "Option (note)" answer is stored exactly, same shape the web menu already uses');
  const { rows: orderAfter } = await pool.query(`select pending_question_id, pending_question_order_item_id from "order" where id = $1`, [order.id]);
  assert(orderAfter[0].pending_question_id === null && orderAfter[0].pending_question_order_item_id === null, 'the pending question is genuinely cleared, not left hanging');

  // === 3. A question with NO options at all -- plain text, unchanged. ===
  const customer2 = await flow.findOrCreateCustomer({ phoneNumber: '2348012371002', channel: 'whatsapp' });
  customer2.channel = 'website';
  const { rows: order2Rows } = await pool.query(
    `insert into "order" (customer_id, reference, status, engine_state) values ($1, 'REF-QDROPDOWN-2', 'new', 'collect_info') returning *`,
    [customer2.id]
  );
  await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, 3500, $3)', [order2Rows[0].id, noOptionsProd[0].id, customer2.id]);
  await flow.finishItemsCollection(customer2, order2Rows[0], '', { preferTextForQuestions: true });
  const { rows: msg2 } = await pool.query(
    `select body, trigger, interactive from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customer2.id]
  );
  assert(msg2[0].trigger === 'item_question_asked', 'still the same item-question trigger');
  assert(!msg2[0].interactive, 'no interactive select for a question with no real options -- plain text, exactly as before');
  assert(/Peppered or not\?/.test(msg2[0].body), 'the plain-text question still goes out normally');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
