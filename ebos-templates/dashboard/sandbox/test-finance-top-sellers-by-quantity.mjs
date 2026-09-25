// Chidera, 2026-09-25: "i never said top sellers by revenue i said how
// much revenue top sellers have generated, its different cause the top
// sellers are different price and highest seller may not be the most
// revenue." Verifies GET /finance/summary's topSellers is ranked by units
// sold, not by revenue -- a cheap item sold many times must outrank an
// expensive item sold rarely even though the expensive one earned more.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3945';
process.env.SESSION_SECRET = 'testsecret';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3945';

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

  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@samplerestaurant.test', password: 'testpass123' }),
  });
  const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert(loginRes.status === 200 && !!cookie, 'staff login succeeded, got a real session cookie');
  const authed = (url) => fetch(url, { headers: { cookie } });

  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: custRows } = await pool.query(`insert into customers (phone_number, branch_id) values ('2348055550006', $1) returning id`, [branchId]);
  const customerId = custRows[0].id;

  // Cheap item, sold a LOT (20 units x NGN200 = NGN4000 revenue).
  const { rows: cheapProd } = await pool.query(`insert into product (name, price, branch_id) values ('Puff Puff', 200, $1) returning id`, [branchId]);
  // Expensive item, sold RARELY (2 units x NGN5000 = NGN10000 revenue -- more revenue, fewer units).
  const { rows: pricyProd } = await pool.query(`insert into product (name, price, branch_id) values ('Whole Chicken Platter', 5000, $1) returning id`, [branchId]);

  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, branch_id, fulfilment_type, status, payment_status, total)
     values ($1, 'REF-TOPSELL', $2, 'pickup', 'completed', 'confirmed', 14000) returning id`,
    [customerId, branchId]
  );
  const orderId = orderRows[0].id;
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 20, 200)`, [orderId, cheapProd[0].id]);
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 2, 5000)`, [orderId, pricyProd[0].id]);

  const summary = await (await authed(`${BASE}/api/finance/summary`)).json();
  const [first, second] = summary.topSellers;
  assert(first.name === 'Puff Puff', `the 20-unit seller ranks first despite earning less revenue (got "${first?.name}" first)`);
  assert(first.quantity === 20 && first.revenue === 4000, `Puff Puff: 20 units, NGN4000 revenue (got ${first.quantity} units, NGN${first.revenue})`);
  assert(second.name === 'Whole Chicken Platter', `the higher-revenue, lower-quantity item ranks SECOND, not first (got "${second?.name}" second)`);
  assert(second.quantity === 2 && second.revenue === 10000, `Whole Chicken Platter: 2 units, NGN10000 revenue -- more revenue but ranks lower (got ${second.quantity} units, NGN${second.revenue})`);

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
