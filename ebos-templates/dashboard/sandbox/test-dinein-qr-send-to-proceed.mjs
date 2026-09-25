// Chidera, 2026-09-25: "when qr is scanned instead of just menu table i
// want a menu table 1(send this to proceed)." A prefilled WhatsApp message
// still needs an explicit tap on Send -- a bare "Menu Table 1" read as
// already sent to guests unfamiliar with a wa.me link. Proves both halves:
// the QR itself now encodes the parenthetical, and handleDineinScan still
// correctly resolves the real table from it (strips the parenthetical back
// off before matching), same as a plain "Menu Table 1" (old QR codes still
// in the wild, or a typed reply to "which table are you at?") still works.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3972';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3972';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3972';

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
  await pool.query(
    `insert into dinein_config (business_id, enabled) values ($1, true)
     on conflict (business_id) do update set enabled = true`,
    [bizRows[0].id]
  );
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length
    ? existingBranch[0].id
    : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  await pool.query(
    `insert into restaurant_table (branch_id, label, qr_token) values ($1, '1', 'qrproceed1')`,
    [branchId]
  );

  // === 1. The scan text real customers actually send now carries the new
  // "(send this to proceed)" suffix, exactly as the QR encodes it. ===
  const phoneNumber = '2348013370030';
  await flow.handleInboundMessage({ phoneNumber, text: 'Menu Table 1(send this to proceed)', channel: 'whatsapp', messageId: 'qp1', branchId });
  await wait(flow.DEBOUNCE_MS + 1000);
  const { rows: custRows } = await pool.query(`select * from customers where phone_number = $1`, [phoneNumber]);
  const customer = custRows[0];
  assert(Boolean(customer), 'the scan with the new suffix still resolved a customer');
  const { rows: sessionRows } = await pool.query(
    `select ts.* from table_session ts join restaurant_table rt on rt.id = ts.table_id where rt.qr_token = 'qrproceed1' and ts.closed_at is null`
  );
  assert(sessionRows.length === 1, 'and a real table_session was opened for table 1, not left asking "which table"');
  const { rows: askRows } = await pool.query(
    `select 1 from message where customer_id = $1 and trigger = 'dinein_ask_table'`,
    [customer.id]
  );
  assert(!askRows.length, 'the parenthetical never confused the label match into asking which table');

  // === 2. An old-style scan (no suffix, e.g. an already-printed QR code or
  // a typed reply) still works exactly as before -- no regression. ===
  const phoneNumber2 = '2348013370031';
  await flow.handleInboundMessage({ phoneNumber: phoneNumber2, text: 'Menu Table 1', channel: 'whatsapp', messageId: 'qp2', branchId });
  await wait(flow.DEBOUNCE_MS + 1000);
  const { rows: custRows2 } = await pool.query(`select * from customers where phone_number = $1`, [phoneNumber2]);
  const { rows: guestRows } = await pool.query(
    `select 1 from table_session_guest g join table_session ts on ts.id = g.session_id join restaurant_table rt on rt.id = ts.table_id
     where rt.qr_token = 'qrproceed1' and g.customer_id = $1`,
    [custRows2[0].id]
  );
  assert(guestRows.length === 1, 'a plain "Menu Table 1" with no suffix still resolves the same real table');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
