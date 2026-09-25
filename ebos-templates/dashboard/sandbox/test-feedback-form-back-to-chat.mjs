// Chidera, 2026-09-25: "after feedback take customer back to web chat ...
// after giving feedback that thank you, feedback should have a back to
// chat thing." The feedback form's own "back to chat" used to be a bare
// wa.me/<number> redirect (Chidera 2026-09-11's original fix, predating
// the web-chat feature entirely) -- now the real /wa/:token thread
// instead, table-scoped for a dine-in order.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3981';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3981';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3981';

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

  const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);
  const product = prodRows[0];

  // === 1. Online order feedback -- the page's own webChatPath must be
  // the real bare online thread, not wa.me. ===
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348013380110', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-FBCHAT', 'pickup', $2, 'completed', 'confirmed', 'completed', 'whatsapp') returning *`,
    [customer.id, product.price]
  );
  const { rows: fbRows } = await pool.query(
    `insert into order_feedback (order_id, customer_id, channel, status) values ($1, $2, 'whatsapp', 'sent') returning *`,
    [orderRows[0].id, customer.id]
  );
  const fbId = fbRows[0].id;

  const page = await (await fetch(`${BASE}/f/${fbId}`)).text();
  assert(page.includes(`WEB_CHAT_PATH = "/wa/${token}"`), 'the feedback page carries the real web-chat thread link, not a bare wa.me redirect');

  // === 2. Submitting feedback -- the "Thank you" state must show a real
  // visible back-to-chat button, not just an invisible auto-redirect. ===
  const submitRes = await fetch(`${BASE}/f/${fbId}/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ experience: 5, food: 5, service: 5, comment: 'Great!' }),
  });
  assert(submitRes.status === 200, 'the feedback submission itself still succeeds');

  // === 3. Reloading after submission (the "already answered" state) must
  // ALSO carry a real back-to-chat link, not leave the guest stranded. ===
  const afterPage = await (await fetch(`${BASE}/f/${fbId}`)).text();
  assert(afterPage.includes('class="backToChat"'), 'the "already rated" page shows a visible back-to-chat button too');
  assert(afterPage.includes(`href="/wa/${token}"`), 'pointing at the real web-chat thread');

  // === 4. A dine-in order's feedback link is table-scoped, matching the
  // table's own separate thread, not the generic online one. ===
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length
    ? existingBranch[0].id
    : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '71', 'qrfeedback71') returning id`, [branchId]);
  const dineinCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348013380111', channel: 'whatsapp' });
  const dineinToken = await flow.ensureMenuToken(dineinCustomer);
  const { rows: dineinOrderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel, table_id)
     values ($1, 'REF-FBCHAT-DINEIN', 'table', $2, 'completed', 'confirmed', 'completed', 'dinein', $3) returning *`,
    [dineinCustomer.id, product.price, tableRows[0].id]
  );
  const { rows: dineinFbRows } = await pool.query(
    `insert into order_feedback (order_id, customer_id, channel, status) values ($1, $2, 'dinein', 'sent') returning *`,
    [dineinOrderRows[0].id, dineinCustomer.id]
  );
  const dineinPage = await (await fetch(`${BASE}/f/${dineinFbRows[0].id}`)).text();
  assert(dineinPage.includes(`WEB_CHAT_PATH = "/wa/${dineinToken}?table=qrfeedback71"`), 'a dine-in order\'s feedback link points at this table\'s own separate thread, not the generic online one');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
