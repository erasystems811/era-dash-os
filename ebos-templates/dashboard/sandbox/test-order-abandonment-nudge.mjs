// Chidera, 2026-09-25: "when a customer text and abandon a menu maybe they
// text bare chat and they dont open web menu or they open webmenu but dont
// say anything after see menu, retext them... 10 mins after abandonment."
// A different, earlier gap than sweepAbandonedWebChatOrders (which only
// ever fires once a real order already reached confirm_payment) --
// sweepAbandonedChatCustomers covers everything before that: a customer
// who got a bot bubble and then just went quiet, possibly with no order
// row at all yet.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3973';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3973';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3973';

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

  async function makeCustomer(phone, { lastMessageMinutesAgo, webChatActiveMinutesAgo = null, chatRedirectSentMinutesAgo = null }) {
    const customer = await flow.findOrCreateCustomer({ phoneNumber: phone, channel: 'whatsapp' });
    await pool.query(`update customers set last_message = 'hi', last_message_at = now() - make_interval(mins => $1) where id = $2`, [lastMessageMinutesAgo, customer.id]);
    if (webChatActiveMinutesAgo !== null) {
      await pool.query(`update customers set web_chat_active_at = now() - make_interval(mins => $1) where id = $2`, [webChatActiveMinutesAgo, customer.id]);
    }
    if (chatRedirectSentMinutesAgo !== null) {
      await pool.query(`update customers set chat_redirect_sent_at = now() - make_interval(mins => $1) where id = $2`, [chatRedirectSentMinutesAgo, customer.id]);
    }
    return customer;
  }

  // === 1. Genuinely abandoned: texted 15 min ago, never opened the web
  // chat, no order at all -- gets the nudge. ===
  const abandoned = await makeCustomer('2348013380001', { lastMessageMinutesAgo: 15 });

  // === 2. Too recent -- 5 min old, not abandoned yet. ===
  const tooRecent = await makeCustomer('2348013380002', { lastMessageMinutesAgo: 5 });

  // === 3. Opened the web menu (web_chat_active_at fresh) but said nothing
  // after -- last_message_at is still stale (opening a page alone never
  // touches it), so this is STILL abandonment, same 15 min ago bubble. ===
  const openedMenuSaidNothing = await makeCustomer('2348013380003', { lastMessageMinutesAgo: 15, webChatActiveMinutesAgo: 12 });

  // === 4. Actually still on the page right now (both clocks fresh) --
  // skip, nothing to nudge them about yet. ===
  const stillOnPage = await makeCustomer('2348013380004', { lastMessageMinutesAgo: 2, webChatActiveMinutesAgo: 1 });

  // === 5. Already has an order at confirm_payment -- the OTHER sweep's
  // job, never double-messaged by this one too. ===
  const atPayment = await makeCustomer('2348013380005', { lastMessageMinutesAgo: 15 });
  const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);
  const product = prodRows[0];
  await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-ABANDON-PAY', 'pickup', $2, 'new', 'pending', 'confirm_payment', 'whatsapp')`,
    [atPayment.id, product.price]
  );

  // === 6. Dine-in (an open table session) -- physically at the
  // restaurant, never "abandoned" the same way this feature means. ===
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length
    ? existingBranch[0].id
    : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '31', 'qrabandon31')`, [branchId]);
  const dinein = await makeCustomer('2348013380006', { lastMessageMinutesAgo: 15 });
  const { rows: tableRows } = await pool.query(`select id from restaurant_table where qr_token = 'qrabandon31'`);
  await pool.query(`insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3)`, [tableRows[0].id, branchId, dinein.id]);

  // === 7. Already pinged, never revisited since -- no duplicate. ===
  const alreadyPinged = await makeCustomer('2348013380007', { lastMessageMinutesAgo: 15, chatRedirectSentMinutesAgo: 12 });

  // === 8. Pinged before, but genuinely came back and went quiet again --
  // a fresh nudge is warranted. ===
  const pingedThenReturned = await makeCustomer('2348013380008', { lastMessageMinutesAgo: 15, webChatActiveMinutesAgo: 11, chatRedirectSentMinutesAgo: 40 });

  await flow.sweepAbandonedChatCustomers();

  async function lastOutbound(customerId) {
    const { rows } = await pool.query(
      `select channel, trigger, body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
      [customerId]
    );
    return rows[0] || null;
  }

  const m1 = await lastOutbound(abandoned.id);
  assert(m1?.trigger === 'order_abandonment_nudge' && m1?.channel === 'whatsapp', 'a genuinely abandoned customer (texted, no order, no web-chat visit) gets the real nudge');
  assert(/didn.t go on with your order/i.test(m1?.body || ''), 'with the real requested wording');

  const m2 = await lastOutbound(tooRecent.id);
  assert(!m2, 'only 5 minutes silent -- not abandoned yet, no nudge');

  const m3 = await lastOutbound(openedMenuSaidNothing.id);
  assert(m3?.trigger === 'order_abandonment_nudge', 'opening the web menu but saying nothing after still counts as abandonment once last_message_at is stale');

  const m4 = await lastOutbound(stillOnPage.id);
  assert(!m4, 'a customer genuinely still on the page right now is never nudged');

  const m5 = await lastOutbound(atPayment.id);
  assert(!m5, 'a customer already at confirm_payment is left to the OTHER sweep, never double-messaged here');

  const m6 = await lastOutbound(dinein.id);
  assert(!m6, 'a dine-in customer (open table session) is never nudged by this feature');

  const m7 = await lastOutbound(alreadyPinged.id);
  assert(!m7, 'already pinged with no revisit since -- no duplicate nudge');

  const m8 = await lastOutbound(pingedThenReturned.id);
  assert(m8?.trigger === 'order_abandonment_nudge', 'pinged before, but genuinely came back (web_chat_active_at newer than the old ping) and went quiet again -- a fresh nudge fires');

  // Running the sweep again right away must never double-send the one it just sent.
  const beforeSecondSweep = (await pool.query(`select count(*)::int as n from message where customer_id = $1 and direction = 'outbound'`, [abandoned.id])).rows[0].n;
  await flow.sweepAbandonedChatCustomers();
  const afterSecondSweep = (await pool.query(`select count(*)::int as n from message where customer_id = $1 and direction = 'outbound'`, [abandoned.id])).rows[0].n;
  assert(afterSecondSweep === beforeSecondSweep, 'running the sweep again right away never double-sends the same customer\'s nudge');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
