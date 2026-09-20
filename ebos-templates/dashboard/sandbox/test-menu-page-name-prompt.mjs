// Regression + feature test for routes/menu-page.js (general, non-dine-in
// web ordering). Confirms the general-ordering page and a plain order
// submit still work after joint dine-in Stage 1 touched shared code in
// menu-page-template.js (POLL_PATH stays null/inert here, the poll code
// never runs on this route). Also covers the name prompt (2026-09-20,
// "we agreed a name so bot can refer to customer"): shows only when no
// name is on file, saves and persists, stops showing once set, and the
// bot's own greeting actually reads it back.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3913';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3913';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3913';

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

  const { rows: prodRows } = await pool.query(`select id from product limit 1`);
  const productId = prodRows[0].id;

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348099990000', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);

  const page = await fetch(`${BASE}/m/${token}`);
  assert(page.status === 200, 'general ordering page loads');
  const html = await page.text();
  assert(html.includes('POLL_PATH = null'), 'POLL_PATH stays null on the non-dine-in page (no shared-order polling)');

  const review = await fetch(`${BASE}/m/${token}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId, quantity: 2, answers: {} }] }),
  });
  const reviewData = await review.json();
  assert(review.status === 200 && reviewData.ok, 'general order submit still succeeds');

  const { rows: orderRows } = await pool.query(`select * from "order" where customer_id = $1`, [customer.id]);
  assert(orderRows.length === 1, 'exactly one order created');
  const { rows: items } = await pool.query(`select * from order_item where order_id = $1`, [orderRows[0].id]);
  assert(items.length === 1 && items[0].quantity === 2, 'order item correctly persisted');

  // --- Name prompt ("we agreed a name so bot can refer to customer") ---
  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  await pool.query(
    `insert into crm_config (business_id, enabled) values ($1, true)
     on conflict (business_id) do update set enabled = true`,
    [bizRows[0].id]
  );

  const page2 = await fetch(`${BASE}/m/${token}`);
  const html2 = await page2.text();
  assert(html2.includes('SHOW_NAME_PROMPT = true'), 'name prompt shows for a customer with no name on file');

  const nameSave = await fetch(`${BASE}/m/${token}/name`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Ada' }),
  });
  assert(nameSave.status === 200, 'name save succeeds');
  const { rows: custAfter } = await pool.query(`select name from customers where id = $1`, [customer.id]);
  assert(custAfter[0]?.name === 'Ada', 'name actually persisted');

  const page3 = await fetch(`${BASE}/m/${token}`);
  const html3 = await page3.text();
  assert(html3.includes('SHOW_NAME_PROMPT = false'), 'name prompt stops showing once a name is on file');

  // handleGreeting reads it back -- "Hello [Name]!" -- via a real inbound
  // "hi" message (handleInboundMessage's own debounce, same pattern as
  // sandbox/test-conversation.mjs), not calling the internal function
  // directly (it isn't exported). A FRESH customer, not the one above --
  // that one already has an in-progress order/conversation, so "hi" from
  // them gets a context-aware reply, not the cold-open greeting.
  const greetCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348088880000', channel: 'whatsapp' });
  await pool.query('update customers set name = $1 where id = $2', ['Ada', greetCustomer.id]);
  await flow.handleInboundMessage({ phoneNumber: '2348088880000', text: 'hi', channel: 'whatsapp' });
  await new Promise((r) => setTimeout(r, flow.DEBOUNCE_MS + 1000));
  const { rows: greetRows } = await pool.query(
    `select body from message where customer_id = $1 and trigger = 'greeting' order by created_at desc limit 1`,
    [greetCustomer.id]
  );
  assert(greetRows[0]?.body?.startsWith('Hello Ada!'), 'bot greeting actually uses the saved name');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
