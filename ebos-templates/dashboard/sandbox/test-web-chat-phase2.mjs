// Phase 2 of the web-chat feature (deferred from the original plan, built
// 2026-09-23): the abandonment nudge and the feedback-request website
// branch. Chidera: "go on with phase 2 and minor fix."
//
// Abandonment nudge: on plain WhatsApp, a customer left at confirm_payment
// naturally re-engages by texting something, which is what triggers
// handleWaitingOnPayment's existing reminder. A web-chat customer who taps
// "Ready to pay?", opens the pay page, then just closes the tab has no way
// to trigger that -- sweepAbandonedWebChatOrders (flow.js) is the proactive
// counterpart: real silence past PAYMENT_NUDGE_MINUTES gets exactly ONE
// real WhatsApp/Instagram nudge, reusing order.payment_reminder_sent_at
// (already existed for the reactive case) as the single idempotency guard.
//
// Feedback request: sendFeedbackRequest used to flatly skip any customer
// whose channel wasn't whatsapp/instagram -- a web-chat customer never got
// asked for feedback at all. Now checks web_chat_active_at freshness (same
// pattern completePayment already uses) and renders a bubble instead of a
// real send when they're still recently active on the chat page.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3933';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3933';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch('http://localhost:3933/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);
  const product = prodRows[0];
  const total = Number(product.price);

  async function makeOrder(customer, { updatedMinutesAgo, webChatActiveMinutesAgo, reminderAlreadySent }) {
    const { rows } = await pool.query(
      `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
       values ($1, $2, 'pickup', $3, 'new', 'pending', 'confirm_payment', $4) returning *`,
      [customer.id, `REF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, total, customer.channel]
    );
    const order = rows[0];
    await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order.id, product.id, product.price]);
    await pool.query(`update "order" set updated_at = now() - make_interval(mins => $1) where id = $2`, [updatedMinutesAgo, order.id]);
    if (reminderAlreadySent) await pool.query(`update "order" set payment_reminder_sent_at = now() where id = $1`, [order.id]);
    if (webChatActiveMinutesAgo !== null) {
      await pool.query(`update customers set web_chat_active_at = now() - make_interval(mins => $1) where id = $2`, [webChatActiveMinutesAgo, customer.id]);
    }
    return order;
  }

  // === 1. Genuinely abandoned: 25 min silent, never touched web-chat -- gets the nudge ===
  const abandoned = await flow.findOrCreateCustomer({ phoneNumber: '2348012344001', channel: 'whatsapp' });
  const abandonedOrder = await makeOrder(abandoned, { updatedMinutesAgo: 25, webChatActiveMinutesAgo: null, reminderAlreadySent: false });

  // === 2. Too recent -- 5 min old, should NOT be nudged yet ===
  const tooRecent = await flow.findOrCreateCustomer({ phoneNumber: '2348012344002', channel: 'whatsapp' });
  const tooRecentOrder = await makeOrder(tooRecent, { updatedMinutesAgo: 5, webChatActiveMinutesAgo: null, reminderAlreadySent: false });

  // === 3. Still actively on the chat page right now -- skip, they're already looking at the bubble ===
  const stillActive = await flow.findOrCreateCustomer({ phoneNumber: '2348012344003', channel: 'whatsapp' });
  const stillActiveOrder = await makeOrder(stillActive, { updatedMinutesAgo: 25, webChatActiveMinutesAgo: 2, reminderAlreadySent: false });

  // === 4. Already reminded (e.g. they texted "okay" and got the reactive one) -- never a duplicate ===
  const alreadyReminded = await flow.findOrCreateCustomer({ phoneNumber: '2348012344004', channel: 'whatsapp' });
  const alreadyRemindedOrder = await makeOrder(alreadyReminded, { updatedMinutesAgo: 25, webChatActiveMinutesAgo: null, reminderAlreadySent: true });

  // === 5. Dine-in -- excluded entirely, staff-mediated, never "abandoned" the same way ===
  const dinein = await flow.findOrCreateCustomer({ phoneNumber: '2348012344005', channel: 'whatsapp' });
  const dineinOrder = await makeOrder(dinein, { updatedMinutesAgo: 25, webChatActiveMinutesAgo: null, reminderAlreadySent: false });
  await pool.query(`update "order" set channel = 'dinein' where id = $1`, [dineinOrder.id]);

  await flow.sweepAbandonedWebChatOrders();

  const { rows: r1 } = await pool.query(`select payment_reminder_sent_at from "order" where id = $1`, [abandonedOrder.id]);
  assert(r1[0].payment_reminder_sent_at !== null, 'a genuinely abandoned order gets the nudge (payment_reminder_sent_at set)');
  const { rows: msg1 } = await pool.query(`select channel, trigger from message where customer_id = $1 order by created_at desc limit 1`, [abandoned.id]);
  assert(msg1[0]?.channel === 'whatsapp' && msg1[0]?.trigger === 'payment_reminder', 'the nudge is a real WhatsApp payment reminder, since they genuinely left');

  const { rows: r2 } = await pool.query(`select payment_reminder_sent_at from "order" where id = $1`, [tooRecentOrder.id]);
  assert(r2[0].payment_reminder_sent_at === null, 'an order only 5 minutes old is not nudged yet -- too soon to call it abandoned');

  const { rows: r3 } = await pool.query(`select payment_reminder_sent_at from "order" where id = $1`, [stillActiveOrder.id]);
  assert(r3[0].payment_reminder_sent_at === null, 'a customer still actively on the chat page right now is never pinged on top of the bubble they\'re already looking at');

  const { rows: msg4 } = await pool.query(`select count(*)::int as n from message where customer_id = $1 and direction = 'outbound'`, [alreadyReminded.id]);
  assert(msg4[0].n === 0, 'an order whose reminder already went out (reactively) gets no duplicate from the sweep');

  const { rows: r5 } = await pool.query(`select payment_reminder_sent_at from "order" where id = $1`, [dineinOrder.id]);
  assert(r5[0].payment_reminder_sent_at === null, 'a dine-in order is never touched by this sweep -- staff-mediated, not "abandoned" the same way');

  // Running the sweep again must never double-send the one it already sent.
  const beforeSecondSweepCount = (await pool.query(`select count(*)::int as n from message where customer_id = $1 and direction = 'outbound'`, [abandoned.id])).rows[0].n;
  await flow.sweepAbandonedWebChatOrders();
  const afterSecondSweepCount = (await pool.query(`select count(*)::int as n from message where customer_id = $1 and direction = 'outbound'`, [abandoned.id])).rows[0].n;
  assert(afterSecondSweepCount === beforeSecondSweepCount, 'running the sweep again never double-sends the same order\'s nudge');

  // === Feedback request: web-chat-active customer gets a bubble, not a real send ===
  const feedbackWebChat = await flow.findOrCreateCustomer({ phoneNumber: '2348012344006', channel: 'whatsapp' });
  await pool.query('update customers set web_chat_active_at = now() where id = $1', [feedbackWebChat.id]);
  const { rows: fbOrder1 } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-FB-WEBCHAT', 'pickup', $2, 'completed', 'confirmed', 'completed', 'whatsapp') returning *`,
    [feedbackWebChat.id, total]
  );
  await flow.sendFeedbackRequest(fbOrder1[0].id);
  const { rows: fbMsg1 } = await pool.query(`select channel, interactive from message where customer_id = $1 and trigger = 'feedback_form_sent' order by created_at desc limit 1`, [feedbackWebChat.id]);
  assert(fbMsg1[0]?.channel === 'website', 'a customer still recently active on the chat page gets the feedback request as a bubble');
  assert(fbMsg1[0]?.interactive?.type === 'cta_url', 'rendered as a real tappable "Rate your order" button');

  // === Feedback request: stale/never-active customer still gets the real send (unchanged behavior) ===
  const feedbackStale = await flow.findOrCreateCustomer({ phoneNumber: '2348012344007', channel: 'whatsapp' });
  const { rows: fbOrder2 } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-FB-STALE', 'pickup', $2, 'completed', 'confirmed', 'completed', 'whatsapp') returning *`,
    [feedbackStale.id, total]
  );
  await flow.sendFeedbackRequest(fbOrder2[0].id);
  const { rows: fbMsg2 } = await pool.query(`select channel from message where customer_id = $1 and trigger = 'feedback_form_sent' order by created_at desc limit 1`, [feedbackStale.id]);
  assert(fbMsg2[0]?.channel === 'whatsapp', 'a customer who never touched web-chat still gets the real WhatsApp feedback request, unchanged');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
