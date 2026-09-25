// Chidera, 2026-09-23: "even when the order is over let that web chat
// never delete any new order they want to place go on afresh there with
// past chat there so it feels like actual whatsapp with chat history."
// Verifying, not assuming: routes/web-chat.js's messageHistory() has
// always queried by customer_id alone (channel='website'), never scoped
// to a single order, and nothing anywhere deletes a website-channel
// message row when an order completes -- a returning customer's SAME
// menu_token/chat page should already show every past message across
// every order they've ever placed.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3944';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3944';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3944';

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

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012353001', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);

  // First visit -- greeting bubble logged.
  await fetch(`${BASE}/wa/${token}`);
  const historyAfterFirstVisit = await (await fetch(`${BASE}/wa/${token}/messages`)).json();
  assert(historyAfterFirstVisit.length >= 1, 'first visit logs at least the greeting bubble');

  // Order 1: completed and paid in full (a real customer's first order).
  const { rows: order1 } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-HIST-1', 'pickup', 3500, 'completed', 'confirmed', 'completed', 'whatsapp') returning *`,
    [customer.id]
  );
  await flow.logWebsiteBubble({ customerId: customer.id, body: 'Your order is ready for pickup!', trigger: 'ready_for_pickup' });

  const historyAfterOrder1 = await (await fetch(`${BASE}/wa/${token}/messages`)).json();
  const order1MessageCount = historyAfterOrder1.length;
  assert(order1MessageCount > historyAfterFirstVisit.length, 'order 1 activity is visible in the chat history');

  // Order 2: a brand new order for the SAME returning customer -- same
  // token, same page, nothing about order 1 gets wiped.
  await flow.logWebsiteBubble({ customerId: customer.id, body: 'Welcome back! What would you like to order this time?', trigger: 'greeting' });
  const { rows: order2 } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-HIST-2', 'pickup', 5000, 'new', 'pending', 'confirm_order', 'whatsapp') returning *`,
    [customer.id]
  );

  const historyAfterOrder2 = await (await fetch(`${BASE}/wa/${token}/messages`)).json();
  assert(historyAfterOrder2.length > order1MessageCount, 'the new order 2 bubble is added, not replacing anything');
  assert(
    historyAfterOrder2.some((m) => /ready for pickup/i.test(m.body || '')),
    'order 1\'s "ready for pickup" message is STILL visible after order 2 starts -- history was never cleared'
  );
  assert(
    historyAfterOrder2.some((m) => /welcome back/i.test(m.body || '')),
    'order 2\'s own greeting is also visible, appended after order 1\'s history, not instead of it'
  );

  // Reopening the SAME link (a fresh page load, not just the poll
  // endpoint) must show the exact same full history -- this is what a
  // returning customer's browser actually does.
  const fullPageHtml = await (await fetch(`${BASE}/wa/${token}`)).text();
  assert(fullPageHtml.includes('ready for pickup'), 'a fresh page load of the same link still carries order 1\'s history into HISTORY');
  assert(fullPageHtml.includes('Welcome back'), 'and order 2\'s greeting too -- one continuous transcript, like real WhatsApp');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
