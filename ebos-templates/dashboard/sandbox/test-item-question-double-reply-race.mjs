// Chidera, 2026-09-25, real live report: "while placing my order after
// the bot upsold me a drink and i chose cold it sent me double reply."
// A genuine race in handlePendingItemQuestion -- it used to clear
// order.pending_question_id at the very END, after all the real work
// (insert the answer, update order_item.modification, then reply). Two
// requests answering the SAME question almost simultaneously (a dropdown
// tap and typed text landing together, or two rapid taps) both read the
// same pending_question_id before either cleared it, so both ran the
// full apply-and-reply path -- two separate "Got it..." messages for one
// answer. Fixed by claiming the question atomically FIRST (a conditional
// UPDATE ... WHERE pending_question_id = $2 RETURNING id) -- the losing
// request finds nothing left to claim and does nothing more.
//
// Set EBOS_TEST_PGLITE=1 to run against a real, throwaway, in-process
// Postgres (see lib/db.js) -- schema.sql is applied automatically.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function outboundRows(pool, customerId) {
  const { rows } = await pool.query(
    `select body, trigger from message where customer_id = $1 and direction = 'outbound' order by created_at asc`,
    [customerId]
  );
  return rows;
}

async function main() {
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  const { rows: prodRows } = await pool.query(`insert into product (name, description, price, availability_type) values ('Chapman', 'desc', 1500, 'stock') returning id, price`);
  const product = prodRows[0];
  const { rows: qRows } = await pool.query(
    `insert into product_question (product_id, question, position) values ($1, 'Cold or room temperature?', 0) returning id`,
    [product.id]
  );
  const questionId = qRows[0].id;

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012410001', channel: 'whatsapp' });
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-QRACE-1', 'pickup', $2, 'new', 'pending', 'collect_info', 'whatsapp') returning *`,
    [customer.id, product.price]
  );
  const order = orderRows[0];
  const { rows: itemRows } = await pool.query(
    `insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3) returning id`,
    [order.id, product.id, product.price]
  );
  const itemId = itemRows[0].id;

  await pool.query('update "order" set pending_question_order_item_id = $1, pending_question_id = $2 where id = $3', [itemId, questionId, order.id]);
  order.pending_question_order_item_id = itemId;
  order.pending_question_id = questionId;

  // Two "requests" racing to answer the exact SAME pending question with
  // the same in-memory `order` snapshot -- a real double-tap (or a tap and
  // typed text landing together), not two different, unrelated turns.
  // Both go through the real per-request path (each resolves its own
  // fresh order row, same as two real HTTP requests each would).
  await Promise.all([
    flow.handleItemQuestionChoiceTap({ customer, option: 'Cold' }).catch((err) => console.error('tap 1 failed:', err.message)),
    flow.handleItemQuestionChoiceTap({ customer, option: 'Cold' }).catch((err) => console.error('tap 2 failed:', err.message)),
  ]);

  const rows = await outboundRows(pool, customer.id);
  assert(rows.length === 1, `only ONE reply for the one real answer, not two (got ${rows.length}: ${JSON.stringify(rows.map((r) => r.trigger))})`);

  const { rows: answerRows } = await pool.query('select answer from order_item_answer where order_item_id = $1 and question_id = $2', [itemId, questionId]);
  assert(answerRows.length === 1, `exactly one real answer row saved, not duplicated (got ${answerRows.length})`);

  const { rows: orderAfter } = await pool.query('select pending_question_id from "order" where id = $1', [order.id]);
  assert(orderAfter[0].pending_question_id === null, 'the pending question is genuinely cleared, not left dangling');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
