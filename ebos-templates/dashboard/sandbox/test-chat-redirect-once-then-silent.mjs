// Chidera, 2026-09-24: "in my customers tab in dashboard, they have this
// thing where they can text customer directly, even any text going out to
// the customer, the customer should get a one time we are trying to reach
// out to you tap here to text, so they can enter the webchat...not on
// bare chat that will be costing me, this also reduce the amount of
// conversation they can hold at a cost... also bot must not answer every
// reply customer makes on bare chat, just resend them the place to text
// once if they text bare and if they text bare again, leave it stay
// silent."
//
// Corrected same day: "i said after the first greeting there should be a
// second resend of the tap here to chat to redirect customer again before
// silent, but this one only did first greeting and went quiet with fake
// false hope of typing." Up to TWO consecutive pings (the entry ping, then
// one real resend) before staying fully silent -- not just the one this
// originally stopped at.
//
// Chidera, 2026-09-25: "let bot resend that greeting text to chat a max
// time of 5 cause that 2 is risky, going silent on a customer is risky."
// Raised to FIVE consecutive pings before staying silent.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3952';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3952';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

// Real production always re-fetches the customer fresh from the DB before
// each debounce cycle's dispatch (handleInboundMessage's own
// scheduleDebouncedProcessing) -- a test reusing the same in-memory
// object across multiple handlePendingBatch calls would see stale
// chat_redirect_sent_at/web_chat_active_at/chat_redirect_count values that
// were never really possible in production.
async function freshCustomer(pool, id) {
  const { rows } = await pool.query('select * from customers where id = $1', [id]);
  return rows[0];
}

