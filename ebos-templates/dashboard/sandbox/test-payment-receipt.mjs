// Chidera, 2026-09-25: "after payment is confirmed instead of the bare
// payment received, send customer a receipt, but receipt shouldnt look
// like invoice it is a receipt" -- then, same day, on the first version:
// "the styling of the receipt i dont like it, it looks almost like the
// invoice, have you seen all these paystack them receipt before?" Verifies:
// 1. routes/documents.js's receiptPage reads as a real payment-processor
//    receipt (checkmark badge, big amount, clean detail rows), not the
//    invoice's wide bordered item table with different words on it.
// 2. engine/flow.js's completePayment (the real "payment confirmed"
//    choke point every webhook and the staff manual confirm route both
//    go through) actually sends that receipt as a WhatsApp document
//    instead of the old bare "Payment received" text.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3946';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3946';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3946';

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

  await pool.query(`update business set bank_name='GTBank', bank_account_number='0123456789', bank_account_name='Test Biz', brand_color='#7A2E8F'`);
  const { rows: prodRows } = await pool.query(`insert into product (name, price) values ('Jollof Rice', 2500) returning id`);
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348066660007', channel: 'whatsapp' });

  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, payment_method)
     values ($1, 'REF-RECEIPT-1', 'pickup', 2500, 'confirmation', 'pending', 'confirm_payment', 'card') returning id`,
    [customer.id]
  );
  const orderId = orderRows[0].id;
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, 2500)`, [orderId, prodRows[0].id]);

  // === 1. The receipt page reads as a real payment receipt (Paystack/
  // Stripe-style: checkmark, big amount, clean detail rows), not the
  // invoice's wide bordered item table with a different title stuck on top ===
  const res = await fetch(`${BASE}/documents/receipt/${orderId}`);
  const html = await res.text();
  assert(res.status === 200, 'receipt page renders');
  assert(html.includes('Payment successful'), 'shows the "Payment successful" headline');
  assert(html.includes('check-badge'), 'shows the checkmark badge, not a text PAID stamp');
  assert(html.includes('Received from'), 'says "Received from", not "Billed to"');
  assert(html.includes('Paid via'), 'shows how it was paid');
  assert(html.includes('Card'), 'shows the real payment method, card (checked substring "Card")');
  assert(html.includes('NGN 2,500.00'), 'shows the paid amount, formatted');
  assert(html.includes('#7A2E8F'), 'checkmark/headline use the business\'s own brand_color, not a fixed green');
  assert(!html.includes('<table>'), 'does NOT use the invoice\'s wide bordered item table -- a plain list instead');
  assert(!html.includes('BILLED TO'), 'does NOT say "Billed to" (invoice-only language)');
  assert(!html.includes('Pay now'), 'does NOT show a Pay now button -- it is already paid');
  assert(!html.includes('PAYMENT INFORMATION'), 'does NOT show the invoice\'s own "Payment information" box');
  assert(!html.includes('Account:'), 'does NOT show bank account details -- nothing left to pay');

  // === 2. completePayment sends the receipt, not the old bare text ===
  await flow.completePayment(orderId);
  const { rows: sentMessages } = await pool.query(
    `select body, trigger from message where customer_id = $1 and direction = 'outbound' order by created_at`,
    [customer.id]
  );
  const receiptRow = sentMessages.find((m) => m.trigger === 'receipt_pdf');
  assert(!!receiptRow, 'a [receipt PDF] message was logged for this send');
  assert(receiptRow?.body.includes('/documents/receipt/'), `the logged receipt message points at the real receipt URL (got "${receiptRow?.body}")`);
  const followUp = sentMessages[sentMessages.length - 1];
  assert(followUp.body.startsWith('Your payment has been received. Your receipt is attached above.'), `the follow-up text opens with the real "payment received" confirmation + the receipt line, not the old bare "Payment received" (got "${followUp.body}")`);
  assert(!sentMessages.some((m) => m.body === 'Payment received.'), 'the old bare "Payment received." text is never sent anymore');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
