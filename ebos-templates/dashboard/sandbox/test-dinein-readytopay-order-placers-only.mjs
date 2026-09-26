// Chidera, 2026-09-25 (live report): "the whole ready to pay should come
// on bare chat once only for people who actually placed an order not just
// everyone on the table." notifyGuestsReadyToPay used to notify EVERY
// guest who'd ever scanned or joined the table's session (table_session_guest
// + table_session.customer_id), even one who tagged along and never
// actually ordered anything -- nothing for them to pay for, no reason for
// them to get a "ready to pay" bubble or a real WhatsApp ping. Confirms
// only guests with their own real order_item lines on this exact order
// get notified.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3992';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3992';
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
  const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '40', 'qrplacers40') returning id`, [branchId]);
  const { rows: prodRows } = await pool.query(`insert into product (name, price, category, branch_id) values ('Jollof Rice', 3500, 'MAINS', $1) returning id, price`, [branchId]);

  const orderer = await flow.findOrCreateCustomer({ phoneNumber: '2348013390140', channel: 'whatsapp' });
  // A real guest who scanned/joined this exact table's session (so they
  // show up in table_session_guest, the OLD, too-broad source this
  // function used to notify from) but never actually ordered anything.
  const tagAlong = await flow.findOrCreateCustomer({ phoneNumber: '2348013390141', channel: 'whatsapp' });

  const { rows: sessionRows } = await pool.query(
    `insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning *`,
    [tableRows[0].id, branchId, orderer.id]
  );
  const session = sessionRows[0];
  await pool.query(`insert into table_session_guest (session_id, customer_id) values ($1, $2) on conflict do nothing`, [session.id, tagAlong.id]);

  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, session_id, table_id, branch_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel, payment_mode)
     values ($1, $2, $3, $4, 'REF-PLACERS40', 'table', 3500, 'preparation', 'pending', 'fulfilment', 'dinein', 'at_table') returning *`,
    [orderer.id, session.id, tableRows[0].id, branchId]
  );
  const order = orderRows[0];
  // Only the real orderer has an order_item line -- addedBy correctly
  // attributed, same as the real /review route already does.
  await pool.query(`insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, $3, $4)`, [order.id, prodRows[0].id, prodRows[0].price, orderer.id]);

  await flow.notifyGuestsReadyToPay(order);

  const { rows: ordererMsgs } = await pool.query(
    `select 1 from message where customer_id = $1 and trigger = 'dinein_ready_to_pay'`,
    [orderer.id]
  );
  assert(ordererMsgs.length === 1, 'the guest who actually placed the order gets their real "ready to pay" bubble');

  const { rows: tagAlongMsgs } = await pool.query(
    `select 1 from message where customer_id = $1 and trigger = 'dinein_ready_to_pay'`,
    [tagAlong.id]
  );
  assert(tagAlongMsgs.length === 0, 'the guest who just tagged along (joined the table, never ordered anything) gets NOTHING -- nothing for them to pay for');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
