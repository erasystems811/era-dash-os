// Chidera, 2026-09-20: "i want them to be able to pick transfer or card,
// transfer will give them number on pos while card the bot just waits to
// auto confirm payment...i need pos to work now for both online and in
// house" -- dine-in's own Stage 3 (order_payment + matchPosTransactionToPayment)
// was already real and tested (sandbox/test-dinein-pos-payment.mjs); this
// confirms the SAME mechanism now works for a normal online order too.
// Chidera corrected the first pass ("when pos is selected the whole thing
// will still be inside the web na... make it 'ready to pay? click here'")
// -- the choice itself lives on a real web page (routes/menu-page.js's
// /:token/pay), reached by a plain CTA-URL link, not WhatsApp quick-reply
// buttons. A matching Moniepoint transaction still auto-confirms the
// payment AND moves the order into 'fulfilment' (kitchen preparing) --
// NOT straight to 'completed' the way dine-in's own confirmOrderPayment
// branch does, since an online order is only just STARTING once it's
// paid, unlike a table that's already eaten.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3928';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3928';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3928';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

// Chidera, 2026-09-20: "how do we integrate the pos now" -- her real
// Moniepoint account's own webhook subscription (created through their
// Settings UI, not the never-working API-key system) authenticates with
// HMAC-SHA256 over the raw body, not Basic auth.
const WEBHOOK_SECRET = 'test-webhook-secret';

async function postMoniepointWebhook(amountNaira, reference) {
  const body = JSON.stringify({
    eventId: `evt-${reference}`,
    eventType: 'V1_POS_TRANSFER_TRANSACTION',
    data: { transactionReference: reference, amount: amountNaira * 100, transactionTime: new Date().toISOString(), transactionStatus: 'COMPLETED' },
    createdAt: new Date().toISOString(),
  });
  const webhookId = `wh-${reference}`;
  const timestamp = String(Date.now());
  const crypto = await import('node:crypto');
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${webhookId}__${timestamp}__${body}`).digest('base64');
  return fetch(`${BASE}/webhook/moniepoint`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'moniepoint-webhook-id': webhookId,
      'moniepoint-webhook-timestamp': timestamp,
      'moniepoint-webhook-signature': signature,
    },
    body,
  });
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  await pool.query(`insert into staff (name, phone_number, handover_alerts, order_alerts, role) values ('Owner', '2348099990002', true, true, 'owner')`);

  // Moniepoint webhook creds -- same shape sandbox/test-dinein-pos-payment.mjs uses.
  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  await pool.query(
    `insert into pos_sync_config (business_id, enabled, webhook_secret) values ($1, true, $2)
     on conflict (business_id) do update set enabled = true, webhook_secret = $2`,
    [bizRows[0].id, WEBHOOK_SECRET]
  );

  // Settings' own new "How you get paid" choice -- POS, with real transfer details.
  await pool.query(
    `insert into payment_config (business_id, provider, transfer_account_number, transfer_account_name, transfer_bank_name)
     values ($1, 'pos', '1234567890', 'Sample Restaurant Ltd', 'Moniepoint MFB')`,
    [bizRows[0].id]
  );

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012341111', channel: 'whatsapp' });
  const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);
  const product = prodRows[0];
  const total = Number(product.price);
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state)
     values ($1, 'REF-ONLINE-POS', 'pickup', $2, 'new', 'pending', 'confirm_payment') returning *`,
    [customer.id, total]
  );
  const order = orderRows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order.id, product.id, product.price]);

  await flow.sendPaymentInstructions(customer, order);

  const { rows: choiceMsg } = await pool.query(
    `select body, trigger from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customer.id]
  );
  assert(choiceMsg[0]?.trigger === 'pos_pay_choice', 'POS provider sends the real "Ready to pay" link, not a Paystack link or bank details');
  assert(choiceMsg[0]?.body?.includes('[pay link sent:'), 'the message actually carries a real pay-page link');

  const { rows: paymentRows } = await pool.query(`select * from order_payment where order_id = $1`, [order.id]);
  assert(paymentRows.length === 1, 'exactly one order_payment row created for the whole order');
  assert(paymentRows[0].covers_item_ids === null, 'covers the whole order (not a dine-in split)');
  assert(Number(paymentRows[0].amount) === total, 'amount matches the order total');
  assert(paymentRows[0].status === 'pending', 'starts pending, not auto-confirmed');

  const { rows: tokenRows } = await pool.query(`select menu_token from customers where id = $1`, [customer.id]);
  const token = tokenRows[0].menu_token;
  const payPageRes = await fetch(`${BASE}/m/${token}/pay`);
  const payPageHtml = await payPageRes.text();
  assert(payPageRes.status === 200, 'the real pay page loads');
  assert(payPageHtml.includes(Number(total).toLocaleString()), 'shows the real amount owed');
  // Chidera, 2026-09-20: "online orders an only use transfer route" -- no
  // Transfer/Card choice for a single online order (unlike dine-in, the
  // customer here is never physically at a terminal to tap a card on),
  // account details show directly, no extra tap needed.
  assert(payPageHtml.includes('1234567890') && payPageHtml.includes('Moniepoint MFB'), 'carries the real transfer details from Settings, shown directly, no choice needed');
  assert(!payPageHtml.includes('Tap card') && !payPageHtml.includes('Tap your card'), 'no Card option is ever offered for an online order');

  const statusBefore = await (await fetch(`${BASE}/m/${token}/pay/status`)).json();
  assert(statusBefore.confirmed === false, 'not confirmed yet before any real POS transaction arrives');

  const webhookRes = await postMoniepointWebhook(total, 'MP-ONLINE-1');
  assert(webhookRes.status === 200, 'Moniepoint webhook accepted');
  await new Promise((r) => setTimeout(r, 300));

  const { rows: confirmedPayment } = await pool.query(`select status from order_payment where order_id = $1`, [order.id]);
  assert(confirmedPayment[0].status === 'confirmed', 'the matching POS transaction auto-confirmed the payment, no staff step');

  const { rows: reloadedOrder } = await pool.query(`select engine_state, status, completed_at from "order" where id = $1`, [order.id]);
  assert(reloadedOrder[0].engine_state === 'fulfilment', 'order moves to fulfilment (kitchen preparing), same as a Paystack/proof confirm would');
  assert(reloadedOrder[0].status === 'preparation', 'status also reflects preparation, not completed');
  assert(reloadedOrder[0].completed_at === null, 'never silently marked completed -- that\'s dine-in-only behaviour, an online order still has delivery/pickup ahead of it');

  const statusAfter = await (await fetch(`${BASE}/m/${token}/pay/status`)).json();
  assert(statusAfter.confirmed === true, 'the pay page itself now reports confirmed, so the customer sees "Payment confirmed" without refreshing manually');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
