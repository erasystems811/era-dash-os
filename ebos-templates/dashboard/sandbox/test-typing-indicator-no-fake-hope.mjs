// Chidera, 2026-09-24, real report: "if on bare chat we already set that
// bot wont respond, why is it still showing the typing sign like it
// wants to respond? ... went quiet with fake false hope of typing."
// handleInboundMessage used to start WhatsApp's real "typing..." keep-alive
// unconditionally, before the debounce even fires -- by the time
// handlePendingBatch's own redirect gate decided to stay silent (already
// pinged twice, no chat visit since), the customer had already watched
// "typing..." for the whole debounce+processing wait with nothing ever
// arriving. shouldSkipTypingIndicator reuses the exact same checks the
// real gate makes, so it can never promise a reply the gate has already
// decided not to send.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3958';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3958';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function freshCustomer(pool, id) {
  const { rows } = await pool.query('select * from customers where id = $1', [id]);
  return rows[0];
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  // === 1. A customer's very first-ever bare text -- the gate WILL send a
  // real redirect, so typing is genuinely honest here. ===
  const firstContact = await flow.findOrCreateCustomer({ phoneNumber: '2348012370001', channel: 'whatsapp' });
  assert((await flow.shouldSkipTypingIndicator(firstContact, 'whatsapp', 'do you have jollof rice')) === false, 'first-ever contact: typing shows, a real redirect IS coming');

  // === 2. Second bare text, no chat visit -- still the one real resend
  // (Chidera's own "second resend before silent"), typing still honest. ===
  await pool.query('update customers set chat_redirect_sent_at = now(), chat_redirect_count = 1 where id = $1', [firstContact.id]);
  const afterFirstPing = await freshCustomer(pool, firstContact.id);
  assert((await flow.shouldSkipTypingIndicator(afterFirstPing, 'whatsapp', 'hello?')) === false, 'second bare text (the one real resend): typing still shows');

  // === 3. THE REAL BUG: third bare text, still no visit -- the gate is
  // genuinely exhausted (2 consecutive pings already sent) and will stay
  // completely silent. Typing must NOT show -- no fake hope. ===
  await pool.query('update customers set chat_redirect_count = 2 where id = $1', [firstContact.id]);
  const afterSecondPing = await freshCustomer(pool, firstContact.id);
  assert((await flow.shouldSkipTypingIndicator(afterSecondPing, 'whatsapp', 'still there?')) === true, 'third bare text with no visit: gate is exhausted, typing must NOT show');

  // === 4. Customer genuinely visited the chat since the last ping -- the
  // count resets, a fresh real ping IS coming, typing is honest again.
  // Backdating the ping itself first so there's real room for "visited
  // after that ping, but more than 30 minutes ago" (not "actively on it
  // right now", which would skip typing for a different, unrelated reason). ===
  await pool.query('update customers set chat_redirect_sent_at = now() - interval \'3 hours\' where id = $1', [firstContact.id]);
  await pool.query('update customers set web_chat_active_at = now() - interval \'45 minutes\' where id = $1', [firstContact.id]);
  const afterVisit = await freshCustomer(pool, firstContact.id);
  assert((await flow.shouldSkipTypingIndicator(afterVisit, 'whatsapp', 'still there?')) === false, 'after a genuine chat visit since the last ping: typing shows again, a fresh redirect IS coming');

  // === 5. A pure "ok"-type ack against a genuinely OPEN order bypasses the
  // redirect gate entirely and always gets a real dispatch reply -- typing
  // must show even though the gate itself is exhausted (chat_redirect_count
  // still 2, unchanged from step 3/4's setup on a DIFFERENT customer here). ===
  const orderCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012370002', channel: 'whatsapp' });
  await pool.query('update customers set chat_redirect_sent_at = now(), chat_redirect_count = 2 where id = $1', [orderCustomer.id]);
  const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);
  await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-TYPING-1', 'pickup', $2, 'new', 'pending', 'collect_info', 'whatsapp')`,
    [orderCustomer.id, prodRows[0].price]
  );
  const withOpenOrder = await freshCustomer(pool, orderCustomer.id);
  assert((await flow.shouldSkipTypingIndicator(withOpenOrder, 'whatsapp', 'ok')) === false, 'a plain "ok" ack against a real open order bypasses the redirect gate -- a real dispatch reply IS coming, typing must show');

  // === 6. Same exhausted-gate customer, but NOT a pure ack ("ok" with no
  // open order at all this time) -- genuinely silent, typing must NOT show. ===
  const noOrderCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012370003', channel: 'whatsapp' });
  await pool.query('update customers set chat_redirect_sent_at = now(), chat_redirect_count = 2 where id = $1', [noOrderCustomer.id]);
  const noOrder = await freshCustomer(pool, noOrderCustomer.id);
  assert((await flow.shouldSkipTypingIndicator(noOrder, 'whatsapp', 'ok')) === true, 'a plain "ok" ack with no open order at all falls through to the exhausted redirect gate -- silent, no fake typing');

  // === 7. A website-channel customer is never touched by any of this --
  // typing always shows on the free web chat, unaffected. ===
  const webCustomer = { ...noOrder, channel: 'website' };
  assert((await flow.shouldSkipTypingIndicator(webCustomer, 'website', 'still there?')) === false, 'a website-channel customer is completely unaffected -- never a WhatsApp typing indicator in the first place');

  // === 8. A customer a human staff member already has never shows typing
  // for the bot -- unchanged from before, not something this fix touches. ===
  await pool.query(`update customers set handled_by = 'staff' where id = $1`, [noOrderCustomer.id]);
  const staffHeld = await freshCustomer(pool, noOrderCustomer.id);
  assert((await flow.shouldSkipTypingIndicator(staffHeld, 'whatsapp', 'anyone there?')) === false, 'staff-held customers are left exactly as before -- this fix only narrows the redirect-gate case');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
