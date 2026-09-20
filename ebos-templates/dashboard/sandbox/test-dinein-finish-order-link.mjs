// Chidera, real report: "i tapped the finish my order to add, i saw an
// empty cart." Root cause: finishItemsCollection's "Finish my order" link
// (sendWebMenuLink) always built /m/<this customer's own token>, which
// routes/menu-page.js resolves via getOpenOrder(customer.id) -- fine for
// a normal order (order.customer_id IS that customer), wrong for a joint
// dine-in order, where order.customer_id is always the table's ORIGINAL
// scanner, never whichever guest is actually mid-conversation. Confirms
// the link now correctly routes to the table's own /t/:qrToken page with
// THIS guest's own ?g= token instead, which resolves the shared order by
// session (not by whose customer_id happens to be on it) -- the one page
// that will actually show their basket instead of an empty one.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3920';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3920';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '13', 'qrtest13') returning id`, [branchId]);
  const table = tableRows[0];
  const { rows: prodRows } = await pool.query(`insert into product (name, price, category, branch_id) values ('Jollof Rice', 3500, 'MAINS', $1) returning id`, [branchId]);
  const productId = prodRows[0].id;
  await pool.query(`insert into product_question (product_id, question) values ($1, 'Peppered or not?')`, [productId]);

  const guest1 = await flow.findOrCreateCustomer({ phoneNumber: '2348011110013', channel: 'whatsapp', branchId });
  const guest2 = await flow.findOrCreateCustomer({ phoneNumber: '2348022220013', channel: 'whatsapp', branchId });

  // Session owned by guest 1 (the original scanner), same as any real
  // joint dine-in table -- order.customer_id is guest1's id.
  const { rows: sessionRows } = await pool.query(
    `insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning *`,
    [table.id, branchId, guest1.id]
  );
  const session = sessionRows[0];
  await pool.query(`insert into table_session_guest (session_id, customer_id) values ($1, $2), ($1, $3)`, [session.id, guest1.id, guest2.id]);

  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, branch_id, channel, table_id, session_id, fulfilment_type, payment_mode, engine_state, status)
     values ($1, 'REF-FOL', $2, 'dinein', $3, $4, 'table', 'at_table', 'collect_info', 'new') returning *`,
    [guest1.id, branchId, table.id, session.id]
  );
  const order = orderRows[0];
  // GUEST 2 added this item (typed in chat), with no answer yet to its
  // real question -- exactly the real-world case that triggers
  // finishItemsCollection's own "Finish my order" link.
  await pool.query(`insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, 3500, $3)`, [order.id, productId, guest2.id]);

  // finishItemsCollection called with GUEST 2 as the customer -- they're
  // the one currently being asked, same as the real dispatch() path would
  // do for whoever just typed the message that added this item.
  await flow.finishItemsCollection(guest2, order, '');

  const { rows: linkMsg } = await pool.query(
    `select body from message where customer_id = $1 and trigger = 'menu_shown' order by created_at desc limit 1`,
    [guest2.id]
  );
  const body = linkMsg[0]?.body || '';
  assert(body.includes('/t/qrtest13'), 'the "Finish my order" link now points at the dine-in table page, not the generic /m/ page');
  assert(/[?&]g=/.test(body), 'the link carries guest 2\'s own ?g= token, not the order-owner\'s');
  assert(!body.includes('/m/'), 'the old, wrong /m/ link is gone entirely for this dine-in case');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
