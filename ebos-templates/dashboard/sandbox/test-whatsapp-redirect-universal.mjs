// Chidera, 2026-09-24: "in general, any outbound text should redirect
// customer to the web chat and if customer text on bare again only 1 re
// ping after that bot only responds in web chat not bare chat." Was
// scoped to "only once an order's already in progress" -- now applies to
// ANY real WhatsApp text, including a customer's very FIRST message
// (greeting or a straight order request), before any order even exists
// yet. classifyIntent/handleGreeting/handleEnquiry/dispatch must never
// run at all for a whatsapp customer anymore.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3953';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3953';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function outboundRows(pool, customerId) {
  const { rows } = await pool.query(
    `select channel, sender, body, trigger from message where customer_id = $1 and direction = 'outbound' order by created_at asc`,
    [customerId]
  );
  return rows;
}

async function freshCustomer(pool, id) {
  const { rows } = await pool.query('select * from customers where id = $1', [id]);
  return rows[0];
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  // === 1. A customer's very FIRST message ever, no order, a real order
  // request (not a pure greeting) -- must redirect, NOT run
  // classifyIntent/handleCollectInfo/create an order via real AI. ===
  const orderTextCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012361001', channel: 'whatsapp' });
  await flow.handlePendingBatch(orderTextCustomer, 'I want jollof rice and a drink please');
  let rows = await outboundRows(pool, orderTextCustomer.id);
  assert(rows.length === 1, 'exactly one real message went out for this first-ever order-shaped text');
  assert(rows[0].trigger === 'greeting', 'it is the redirect (sendStartOrderLink), same trigger as the plain-greeting case');
  const { rows: ordersCreated } = await pool.query(`select count(*)::int as n from "order" where customer_id = $1`, [orderTextCustomer.id]);
  assert(ordersCreated[0].n === 0, 'no order was created -- classifyIntent/handleCollectInfo never ran at all, no real AI call needed');

  // === 2. Same customer, texting again with no chat visit in between --
  // Chidera, 2026-09-24: "after the first greeting there should be a
  // second resend... before silent"; 2026-09-25: "let bot resend that
  // greeting text to chat a max time of 5 cause that 2 is risky." Four
  // more real resends still go out here (pings 2-5), then a bare text
  // past the cap with still no visit is genuinely silent.
  for (let i = 2; i <= 5; i++) {
    await flow.handlePendingBatch(await freshCustomer(pool, orderTextCustomer.id), `hello? (${i})`);
  }
  rows = await outboundRows(pool, orderTextCustomer.id);
  assert(rows.length === 5, 'four more bare texts with no chat visit still get real resends, up to 5 total');
  await flow.handlePendingBatch(await freshCustomer(pool, orderTextCustomer.id), 'still there?');
  rows = await outboundRows(pool, orderTextCustomer.id);
  assert(rows.length === 5, 'a bare text past the cap with still no visit gets nothing at all -- five consecutive pings already spent');

  // === 3. A plain "thanks"/"okay" ack from a whatsapp customer also
  // redirects now instead of getting an instant real "You're welcome!". ===
  const thanksCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012361002', channel: 'whatsapp' });
  await flow.handlePendingBatch(thanksCustomer, 'thank you');
  rows = await outboundRows(pool, thanksCustomer.id);
  assert(rows.length === 1 && rows[0].trigger === 'greeting', '"thank you" redirects to the chat link instead of an instant real reply');
  assert(!rows.some((r) => r.trigger === 'thanks_ack'), 'no real thanks_ack send happened');

  // === 4. A website-channel customer (already on the free chat page) is
  // COMPLETELY unaffected -- "thanks" still gets the real instant bubble,
  // same as always. ===
  const webCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012361003', channel: 'whatsapp' });
  await flow.handlePendingBatch({ ...webCustomer, channel: 'website' }, 'thank you');
  rows = await outboundRows(pool, webCustomer.id);
  const websiteThanks = rows.find((r) => r.trigger === 'thanks_ack');
  assert(Boolean(websiteThanks), `a website-channel customer still gets the real "You're welcome!" bubble, unaffected by any of this`);
  assert(websiteThanks.channel === 'website', 'on the free website channel, as always');

  // === 5. Chidera, 2026-09-24: "now we need dine in to go through web
  // chat too." Dine-in is now folded INTO the universal gate, same as
  // every other whatsapp customer -- a dine-in guest's own bare text (no
  // chat visit since the last ping) gets redirected too, not routed
  // through the normal AI-dependent path. This deliberately replaces the
  // earlier version of this assertion (dine-in used to be excluded here on
  // purpose, before the dine-in-to-web-chat migration existed). ===
  const dineinCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012361004', channel: 'whatsapp' });
  const { rows: tableRows } = await pool.query(`select id from restaurant_table limit 1`);
  if (tableRows.length) {
    await pool.query(
      `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel, table_id)
       values ($1, 'REF-DINEIN-UNIV', null, 3500, 'new', 'pending', 'collect_info', 'dinein', $2)`,
      [dineinCustomer.id, tableRows[0].id]
    );
  } else {
    await pool.query(
      `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
       values ($1, 'REF-DINEIN-UNIV', null, 3500, 'new', 'pending', 'collect_info', 'dinein')`,
      [dineinCustomer.id]
    );
  }
  await flow.handlePendingBatch(dineinCustomer, 'do you have jollof rice');
  rows = await outboundRows(pool, dineinCustomer.id);
  assert(rows.length === 1 && rows[0].trigger === 'greeting', 'a dine-in guest\'s own bare WhatsApp text also redirects now -- no AI call, no leaked normal-path reply');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
