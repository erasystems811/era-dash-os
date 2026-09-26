// Chidera, 2026-09-26: "receipt too is taking me to facebook" -- same root
// cause and fix as test-instagram-invoice-link.mjs: sendReceiptMessage used
// to send Instagram customers the receipt as a raw PDF file attachment
// (sendInstagramDocument), which Instagram's own client opens through a
// Facebook-branded document viewer instead of a normal web page. Verifies
// Instagram now gets a plain text link to the real HTML receipt page
// instead, and never a PDF attachment.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3952';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3952';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3952';

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

  const { rows: prodRows } = await pool.query(`insert into product (name, price) values ('Jollof Rice', 2500) returning id`);
  const customer = await flow.findOrCreateCustomer({ phoneNumber: 'ig-user-2', channel: 'instagram' });

  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-IG-RECEIPT-1', 'pickup', 2500, 'preparation', 'confirmed', 'fulfilment', 'instagram') returning id`,
    [customer.id]
  );
  const order = orderRows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, 2500)`, [order.id, prodRows[0].id]);

  await flow.sendReceiptMessage(customer, order);

  const { rows: messages } = await pool.query(
    `select body, trigger from message where customer_id = $1 and direction = 'outbound' order by created_at`,
    [customer.id]
  );

  assert(!messages.some((m) => m.trigger === 'receipt_pdf'), 'no PDF-file-attachment message was logged for an Instagram customer');
  const receiptLine = messages.find((m) => /receipt/i.test(m.body));
  assert(!!receiptLine, 'a receipt message was still sent');
  assert(receiptLine?.body.includes('Your payment has been received.'), `it still opens with the real payment-received confirmation (got "${receiptLine?.body}")`);
  assert(receiptLine?.body.includes(`/documents/receipt/${order.id}`), `the receipt message links to the plain HTML receipt page (got "${receiptLine?.body}")`);
  assert(!receiptLine?.body.includes('/pdf'), 'the receipt link does NOT point at the /pdf route');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
