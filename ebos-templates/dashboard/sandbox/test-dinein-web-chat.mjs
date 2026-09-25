// Chidera, 2026-09-24: "now we need dine in to go through web chat too,
// study how it works and the best way it can go through web chat and bare
// chat to reduce my cost." End-to-end: a real table QR scan still costs
// exactly ONE real WhatsApp message (sendStartOrderLink, same as every
// other first contact); the dine-in-aware welcome bubble on /wa/:token
// points at the table's own /t/:qrToken page; and -- the actual gap this
// test exists to catch -- submitting an order through /t/:qrToken/review
// while web_chat_active_at is fresh must flip the acting customer's
// channel to 'website' before finishItemsCollection runs, so every
// item-question/upsell/confirm message that submission produces lands as a
// free website bubble instead of a real, billable WhatsApp send. Also
// covers the "isRepeatAddOn" branch (adding on after the round's already
// confirmed) taking the same free path.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3955';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3955';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3955';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function countOutbound(pool, customerId, channel) {
  const { rows } = await pool.query(
    `select count(*)::int as n from message where customer_id = $1 and direction = 'outbound' and channel = $2`,
    [customerId, channel]
  );
  return rows[0].n;
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  await pool.query(
    `insert into dinein_config (business_id, enabled) values ($1, true)
     on conflict (business_id) do update set enabled = true`,
    [bizRows[0].id]
  );
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length
    ? existingBranch[0].id
    : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(
    `insert into restaurant_table (branch_id, label, qr_token) values ($1, '7', 'qrtest7') returning id`,
    [branchId]
  );
  const table = tableRows[0];
  const { rows: prodRows } = await pool.query(
    `insert into product (name, description, price, category, branch_id) values ('Suya Wrap', 'spicy wrap', 4700, 'MAINS', $1) returning id`,
    [branchId]
  );
  const productId = prodRows[0].id;

  // === 1. The real QR scan -- exactly one real WhatsApp message, same
  // single-CTA send every other first contact gets, not the old 2-step
  // welcome+menu-link. ===
  await flow.handleInboundMessage({ phoneNumber: '2348013330007', text: 'Menu Table 7', channel: 'whatsapp', messageId: 'd1', branchId });
  await wait(flow.DEBOUNCE_MS + 1000);
  const { rows: custRows } = await pool.query(`select * from customers where phone_number = $1`, ['2348013330007']);
  const customer = custRows[0];
  assert(await countOutbound(pool, customer.id, 'whatsapp') === 1, 'the table scan produced exactly one real WhatsApp message');
  const { rows: greetRows } = await pool.query(
    `select body, trigger from message where customer_id = $1 and direction = 'outbound' and channel = 'whatsapp' order by created_at desc limit 1`,
    [customer.id]
  );
  assert(/tap below to get started/i.test(greetRows[0].body), 'and it is the short universal CTA, not the old 2-step dine-in welcome');
  // Chidera, 2026-09-25: "let the greeting text difference be welcome to
  // <restaurant name> tap below to get started on for your dine in
  // session." The one real WhatsApp message a table scan gets must name
  // the dine-in session specifically, not the generic online wording.
  assert(/dine-in session/i.test(greetRows[0].body), 'and the real WhatsApp message names it as a dine-in session, not the generic online CTA');
  assert(Boolean(customer.menu_token), 'the scan already generated this guest a reusable menu_token');
  const token = customer.menu_token;

  // === 2. GET /wa/:token -- the dine-in-aware first bubble, pointing at
  // this table's own /t/:qrToken page, not the generic /m/:token shop. ===
  const pageRes = await fetch(`${BASE}/wa/${token}`);
  assert(pageRes.status === 200, 'the chat page loads for a dine-in guest');
  const { rows: dineinGreetRows } = await pool.query(
    `select body, trigger, interactive from message where customer_id = $1 and direction = 'outbound' and channel = 'website' order by created_at desc limit 1`,
    [customer.id]
  );
  const dineinGreet = dineinGreetRows[0];
  assert(dineinGreet.trigger === 'dinein_greeting', 'the first website bubble is the dine-in-specific greeting, not the generic order-vs-complaint choice');
  assert(/Table 7/.test(dineinGreet.body), 'it names the real table');
  assert(dineinGreet.interactive?.type === 'cta_url' && dineinGreet.interactive.url.includes(`/t/qrtest7`), 'its "See menu" button points at the table\'s own /t/ page');
  assert(dineinGreet.interactive.url.includes(`g=${token}`), 'carrying this guest\'s own token');

  // === 3. Submit an order through the real /t/:qrToken/review route --
  // this is the actual gap: without the channel flip, everything
  // finishItemsCollection produces below would be a real WhatsApp send. ===
  const reviewRes = await fetch(`${BASE}/t/qrtest7/review?g=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId, quantity: 1 }] }),
  });
  assert(reviewRes.status === 200, 'the order submission is accepted');
  assert(await countOutbound(pool, customer.id, 'whatsapp') === 1, 'still exactly one real WhatsApp message ever -- the whole item-question/upsell/confirm sequence this submission produced landed as free bubbles');
  const websiteCountAfterReview = await countOutbound(pool, customer.id, 'website');
  assert(websiteCountAfterReview > 1, 'and at least one new website bubble was produced by the submission itself (finishItemsCollection actually ran)');

  const { rows: orderRows } = await pool.query(`select * from "order" where table_id = $1 order by created_at desc limit 1`, [table.id]);
  const order = orderRows[0];
  assert(order.channel === 'dinein' && Number(order.total) === 4700, 'the real dine-in order was created with the real submitted total');

  // === 4. Repeat add-on after confirmation -- Chidera's own live bug
  // report from earlier this session ("bot was not acknowledging my new
  // selection") was about upsell taps, not this path, but the isRepeatAddOn
  // branch is a second, separate finishItemsCollection call site that needs
  // the exact same channel-flip fix. ===
  await pool.query(`update "order" set confirmed_at = now() where id = $1`, [order.id]);
  const websiteCountBeforeAddOn = await countOutbound(pool, customer.id, 'website');
  const addOnRes = await fetch(`${BASE}/t/qrtest7/review?g=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId, quantity: 2 }] }),
  });
  assert(addOnRes.status === 200, 'the add-on submission (isRepeatAddOn branch) is accepted');
  assert(await countOutbound(pool, customer.id, 'whatsapp') === 1, 'the add-on round also produced zero real WhatsApp messages');
  assert(await countOutbound(pool, customer.id, 'website') > websiteCountBeforeAddOn, 'and it produced its own free website bubble(s) too');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
