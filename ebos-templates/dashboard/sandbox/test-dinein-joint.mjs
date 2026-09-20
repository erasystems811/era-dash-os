// Joint dine-in, Stages 1-2 (fancy-whistling-pearl.md): two guests scanning
// the same table share one order, each attributed line correctly, the 15s
// poll picks up each other's additions without clobbering local edits
// (Stage 1); serving triggers a per-guest "Ready to pay" link and a
// post-serve add-on reuses the same order and alerts staff (Stage 2). Same
// EBOS_TEST_PGLITE + EBOS_SANDBOX pattern as sandbox/test-conversation.mjs
// -- zero real Meta/AI credentials touched.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3912';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3912';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3912';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');
  // handleInboundMessage only QUEUES a message -- the real dine-in scan
  // handling happens DEBOUNCE_MS later (same pattern sandbox/test-
  // conversation.mjs already uses for exactly this reason).
  const sendAndWait = async (args) => { await flow.handleInboundMessage(args); await wait(flow.DEBOUNCE_MS + 1000); };

  // Wait for the listener.
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // --- Seed: reuse server.js's own auto-seeded business, add dine-in bits ---
  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  const businessId = bizRows[0].id;
  await pool.query(
    `insert into dinein_config (business_id, enabled) values ($1, true)
     on conflict (business_id) do update set enabled = true`,
    [businessId]
  );
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length
    ? existingBranch[0].id
    : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(
    `insert into restaurant_table (branch_id, label, qr_token) values ($1, '5', 'qrtest5') returning id`,
    [branchId]
  );
  const tableId = tableRows[0].id;
  const { rows: prodRows } = await pool.query(
    `insert into product (name, description, price, category, branch_id) values
     ('Jollof Rice', 'party jollof', 3500, 'MAINS', $1) returning id`,
    [branchId]
  );
  const product1 = prodRows[0].id;
  const { rows: prod2Rows } = await pool.query(
    `insert into product (name, description, price, category, branch_id) values
     ('Zobo Drink', 'chilled zobo', 1200, 'DRINKS', $1) returning id`,
    [branchId]
  );
  const product2 = prod2Rows[0].id;

  // --- Guest 1 scans the table ---
  await sendAndWait({ phoneNumber: '2348011110001', text: 'Menu Table 5', channel: 'whatsapp', messageId: 'm1', branchId });
  const { rows: c1Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348011110001']);
  const customer1 = c1Rows[0];
  assert(!!customer1, 'guest 1 customer row created');

  const { rows: sessionRows } = await pool.query(`select * from table_session where table_id = $1 and closed_at is null`, [tableId]);
  assert(sessionRows.length === 1, 'exactly one open table_session created by guest 1 scan');
  const session = sessionRows[0];
  assert(session.customer_id === customer1.id, 'session owned by guest 1 (first scanner)');

  const { rows: guestRows1 } = await pool.query(`select * from table_session_guest where session_id = $1`, [session.id]);
  assert(guestRows1.some((g) => g.customer_id === customer1.id), 'guest 1 upserted into table_session_guest on scan');

  // Guest 1 taps "See the menu"
  await flow.handleDineinButtonTap({ phoneNumber: '2348011110001', buttonId: 'dinein_menu', channel: 'whatsapp', branchId });
  const { rows: link1Rows } = await pool.query(
    `select body from message where customer_id = $1 and trigger = 'dinein_menu_sent' order by created_at desc limit 1`,
    [customer1.id]
  );
  assert(link1Rows.length === 1, 'guest 1 got a menu link message');
  const g1Match = /[?&]g=([a-f0-9]+)/.exec(link1Rows[0]?.body || '');
  assert(!!g1Match, 'guest 1 menu link carries a ?g= guest token');
  const g1 = g1Match?.[1];

  // --- Guest 2 scans the SAME table ---
  await sendAndWait({ phoneNumber: '2348022220002', text: 'Menu Table 5', channel: 'whatsapp', messageId: 'm2', branchId });
  const { rows: c2Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348022220002']);
  const customer2 = c2Rows[0];
  assert(!!customer2, 'guest 2 customer row created');

  const { rows: sessionRows2 } = await pool.query(`select * from table_session where table_id = $1 and closed_at is null`, [tableId]);
  assert(sessionRows2.length === 1, 'guest 2 scan did NOT open a second session (joined the existing one)');

  const { rows: guestRows2 } = await pool.query(`select * from table_session_guest where session_id = $1`, [session.id]);
  assert(guestRows2.length === 2, 'both guests now in table_session_guest');
  assert(guestRows2.some((g) => g.customer_id === customer2.id), 'guest 2 upserted into table_session_guest on scan');

  const { rows: welcome2Rows } = await pool.query(
    `select body from message where customer_id = $1 and trigger = 'dinein_welcome' order by created_at desc limit 1`,
    [customer2.id]
  );
  assert(/active order/i.test(welcome2Rows[0]?.body || ''), 'guest 2 got the "active order, add to it" wording, not the generic first-timer welcome');

  // Guest 2 taps "See the menu" -- this used to fail with "please scan your table's QR code" before the currentDineinSession fix
  await flow.handleDineinButtonTap({ phoneNumber: '2348022220002', buttonId: 'dinein_menu', channel: 'whatsapp', branchId });
  const { rows: link2Rows } = await pool.query(
    `select body from message where customer_id = $1 and trigger in ('dinein_menu_sent', 'dinein_no_session') order by created_at desc limit 1`,
    [customer2.id]
  );
  assert(link2Rows[0]?.body?.includes('menu link sent'), 'guest 2 button tap resolved to a real menu link, not "please scan the QR code" (currentDineinSession now matches table_session_guest)');
  const g2Match = /[?&]g=([a-f0-9]+)/.exec(link2Rows[0]?.body || '');
  const g2 = g2Match?.[1];
  assert(!!g2 && g2 !== g1, 'guest 2 got their own distinct ?g= token');

  // --- Guest 1 opens the shared page and submits an order ---
  const page1 = await fetch(`${BASE}/t/qrtest5?g=${g1}`);
  assert(page1.status === 200, 'guest 1 page loads');
  const page1Html = await page1.text();
  assert(page1Html.includes(`g=${g1}`), 'guest 1 page embeds their own ?g= into review/poll paths');

  const review1 = await fetch(`${BASE}/t/qrtest5/review?g=${g1}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: product1, quantity: 1, answers: {}, addedBy: null }] }),
  });
  assert(review1.status === 200, 'guest 1 order submit succeeds');

  const { rows: orderRows } = await pool.query(`select * from "order" where session_id = $1`, [session.id]);
  assert(orderRows.length === 1, 'exactly one shared order created for the table');
  const order = orderRows[0];
  assert(order.customer_id === customer1.id, 'order.customer_id stays the original scanner (guest 1)');

  const { rows: items1 } = await pool.query(`select * from order_item where order_id = $1`, [order.id]);
  assert(items1.length === 1 && items1[0].added_by_customer_id === customer1.id, 'guest 1\'s line correctly attributed to guest 1');

  // --- Guest 2 polls, sees guest 1's item, adds their own, submits the combined basket ---
  const poll2 = await fetch(`${BASE}/t/qrtest5/menu.json?g=${g2}`);
  const poll2Data = await poll2.json();
  assert(poll2Data.pendingOrder?.items?.length === 1, 'guest 2 sees the shared pending order via poll');
  assert(poll2Data.pendingOrder.items[0].addedByLabel !== 'You', 'guest 2 sees guest 1\'s item NOT labelled "You"');
  assert(poll2Data.pendingOrder.items[0].addedBy === customer1.id, 'guest 2\'s poll response carries guest 1\'s real customer id for the existing line');

  const review2 = await fetch(`${BASE}/t/qrtest5/review?g=${g2}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [
        { productId: product1, quantity: 1, answers: {}, addedBy: customer1.id }, // guest 1's line, carried forward
        { productId: product2, quantity: 2, answers: {}, addedBy: customer2.id }, // guest 2's own new line
      ],
    }),
  });
  assert(review2.status === 200, 'guest 2 combined-basket submit succeeds');

  const { rows: orderRowsAfter } = await pool.query(`select * from "order" where session_id = $1`, [session.id]);
  assert(orderRowsAfter.length === 1, 'STILL exactly one shared order (guest 2\'s submit did not create a second one)');

  const { rows: itemsAfter } = await pool.query(`select * from order_item where order_id = $1`, [order.id]);
  assert(itemsAfter.length === 2, 'both lines present on the one shared order');
  const line1 = itemsAfter.find((i) => i.product_id === product1);
  const line2 = itemsAfter.find((i) => i.product_id === product2);
  assert(line1?.added_by_customer_id === customer1.id, 'guest 1\'s line kept its real attribution after guest 2\'s combined submit');
  assert(line2?.added_by_customer_id === customer2.id, 'guest 2\'s new line correctly attributed to guest 2');

  // --- Guest 1 polls again, sees guest 2's addition with correct labels ---
  const poll1 = await fetch(`${BASE}/t/qrtest5/menu.json?g=${g1}`);
  const poll1Data = await poll1.json();
  assert(poll1Data.pendingOrder?.items?.length === 2, 'guest 1 sees both lines on next poll');
  const p1Line1 = poll1Data.pendingOrder.items.find((i) => i.productId === product1);
  const p1Line2 = poll1Data.pendingOrder.items.find((i) => i.productId === product2);
  assert(p1Line1?.addedByLabel === 'You', 'guest 1 sees their own line labelled "You"');
  assert(p1Line2?.addedByLabel !== 'You' && !!p1Line2?.addedByLabel, 'guest 1 sees guest 2\'s line labelled with something other than "You"');

  // === Stage 2: serve-triggers-pay + add-on alerts ===

  // A staff row with order_alerts on -- who notifyGuestsReadyToPay/
  // resetServedForAddOn's own staff ping actually reaches.
  await pool.query(`insert into staff (name, phone_number, order_alerts, role) values ('Kitchen', '2348033330003', true, 'staff')`);

  // Simulate staff confirming + serving the order (the real confirm/
  // engine_state walk is a separate, already-tested part of the engine --
  // this test is only exercising what Stage 2 itself adds).
  // confirmed_at too -- only a real "Yes, confirm" tap sets it, and it's
  // what distinguishes a genuine repeat add-on round from a still-being-
  // decided first order (see flow.js's finishItemsCollection/
  // handleOrderModification, wasAlreadyConfirmed).
  await pool.query(`update "order" set status = 'preparation', confirmed_at = now() where id = $1`, [order.id]);
  const { rows: servedRows } = await pool.query(`update "order" set served_at = now() where id = $1 returning *`, [order.id]);
  const servedOrder = servedRows[0];

  await flow.notifyGuestsReadyToPay(servedOrder);
  const { rows: pay1Rows } = await pool.query(
    `select body from message where customer_id = $1 and trigger = 'dinein_ready_to_pay' order by created_at desc limit 1`, [customer1.id]
  );
  const { rows: pay2Rows } = await pool.query(
    `select body from message where customer_id = $1 and trigger = 'dinein_ready_to_pay' order by created_at desc limit 1`, [customer2.id]
  );
  assert(pay1Rows[0]?.body?.includes('/pay?g='), 'guest 1 got their own Ready-to-pay link');
  assert(pay2Rows[0]?.body?.includes('/pay?g='), 'guest 2 got their own Ready-to-pay link');

  const payPage = await fetch(`${BASE}/t/qrtest5/pay?g=${g1}`);
  assert(payPage.status === 200, 'pay page loads');
  const payHtml = await payPage.text();
  assert(payHtml.includes('Jollof Rice') && payHtml.includes('Zobo Drink') && payHtml.includes('5900'), 'pay page shows the real order summary and total');

  // Guest 2 orders MORE after being served ("in house people can be
  // ordering in batch and based on mood... the bill can pile up as
  // conclusive"). Chidera, 2026-09-20: "when they add on send them the
  // yes to confirm button... dont send the whole menu to the customer
  // again" -- should reopen the SAME order (not spawn a second one), and
  // get a real yes/no confirm gate scoped to just the new items, NOT the
  // whole running bill restated. served_at/the staff alert are deferred
  // until that yes is actually tapped (checked further below).
  const review3 = await fetch(`${BASE}/t/qrtest5/review?g=${g2}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [
        { productId: product1, quantity: 1, answers: {}, addedBy: customer1.id },
        { productId: product2, quantity: 5, answers: {}, addedBy: customer2.id }, // guest 2 orders MORE zobo, based on mood (was 2, now 5)
      ],
    }),
  });
  assert(review3.status === 200, 'post-serve add-on submit succeeds');

  const { rows: orderRowsFinal } = await pool.query(`select * from "order" where session_id = $1`, [session.id]);
  assert(orderRowsFinal.length === 1, 'STILL exactly one order for the table -- the post-serve add-on reused it, not a second kitchen ticket');
  assert(orderRowsFinal[0].served_at !== null, 'served_at NOT reset yet -- the add-on has not been confirmed with a yes tap');

  const { rows: guest2LastMsg } = await pool.query(
    `select body, trigger from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`, [customer2.id]
  );
  assert(guest2LastMsg[0]?.body?.includes('3x Zobo Drink'), 'guest 2 told exactly the delta added (3 more zobo), not the running total quantity');
  assert(guest2LastMsg[0]?.body?.startsWith('Add on:'), 'the add-on gets its own short confirm, not the full order restated');
  assert(guest2LastMsg[0]?.trigger === 'order_confirm_asked', 'the add-on still gets a real yes/no confirm gate (sendConfirmButtons), same as any other round');

  // Guest 2 taps "Yes, confirm" on the add-on -- THIS is what actually
  // pings staff and moves the table back to the Serving pipeline.
  // handleConfirmOrder's own yes/no reading is AI-based (real, deliberate
  // -- not something this test re-verifies); the real Anthropic API call
  // underneath it is mocked at the network boundary (not the application
  // code) so this exercises the REAL post-"yes" code path, same "zero-AI
  // test path" discipline every other sandbox test uses, just applied one
  // layer deeper since this specific call has no non-AI route in.
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.anthropic.com')) {
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"confirmed": true}' }], usage: {} }), { status: 200 });
    }
    return realFetch(url, opts);
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); originalLog(...args); };
  const { rows: orderForConfirm } = await pool.query(`select * from "order" where id = $1`, [order.id]);
  await flow.handleConfirmOrder(customer2, orderForConfirm[0], 'yes');
  console.log = originalLog;
  global.fetch = realFetch;

  const { rows: orderRowsAfterYes } = await pool.query(`select served_at from "order" where id = $1`, [order.id]);
  assert(orderRowsAfterYes[0].served_at === null, 'served_at reset back to null once the add-on is actually confirmed');
  assert(logs.some((l) => l.includes('added more after being served')), 'staff got pinged about the post-serve add-on, on the yes tap');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
