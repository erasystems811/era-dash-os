// Joint dine-in, Stage 3 (fancy-whistling-pearl.md): split/joint payment
// picking on the pay page, and POS auto-confirm via the real Moniepoint
// webhook route (real HMAC-SHA256 signature verification included, not
// calling the matching logic directly) -- covers a split payment across
// two guests, the order only completing once BOTH are confirmed, a tied
// (same amount, same window) pair of pending payments correctly NOT
// auto-confirming either, and a whole-table payment covering everything
// in one shot regardless of per-guest amounts. Same EBOS_TEST_PGLITE +
// EBOS_SANDBOX pattern as the other dine-in tests -- zero real Meta/
// Paystack/Moniepoint credentials touched (PAYMENT_PROVIDER is left
// unset, so Stage 3's own POS path, which never depends on it, is what's
// actually being exercised).
//
// Chidera, 2026-09-20: "how do we integrate the pos now" -- her real
// Moniepoint account's own webhook subscription (created through their
// Settings UI, not the never-working API-key system) authenticates with
// HMAC-SHA256 over the raw body, not Basic auth -- webhook_secret +
// signature headers replace the old webhook_username/password + Basic
// auth this test used to exercise.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3917';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3917';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3917';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

  // --- Seed: business/dinein config, a table, POS webhook auth, staff for alerts ---
  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  const businessId = bizRows[0].id;
  await pool.query(`insert into dinein_config (business_id, enabled) values ($1, true) on conflict (business_id) do update set enabled = true`, [businessId]);
  await pool.query(
    `insert into pos_sync_config (business_id, enabled, webhook_secret) values ($1, true, $2)
     on conflict (business_id) do update set enabled = true, webhook_secret = $2`,
    [businessId, WEBHOOK_SECRET]
  );
  await pool.query(`insert into staff (name, phone_number, order_alerts, role) values ('Kitchen', '2348033330003', true, 'staff')`);
  await pool.query(`insert into staff (name, phone_number, handover_alerts, role) values ('Owner', '2348099990001', true, 'owner')`);
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '9', 'qrtest9') returning id`, [branchId]);
  const tableId = tableRows[0].id;
  const { rows: prod1 } = await pool.query(`insert into product (name, price, category, branch_id) values ('Jollof Rice', 3500, 'MAINS', $1) returning id`, [branchId]);
  const { rows: prod2 } = await pool.query(`insert into product (name, price, category, branch_id) values ('Zobo Drink', 1200, 'DRINKS', $1) returning id`, [branchId]);
  const product1 = prod1[0].id;
  const product2 = prod2[0].id;

  const sendAndWait = async (args) => { await flow.handleInboundMessage(args); await wait(flow.DEBOUNCE_MS + 1000); };

  // --- Two guests scan and order ---
  await sendAndWait({ phoneNumber: '2348011110009', text: 'Menu Table 9', channel: 'whatsapp', messageId: 'm1', branchId });
  const { rows: c1Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348011110009']);
  const customer1 = c1Rows[0];
  await flow.handleDineinButtonTap({ phoneNumber: '2348011110009', buttonId: 'dinein_menu', channel: 'whatsapp', branchId });
  const { rows: g1Link } = await pool.query(`select body from message where customer_id = $1 and trigger = 'dinein_menu_sent' order by created_at desc limit 1`, [customer1.id]);
  const g1 = /[?&]g=([a-f0-9]+)/.exec(g1Link[0]?.body || '')?.[1];

  await sendAndWait({ phoneNumber: '2348022220009', text: 'Menu Table 9', channel: 'whatsapp', messageId: 'm2', branchId });
  const { rows: c2Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348022220009']);
  const customer2 = c2Rows[0];
  await flow.handleDineinButtonTap({ phoneNumber: '2348022220009', buttonId: 'dinein_menu', channel: 'whatsapp', branchId });
  const { rows: g2Link } = await pool.query(`select body from message where customer_id = $1 and trigger = 'dinein_menu_sent' order by created_at desc limit 1`, [customer2.id]);
  const g2 = /[?&]g=([a-f0-9]+)/.exec(g2Link[0]?.body || '')?.[1];

  await fetch(`${BASE}/t/qrtest9/review?g=${g1}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: product1, quantity: 1, answers: {}, addedBy: null }] }),
  });
  await fetch(`${BASE}/t/qrtest9/review?g=${g2}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [
        { productId: product1, quantity: 1, answers: {}, addedBy: customer1.id },
        { productId: product2, quantity: 1, answers: {}, addedBy: customer2.id },
      ],
    }),
  });

  const { rows: sessionRows } = await pool.query(`select * from table_session where table_id = $1 and closed_at is null`, [tableId]);
  const session = sessionRows[0];
  const { rows: orderRows } = await pool.query(`select * from "order" where session_id = $1`, [session.id]);
  const order = orderRows[0];
  // Confirm + serve, bypassing the full chat confirm flow (already covered elsewhere) -- Stage 3 only cares what happens after that.
  await pool.query(`update "order" set status = 'preparation', served_at = now() where id = $1`, [order.id]);

  // --- Guest 1 requests payment for just themselves ---
  const pay1 = await fetch(`${BASE}/t/qrtest9/pay/status?g=${g1}`);
  const pay1Data = await pay1.json();
  assert(pay1Data.items.length === 2, 'pay page sees both order lines');
  assert(pay1Data.guests.length === 2, 'pay page lists both guests');

  const create1 = await fetch(`${BASE}/t/qrtest9/pay/create?g=${g1}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guestIds: [customer1.id] }),
  });
  const create1Data = await create1.json();
  assert(create1Data.amount === 3500, 'guest 1\'s own-items-only payment amount is correct (just their rice)');

  // --- Guest 2 requests payment for just themselves ---
  const create2 = await fetch(`${BASE}/t/qrtest9/pay/create?g=${g2}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guestIds: [customer2.id] }),
  });
  const create2Data = await create2.json();
  assert(create2Data.amount === 1200, 'guest 2\'s own-items-only payment amount is correct (just their zobo)');

  // --- POS transaction matches guest 1's amount exactly -- should auto-confirm, order NOT yet complete ---
  const wh1 = await postMoniepointWebhook(3500, 'MPTX-001');
  assert(wh1.status === 200, 'webhook accepted');
  await wait(500);
  const { rows: orderAfter1 } = await pool.query(`select status from "order" where id = $1`, [order.id]);
  assert(orderAfter1[0].status !== 'completed', 'order NOT completed yet -- guest 2\'s share still outstanding');
  const { rows: payments1 } = await pool.query(`select amount, status from order_payment where order_id = $1 order by amount`, [order.id]);
  assert(payments1.find((p) => p.amount == 3500)?.status === 'confirmed', 'guest 1\'s payment auto-confirmed by the real webhook');

  // --- POS transaction matches guest 2's amount -- should auto-confirm AND complete the order ---
  const wh2 = await postMoniepointWebhook(1200, 'MPTX-002');
  assert(wh2.status === 200, 'second webhook accepted');
  await wait(500);
  const { rows: orderAfter2 } = await pool.query(`select status, engine_state, completed_at from "order" where id = $1`, [order.id]);
  assert(orderAfter2[0].status === 'completed', 'order auto-completed once BOTH split payments confirmed');
  assert(orderAfter2[0].engine_state === 'completed' && orderAfter2[0].completed_at, 'engine_state and completed_at set correctly');
  const { rows: sessionAfter } = await pool.query(`select closed_at, closed_by from table_session where id = $1`, [session.id]);
  assert(sessionAfter[0].closed_at && sessionAfter[0].closed_by === 'auto', 'table_session auto-closed once the (only) order was fully paid');

  // --- Tie case: two pending payments, same amount, real webhook must NOT guess ---
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); originalLog(...args); };

  // A fresh table/session/order for a clean tie test.
  const { rows: tableRows2 } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '10', 'qrtest10') returning id`, [branchId]);
  const table2Id = tableRows2[0].id;
  await sendAndWait({ phoneNumber: '2348033330009', text: 'Menu Table 10', channel: 'whatsapp', messageId: 'm3', branchId });
  const { rows: c3Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348033330009']);
  const customer3 = c3Rows[0];
  await fetch(`${BASE}/t/qrtest10/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: product1, quantity: 1, answers: {} }] }),
  });
  const { rows: sessionRows2 } = await pool.query(`select * from table_session where table_id = $1`, [table2Id]);
  const { rows: orderRows2 } = await pool.query(`select * from "order" where session_id = $1`, [sessionRows2[0].id]);
  const order2 = orderRows2[0];
  await pool.query(`update "order" set status = 'preparation', served_at = now() where id = $1`, [order2.id]);
  // Two independent pending payments at the exact same amount (3500) -- one on each table.
  await flow.createOrderPayment(order2, [customer3.id], customer3.id);
  // order2's own item is also 3500 (Jollof Rice), matching order 1's original 3500 payment amount coincidentally? No -- order 1 is already fully settled. Use a genuinely fresh tie instead:
  const { rows: tableRows3 } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '11', 'qrtest11') returning id`, [branchId]);
  const table3Id = tableRows3[0].id;
  await sendAndWait({ phoneNumber: '2348044440009', text: 'Menu Table 11', channel: 'whatsapp', messageId: 'm4', branchId });
  const { rows: c4Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348044440009']);
  const customer4 = c4Rows[0];
  await fetch(`${BASE}/t/qrtest11/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: product1, quantity: 1, answers: {} }] }),
  });
  const { rows: sessionRows3 } = await pool.query(`select * from table_session where table_id = $1`, [table3Id]);
  const { rows: orderRows3 } = await pool.query(`select * from "order" where session_id = $1`, [sessionRows3[0].id]);
  const order3 = orderRows3[0];
  await pool.query(`update "order" set status = 'preparation', served_at = now() where id = $1`, [order3.id]);
  await flow.createOrderPayment(order3, [customer4.id], customer4.id);

  const whTie = await postMoniepointWebhook(3500, 'MPTX-TIE');
  assert(whTie.status === 200, 'tie webhook accepted');
  await wait(500);
  console.log = originalLog;

  const { rows: order2After } = await pool.query(`select status from "order" where id = $1`, [order2.id]);
  const { rows: order3After } = await pool.query(`select status from "order" where id = $1`, [order3.id]);
  assert(order2After[0].status !== 'completed' && order3After[0].status !== 'completed', 'a genuine tie (same amount, both pending) auto-confirms NEITHER');
  // Chidera, 2026-09-20: "i need pos to work now for both online and in
  // house" -- this alert's own wording was generalized (flow.js's
  // matchPosTransactionToPayment) to cover an online order (no table)
  // alongside a dine-in one, so the tie-alert text itself changed from
  // "table" to "order" -- see sandbox/test-online-pos-payment.mjs for the
  // online-order half of this same alert.
  assert(logs.some((l) => l.includes('matched more than one order')), 'staff got alerted about the tie instead of a silent guess');

  // --- Whole-table payment: one guest selects everyone, covers the full order regardless of per-item amounts ---
  const { rows: tableRows4 } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '12', 'qrtest12') returning id`, [branchId]);
  const table4Id = tableRows4[0].id;
  await sendAndWait({ phoneNumber: '2348055550009', text: 'Menu Table 12', channel: 'whatsapp', messageId: 'm5', branchId });
  const { rows: c5Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348055550009']);
  const customer5 = c5Rows[0];
  await fetch(`${BASE}/t/qrtest12/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: product1, quantity: 1, answers: {} }, { productId: product2, quantity: 1, answers: {} }] }),
  });
  const { rows: sessionRows4 } = await pool.query(`select * from table_session where table_id = $1`, [table4Id]);
  const { rows: orderRows4 } = await pool.query(`select * from "order" where session_id = $1`, [sessionRows4[0].id]);
  const order4 = orderRows4[0];
  await pool.query(`update "order" set status = 'preparation', served_at = now() where id = $1`, [order4.id]);
  const wholePayment = await flow.createOrderPayment(order4, [customer5.id], customer5.id);
  assert(wholePayment.covers_item_ids === null, 'a single guest at a solo table paying "for everyone" is recognized as a whole-order payment (covers_item_ids null)');
  await flow.confirmOrderPayment(wholePayment.id);
  const { rows: order4After } = await pool.query(`select status from "order" where id = $1`, [order4.id]);
  assert(order4After[0].status === 'completed', 'whole-order payment completes the order in one confirm');

  // --- "I SENT MONEY NO PLACE FOR CUSTOMER TO TAP I SENT THE MONEY FOR BOT
  // TO AUTO CONFIRM" -- the pay page's own fallback for when a real
  // transfer lands but the webhook doesn't. Fresh table so it doesn't
  // interfere with any payment already confirmed above.
  const { rows: tableRows5 } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '13', 'qrtest13') returning id`, [branchId]);
  const table5Id = tableRows5[0].id;
  await sendAndWait({ phoneNumber: '2348066660009', text: 'Menu Table 13', channel: 'whatsapp', messageId: 'm6', branchId });
  const { rows: c6Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348066660009']);
  const customer6 = c6Rows[0];
  await flow.handleDineinButtonTap({ phoneNumber: '2348066660009', buttonId: 'dinein_menu', channel: 'whatsapp', branchId });
  const { rows: g6Link } = await pool.query(`select body from message where customer_id = $1 and trigger = 'dinein_menu_sent' order by created_at desc limit 1`, [customer6.id]);
  const g6 = /[?&]g=([a-f0-9]+)/.exec(g6Link[0]?.body || '')?.[1];
  await fetch(`${BASE}/t/qrtest13/review?g=${g6}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: product1, quantity: 1, answers: {} }] }),
  });
  const { rows: sessionRows5 } = await pool.query(`select * from table_session where table_id = $1`, [table5Id]);
  const { rows: orderRows5 } = await pool.query(`select * from "order" where session_id = $1`, [sessionRows5[0].id]);
  const order5 = orderRows5[0];
  await pool.query(`update "order" set status = 'preparation', served_at = now() where id = $1`, [order5.id]);
  const create5 = await fetch(`${BASE}/t/qrtest13/pay/create?g=${g6}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guestIds: [customer6.id] }),
  });
  assert((await create5.json()).amount === 3500, 'a real pending payment exists for the claim tap to react to');

  const payPage5 = await (await fetch(`${BASE}/t/qrtest13/pay?g=${g6}`)).text();
  assert(payPage5.includes('id="claimBtn"'), 'the "I\'ve sent it" fallback button is in the page (hidden until Transfer is picked)');

  const claimLogs = [];
  const originalLog2 = console.log;
  console.log = (...args) => { claimLogs.push(args.join(' ')); originalLog2(...args); };
  const claim5 = await fetch(`${BASE}/t/qrtest13/pay/claim?g=${g6}`, { method: 'POST' });
  console.log = originalLog2;
  assert(claim5.status === 200, 'the dine-in claim tap is accepted');
  const { rows: payment5After } = await pool.query(`select status from order_payment where order_id = $1`, [order5.id]);
  assert(payment5After[0].status === 'pending', 'the dine-in claim tap does NOT touch payment state either');
  const staffAlert5 = claimLogs.find((l) => l.includes('2348099990001') && l.includes('POS transfer'));
  assert(Boolean(staffAlert5), 'staff got a real dine-in alert naming it as a POS transfer claim');
  assert(staffAlert5?.includes('3,500'), 'the dine-in alert carries the real amount claimed');
  // Chidera, 2026-09-21: "WHY IS DINE IN HANDOVER TAKING ME OUT OF
  // WHATSAPP TO SHOW ME INVOICE?" -- a plain-text link auto-linkifies to
  // WhatsApp's OWN external browser, breaking exactly what she's asking
  // for (stay inside WhatsApp) -- dropped entirely, the "Confirm payment"
  // CTA button is the only link now.
  assert(!staffAlert5?.includes('Invoice:'), 'no plain-text invoice link in the alert body (that took her out of WhatsApp)');
  assert(staffAlert5?.includes('covers the whole table'), 'a single guest at a solo table (covers_item_ids null) is correctly described as covering the whole table');

  // === A genuine SPLIT payment -- "LET INVOICE HANDOVER FOR DINE IN
  // GROUP PAYMENT BASED ON HOW PARTIES AGREED TO MAKE THE PAYMENT...SO
  // STAFF WONT SEE TO CHECK FOR A SMALL AMOUNT IN A LARGE INVOICE AND BE
  // WONDERING HOW" -- a fresh table with two guests, one requesting
  // payment for just their own item (a REAL covers_item_ids split, not a
  // whole-order one) -- the claim alert must say what this amount
  // actually covers, not just the raw number.
  const { rows: tableRows6 } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '14', 'qrtest14') returning id`, [branchId]);
  const table6Id = tableRows6[0].id;
  await sendAndWait({ phoneNumber: '2348077770009', text: 'Menu Table 14', channel: 'whatsapp', messageId: 'm7', branchId });
  const { rows: c7Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348077770009']);
  const customer7 = c7Rows[0];
  await flow.handleDineinButtonTap({ phoneNumber: '2348077770009', buttonId: 'dinein_menu', channel: 'whatsapp', branchId });
  const { rows: g7Link } = await pool.query(`select body from message where customer_id = $1 and trigger = 'dinein_menu_sent' order by created_at desc limit 1`, [customer7.id]);
  const g7 = /[?&]g=([a-f0-9]+)/.exec(g7Link[0]?.body || '')?.[1];
  const { rows: c8Rows } = await pool.query(`insert into customers (phone_number, channel, name) values ('2348088880009', 'whatsapp', 'Second Guest') returning *`);
  const customer8 = c8Rows[0];
  // Registered as a real table_session_guest BEFORE the review call --
  // /review's own addedBy validation (routes/dinein-menu.js) only trusts
  // an addedBy claim for an already-known guest, same "never trust the
  // client's own claim" discipline as everything else in that route.
  const { rows: sessionRows6 } = await pool.query(`select * from table_session where table_id = $1`, [table6Id]);
  await pool.query(`insert into table_session_guest (session_id, customer_id) values ($1, $2) on conflict do nothing`, [sessionRows6[0].id, customer8.id]);
  await fetch(`${BASE}/t/qrtest14/review?g=${g7}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [
        { productId: product1, quantity: 1, answers: {}, addedBy: customer7.id },
        { productId: product2, quantity: 1, answers: {}, addedBy: customer8.id },
      ],
    }),
  });
  const { rows: orderRows6 } = await pool.query(`select * from "order" where session_id = $1`, [sessionRows6[0].id]);
  const order6 = orderRows6[0];
  await pool.query(`update "order" set status = 'preparation', served_at = now() where id = $1`, [order6.id]);
  const create6 = await fetch(`${BASE}/t/qrtest14/pay/create?g=${g7}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guestIds: [customer7.id] }),
  });
  assert((await create6.json()).amount === 3500, 'guest 7 requested payment for just their own Jollof Rice, not the whole table');

  const splitClaimLogs = [];
  const originalLog3 = console.log;
  console.log = (...args) => { splitClaimLogs.push(args.join(' ')); originalLog3(...args); };
  const splitClaim = await fetch(`${BASE}/t/qrtest14/pay/claim?g=${g7}`, { method: 'POST' });
  console.log = originalLog3;
  assert(splitClaim.status === 200, 'the split-payment claim tap is accepted');
  const splitAlert = splitClaimLogs.find((l) => l.includes('2348099990001') && l.includes('POS transfer'));
  assert(Boolean(splitAlert), 'staff got an alert for the split payment claim too');
  assert(!splitAlert?.includes('Invoice:'), 'no plain-text invoice link here either');
  assert(splitAlert?.includes('Jollof Rice') && splitAlert?.includes('not the whole table'), 'the alert says exactly what this guest\'s own share covers (their rice), not a bare amount against the full table');
  assert(splitAlert?.includes('4,700'), 'the alert also names the table\'s real full total, so staff can tell a partial amount from a mistaken one at a glance');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
