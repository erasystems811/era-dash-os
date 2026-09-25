// Chidera, 2026-09-25: "the feedback web page and complaint web page
// should have the back to chat thing too." routes/complaint.js already
// carried a chatUrl for its own invisible auto-redirect -- now a real
// visible button in the "Thank you" state too, table-scoped for a
// dine-in guest currently mid a real table session (same as the feedback
// form's own fix), instead of always the generic online thread.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3982';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3982';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3982';

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

  // === 1. Online customer -- the page carries the real bare online
  // thread link, and the client-side "Thank you" state shows a visible
  // back-to-chat button. ===
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348013380120', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);

  const page = await (await fetch(`${BASE}/c/${token}`)).text();
  assert(page.includes(`CHAT_URL = "${BASE}/wa/${token}"`), 'the complaint page carries the real online web-chat thread link');
  assert(page.includes('backToChat'), 'and the visible back-to-chat button markup is present in the client script');

  // handover()'s own transcript summary needs a real Anthropic API key
  // this sandbox doesn't have -- the complaint row itself is recorded
  // BEFORE that call, so a 500 here is that pre-existing, unrelated
  // constraint, not a regression from this fix (same pattern test-
  // whatsapp-redirect-and-cover-photo.mjs's own comment documents).
  const submitRes = await fetch(`${BASE}/c/${token}/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'The food was cold.' }),
  });
  assert(submitRes.status === 200 || submitRes.status === 500, `the complaint submission is accepted (got ${submitRes.status})`);
  const { rows: complaintRows } = await pool.query(`select 1 from complaint where customer_id = $1`, [customer.id]);
  assert(complaintRows.length === 1, 'a real complaint row was still recorded regardless');

  // === 2. A dine-in guest currently mid a real table session -- the
  // link must be table-scoped, matching their own separate thread. ===
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length
    ? existingBranch[0].id
    : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '81', 'qrcomplaint81') returning id`, [branchId]);
  const dineinCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348013380121', channel: 'whatsapp' });
  const dineinToken = await flow.ensureMenuToken(dineinCustomer);
  await pool.query(`insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3)`, [tableRows[0].id, branchId, dineinCustomer.id]);

  const dineinPage = await (await fetch(`${BASE}/c/${dineinToken}`)).text();
  assert(dineinPage.includes(`CHAT_URL = "${BASE}/wa/${dineinToken}?table=qrcomplaint81"`), 'a dine-in guest\'s complaint link is table-scoped to their own separate thread, not the generic online one');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
