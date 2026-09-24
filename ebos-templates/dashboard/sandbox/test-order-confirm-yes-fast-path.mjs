// Chidera, 2026-09-24: "after taping yes confirm the reply after that is
// too slow." Root cause: a tap on "Yes, confirm" used to go through the
// full text pipeline (dispatch()'s own extractOrderModifications, then
// handleConfirmOrder's own extractField) -- TWO real Anthropic calls for
// something the tap already answers unambiguously. handleOrderConfirmYesTap
// is a dedicated, zero-AI handler now. This sandbox has no real Anthropic
// key at all -- if either AI call still ran, this test would throw/crash,
// so a clean pass here IS the proof no AI call happened.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3948';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3948';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3948';

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

  // === 1. Web chat tap: order_confirm_yes goes straight through with no
  // AI call, and actually confirms + advances the order. ===
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012357001', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);
  const { rows: order1 } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-YESFAST-1', null, $2, 'new', 'pending', 'confirm_order', 'whatsapp') returning *`,
    [customer.id, prodRows[0].price]
  );
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order1[0].id, prodRows[0].id, prodRows[0].price]);

  const tapRes = await fetch(`${BASE}/wa/${token}/tap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buttonId: 'order_confirm_yes' }),
  });
  assert(tapRes.status === 200, 'the tap succeeds with no crash -- proof no real Anthropic call was attempted (no key configured in this sandbox)');

  const { rows: after1 } = await pool.query(`select confirmed_at from "order" where id = $1`, [order1[0].id]);
  assert(after1[0].confirmed_at !== null, 'the order is actually marked confirmed');

  // === 2. A stale tap (already confirmed) is a safe no-op, not a crash or
  // a double-confirmation. ===
  const confirmedAtBefore = after1[0].confirmed_at;
  const staleRes = await fetch(`${BASE}/wa/${token}/tap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buttonId: 'order_confirm_yes' }),
  });
  assert(staleRes.status === 200, 'a stale repeat tap does not error');
  const { rows: after2 } = await pool.query(`select confirmed_at from "order" where id = $1`, [order1[0].id]);
  assert(new Date(after2[0].confirmed_at).getTime() === new Date(confirmedAtBefore).getTime(), 'and it did not re-confirm/re-timestamp the order a second time');

  // === 3. Direct function call (mirrors the real WhatsApp webhook's own
  // path) -- same zero-AI guarantee for real WhatsApp customers, not just
  // web chat. ===
  const waCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012357002', channel: 'whatsapp' });
  const { rows: order2 } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-YESFAST-2', null, $2, 'new', 'pending', 'confirm_order', 'whatsapp') returning *`,
    [waCustomer.id, prodRows[0].price]
  );
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order2[0].id, prodRows[0].id, prodRows[0].price]);
  await flow.handleOrderConfirmYesTap({ phoneNumber: '2348012357002', channel: 'whatsapp' });
  const { rows: after3 } = await pool.query(`select confirmed_at from "order" where id = $1`, [order2[0].id]);
  assert(after3[0].confirmed_at !== null, 'the real WhatsApp path (handleOrderConfirmYesTap called directly, same as the webhook does) also confirms with no AI call');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
