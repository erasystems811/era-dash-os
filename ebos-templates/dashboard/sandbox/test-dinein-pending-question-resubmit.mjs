// Chidera, real report, 2026-09-20: "on era demo after it upsold me and i
// went to type cold for water it is refusing to click the place order
// button." Reproduced live via a real browser: an item added with a
// question still outstanding (here, an upsell accepted via the WhatsApp
// list tap) leaves order.pending_question_order_item_id pointing at that
// row. Answering it through the web page's own question sheet is purely
// client-side (menu-page-template.js's qSheetAdd never calls the server),
// so that column is still set the moment "Place order" submits the whole
// basket to the review route -- its own `delete from order_item where
// order_id = $1` then hit the real foreign key
// (order_pending_question_order_item_id_fkey), an uncaught exception with
// no response ever sent, which is exactly what reads as a dead/unresponsive
// button rather than a clean error. Fixed by clearing that pointer before
// the delete, same reasoning as clearPendingQuestionIfOnItem's own single-
// item case -- every item is about to be replaced anyway.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3931';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3931';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3931';

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
    `insert into restaurant_table (branch_id, label, qr_token) values ($1, 'PQ', 'qrpendingq') returning id`,
    [branchId]
  );
  const table = tableRows[0];
  const { rows: waterRows } = await pool.query(
    `insert into product (name, price, category, branch_id, availability) values ('Water', 500, 'DRINKS', $1, true) returning id`,
    [branchId]
  );
  const waterId = waterRows[0].id;
  await pool.query(`insert into product_question (product_id, question) values ($1, 'Cold or not?')`, [waterId]);
  const { rows: jollofRows } = await pool.query(
    `insert into product (name, price, category, branch_id) values ('Jollof Rice', 3500, 'MAINS', $1) returning id`,
    [branchId]
  );
  const jollofId = jollofRows[0].id;

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348011110080', channel: 'whatsapp', branchId });
  const { rows: sessionRows } = await pool.query(`insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning *`, [table.id, branchId, customer.id]);
  const session = sessionRows[0];
  const order = await flow.getOrCreateTableOrder(session, table, customer);
  await pool.query(`insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, 3500, $3)`, [order.id, jollofId, customer.id]);
  await pool.query(`update "order" set pending_upsell_category = 'drinks' where id = $1`, [order.id]);

  // A real tap on the upsell's own WhatsApp list -- same as
  // sandbox/test-upsell-attribution.mjs, leaves pending_question_order_item_id
  // pointing at the new Water line (it has an unanswered question).
  await flow.handleUpsellListTap({ phoneNumber: '2348011110080', channelId: '2348011110080', rowId: `upsell::${waterId}`, channel: 'whatsapp', branchId });

  const { rows: orderBefore } = await pool.query(`select pending_question_order_item_id from "order" where id = $1`, [order.id]);
  assert(orderBefore[0].pending_question_order_item_id !== null, 'sanity check: the order really does have a pending question pointer set before the resubmit');

  const guestToken = await flow.ensureMenuToken(customer);
  const { rows: qRows } = await pool.query(`select id from product_question where product_id = $1`, [waterId]);
  const questionId = qRows[0].id;
  // Exactly what the web page's own submitOrder() sends -- the whole
  // basket, water now answered "cold" through the question sheet
  // (purely client-side, no server call of its own).
  const reviewRes = await fetch(`${BASE}/t/qrpendingq/review?g=${guestToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [
        { productId: jollofId, quantity: 1, answers: {} },
        { productId: waterId, quantity: 1, answers: { [questionId]: 'cold' } },
      ],
    }),
  });
  assert(reviewRes.status === 200, `resubmitting the basket after answering the pending-question item on the web page succeeds, not a hang/crash (got ${reviewRes.status})`);

  const { rows: orderAfter } = await pool.query(`select pending_question_order_item_id, pending_question_id from "order" where id = $1`, [order.id]);
  assert(orderAfter[0].pending_question_order_item_id === null && orderAfter[0].pending_question_id === null, 'the stale pending-question pointer is cleared, not left dangling on the new rows');

  const { rows: waterAnswer } = await pool.query(
    `select oa.answer from order_item oi join order_item_answer oa on oa.order_item_id = oi.id where oi.order_id = $1 and oi.product_id = $2`,
    [order.id, waterId]
  );
  assert(waterAnswer[0]?.answer === 'cold', 'the real answer ("cold") actually persisted through the resubmit');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
