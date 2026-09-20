// Chidera, 2026-09-20: "i want them to be able to pick transfer or card,
// transfer will give them number on pos while card the bot just waits to
// auto confirm payment...i need pos to work now for both online and in
// house" -- dine-in's own Stage 3 (order_payment + matchPosTransactionToPayment)
// was already real and tested (sandbox/test-dinein-pos-payment.mjs); this
// confirms the SAME mechanism now works for a normal online order too:
// buildPayLine's new 'pos' branch sends a real Transfer/Card button choice
// (not Paystack, not the generic bank-details fallback) once Settings'
// payment_config.provider is 'pos', a tap on either button gets the right
// reply, and a matching Moniepoint transaction auto-confirms the payment
// AND moves the order into 'fulfilment' (kitchen preparing) -- NOT
// straight to 'completed' the way dine-in's own confirmOrderPayment
// branch does, since an online order is only just STARTING once it's
// paid, unlike a table that's already eaten.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3928';
process.env.SESSION_SECRET = 'testsecret';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3928';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function postMoniepointWebhook(amountNaira, reference) {
  const auth = Buffer.from('testuser:testpass').toString('base64');
  return fetch(`${BASE}/webhook/moniepoint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Basic ${auth}` },
    body: JSON.stringify({
      eventType: 'POS_TRANSACTION_SUCCESSFUL',
      data: { transactionReference: reference, actualAmount: amountNaira * 100, createdAt: new Date().toISOString() },
    }),
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
    `insert into pos_sync_config (business_id, enabled, webhook_username, webhook_password) values ($1, true, 'testuser', 'testpass')
     on conflict (business_id) do update set enabled = true, webhook_username = 'testuser', webhook_password = 'testpass'`,
    [bizRows[0].id]
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
  assert(choiceMsg[0]?.trigger === 'pos_pay_choice', 'POS provider sends the real Transfer/Card choice, not a Paystack link or bank details');
  assert(choiceMsg[0]?.body?.includes('How would you like to pay'), 'the choice message actually asks how they want to pay');

  const { rows: paymentRows } = await pool.query(`select * from order_payment where order_id = $1`, [order.id]);
  assert(paymentRows.length === 1, 'exactly one order_payment row created for the whole order');
  assert(paymentRows[0].covers_item_ids === null, 'covers the whole order (not a dine-in split)');
  assert(Number(paymentRows[0].amount) === total, 'amount matches the order total');
  assert(paymentRows[0].status === 'pending', 'starts pending, not auto-confirmed');

  await flow.handlePosPayMethodTap({ phoneNumber: '2348012341111', channelId: '2348012341111', buttonId: 'pos_pay_transfer', channel: 'whatsapp' });
  const { rows: transferMsg } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customer.id]
  );
  assert(transferMsg[0]?.body?.includes('1234567890') && transferMsg[0]?.body?.includes('Moniepoint MFB'), 'tapping Transfer gives the real account details from Settings');

  const webhookRes = await postMoniepointWebhook(total, 'MP-ONLINE-1');
  assert(webhookRes.status === 200, 'Moniepoint webhook accepted');
  await new Promise((r) => setTimeout(r, 300));

  const { rows: confirmedPayment } = await pool.query(`select status from order_payment where order_id = $1`, [order.id]);
  assert(confirmedPayment[0].status === 'confirmed', 'the matching POS transaction auto-confirmed the payment, no staff step');

  const { rows: reloadedOrder } = await pool.query(`select engine_state, status, completed_at from "order" where id = $1`, [order.id]);
  assert(reloadedOrder[0].engine_state === 'fulfilment', 'order moves to fulfilment (kitchen preparing), same as a Paystack/proof confirm would');
  assert(reloadedOrder[0].status === 'preparation', 'status also reflects preparation, not completed');
  assert(reloadedOrder[0].completed_at === null, 'never silently marked completed -- that\'s dine-in-only behaviour, an online order still has delivery/pickup ahead of it');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
