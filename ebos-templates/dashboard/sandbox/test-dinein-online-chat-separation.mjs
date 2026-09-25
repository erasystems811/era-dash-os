// Chidera, 2026-09-25: "let table dine in and online delivery have their
// complete different web chat so a person can be doing both at same time
// in 2 different web chats, so let dine in be its own web chat." The
// SAME customer (same phone number/customer_id) can have an ordinary
// online order AND an open dine-in table session going at once -- this
// proves the two now live on genuinely separate threads (routes/
// web-chat.js's ?table=), not just separately-resolved orders
// (getOpenOrder's own dine-in exclusion, already covered elsewhere).
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3966';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3966';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3966';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
  await pool.query(
    `insert into restaurant_table (branch_id, label, qr_token) values ($1, '21', 'qrsep21')`,
    [branchId]
  );
  const { rows: prodRows } = await pool.query(
    `insert into product (name, description, price, category, branch_id) values ('Zobo', 'chilled', 1200, 'DRINKS', $1) returning id`,
    [branchId]
  );
  const productId = prodRows[0].id;
  const phoneNumber = '2348013370021';

  // === 1. The SAME customer starts an ordinary online conversation first
  // ("hi", no table) -- gets the generic bare-thread greeting. ===
  await flow.handleInboundMessage({ phoneNumber, text: 'hi', channel: 'whatsapp', messageId: 'sep1', branchId });
  await wait(flow.DEBOUNCE_MS + 1000);
  const { rows: custRows } = await pool.query(`select * from customers where phone_number = $1`, [phoneNumber]);
  const customer = custRows[0];
  const token = customer.menu_token;

  const onlinePage = await (await fetch(`${BASE}/wa/${token}`)).text();
  assert(onlinePage.includes('"trigger":"first_choice"'), 'the bare thread shows the generic online first-choice bubble');
  assert(!onlinePage.includes('Table 21'), 'and NOT any dine-in content -- no table session exists yet');

  // === 2. The SAME customer (SAME phone number, SAME customer_id) then
  // also scans table 21's QR code -- a genuinely separate real-life act,
  // e.g. dining in while a delivery order for the house is still open. ===
  await flow.handleInboundMessage({ phoneNumber, text: 'Menu Table 21', channel: 'whatsapp', messageId: 'sep2', branchId });
  await wait(flow.DEBOUNCE_MS + 1000);
  const { rows: tableRows } = await pool.query(`select id from restaurant_table where qr_token = 'qrsep21'`);
  const table = tableRows[0];

  const dineinPage = await (await fetch(`${BASE}/wa/${token}?table=qrsep21`)).text();
  assert(dineinPage.includes('Table 21'), 'the table-scoped thread shows the real dine-in greeting');
  assert(!dineinPage.includes('"trigger":"first_choice"'), 'and NOT the generic online first-choice bubble -- genuinely separate content');

  // === 3. The bare online thread is unaffected by the table scan -- still
  // exactly what it was before, the two threads never bled into each other. ===
  const onlinePageAgain = await (await fetch(`${BASE}/wa/${token}`)).text();
  assert(onlinePageAgain.includes('"trigger":"first_choice"'), 'the bare thread still shows its own original content');
  assert(!onlinePageAgain.includes('Table 21'), 'and still never picked up the dine-in greeting');

  // === 4. Typing into the ONLINE thread only logs there, not into the
  // dine-in thread's own poll. ===
  const dineinCountBeforeTap = (await (await fetch(`${BASE}/wa/${token}/messages?table=qrsep21`)).json()).length;
  const onlineCountBeforeTap = (await (await fetch(`${BASE}/wa/${token}/messages`)).json()).length;
  await fetch(`${BASE}/wa/${token}/tap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ buttonId: 'wa_start_order' }),
  });
  const onlinePoll = await (await fetch(`${BASE}/wa/${token}/messages`)).json();
  const dineinPollBefore = await (await fetch(`${BASE}/wa/${token}/messages?table=qrsep21`)).json();
  assert(onlinePoll.length > onlineCountBeforeTap, 'the online "Place an order" tap logged into the online thread');
  assert(dineinPollBefore.length === dineinCountBeforeTap, 'and did NOT leak into the dine-in thread\'s own poll');

  // === 5. Submitting a real dine-in order only logs into the dine-in
  // thread, not the online one -- the actual "doing both at once" proof. ===
  const onlineCountBefore = onlinePoll.length;
  await fetch(`${BASE}/t/qrsep21/review?g=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId, quantity: 1 }] }),
  });
  const dineinPollAfter = await (await fetch(`${BASE}/wa/${token}/messages?table=qrsep21`)).json();
  const onlinePollAfter = await (await fetch(`${BASE}/wa/${token}/messages`)).json();
  assert(dineinPollAfter.length > dineinPollBefore.length, 'the dine-in order submission produced new bubbles on the dine-in thread');
  assert(onlinePollAfter.length === onlineCountBefore, 'and produced ZERO new bubbles on the online thread -- true simultaneous separation');

  const { rows: orderRows } = await pool.query(`select * from "order" where table_id = $1 order by created_at desc limit 1`, [table.id]);
  assert(orderRows[0]?.channel === 'dinein' && Number(orderRows[0].total) === 1200, 'the real dine-in order exists, unaffected by the online thread\'s own state');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
