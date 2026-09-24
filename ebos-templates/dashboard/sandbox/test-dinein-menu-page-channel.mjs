// Chidera, 2026-09-24, real report: "in dine in when i tapped place
// order, it took me back to bare chat not web chat....in dine in the
// double message issue for chossing drink was not fixed it send me
// double text, i think dine in hasnt gotten our latest fixes." Real root
// cause, confirmed by reading: routes/dinein-menu.js's GET /:qrToken
// never passed `channel` to renderMenuPage at all (only routes/
// menu-page.js's online equivalent did) -- so menu-page-template.js's own
// client-side CHANNEL constant always defaulted to 'whatsapp', and
// submitOrder()'s post-submit redirect always fell through to its wa.me
// fallback, even for a guest who genuinely arrived via the web chat.
// Bounced to bare WhatsApp instead of back to /wa/:token, she never
// actually saw the (already-fixed) web-chat upsell sheet at all -- the
// "double text" was real WhatsApp's own older, unfixed flow, not a
// regression in the web-chat fix itself. Confirms the GET page now
// renders the real channel/webChatPath once a guest has genuinely visited
// the chat, and that a plain first visit (never been to chat) still
// correctly defaults to whatsapp/no webChatPath -- same "never invent
// structure that isn't there" rule as everywhere else.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3963';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3963';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3963';

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

  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  await pool.query(`insert into dinein_config (business_id, enabled) values ($1, true) on conflict (business_id) do update set enabled = true`, [bizRows[0].id]);
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '9', 'qrchanneltest') returning id`, [branchId]);
  await pool.query(`insert into product (name, price, category, branch_id) values ('Suya Wrap', 4700, 'MAINS', $1)`, [branchId]);

  // === 1. A brand-new guest, never visited /wa/:token at all -- the menu
  // page correctly still defaults to whatsapp/no back-to-chat link. Not
  // the bug, just confirming the fix doesn't over-fire. ===
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348013370009', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);
  const { rows: sessionRows0 } = await pool.query(
    `insert into table_session (table_id, branch_id, customer_id) values ((select id from restaurant_table where qr_token = 'qrchanneltest'), $1, $2) returning *`,
    [branchId, customer.id]
  );
  void sessionRows0;
  const freshPage = await (await fetch(`${BASE}/t/qrchanneltest?g=${token}`)).text();
  const freshChannelMatch = freshPage.match(/const CHANNEL = (".*?");/);
  assert(freshChannelMatch && freshChannelMatch[1] === '"whatsapp"', 'a guest who never visited the web chat still gets CHANNEL=whatsapp -- unchanged, not the bug');
  assert(!freshPage.includes('<a class="back-to-chat"'), 'and no back-to-chat link either -- nothing to go back to yet');

  // === 2. THE REAL BUG: the same guest actually visits /wa/:token (the
  // real web chat) first -- web_chat_active_at is now genuinely fresh.
  // The menu page must now render CHANNEL=website, so submitOrder()'s own
  // post-submit redirect actually goes back to /wa/:token, not wa.me. ===
  await fetch(`${BASE}/wa/${token}`);
  const afterChatVisit = await (await fetch(`${BASE}/t/qrchanneltest?g=${token}`)).text();
  const realChannelMatch = afterChatVisit.match(/const CHANNEL = (".*?");/);
  assert(realChannelMatch && realChannelMatch[1] === '"website"', 'after a genuine web-chat visit, the menu page renders CHANNEL=website -- the actual fix');
  const webChatPathMatch = afterChatVisit.match(/const WEB_CHAT_PATH = (.*?);/);
  // Chidera, 2026-09-25: "let table dine in and online delivery have their
  // complete different web chat" -- this must point at the TABLE's own
  // separate thread (?table=qrchanneltest), not the now online-only bare
  // /wa/:token, or submitOrder()'s post-submit redirect would silently
  // drop this dine-in guest into the wrong (empty) thread.
  assert(webChatPathMatch && webChatPathMatch[1] === `"/wa/${token}?table=qrchanneltest"`, 'and WEB_CHAT_PATH points at this table\'s own separate chat thread, not the generic online one');
  assert(afterChatVisit.includes('<a class="back-to-chat"'), 'the visible "Back to chat" header link shows too, same gate');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
