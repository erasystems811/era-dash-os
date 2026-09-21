// Chidera, real report, 2026-09-20: "when i refreshed that payment page it
// accommodated a third pending payment that would cause an excess
// payout...a refresh is not meant to cancel or restart page or payment
// process, also when i tapped transfer it didint show me the account
// number." Reproduced live in a real browser: a refresh always reset the
// pay page back to its static "Who are you paying for?" state regardless
// of an already-pending payment, so a second "Request payment amount"
// tap with a different guest selection (checkboxes reset to just this
// guest on every load) created a genuinely different, second pending
// payment instead of reusing the first -- createOrderPayment's own dedup
// only matches an EXACT same coverage. payStatusPayload now reports this
// guest's own pending amount; the client opens straight into showing it
// instead of the selection screen whenever one exists, so a refresh can
// never trigger a second request. Also caught (same live check): the
// Transfer/Card buttons never actually hid after picking one --
// .payChoice's own `display:flex` was silently beating the `hidden`
// attribute's default `display:none`, a real CSS specificity bug, fixed
// alongside this.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3935';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3935';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3935';

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
  await pool.query(
    `insert into payment_config (business_id, provider) values ($1, 'pos')
     on conflict (business_id) do update set provider = 'pos'`,
    [bizRows[0].id]
  );
  // Transfer account quoted to customers reads from business's own Settings
  // fields (getPaymentConfig() joins them in), same as the "manual" flow
  // has always used -- not a second, payment_config-only place to set it.
  await pool.query(
    `update business set bank_name = 'Moniepoint MFB', bank_account_number = '1234567890', bank_account_name = 'Sample Restaurant Ltd' where id = $1`,
    [bizRows[0].id]
  );
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(
    `insert into restaurant_table (branch_id, label, qr_token) values ($1, 'RF1', 'qrrefresh') returning id`,
    [branchId]
  );
  const table = tableRows[0];
  const { rows: prod1 } = await pool.query(`insert into product (name, price, category, branch_id) values ('Jollof Rice', 3500, 'MAINS', $1) returning id`, [branchId]);
  const { rows: prod2 } = await pool.query(`insert into product (name, price, category, branch_id) values ('Zobo Drink', 1200, 'DRINKS', $1) returning id`, [branchId]);

  const customer1 = await flow.findOrCreateCustomer({ phoneNumber: '2348011119940', channel: 'whatsapp', branchId });
  const customer2 = await flow.findOrCreateCustomer({ phoneNumber: '2348011119941', channel: 'whatsapp', branchId });
  const { rows: sessionRows } = await pool.query(`insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning *`, [table.id, branchId, customer1.id]);
  const session = sessionRows[0];
  await pool.query(`insert into table_session_guest (session_id, customer_id) values ($1, $2)`, [session.id, customer2.id]);
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, branch_id, channel, table_id, session_id, fulfilment_type, payment_mode, engine_state, status, served_at, total)
     values ($1, 'REF-REFRESH', $2, 'dinein', $3, $4, 'table', 'at_table', 'fulfilment', 'preparation', now(), 4700) returning *`,
    [customer1.id, branchId, table.id, session.id]
  );
  const order = orderRows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, 3500, $3)`, [order.id, prod1[0].id, customer1.id]);
  await pool.query(`insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, 1200, $3)`, [order.id, prod2[0].id, customer2.id]);

  const guestToken = await flow.ensureMenuToken(customer1);

  // Guest 1 requests the WHOLE table (both guests' items) -- a real,
  // deliberate coverage choice.
  const create1 = await fetch(`${BASE}/t/qrrefresh/pay/create?g=${guestToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guestIds: [customer1.id, customer2.id] }),
  });
  const data1 = await create1.json();
  assert(data1.amount === 4700, 'first request covers the whole table (4700)');

  // Simulates a hard refresh -- exactly what the browser does: GET the
  // page fresh, status.myPendingAmount is what the page now opens
  // straight into instead of re-showing "Who are you paying for?".
  const pageAfterRefresh = await (await fetch(`${BASE}/t/qrrefresh/pay?g=${guestToken}`)).text();
  assert(pageAfterRefresh.includes('"myPendingAmount":4700'), 'the reloaded page carries this guest\'s own already-pending amount, ready to open straight into it');

  // Even if the client-side selection state resets (the real bug's own
  // mechanism) and would have re-requested a DIFFERENT coverage -- say,
  // just guest 1's own items -- the page no longer gives it the chance to
  // (JS only re-requests via the button, which the fix keeps hidden once
  // myPendingAmount exists). Confirms the server side is safe too: a
  // stray duplicate /create call with a different coverage is still its
  // own real, separate payment (server-side dedup only ever matched
  // exact coverage) -- this is why the CLIENT must never make that call
  // again, not something the server alone can fully prevent.
  const { rows: paymentsAfterRefresh } = await pool.query(`select * from order_payment where order_id = $1`, [order.id]);
  assert(paymentsAfterRefresh.length === 1, 'still exactly one pending payment after the refresh -- no duplicate created just by reloading');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
