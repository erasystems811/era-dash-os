// Chidera, 2026-09-23: "now we do payment integration with either
// moniepoint, opay or paystack" -- clarified to mean finishing the web-chat
// parity Phase 1 deferred (POS Transfer/Card claim-tap on the /wa page).
// Paystack and Moniepoint are already wired into EBOS; sendPaymentInstructions
// and sendPosPaymentChoice already had 'website' branches for the initial
// "Ready to pay?" link (see flow.js). The gap found while wiring this up:
// routes/menu-page.js's POST /:token/pay/claim -- the pay page's own "I've
// sent it" button -- resolved the customer fresh from the DB and called
// notifyCustomerClaimedPosPayment with it directly, never applying the
// same in-memory channel='website' override every other route into this
// page already has. If Moniepoint hadn't matched the transfer yet, the
// staff-handover branch's reply() would have gone out as a REAL WhatsApp
// message to a customer who's actually sitting on the chat page -- exactly
// the silent-fallthrough class of bug this whole feature exists to catch.
// This proves the fix: a claim tap from a web-chat customer never touches
// real WhatsApp, before OR after Moniepoint matches the transfer.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3929';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3929';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3929';

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

  await pool.query(`insert into staff (name, phone_number, handover_alerts, order_alerts, role) values ('Owner', '2348099990003', true, true, 'owner')`);

  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  await pool.query(
    `insert into pos_sync_config (business_id, enabled, webhook_secret) values ($1, true, 'test-webhook-secret')
     on conflict (business_id) do update set enabled = true`,
    [bizRows[0].id]
  );
  await pool.query(`insert into payment_config (business_id, provider) values ($1, 'pos')`, [bizRows[0].id]);
  await pool.query(
    `update business set bank_name = 'Moniepoint MFB', bank_account_number = '1234567890', bank_account_name = 'Sample Restaurant Ltd' where id = $1`,
    [bizRows[0].id]
  );

  // A customer whose real stored channel is 'whatsapp' (that's how they
  // first contacted the business) but who's currently on the /wa chat
  // page -- web_chat_active_at fresh, same breadcrumb every other route
  // in this feature relies on.
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012342222', channel: 'whatsapp' });
  await pool.query('update customers set web_chat_active_at = now() where id = $1', [customer.id]);

  const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);
  const product = prodRows[0];
  const total = Number(product.price);
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state)
     values ($1, 'REF-WEBCHAT-POS', 'pickup', $2, 'new', 'pending', 'confirm_payment') returning *`,
    [customer.id, total]
  );
  const order = orderRows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order.id, product.id, product.price]);

  // Mirrors what routes/menu-page.js's /review does before calling into
  // the order engine for a web-chat customer -- the in-memory override
  // this whole feature is built on, never written back to the real row.
  customer.channel = 'website';
  await flow.sendPaymentInstructions(customer, order);

  const { rows: choiceMsg } = await pool.query(
    `select body, trigger, channel, interactive from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customer.id]
  );
  assert(choiceMsg[0]?.trigger === 'pos_pay_choice', 'POS provider sends the "Ready to pay" bubble, not a Paystack link or bank details');
  assert(choiceMsg[0]?.channel === 'website', 'the pay-page link lands as a website bubble, not a real WhatsApp send');
  assert(choiceMsg[0]?.interactive?.type === 'cta_url', 'rendered as a real tappable button on the chat page');

  const { rows: tokenRows } = await pool.query(`select menu_token from customers where id = $1`, [customer.id]);
  const token = tokenRows[0].menu_token;

  // === The actual bug: claim tap BEFORE Moniepoint has matched anything ===
  // notifyCustomerClaimedPosPayment's staff-handover branch fires here --
  // this is exactly the path that used to go out as a real WhatsApp send.
  const beforeClaimWa = (await pool.query(
    `select count(*)::int as n from message where customer_id = $1 and channel = 'whatsapp' and direction = 'outbound'`,
    [customer.id]
  )).rows[0].n;

  const claimRes = await fetch(`${BASE}/m/${token}/pay/claim`, { method: 'POST' });
  assert(claimRes.status === 200, 'the claim tap is accepted');

  const afterClaimWa = (await pool.query(
    `select count(*)::int as n from message where customer_id = $1 and channel = 'whatsapp' and direction = 'outbound'`,
    [customer.id]
  )).rows[0].n;
  assert(afterClaimWa === beforeClaimWa, 'a web-chat customer\'s claim tap added ZERO real WhatsApp messages, even on the unmatched staff-handover branch');

  const { rows: claimAck } = await pool.query(
    `select body, channel from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customer.id]
  );
  assert(claimAck[0]?.channel === 'website', 'the "I\'ll confirm your transfer" ack lands as a website bubble');
  assert(/confirm your transfer/i.test(claimAck[0]?.body || ''), 'the customer still gets a real acknowledgement, just not over WhatsApp');

  const { rows: staffHandover } = await pool.query(`select handled_by, handover_reason from customers where id = $1`, [customer.id]);
  assert(staffHandover[0].handled_by === 'staff', 'staff handover still fires for real -- this fix only changes which channel the customer-facing ack uses');
  assert(/POS transfer/.test(staffHandover[0].handover_reason || ''), 'handover reason still names it as a POS transfer claim');

  const { rows: paymentStillPending } = await pool.query(`select status from order_payment where order_id = $1`, [order.id]);
  assert(paymentStillPending[0].status === 'pending', 'the claim tap alone never confirms payment -- still needs a real matching transaction or staff');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
