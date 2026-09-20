// Quick regression smoke test for routes/menu-page.js (general, non-dine-in
// web ordering) after joint dine-in Stage 1 touched shared code in
// menu-page-template.js (renderMenuPage's signature, basket line shape in
// changeQty/qSheetAdd). Confirms the general-ordering page still renders
// and a plain order submit still works -- POLL_PATH is never passed here,
// so this also confirms the poll code stays fully inert on this route.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3913';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3913';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3913';

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

  const { rows: prodRows } = await pool.query(`select id from product limit 1`);
  const productId = prodRows[0].id;

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348099990000', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);

  const page = await fetch(`${BASE}/m/${token}`);
  assert(page.status === 200, 'general ordering page loads');
  const html = await page.text();
  assert(html.includes('POLL_PATH = null'), 'POLL_PATH stays null on the non-dine-in page (no shared-order polling)');

  const review = await fetch(`${BASE}/m/${token}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId, quantity: 2, answers: {} }] }),
  });
  const reviewData = await review.json();
  assert(review.status === 200 && reviewData.ok, 'general order submit still succeeds');

  const { rows: orderRows } = await pool.query(`select * from "order" where customer_id = $1`, [customer.id]);
  assert(orderRows.length === 1, 'exactly one order created');
  const { rows: items } = await pool.query(`select * from order_item where order_id = $1`, [orderRows[0].id]);
  assert(items.length === 1 && items[0].quantity === 2, 'order item correctly persisted');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
