// Chidera, real report (Emmanuel, era-demo): "if they are already using
// text no need to send them back to the menu to answer cold or not, just
// go text it." A customer whose item was added by typed chat (not the
// web menu) now gets any real item-customization question asked directly
// in text, not redirected to a web link -- confirms finishItemsCollection's
// preferTextForQuestions option, wired into every text-originated caller.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3922';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3922';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348011119998', channel: 'whatsapp' });
  const { rows: prodRows } = await pool.query(`insert into product (name, price, category) values ('Jollof Rice', 3500, 'MAINS') returning id`);
  const productId = prodRows[0].id;
  await pool.query(`insert into product_question (product_id, question) values ($1, 'Peppered or not?')`, [productId]);
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, status, engine_state) values ($1, 'REF-TXTQ', 'new', 'collect_info') returning *`,
    [customer.id]
  );
  const order = orderRows[0];
  await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, 3500, $3)', [order.id, productId, customer.id]);

  // Exactly the finishItemsCollection call handleCollectInfo makes after
  // a typed item add (preferTextForQuestions: true) -- the item's own
  // real, unanswered question should be asked directly, no web link.
  await flow.finishItemsCollection(customer, order, '', { preferTextForQuestions: true });

  const { rows: msgRows } = await pool.query(
    `select trigger, body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customer.id]
  );
  assert(msgRows[0]?.trigger === 'item_question_asked', 'the item question was asked directly (item_question_asked trigger), not a web link');
  assert(msgRows[0]?.body?.includes('Peppered or not?'), 'the real question text was actually asked');
  assert(!msgRows[0]?.body?.includes('/m/') && !msgRows[0]?.body?.includes('/t/'), 'no web link was sent for a text-originated item question');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
