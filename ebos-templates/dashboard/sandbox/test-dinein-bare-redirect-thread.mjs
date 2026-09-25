// Chidera, 2026-09-25, real report: "why is one number having 2 seperate
// table 1 conversation? ... dine in can only ever be triggered with a qr
// code and all its greeting or redirect text to webchat must state the
// 'started on your dine in session'." Root cause, confirmed by reading:
// the two bare-WhatsApp chat-redirect fallbacks (handlePendingBatch's
// ack/thanks/decline branch, and its main needsChatRedirect gate) both
// always called sendStartOrderLink(customer) with no dine-in awareness at
// all -- a dine-in guest who scans, then later types plain "Thanks" or
// anything else on real WhatsApp instead of using the web chat, got
// redirected to the GENERIC bare /wa/:token thread, not their own table's
// ?table=... one -- the wrong thread entirely, not just wrong wording.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3974';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3974';
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

  for (let i = 0; i < 50; i++) {
    try { await fetch('http://localhost:3974/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
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
  await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '1', 'qrbareredirect1')`, [branchId]);

  // === 1. Real QR scan opens the table's own dine-in session. ===
  const phoneNumber = '2348013380050';
  await flow.handleInboundMessage({ phoneNumber, text: 'Menu Table 1(send this to proceed)', channel: 'whatsapp', messageId: 'br1', branchId });
  await wait(flow.DEBOUNCE_MS + 1000);
  const { rows: custRows } = await pool.query(`select * from customers where phone_number = $1`, [phoneNumber]);
  const customer = custRows[0];

  // === 2. Instead of using the web chat, the guest just types "Thanks" on
  // real WhatsApp -- the ack/thanks/decline chat-redirect branch. The real
  // CTA button URL only ever goes to the sandbox console log (sendWhatsAppCtaUrl
  // never persists it to message.body), same pattern
  // test-whatsapp-redirect-and-cover-photo.mjs already uses to check it. ===
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); originalLog(...args); };
  await flow.handleInboundMessage({ phoneNumber, text: 'Thanks', channel: 'whatsapp', messageId: 'br2', branchId });
  await wait(flow.DEBOUNCE_MS + 1000);
  console.log = originalLog;

  const redirectLog = logs.find((l) => l.includes(phoneNumber));
  assert(Boolean(redirectLog), 'the bare "Thanks" reply produced a real WhatsApp send');
  assert(/dine-in session/i.test(redirectLog || ''), 'the bare-text redirect for a dine-in guest names it as a dine-in session, not the generic online CTA');
  assert(/qrbareredirect1/.test(redirectLog || ''), 'and its link points at THIS table\'s own separate thread (?table=qrbareredirect1), not the generic bare one');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
