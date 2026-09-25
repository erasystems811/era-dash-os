// Chidera, 2026-09-25, real live incident: "after pressing yes change it
// and now the bot changed and sent me a new yes confirm and no change it
// button, its not clicking, the 2 buttons are not resonding" + "whenever
// the new total is updated, instead of just typing new total 5700 resend
// me the invoice and paynow thing."
//
// Root cause, confirmed against era-demo's real order state (engine_state
// = confirm_payment, confirmed_at = null -- a real, reachable state):
// finishItemsCollection's "tapped an older upsell bubble after the order
// moved past collect_info" branch only ever updated total and sent a bare
// "New total: NGN X" text -- for an order already at confirm_payment (an
// invoice/payment link already sent once), that left the OLD link
// pointing at the wrong, stale amount, and any order_confirm_asked
// bubble's Yes/No buttons silently no-op (handleOrderConfirmYesTap's own
// guard requires engine_state === 'confirm_order', which this path never
// restores). Now resends real, working payment instructions (confirm_
// payment) or a fresh confirm-buttons bubble (confirm_order) instead.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3979';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3979';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function lastOutbound(pool, customerId) {
  const { rows } = await pool.query(
    `select trigger, interactive, body from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customerId]
  );
  return rows[0] || null;
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch('http://localhost:3979/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);
  const product = prodRows[0];

  // === 1. An order already at confirm_payment (invoice/payment already
  // sent once, real money instructions out) -- a late add must resend
  // real payment instructions for the NEW total, not a dead-end text. ===
  const customer1 = await flow.findOrCreateCustomer({ phoneNumber: '2348013380090', channel: 'whatsapp' });
  customer1.channel = 'website';
  const { rows: order1Rows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel, confirmed_at)
     values ($1, 'REF-LATEADD-1', 'pickup', $2, 'new', 'pending', 'confirm_payment', 'whatsapp', now()) returning *`,
    [customer1.id, product.price]
  );
  const order1 = order1Rows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order1.id, product.id, product.price]);
  // The upsell tap's own item insert, simulated directly -- same shape
  // handleUpsellListTap does right before calling finishItemsCollection.
  await pool.query(`insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, $3, $4)`, [order1.id, product.id, product.price, customer1.id]);
  // upsell_offered past MAX_UPSELL_PICKS -- skips nextUpsellGroup's own
  // "offer another upsell" branch so finishItemsCollection actually
  // reaches the late-add code under test, same as a real order that's
  // already been through its upsell rounds.
  await pool.query(`update "order" set upsell_offered = array['drinks','sides','mains','extras'] where id = $1`, [order1.id]);
  order1.upsell_offered = ['drinks', 'sides', 'mains', 'extras'];

  await flow.finishItemsCollection(customer1, order1, '');

  // sendPaymentInstructions always logs a fresh invoice_pdf bubble first
  // (sandbox has no Paystack/bank details configured, so the LAST message
  // is its own generic "let me get someone to confirm" fallback line --
  // that's the payment-provider gap, not the bug under test) -- checking
  // for the invoice specifically proves real payment instructions were
  // genuinely resent, not a bare "New total" text.
  const { rows: invoiceRows } = await pool.query(
    `select 1 from message where customer_id = $1 and trigger = 'invoice_pdf' order by created_at desc limit 1`,
    [customer1.id]
  );
  assert(invoiceRows.length === 1, 'a fresh invoice was resent for the new total, not a bare "New total" text');
  const m1 = await lastOutbound(pool, customer1.id);
  assert(m1?.trigger !== 'upsell_late_add', 'and it did not fall through to the old bare-text path at all');
  const { rows: order1After } = await pool.query(`select confirmed_at, engine_state, total from "order" where id = $1`, [order1.id]);
  assert(order1After[0].confirmed_at === null, 'confirmed_at reset to null -- needs a fresh yes before this new total is truly locked in');
  assert(order1After[0].engine_state === 'confirm_payment', 'engine_state stays at confirm_payment -- handleReconfirmAfterEdit\'s own state, not reverted');
  assert(Number(order1After[0].total) === Number(product.price) * 2, 'the total genuinely reflects both items');

  // === 2. An order still at confirm_order (no payment step reached yet)
  // -- a late add must resend a FRESH confirm-buttons bubble, so the
  // Yes/No buttons actually work again instead of silently no-opping. ===
  const customer2 = await flow.findOrCreateCustomer({ phoneNumber: '2348013380091', channel: 'whatsapp' });
  customer2.channel = 'website';
  const { rows: order2Rows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-LATEADD-2', 'pickup', $2, 'new', 'pending', 'confirm_order', 'whatsapp') returning *`,
    [customer2.id, product.price]
  );
  const order2 = order2Rows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order2.id, product.id, product.price]);
  await pool.query(`insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, $3, $4)`, [order2.id, product.id, product.price, customer2.id]);
  await pool.query(`update "order" set upsell_offered = array['drinks','sides','mains','extras'] where id = $1`, [order2.id]);
  order2.upsell_offered = ['drinks', 'sides', 'mains', 'extras'];

  await flow.finishItemsCollection(customer2, order2, '');

  const m2 = await lastOutbound(pool, customer2.id);
  assert(m2?.trigger === 'order_confirm_asked', `a fresh confirm-buttons bubble was sent, not a bare "New total" text (got trigger=${m2?.trigger})`);
  assert(m2?.interactive?.buttons?.some((b) => b.id === 'order_confirm_yes'), 'with a real, working "Yes, confirm" button');
  assert(/New total: NGN/.test(m2?.body || ''), 'and it states the real updated total');

  // Now the buttons genuinely work -- a real "Yes, confirm" tap right
  // after must NOT silently no-op (the actual bug this all started from).
  await flow.handleOrderConfirmYesTap({ channel: 'website', customer: customer2 });
  const { rows: order2After } = await pool.query(`select confirmed_at from "order" where id = $1`, [order2.id]);
  assert(order2After[0].confirmed_at !== null, 'the "Yes, confirm" tap on the FRESH bubble actually works -- confirmed_at is set, not silently ignored');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
