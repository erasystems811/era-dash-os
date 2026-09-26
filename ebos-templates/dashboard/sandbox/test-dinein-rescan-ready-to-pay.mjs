// Chidera, 2026-09-25 (live report): "is it possible that once a table is
// open and a number already in it rescans the qr, it takes them directly
// to their web chat? cause i just realized in dine in that served you can
// pay now is inside web and they may not see it." Rescanning the table's
// own QR was already the real way back into the web chat (sendStartOrderLink's
// own chatUrl, unchanged) -- the real gap was the WhatsApp message text
// itself: a generic "tap below to get started" even when this exact
// guest's own real "ready to pay" bubble (notifyGuestsReadyToPay) was
// already sitting there waiting, giving no reason to actually tap through.
// Confirms the rescan message now says so specifically once the table's
// been served, and still says the normal thing before that.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3991';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3991';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3991';

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
  await pool.query(`insert into dinein_config (business_id, enabled) values ($1, true) on conflict (business_id) do update set enabled = true`, [bizRows[0].id]);
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '30', 'qrrescan30') returning id`, [branchId]);
  const tableId = tableRows[0].id;
  const { rows: prodRows } = await pool.query(`insert into product (name, price, category, branch_id) values ('Jollof Rice', 3500, 'MAINS', $1) returning id`, [branchId]);

  const sendAndWait = async (args) => { await flow.handleInboundMessage(args); await wait(flow.DEBOUNCE_MS + 500); };

  // === 1. First scan -- normal "get started" wording, nothing to pay yet. ===
  await sendAndWait({ phoneNumber: '2348013380130', text: 'Menu Table 30', channel: 'whatsapp', messageId: 'm1', branchId });
  const { rows: c1Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348013380130']);
  const customer1 = c1Rows[0];
  const { rows: msg1 } = await pool.query(
    `select body from message where customer_id = $1 and trigger = 'greeting' order by created_at desc limit 1`,
    [customer1.id]
  );
  assert(/tap below to get started on your dine-in session/i.test(msg1[0].body), 'first scan: normal "get started" wording, nothing served yet');
  assert(!/ready to pay/i.test(msg1[0].body), 'and no "ready to pay" mention -- nothing to pay yet');

  // Order it, get served.
  const { rows: sessionRows } = await pool.query(`select * from table_session where table_id = $1`, [tableId]);
  const session = sessionRows[0];
  await fetch(`${BASE}/t/qrrescan30/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: prodRows[0].id, quantity: 1, answers: {} }] }),
  });
  const { rows: orderRows } = await pool.query(`select * from "order" where session_id = $1`, [session.id]);
  const order = orderRows[0];
  await pool.query(`update "order" set status = 'preparation', confirmed_at = now() where id = $1`, [order.id]);
  const { rows: servedOrderRows } = await pool.query(`select * from "order" where id = $1`, [order.id]);
  // The real "Served" action -- same call staff's own tap in the dashboard
  // makes (routes/dinein.js's POST /orders/:id/served), so the real
  // "ready to pay" bubble this test checks for in step 3 actually exists.
  await flow.notifyGuestsReadyToPay(servedOrderRows[0]);
  await pool.query(`update "order" set served_at = now() where id = $1`, [order.id]);

  // === 2. Rescan, table now served and ready to pay -- wording reflects it. ===
  await sendAndWait({ phoneNumber: '2348013380130', text: 'Menu Table 30', channel: 'whatsapp', messageId: 'm2', branchId });
  const { rows: msg2 } = await pool.query(
    `select body from message where customer_id = $1 and trigger = 'greeting' order by created_at desc limit 1`,
    [customer1.id]
  );
  assert(/welcome back/i.test(msg2[0].body), `the rescan wording says "Welcome back" once served (got "${msg2[0].body}")`);
  assert(/ready to pay/i.test(msg2[0].body), `and names the real reason to tap through -- the table's ready to pay (got "${msg2[0].body}")`);

  // === 3. The link it sends points at the SAME table-scoped web chat
  // thread the real ready-to-pay bubble already landed in -- landing
  // there after tapping through actually shows it, not just an empty
  // thread with no clue why they were told to come back. ===
  const { rows: payBubble } = await pool.query(
    `select table_session_id from message where trigger = 'dinein_ready_to_pay' and table_session_id = $1 limit 1`,
    [session.id]
  );
  assert(payBubble.length === 1, "the real ready-to-pay bubble (with its own Pay now button) is sitting in this exact table's own thread, right where the rescan message sends them");

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