async function outboundRows(pool, customerId) {
  const { rows } = await pool.query(
    `select channel, sender, body, trigger, created_at from message where customer_id = $1 and direction = 'outbound' order by created_at asc`,
    [customerId]
  );
  return rows;
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  // === PART A: staff's own "Text customer" send (Customers tab) ===
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012360001', channel: 'whatsapp' });

  await flow.sendStaffReply(customer.id, 'Hi, just checking in on your order.', null);
  let rows = await outboundRows(pool, customer.id);
  const bubble1 = rows.find((r) => r.trigger === 'staff_reply');
  const ping1 = rows.find((r) => r.trigger === 'staff_reply_ping');
  assert(Boolean(bubble1), 'the real staff message is logged as a bubble');
  assert(bubble1.channel === 'website', 'on the free website channel, not a real send');
  assert(bubble1.body === 'Hi, just checking in on your order.', 'carrying staff\'s real words');
  assert(Boolean(ping1), 'a real redirect ping was sent for this first message');
  assert(ping1.channel === 'whatsapp', 'the ping itself is a real WhatsApp send');
  assert(/trying to reach out/i.test(ping1.body), 'with the right ping wording');
  assert(!/checking in/i.test(ping1.body), 'the real message content never leaks into the billable ping');

  // Four more staff messages right after -- customer hasn't visited the
  // chat since the first ping, but each of these is still within the 5
  // consecutive pings Chidera asked for, so all four still go out (pings
  // 2 through 5).
  for (let i = 2; i <= 5; i++) {
    await flow.sendStaffReply(customer.id, `Update #${i}.`, null);
  }
  rows = await outboundRows(pool, customer.id);
  let bubbles = rows.filter((r) => r.trigger === 'staff_reply');
  let pings = rows.filter((r) => r.trigger === 'staff_reply_ping');
  assert(bubbles.length === 5, 'all five messages log as free bubbles');
  assert(pings.length === 5, 'and all five real pings go out too -- up to 5 consecutive before silence');

  // A SIXTH staff message, still no visit at all -- now genuinely silent,
  // five consecutive pings already spent.
  await flow.sendStaffReply(customer.id, 'Still there?', null);
  rows = await outboundRows(pool, customer.id);
  bubbles = rows.filter((r) => r.trigger === 'staff_reply');
  pings = rows.filter((r) => r.trigger === 'staff_reply_ping');
  assert(bubbles.length === 6, 'the sixth message still logs as a free bubble');
  assert(pings.length === 5, 'but NO sixth real ping -- five consecutive pings with no visit is the real cap');

  // Customer actually opens the chat page -- but has since left (not
  // "actively on it right now", which would correctly skip the ping for a
  // DIFFERENT reason -- they'd see the free bubble live). Backdating the
  // last ping further into the past first, so there's real room for
  // "visited after that ping, but more than 30 minutes ago".
  await pool.query('update customers set chat_redirect_sent_at = now() - interval \'3 hours\' where id = $1', [customer.id]);
  await pool.query('update customers set web_chat_active_at = now() - interval \'45 minutes\' where id = $1', [customer.id]);
  await flow.sendStaffReply(customer.id, 'One more update for you.', null);
  rows = await outboundRows(pool, customer.id);
  const pingsAfterVisit = rows.filter((r) => r.trigger === 'staff_reply_ping');
  assert(pingsAfterVisit.length === 6, 'a fresh ping IS sent once the customer has genuinely returned to the chat since the last one -- the count resets, not just stays capped forever');

  // === PART B: a customer texting real ("bare") WhatsApp instead of the
  // web chat, while an order is genuinely in progress. ===
  const orderCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012360002', channel: 'whatsapp' });
  const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-REDIRECT-1', 'pickup', $2, 'new', 'pending', 'collect_info', 'whatsapp') returning *`,
    [orderCustomer.id, prodRows[0].price]
  );

  await flow.handlePendingBatch(orderCustomer, 'do you deliver to Lekki?');
  let orderRowsOut = await outboundRows(pool, orderCustomer.id);
  assert(orderRowsOut.length === 1, 'the first bare-WhatsApp text gets exactly one real redirect');
  assert(orderRowsOut[0].trigger === 'greeting', 'tagged the same as the existing redirect (sendStartOrderLink)');

  // Four more bare-WhatsApp texts, no chat visit in between -- all four
  // still get the real redirect (pings 2 through 5, the 5-ping cap).
  for (let i = 2; i <= 5; i++) {
    await flow.handlePendingBatch(await freshCustomer(pool, orderCustomer.id), `hello? still there? (${i})`);
  }
  orderRowsOut = await outboundRows(pool, orderCustomer.id);
  assert(orderRowsOut.length === 5, 'four more bare texts with no chat visit in between still get real redirects, up to 5 total');
  assert(orderRowsOut.every((r) => r.trigger === 'greeting'), 'all tagged with the same redirect trigger');

  // A SIXTH bare-WhatsApp text, still no visit at all -- now genuinely
  // silent, no "fake false hope of typing" either (that's the client-side
  // typing-indicator fix, tested separately).
  await flow.handlePendingBatch(await freshCustomer(pool, orderCustomer.id), 'still nothing?');
  orderRowsOut = await outboundRows(pool, orderCustomer.id);
  assert(orderRowsOut.length === 5, 'a sixth bare text with still no visit gets nothing at all -- five consecutive pings already spent');

  // Customer actually visits the chat -- a later bare text gets redirected
  // again, since they've come back since. Backdating the FIRST redirect
  // further into the past first, so there's real room for "visited after
  // that, but more than 30 minutes ago" (not "actively on it right now",
  // which would skip the ping for a different reason).
  await pool.query('update customers set chat_redirect_sent_at = now() - interval \'3 hours\' where id = $1', [orderCustomer.id]);
  await pool.query('update customers set web_chat_active_at = now() - interval \'45 minutes\' where id = $1', [orderCustomer.id]);
  await flow.handlePendingBatch(await freshCustomer(pool, orderCustomer.id), 'still there?');
  orderRowsOut = await outboundRows(pool, orderCustomer.id);
  assert(orderRowsOut.length === 6, 'after a genuine chat visit since the last redirect, a later bare text gets redirected again -- the count genuinely reset, not just stayed capped');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
