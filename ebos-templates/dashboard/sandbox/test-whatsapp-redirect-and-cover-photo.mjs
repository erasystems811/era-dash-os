// Chidera, 2026-09-23: "is it possible that if a customer message they
// send them the link again with chat here so they can keep chatting there
// so basically thats the only 3rd acceptable text that can go through
// normal route? and let first message still have that cover photo"
//
// Two real fixes here:
// 1. A real WhatsApp text for an order already in progress used to go
//    straight to detectWantsHuman/dispatch() -- an AI call plus whatever
//    reply the engine generated, unbounded real message count. Now
//    redirected to the SAME chat page instead (one short real message,
//    no AI call), scoped to real WhatsApp text only (not dine-in, not
//    text relayed from the chat page itself).
// 2. sendStartOrderLink (the short first-contact message this whole
//    feature introduced) never got the cover-photo header the original,
//    full-length handleGreeting always had -- a real regression from
//    splitting the greeting, not something intentional.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3941';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3941';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  const { rows: bizRows } = await pool.query(
    `insert into business (name, type, address, phone_number, delivery_enabled, whatsapp_connection)
     values ('Test Biz', 'restaurant', '1 Test Street', '2348010000000', true, 'api_only') returning id`
  );
  // A real cover photo, so businessCoverPhotoUrl() has something to resolve --
  // a tiny valid PNG data URI, not empty/null, which is what the earlier
  // regression was silently falling back to.
  await pool.query(`update business set cover_photo_data_url = $1 where id = $2`, [
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    bizRows[0].id,
  ]);
  await pool.query(`insert into product (name, description, price, availability_type) values ('Jollof Rice', 'desc', 3500, 'stock')`);

  // === 1. Cover photo on the first-contact message ===
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); originalLog(...args); };
  await flow.handleStartOrderTap({ phoneNumber: '2348012349001', channel: 'whatsapp' });
  console.log = originalLog;
  const greetingLog = logs.find((l) => l.includes('2348012349001'));
  assert(Boolean(greetingLog), 'the first-contact message actually went out');
  assert(greetingLog?.includes('[header:'), 'and it carries the real cover photo header -- this was silently dropped after the greeting was split into a short message');

  // === 2. A real WhatsApp text on an active, non-dine-in order gets
  // redirected to the SAME chat link, no AI call needed at all. ===
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012349002', channel: 'whatsapp' });
  const { rows: order1 } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-REDIR-1', 'pickup', 3500, 'new', 'pending', 'collect_info', 'whatsapp') returning *`,
    [customer.id]
  );
  const logs2 = [];
  console.log = (...args) => { logs2.push(args.join(' ')); originalLog(...args); };
  await flow.handlePendingBatch(customer, 'do you have jollof rice');
  console.log = originalLog;
  const redirectLog = logs2.find((l) => l.includes('2348012349002'));
  assert(Boolean(redirectLog), 'the customer gets a real reply');
  assert(redirectLog?.includes('Tap below to get started') || redirectLog?.includes('Tap here to text'), 'and it\'s the chat-link redirect, not the AI engine\'s own answer to the question');
  const { rows: msgAfter1 } = await pool.query(`select trigger from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`, [customer.id]);
  assert(msgAfter1[0]?.trigger === 'greeting', 'tagged as the same greeting/redirect trigger, not a real engine reply');

  // === 3. A dine-in order must NOT be redirected -- dine-in guests belong
  // on their own table page, this feature never touched dine-in. We can't
  // fully exercise detectWantsHuman/dispatch here (real AI, no sandbox
  // stub) -- just prove the redirect branch specifically was skipped. ===
  const dineinCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012349003', channel: 'whatsapp' });
  const { rows: order2 } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-REDIR-2', null, 3500, 'new', 'pending', 'collect_info', 'dinein') returning *`,
    [dineinCustomer.id]
  );
  try {
    await flow.handlePendingBatch(dineinCustomer, 'do you have jollof rice');
  } catch (err) {
    if (!/Anthropic API|x-api-key/i.test(err.message)) throw err;
  }
  const { rows: dineinMsg } = await pool.query(`select trigger from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`, [dineinCustomer.id]);
  assert(dineinMsg[0]?.trigger !== 'greeting', 'a dine-in order is never redirected to the chat link -- it still tries the normal (AI-dependent) path');

  // === 4. Text relayed FROM the chat page itself (customer.channel already
  // flipped to 'website') must also skip the redirect -- that's the exact
  // path that's SUPPOSED to keep dispatching normally. ===
  const webChatCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012349004', channel: 'whatsapp' });
  const { rows: order3 } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-REDIR-3', 'pickup', 3500, 'new', 'pending', 'collect_info', 'whatsapp') returning *`,
    [webChatCustomer.id]
  );
  try {
    await flow.handlePendingBatch({ ...webChatCustomer, channel: 'website' }, 'do you have jollof rice');
  } catch (err) {
    if (!/Anthropic API|x-api-key/i.test(err.message)) throw err;
  }
  const { rows: webChatMsg } = await pool.query(`select trigger, channel from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`, [webChatCustomer.id]);
  assert(webChatMsg[0]?.trigger !== 'greeting', 'text relayed from the chat page itself is never redirected back to a link -- it already IS on the chat page');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
