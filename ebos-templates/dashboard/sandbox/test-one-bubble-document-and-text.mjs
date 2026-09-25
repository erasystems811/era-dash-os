// Chidera, 2026-09-25: "then the receipt and the your receipt is attached
// should be in one chat, same with invoice, the invoice and pay now
// should be one chat....receipt doesnt have the back to chat"
//
// Two real gaps on the website channel:
// 1. The invoice document and the "your invoice is attached / pay now"
//    follow-up used to be TWO separate bubbles; same for the receipt and
//    its own follow-up. Both now land as ONE logMessage row (one bubble),
//    the document `interactive` payload carrying the link, the real
//    explanatory text in the SAME row's body.
// 2. The receipt page (routes/documents.js's receiptPage, rebuilt around
//    a payment-confirmation-card layout) never got the invoice page's own
//    "Back to chat" link ported over.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3956';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3956';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3956';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function latestOutbound(pool, customerId, channel) {
  const { rows } = await pool.query(
    `select body, trigger, interactive from message where customer_id = $1 and direction = 'outbound' and channel = $2 order by created_at desc limit 1`,
    [customerId, channel]
  );
  return rows[0] || null;
}

async function countOutbound(pool, customerId, channel) {
  const { rows } = await pool.query(
    `select count(*) as n from message where customer_id = $1 and direction = 'outbound' and channel = $2`,
    [customerId, channel]
  );
  return Number(rows[0].n);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const { rows: prodRows } = await pool.query(`insert into product (name, description, price, availability_type) values ('Jollof Rice', 'desc', 4500, 'stock') returning id, price`);
  const product = prodRows[0];
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012400001', channel: 'website' });
  await pool.query('update customers set web_chat_active_at = now() where id = $1', [customer.id]);

  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-ONEBUBBLE-1', 'pickup', $2, 'new', 'pending', 'confirm_payment', 'whatsapp') returning *`,
    [customer.id, product.price]
  );
  const order = orderRows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order.id, product.id, product.price]);

  // === 1. Invoice + pay line, ONE bubble ===
  const beforeCount = await countOutbound(pool, customer.id, 'website');
  await flow.sendPaymentInstructions(customer, order);
  const afterInvoice = await countOutbound(pool, customer.id, 'website');
  assert(afterInvoice === beforeCount + 1, `the invoice document AND the pay line landed as exactly ONE new website message, not two (got ${afterInvoice - beforeCount} new)`);

  const invoiceMsg = await latestOutbound(pool, customer.id, 'website');
  assert(invoiceMsg.interactive?.type === 'document', 'that one message carries the real document interactive payload');
  assert(/attached above/i.test(invoiceMsg.body), 'and its body has the real "attached above" follow-up text in the SAME bubble');

  const invoiceLinkRes = await fetch(invoiceMsg.interactive.url);
  assert(invoiceLinkRes.status === 200, `the invoice link itself resolves (got ${invoiceLinkRes.status})`);
  const invoiceHtml = await invoiceLinkRes.text();
  assert(/back-link/i.test(invoiceHtml) && /Back to chat/i.test(invoiceHtml), 'the invoice page itself still has its own back-to-chat link');

  // === 2. Receipt + delivery/pickup line, ONE bubble ===
  const beforeReceiptCount = await countOutbound(pool, customer.id, 'website');
  await pool.query('update customers set web_chat_active_at = now() where id = $1', [customer.id]);
  await flow.completePayment(order.id);
  const afterReceiptCount = await countOutbound(pool, customer.id, 'website');
  assert(afterReceiptCount === beforeReceiptCount + 1, `the receipt document AND the pickup/delivery line landed as exactly ONE new website message, not two (got ${afterReceiptCount - beforeReceiptCount} new)`);

  const receiptMsg = await latestOutbound(pool, customer.id, 'website');
  assert(receiptMsg.interactive?.type === 'document', 'that one message carries the real receipt document payload');
  assert(/attached above/i.test(receiptMsg.body) && /pick up/i.test(receiptMsg.body), 'and its body has BOTH the receipt line and the real pickup instructions in the SAME bubble');

  const receiptLinkRes = await fetch(receiptMsg.interactive.url);
  assert(receiptLinkRes.status === 200, `the receipt link itself resolves (got ${receiptLinkRes.status})`);
  const receiptHtml = await receiptLinkRes.text();
  assert(/back-link/i.test(receiptHtml) && /Back to chat/i.test(receiptHtml), 'the receipt page now has a real back-to-chat link too, same as the invoice');

  // === 3. Chidera, 2026-09-25, follow-up: "when i said invoice and pay
  // now in same chat i meant itll have 2 buttons not just the pay now in
  // the invoice." With a real online payment link (Paystack) configured,
  // the SAME one bubble must carry TWO real buttons -- view the invoice,
  // and pay now -- not rely on the invoice page's own embedded button. ===
  process.env.PAYMENT_PROVIDER = 'paystack';
  process.env.PAYMENT_SECRET_KEY = 'sk_test_fake';
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('paystack.co/transaction/initialize')) {
      return { ok: true, json: async () => ({ data: { reference: 'PSK-2BTN-1', authorization_url: 'https://checkout.paystack.com/fake-2btn' } }) };
    }
    return realFetch(url, opts);
  };

  const customer2 = await flow.findOrCreateCustomer({ phoneNumber: '2348012400002', channel: 'website' });
  await pool.query('update customers set web_chat_active_at = now() where id = $1', [customer2.id]);
  const { rows: order2Rows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-ONEBUBBLE-2BTN', 'pickup', $2, 'new', 'pending', 'confirm_payment', 'whatsapp') returning *`,
    [customer2.id, product.price]
  );
  const order2 = order2Rows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order2.id, product.id, product.price]);

  await flow.sendPaymentInstructions(customer2, order2);
  global.fetch = realFetch;

  const twoBtnMsg = await latestOutbound(pool, customer2.id, 'website');
  assert(twoBtnMsg.interactive?.type === 'document', 'still one combined document-type message, not a separate cta_url one');
  assert(twoBtnMsg.interactive?.payUrl === 'https://checkout.paystack.com/fake-2btn', 'that same bubble carries the real Paystack pay link as its own second button, not folded into a redirect');
  assert(twoBtnMsg.interactive?.payLabel === 'Pay now', 'with the real "Pay now" label');
  const afterTwoBtnCount = await countOutbound(pool, customer2.id, 'website');
  assert(afterTwoBtnCount === 1, `still exactly one website bubble, not two, even with a real pay link attached (got ${afterTwoBtnCount})`);

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
