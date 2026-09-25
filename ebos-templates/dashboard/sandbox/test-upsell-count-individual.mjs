// Chidera, 2026-09-25: "NO ERA DEMO MULTIPLE UPSELL SHOULD BE CALCULATED
// LIKE THAT ALL INDIVIDUAL, AND MY BOARD SHOWS 1/1 FOR UPSELL MEANING IT
// HAS ONLY RECOEDED 1" -- era-demo's real orders offer several upsell
// groups per order (e.g. ["protein","side","drink"]), but both
// computeUpsellStats (routes/api.js, /customers/stats) and the
// business_metrics_log trigger (migrations/0065) used to only look at the
// array's LAST entry. Verifies an order that offers 3 groups where only 2
// actually match now counts as 3 offered / 2 accepted in BOTH places, not
// 1/1 or 1/0.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3948';
process.env.SESSION_SECRET = 'testsecret';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3948';

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

  const { rows: custRows } = await pool.query(`insert into customers (phone_number) values ('2348088880009') returning id`);
  const customerId = custRows[0].id;

  // Only 'drink' and 'snack' actually landed in the final order -- 'protein' was offered but declined.
  const { rows: drinkProd } = await pool.query(`insert into product (name, price, category) values ('Zobo', 500, 'Drinks') returning id`);
  const { rows: snackProd } = await pool.query(`insert into product (name, price, category) values ('Puff Puff', 300, 'Snacks') returning id`);

  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, upsell_offered)
     values ($1, 'REF-MULTI-1', 'pickup', 800, 'new', 'pending', 'confirm_payment', array['protein','snack','drink']) returning id`,
    [customerId]
  );
  const orderId = orderRows[0].id;
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, 500)`, [orderId, drinkProd[0].id]);
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, 300)`, [orderId, snackProd[0].id]);
  await pool.query(`update "order" set status = 'completed', engine_state = 'completed', completed_at = now() where id = $1`, [orderId]);

  // === 1. business_metrics_log (the trigger) counts each entry individually ===
  const { rows: logRows } = await pool.query(`select metric, count(*) as count from business_metrics_log where metric like 'upsell_%' group by metric`);
  const offeredLog = Number(logRows.find((r) => r.metric === 'upsell_offered')?.count || 0);
  const acceptedLog = Number(logRows.find((r) => r.metric === 'upsell_accepted')?.count || 0);
  assert(offeredLog === 3, `business_metrics_log: 3 individual offers logged (got ${offeredLog})`);
  assert(acceptedLog === 2, `business_metrics_log: 2 of them (drink, snack) logged as accepted, protein did not (got ${acceptedLog})`);

  // === 2. computeUpsellStats (/customers/stats) counts the same way ===
  const stats = await (await authed(`${BASE}/api/customers/stats`)).json();
  assert(stats.upsellOffered === 3, `customers/stats: upsellOffered is 3, not 1 (got ${stats.upsellOffered})`);
  assert(stats.upsellAccepted === 2, `customers/stats: upsellAccepted is 2, not 1 or 0 (got ${stats.upsellAccepted})`);

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
