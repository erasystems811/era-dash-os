// Chidera, real report, 2026-09-20: "there is no special currently on
// menu so why is today specials button still showing." sendDineinWelcome's
// own button list was unconditional -- always included "Today's specials"
// regardless of whether a real special (product.is_combo) actually
// exists, unlike handleGreeting's own equivalent logic, which already
// gated on findSpecialsCategory correctly. Confirms the dine-in welcome
// now only offers the button when there's a real one to show, and still
// offers it once one exists.
//
// Chidera, 2026-09-24: "now we need dine in to go through web chat too."
// sendDineinWelcome (the real, unconditional-buttons WhatsApp send this
// test originally caught the bug in) is gone entirely -- the real scan
// reply is now the same universal single-CTA send every first contact
// gets, with no menu/specials content of its own at all. The specials
// gating this test actually cares about now lives in
// buildDineinGreetingContent, rendered as the free dine-in greeting bubble
// on /wa/:token -- moved there rather than dropped.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3932';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3932';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3932';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');
  const sendAndWait = async (args) => { await flow.handleInboundMessage(args); await wait(flow.DEBOUNCE_MS + 1000); };

  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  await pool.query(
    `insert into dinein_config (business_id, enabled) values ($1, true) on conflict (business_id) do update set enabled = true`,
    [bizRows[0].id]
  );
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;

  // === No real special on the menu -- the dine-in greeting bubble must not offer it ===
  await pool.query(
    `insert into restaurant_table (branch_id, label, qr_token) values ($1, 'SB1', 'qrspecialsa') returning id`,
    [branchId]
  );
  await sendAndWait({ phoneNumber: '2348011119970', text: 'Menu Table SB1', channel: 'whatsapp', messageId: 'sa1', branchId });
  const { rows: custARows } = await pool.query(`select * from customers where phone_number = $1`, ['2348011119970']);
  const pageA = await fetch(`${BASE}/wa/${custARows[0].menu_token}`);
  assert(pageA.status === 200, 'sanity check: the chat page really did load');
  const { rows: greetA } = await pool.query(
    `select body from message where customer_id = $1 and trigger = 'dinein_greeting' order by created_at desc limit 1`,
    [custARows[0].id]
  );
  assert(!/today's specials/i.test(greetA[0]?.body || ''), 'no real special on the menu -- the dine-in greeting bubble does not offer the specials line');

  // === A real special (a combo product) exists -- the bubble must show it ===
  await pool.query(
    `insert into product (name, price, category, branch_id, is_combo) values ('Family Combo', 8000, 'Special Offers', $1, true)`,
    [branchId]
  );
  await pool.query(
    `insert into restaurant_table (branch_id, label, qr_token) values ($1, 'SB2', 'qrspecialsb') returning id`,
    [branchId]
  );
  await sendAndWait({ phoneNumber: '2348011119971', text: 'Menu Table SB2', channel: 'whatsapp', messageId: 'sb1', branchId });
  const { rows: custBRows } = await pool.query(`select * from customers where phone_number = $1`, ['2348011119971']);
  const pageB = await fetch(`${BASE}/wa/${custBRows[0].menu_token}`);
  assert(pageB.status === 200, 'sanity check: the second chat page really did load');
  const { rows: greetB } = await pool.query(
    `select body from message where customer_id = $1 and trigger = 'dinein_greeting' order by created_at desc limit 1`,
    [custBRows[0].id]
  );
  assert(/today's specials/i.test(greetB[0]?.body || ''), 'a real special now exists on the menu -- the dine-in greeting bubble offers the specials line');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
