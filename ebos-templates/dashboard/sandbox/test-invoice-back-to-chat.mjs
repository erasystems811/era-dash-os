// Chidera, 2026-09-23, live report: "when i open an invoice it seems like
// im stuck i cant go back to the web whatsapp i have to go back to main
// chat." The invoice page is reached by tapping the invoice bubble's link
// ON the /wa chat page -- a normal same-tab navigation that replaces the
// chat page in whatever browser (often WhatsApp's own in-app one) is
// showing it, with nothing pointing back. Fixed with a "Back to chat" link,
// shown only when this customer actually has a menu_token (genuinely
// reached via the web-chat flow) -- a customer who got their invoice PDF
// straight over WhatsApp/Instagram has no chat page to return to.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3940';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3940';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3940';

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

  // === A web-chat customer (has a real menu_token) -- must get the link ===
  const webChatCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012348001', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(webChatCustomer);
  const { rows: order1 } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state)
     values ($1, 'REF-INV-1', 'pickup', $2, 'new', 'pending', 'confirm_payment') returning *`,
    [webChatCustomer.id, product.price]
  );
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order1[0].id, product.id, product.price]);

  const html1 = await (await fetch(`${BASE}/documents/invoice/${order1[0].id}`)).text();
  assert(html1.includes('Back to chat'), 'a customer who has a real chat page gets a way back to it');
  assert(html1.includes(`/wa/${token}`), 'the link points at their own real chat page, not a generic one');

  // === A customer who never touched web-chat (no menu_token at all) --
  // must NOT show a link that would go nowhere useful. ===
  const plainCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012348002', channel: 'whatsapp' });
  const { rows: order2 } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state)
     values ($1, 'REF-INV-2', 'pickup', $2, 'new', 'pending', 'confirm_payment') returning *`,
    [plainCustomer.id, product.price]
  );
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order2[0].id, product.id, product.price]);

  const html2 = await (await fetch(`${BASE}/documents/invoice/${order2[0].id}`)).text();
  assert(!html2.includes('Back to chat'), 'a customer with no real chat page to return to gets no dead-end link');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
