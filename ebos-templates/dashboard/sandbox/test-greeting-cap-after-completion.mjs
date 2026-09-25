// Chidera, 2026-09-25: "after an order has been completed a retext from
// same customer, bot can respond with greeting text again a max of 3
// times." Real gap: handleGreeting's own WhatsApp branch (sendStartOrderLink)
// sent a real, billable WhatsApp greeting on EVERY single bare "hi" from a
// customer with no open order (an order just completed, or none ever
// placed), completely unbounded -- unlike the bare-WhatsApp mid-order
// redirect, which already shares the same 3x chat_redirect budget. Now
// gated behind that same needsChatRedirect/markChatRedirectSent budget.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3990';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3990';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function freshCustomer(pool, id) {
  const { rows } = await pool.query('select * from customers where id = $1', [id]);
  return rows[0];
}

async function outboundGreetings(pool, customerId) {
  const { rows } = await pool.query(
    `select body, trigger from message where customer_id = $1 and direction = 'outbound' and trigger = 'greeting' order by created_at asc`,
    [customerId]
  );
  return rows;
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012371001', channel: 'whatsapp' });

  // A recently completed order, WITH its own feedback request already
  // sent -- same realistic timing sendFeedbackRequest's own "fires right
  // at completion" behavior always produces in practice, so this exercises
  // handleGreeting (not the separate one-time post_completion_greeting
  // branch, already covered elsewhere).
  const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, completed_at)
     values ($1, 'REF-GREETCAP-1', 'pickup', $2, 'completed', 'confirmed', 'completed', now()) returning *`,
    [customer.id, prodRows[0].price]
  );
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [orderRows[0].id, prodRows[0].id, prodRows[0].price]);
  await pool.query(`insert into order_feedback (order_id, customer_id, channel, status) values ($1, $2, 'whatsapp', 'sent')`, [orderRows[0].id, customer.id]);

  const sendAndWait = async (c) => { await flow.handleInboundMessage({ phoneNumber: '2348012371001', text: 'hi', channel: 'whatsapp', messageId: `m-${Date.now()}-${Math.random()}` }); await wait(flow.DEBOUNCE_MS + 500); };

  // === 1-3: three bare re-texts, each still gets a real greeting. ===
  await sendAndWait();
  let greetings = await outboundGreetings(pool, customer.id);
  assert(greetings.length === 1, `first re-text after completion gets a real greeting (got ${greetings.length})`);

  await sendAndWait();
  greetings = await outboundGreetings(pool, customer.id);
  assert(greetings.length === 2, `second re-text still gets a real greeting (got ${greetings.length})`);

  await sendAndWait();
  greetings = await outboundGreetings(pool, customer.id);
  assert(greetings.length === 3, `third re-text still gets a real greeting -- the cap is 3 (got ${greetings.length})`);

  // === 4th: capped out, no visit in between -- stays silent. ===
  await sendAndWait();
  greetings = await outboundGreetings(pool, customer.id);
  assert(greetings.length === 3, `a 4th re-text with still no chat visit gets nothing at all -- 3 consecutive greetings already spent (got ${greetings.length})`);

  // === A genuine web-chat visit resets the budget -- a later re-text gets
  // greeted again. ===
  await pool.query(`update customers set chat_redirect_sent_at = now() - interval '3 hours' where id = $1`, [customer.id]);
  await pool.query(`update customers set web_chat_active_at = now() - interval '45 minutes' where id = $1`, [customer.id]);
  await sendAndWait();
  greetings = await outboundGreetings(pool, customer.id);
  assert(greetings.length === 4, `after a genuine web-chat visit since the last greeting, a later re-text is greeted again -- the count genuinely reset (got ${greetings.length})`);

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
