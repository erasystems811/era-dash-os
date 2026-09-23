// Chidera, real report: "on the staff card let there be a clear
// demarcation for add on, so they know what has been served and what
// has just been added on." Confirms the served_item_snapshot diff:
// after marking served, a resubmit (full delete+reinsert, same as the
// real web review route) that adds more of an existing item AND a
// brand-new item shows the right split -- partial-new for the mixed
// line, fully-new for the brand-new one, untouched for anything that
// didn't change.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3923';
process.env.SESSION_SECRET = 'testsecret';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3923';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // The dine-in API routes are requireStaffApi-gated -- real staff
  // session, not a bypass. Log in as the sandbox seed's own owner
  // account and reuse the session cookie for every request below.
  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@samplerestaurant.test', password: 'testpass123' }),
  });
  // getSetCookie(), not headers.get('set-cookie') -- the latter collapses
  // multiple Set-Cookie headers (this app runs two cookie-session
  // instances, server.js's own comment explains why) into one unusable
  // string via the Fetch API's own header-folding.
  const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert(loginRes.status === 200 && !!cookie, 'staff login succeeded, got a real session cookie: ' + cookie);
  const authed = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), cookie } });

  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '14', 'qrtest14') returning id`, [branchId]);
  const table = tableRows[0];
  const { rows: prod1 } = await pool.query(`insert into product (name, price, category, branch_id) values ('Jollof Rice', 3500, 'MAINS', $1) returning id`, [branchId]);
  const { rows: prod2 } = await pool.query(`insert into product (name, price, category, branch_id) values ('Zobo Drink', 1200, 'DRINKS', $1) returning id`, [branchId]);
  const product1 = prod1[0].id;
  const product2 = prod2[0].id;
  const { rows: custRows } = await pool.query(`insert into customers (phone_number, branch_id) values ('2348011110014', $1) returning id`, [branchId]);
  const customerId = custRows[0].id;
  const { rows: sessionRows } = await pool.query(`insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning *`, [table.id, branchId, customerId]);
  const session = sessionRows[0];

  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, branch_id, channel, table_id, session_id, fulfilment_type, payment_mode, engine_state, status)
     values ($1, 'REF-DIFF', $2, 'dinein', $3, $4, 'table', 'at_table', 'fulfilment', 'preparation') returning *`,
    [customerId, branchId, table.id, session.id]
  );
  const order = orderRows[0];
  // 2x Jollof Rice, the original round -- staff serves it.
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 2, 3500)`, [order.id, product1]);

  const servedRes = await authed(`${BASE}/api/dinein/orders/${order.id}/served`, { method: 'POST' });
  const servedBody = await servedRes.text();
  assert(servedRes.status === 200, `served route accepted (got ${servedRes.status}: ${servedBody.slice(0, 300)})`);

  // Now the guest adds 3 MORE jollof (mixed line: 2 already served + 3
  // new) and a brand-new Zobo Drink -- same full delete+reinsert shape
  // the real web review route uses.
  await pool.query(`delete from order_item where order_id = $1`, [order.id]);
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 5, 3500)`, [order.id, product1]); // was 2, now 5
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 2, 1200)`, [order.id, product2]); // brand new

  // (pending is served_at-is-null only; this order is still served_at-set
  // since nothing's reset it, so /serving is the real list to check.)
  const servingRes = await authed(`${BASE}/api/dinein/orders/serving`);
  const servingList = await servingRes.json();
  const found = servingList.find((o) => o.id === order.id);
  assert(!!found, 'the order shows up in the serving list');
  const jollof = found.items.find((i) => i.product_id === product1);
  const zobo = found.items.find((i) => i.product_id === product2);
  assert(jollof?.quantity === 5 && jollof?.newQty === 3, 'mixed line correctly shows 3 new out of 5 total (2 were already served)');
  assert(zobo?.quantity === 2 && zobo?.newQty === 2, 'brand-new line correctly shows fully new');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
