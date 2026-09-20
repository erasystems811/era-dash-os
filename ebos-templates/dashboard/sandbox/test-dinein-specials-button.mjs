// Chidera, real report, 2026-09-20: "there is no special currently on
// menu so why is today specials button still showing." sendDineinWelcome's
// own button list was unconditional -- always included "Today's specials"
// regardless of whether a real special (product.is_combo) actually
// exists, unlike handleGreeting's own equivalent logic, which already
// gated on findSpecialsCategory correctly. Confirms the dine-in welcome
// now only offers the button when there's a real one to show, and still
// offers it once one exists.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3932';
process.env.SESSION_SECRET = 'testsecret';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

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

  // Button titles only ever appear in the sandbox's own console line
  // (whatsapp-send.js's sandbox branch) -- message.body in the DB is just
  // the text, never the buttons -- so capturing console.log is the only
  // real way to see what was actually offered.
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); originalLog(...args); };

  // === No real special on the menu -- button must not show ===
  await pool.query(
    `insert into restaurant_table (branch_id, label, qr_token) values ($1, 'SB1', 'qrspecialsa') returning id`,
    [branchId]
  );
  await sendAndWait({ phoneNumber: '2348011119970', text: 'Menu Table SB1', channel: 'whatsapp', messageId: 'sa1', branchId });
  const welcomeA = logs.filter((l) => l.includes('2348011119970')).pop();
  assert(welcomeA?.includes('Tap here to see menu'), 'sanity check: the welcome message really did send');
  assert(!welcomeA?.includes("Today's specials"), 'no real special on the menu -- the welcome message does not offer the button');

  // === A real special (a combo product) exists -- button must show ===
  await pool.query(
    `insert into product (name, price, category, branch_id, is_combo) values ('Family Combo', 8000, 'Special Offers', $1, true)`,
    [branchId]
  );
  await pool.query(
    `insert into restaurant_table (branch_id, label, qr_token) values ($1, 'SB2', 'qrspecialsb') returning id`,
    [branchId]
  );
  await sendAndWait({ phoneNumber: '2348011119971', text: 'Menu Table SB2', channel: 'whatsapp', messageId: 'sb1', branchId });
  const welcomeB = logs.filter((l) => l.includes('2348011119971')).pop();
  assert(welcomeB?.includes("Today's specials"), 'a real special now exists on the menu -- the welcome message offers the button');
  console.log = originalLog;

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
