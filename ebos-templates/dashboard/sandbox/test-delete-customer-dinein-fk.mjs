// Chidera, 2026-09-25, real report: "im trying to delete a conversation on
// dashboard why isnt it deleting?" Root cause, confirmed by reading:
// message.table_session_id (migration 0066, no cascade) is a foreign key
// to table_session -- DELETE /api/customers/:id used to delete
// table_session BEFORE message, so any customer with even one dine-in
// message hit a foreign key violation and the whole delete rolled back.
// Same exact bug class this route's own history already documents for
// rider_payout/feedback/waiter_call -- table_session/message just joined
// the list. Fixed by deleting message before table_session.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3977';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3977';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3977';

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
  const authed = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), cookie } });

  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length
    ? existingBranch[0].id
    : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '61', 'qrdel61') returning id`, [branchId]);
  const table = tableRows[0];

  // A real customer with a real, still-open dine-in table_session AND a
  // real message carrying that session's own table_session_id -- exactly
  // the shape that used to break this delete.
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348013380070', channel: 'whatsapp' });
  const { rows: sessionRows } = await pool.query(
    `insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning *`,
    [table.id, branchId, customer.id]
  );
  const session = sessionRows[0];
  await pool.query(
    `insert into message (customer_id, direction, channel, sender, body, trigger, table_session_id) values ($1, 'outbound', 'website', 'bot', 'Welcome to Table 61', 'dinein_greeting', $2)`,
    [customer.id, session.id]
  );

  const delRes = await authed(`${BASE}/api/customers/${customer.id}`, { method: 'DELETE' });
  const delBody = await delRes.json();
  assert(delRes.status === 200 && delBody.ok === true, `the delete succeeds instead of 500ing on the foreign key (got ${delRes.status}: ${JSON.stringify(delBody)})`);

  const { rows: customerAfter } = await pool.query(`select 1 from customers where id = $1`, [customer.id]);
  const { rows: messageAfter } = await pool.query(`select 1 from message where customer_id = $1`, [customer.id]);
  const { rows: sessionAfter } = await pool.query(`select 1 from table_session where id = $1`, [session.id]);
  assert(customerAfter.length === 0, 'the customer row is genuinely gone');
  assert(messageAfter.length === 0, 'the message row is genuinely gone too');
  assert(sessionAfter.length === 0, 'and the table_session row is genuinely gone too -- nothing left orphaned');

  // Chidera, 2026-10-01, real report: "i cant even delete a conversation in
  // era demo" -- still not deleting after the 2026-09-20/09-25 fixes above.
  // Three more gaps, none of them this customer's own orders this time --
  // a GUEST showing up on someone ELSE's shared table order (joint
  // dine-in lets any guest add items or pay toward the bill), plus a
  // complaint this route never touched at all.
  const owner = await flow.findOrCreateCustomer({ phoneNumber: '2348013380071', channel: 'whatsapp' });
  const guest = await flow.findOrCreateCustomer({ phoneNumber: '2348013380072', channel: 'whatsapp' });
  const { rows: guestTableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '62', 'qrdel62') returning id`, [branchId]);
  const guestTable = guestTableRows[0];
  const { rows: guestSessionRows } = await pool.query(
    `insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning *`,
    [guestTable.id, branchId, owner.id]
  );
  const guestSession = guestSessionRows[0];
  await pool.query(`insert into table_session_guest (session_id, customer_id) values ($1, $2)`, [guestSession.id, guest.id]);
  const { rows: productRows } = await pool.query(`select id, price from product limit 1`);
  const product = productRows[0];
  const { rows: ownerOrderRows } = await pool.query(
    `insert into "order" (customer_id, reference, branch_id, channel, table_id, session_id, fulfilment_type, payment_mode, engine_state, status)
     values ($1, $2, $3, 'dinein', $4, $5, 'table', 'at_table', 'collect_info', 'new') returning *`,
    [owner.id, 'DELFK-' + Date.now(), branchId, guestTable.id, guestSession.id]
  );
  const ownerOrder = ownerOrderRows[0];
  // The guest added an item to the OWNER's shared order -- added_by_customer_id
  // is the guest, order_id belongs to the owner, so deleting the owner's
  // orders (this route's own first pass) never touches this row at all.
  await pool.query(
    `insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, $3, $4)`,
    [ownerOrder.id, product.id, product.price, guest.id]
  );
  // Same shape for a split/joint payment -- the guest paid, the order is
  // the owner's.
  await pool.query(
    `insert into order_payment (order_id, reference, amount, paid_by_customer_id) values ($1, $2, $3, $4)`,
    [ownerOrder.id, 'DELFKPAY-' + Date.now(), product.price, guest.id]
  );
  await pool.query(`insert into complaint (customer_id, message) values ($1, $2)`, [guest.id, 'Test complaint for delete-guest coverage']);

  const delGuestRes = await authed(`${BASE}/api/customers/${guest.id}`, { method: 'DELETE' });
  const delGuestBody = await delGuestRes.json();
  assert(delGuestRes.status === 200 && delGuestBody.ok === true, `deleting a GUEST who added items/paid on someone else's order also succeeds, not a 500 (got ${delGuestRes.status}: ${JSON.stringify(delGuestBody)})`);

  const { rows: guestAfter } = await pool.query(`select 1 from customers where id = $1`, [guest.id]);
  assert(guestAfter.length === 0, 'the guest row is genuinely gone');
  const { rows: complaintAfter } = await pool.query(`select 1 from complaint where customer_id = $1`, [guest.id]);
  assert(complaintAfter.length === 0, "the guest's own complaint is gone too");
  const { rows: ownerOrderAfter } = await pool.query(`select 1 from "order" where id = $1`, [ownerOrder.id]);
  assert(ownerOrderAfter.length === 1, "the OWNER's order survives -- deleting the guest never touches someone else's real order");
  const { rows: itemAfter } = await pool.query(`select added_by_customer_id from order_item where order_id = $1`, [ownerOrder.id]);
  assert(itemAfter.length === 1 && itemAfter[0].added_by_customer_id === null, "the owner's order_item survives too, just with the guest's attribution cleared (not deleted)");
  const { rows: paymentAfter } = await pool.query(`select paid_by_customer_id from order_payment where order_id = $1`, [ownerOrder.id]);
  assert(paymentAfter.length === 1 && paymentAfter[0].paid_by_customer_id === null, "the owner's order_payment survives too, same attribution-cleared-not-deleted treatment");

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
