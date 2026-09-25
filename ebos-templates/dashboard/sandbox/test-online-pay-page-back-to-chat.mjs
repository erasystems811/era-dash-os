// Chidera, 2026-09-25: "when a payment is made and successful, customer
// get stuck at payment successful, it should re route them back to web
// chat." routes/menu-page.js's GET /:token/pay (renderSingleOrderPayPage)
// showed a "Payment confirmed. Thank you!" banner with no way back to the
// web chat at all -- a genuine dead end, same class of gap as the earlier
// "web menu should have a back to chat" fix, just on this page instead.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3978';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3978';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3978';

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

  const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);
  const product = prodRows[0];
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348013380080', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-PAYBACK', 'pickup', $2, 'new', 'confirmed', 'confirm_payment', 'whatsapp') returning *`,
    [customer.id, product.price]
  );
  const order = orderRows[0];
  await pool.query(
    `insert into order_payment (order_id, provider, reference, amount, status, confirmed_at) values ($1, 'paystack', 'REF-PAYBACK-P', $2, 'confirmed', now())`,
    [order.id, product.price]
  );

  // === 1. Never visited the web chat -- no back-to-chat link on the
  // confirmed banner, nothing to go back to yet. ===
  const before = await (await fetch(`${BASE}/m/${token}/pay`)).text();
  assert(before.includes('Payment confirmed. Thank you!'), 'the confirmed banner shows (payment already confirmed)');
  assert(!before.includes('class="backToChat"'), 'but no back-to-chat link for a guest who never visited the web chat');

  // === 2. Genuinely visited the web chat first -- the real fix, same gate
  // every other back-to-chat link on this page family already uses. ===
  await fetch(`${BASE}/wa/${token}`);
  const after = await (await fetch(`${BASE}/m/${token}/pay`)).text();
  assert(after.includes('class="backToChat"'), 'after a genuine web-chat visit, the confirmed banner shows a back-to-chat link');
  const hrefMatch = after.match(/class="backToChat" href="([^"]*)"/);
  assert(hrefMatch && hrefMatch[1] === `/wa/${token}`, 'and it points at the real web chat thread');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
