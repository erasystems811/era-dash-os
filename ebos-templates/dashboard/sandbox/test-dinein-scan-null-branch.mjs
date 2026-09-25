// Chidera, real report: "when i scan a qr why does it still ask me what
// table am i on... let each table have a fixed qr so the system stops
// being confused." Root cause, confirmed against era-demo's real data:
// nothing to do with QR stability (qr_token/label were already correct
// and unchanging) -- handleDineinScan's restaurant_table lookup was a
// strict branch_id = $1 match, and a real customer's own branch_id is
// null (no branch_channel mapping to resolve one from -- same bug class
// already fixed today in menuForBranch/resolveMenu). This test
// deliberately does NOT pass branchId to handleInboundMessage, matching
// the real broken case exactly -- sandbox/test-dinein-joint.mjs always
// passes it explicitly and so never would have caught this.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3919';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3919';
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

  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  await pool.query(`insert into dinein_config (business_id, enabled) values ($1, true) on conflict (business_id) do update set enabled = true`, [bizRows[0].id]);
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '7', 'qrtest7')`, [branchId]);

  // Deliberately no branchId here -- a real customer scanning for the
  // first time, exactly like era-demo's real customers whose branch_id
  // is null.
  await flow.handleInboundMessage({ phoneNumber: '2348099990007', text: 'Menu Table 7', channel: 'whatsapp', messageId: 'm1' });
  await wait(flow.DEBOUNCE_MS + 1000);

  const { rows: customerRows } = await pool.query(`select * from customers where phone_number = $1`, ['2348099990007']);
  assert(!!customerRows[0]?.branch_id === false, 'confirms the real-world condition: this customer genuinely has no branch_id');

  const { rows: sessionRows } = await pool.query(
    `select ts.* from table_session ts join restaurant_table rt on rt.id = ts.table_id where rt.qr_token = 'qrtest7' and ts.closed_at is null`
  );
  assert(sessionRows.length === 1, 'a real "Menu Table 7" scan from a branch_id-less customer now correctly opens a table session (used to silently fail to find the table at all)');

  const { rows: msgRows } = await pool.query(
    `select trigger, body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customerRows[0].id]
  );
  assert(msgRows[0]?.trigger !== 'dinein_ask_table', 'bot did NOT fall back to "what table are you at" for a real, correctly-labelled scan');
  // Chidera, 2026-09-24: "now we need dine in to go through web chat too."
  // The real WhatsApp reply is now the same universal single-CTA send
  // every first contact gets, with no table label in it -- that context
  // now lives in the free dine-in greeting bubble on /wa/:token, checked
  // below (this is still a genuine end-to-end proof that the table was
  // correctly resolved for a branch_id-less customer, just a page fetch
  // away from a real message body now).
  assert(msgRows[0]?.trigger === 'greeting' && /tap below to get started/i.test(msgRows[0]?.body || ''), 'bot sent the universal single-CTA scan reply');
  const chatPageRes = await fetch(`http://localhost:${process.env.PORT}/wa/${customerRows[0].menu_token}`);
  assert(chatPageRes.status === 200, 'the chat page loads for this branch_id-less customer');
  const { rows: greetingRows } = await pool.query(
    `select body from message where customer_id = $1 and trigger = 'dinein_greeting' order by created_at desc limit 1`,
    [customerRows[0].id]
  );
  assert(/Table 7/.test(greetingRows[0]?.body || ''), 'and the chat page\'s own dine-in greeting correctly names the real table -- the branch_id-less lookup genuinely resolved it');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
