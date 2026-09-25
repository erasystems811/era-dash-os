// Chidera, 2026-09-25: "after payment is confirmed instead of the bare
// payment received, send customer a receipt, but receipt shouldnt look
// like invoice it is a receipt." Verifies:
// 1. routes/documents.js's new receiptPage renders as a real RECEIPT, not
//    an invoice with a different title -- a PAID badge, "received from",
//    "how it was paid", and crucially none of the invoice's own
//    pending-payment language (Pay now, bank account box, "Billed to").
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

  await pool.query(`update business set bank_name='GTBank', bank_account_number='0123456789', bank_account_name='Test Biz'`);
  const { rows: prodRows } = await pool.query(`insert into product (name, price) values ('Jollof Rice', 2500) returning id`);
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348066660007', channel: 'whatsapp' });

  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, payment_method)
     values ($1, 'REF-RECEIPT-1', 'pickup', 2500, 'confirmation', 'pending', 'confirm_payment', 'card') returning id`,
    [customer.id]
  );
  const orderId = orderRows[0].id;
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, 2500)`, [orderId, prodRows[0].id]);

  // === 1. The receipt page itself reads as a receipt, not an invoice ===
  const res = await fetch(`${BASE}/documents/receipt/${orderId}`);
  const html = await res.text();
  assert(res.status === 200, 'receipt page renders');
  assert(html.includes('RECEIPT'), 'says RECEIPT (got no match)');
  assert(html.includes('PAID'), 'shows a PAID badge');
  assert(html.includes('RECEIVED FROM'), 'says "received from", not "billed to"');
  assert(html.includes('HOW IT WAS PAID'), 'shows how it was paid');
  assert(html.includes('Card'), `shows the real payment method, card (checked substring "Card")`);
  assert(html.includes('Total paid'), 'says "Total paid"');
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
  assert(followUp.body.startsWith('Your receipt is attached above.'), `the follow-up text opens with the receipt line, not the old bare "Payment received" (got "${followUp.body}")`);
  assert(!sentMessages.some((m) => m.body === 'Payment received.'), 'the old bare "Payment received." text is never sent anymore');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
