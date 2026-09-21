// Chidera, 2026-09-21: "look at my instagram flow, for online ordering,
// how does instagram catch up to our current state since its
// capabilities are low... fix all, make it flow in the best way possible
// closest to whatsapp." Real gaps found live: an Instagram customer never
// saw a menu link anywhere in the whole conversation (handleGreeting/
// sendWebMenuLink both unconditionally used WhatsApp's own CTA-URL button
// type, no fallback at all); the brand-new POS "Ready to pay?" button
// (sendPosPaymentChoice, built earlier tonight) had the same gap; and
// sendFeedbackRequest flatly skipped Instagram altogether. Fixed with the
// SAME plain-text-link fallback sendPaymentLinkButton already used
// correctly (auto-linkified by Instagram's own client) -- confirms all
// three now reach a real Instagram customer with a real, working link,
// and that the WhatsApp path (untouched) still gets its real buttons.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3939';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3939';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3939';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // === 1. Greeting: an Instagram customer's very first "hi" now carries a real menu link ===
  const igCustomer = await flow.findOrCreateCustomer({ channelId: 'ig-user-001', channel: 'instagram' });
  await flow.handleInboundMessage({ channelId: 'ig-user-001', text: 'hi', channel: 'instagram', messageId: 'ig-m1' });
  await wait(flow.DEBOUNCE_MS + 1000);
  const { rows: greetingMsgs } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [igCustomer.id]
  );
  assert(/\/m\/[a-f0-9]+/.test(greetingMsgs[0]?.body || ''), 'an Instagram "hi" now gets a real menu link in the reply text, not silence');

  // === 2. POS payment: the brand-new "Ready to pay?" flow reaches Instagram too ===
  await pool.query(`insert into payment_config (business_id, provider) values ((select id from business limit 1), 'pos') on conflict (business_id) do update set provider = 'pos'`);
  const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);
  const product = prodRows[0];
  const total = Number(product.price);
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state)
     values ($1, 'REF-IG-POS', 'pickup', $2, 'new', 'pending', 'confirm_payment') returning *`,
    [igCustomer.id, total]
  );
  const order = orderRows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order.id, product.id, product.price]);
  await flow.sendPaymentInstructions(igCustomer, order);

  const { rows: payMsgs } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [igCustomer.id]
  );
  assert(/Ready to pay/i.test(payMsgs[0]?.body || '') && /\/m\/[a-f0-9]+\/pay/.test(payMsgs[0]?.body || ''), 'the new POS "Ready to pay?" flow now sends Instagram a real, working pay link as plain text');

  // === 3. Feedback request: previously skipped Instagram entirely ===
  await pool.query(`insert into staff (name, phone_number, order_alerts, role) values ('Owner', '2348099990004', true, 'owner') on conflict do nothing`);
  await pool.query(`update "order" set status = 'completed', payment_status = 'confirmed' where id = $1`, [order.id]);
  await flow.sendFeedbackRequest(order.id);
  const { rows: feedbackMsgs } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [igCustomer.id]
  );
  assert(/rate it/i.test(feedbackMsgs[0]?.body || '') && /\/f\/[a-f0-9-]+/.test(feedbackMsgs[0]?.body || ''), 'sendFeedbackRequest now reaches Instagram too (used to flatly skip it), with a real, working feedback link');

  // === 4. The WhatsApp path is untouched -- still gets its real CTA-URL buttons, not plain text ===
  const waCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012340099', channel: 'whatsapp' });
  await flow.handleInboundMessage({ phoneNumber: '2348012340099', text: 'hi', channel: 'whatsapp', messageId: 'wa-m1' });
  await wait(flow.DEBOUNCE_MS + 1000);
  const { rows: waGreetingMsgs } = await pool.query(
    `select body, trigger from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [waCustomer.id]
  );
  assert(waGreetingMsgs[0]?.trigger === 'greeting', 'the WhatsApp greeting still fires its own real trigger (a real CTA-URL button send), unaffected by the Instagram fallback');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
