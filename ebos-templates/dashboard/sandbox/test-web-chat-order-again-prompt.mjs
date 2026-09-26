// Chidera, 2026-09-24: "when i enter the web chat to place an order again
// it should still resend that menu for a new order to be placed." A
// returning customer whose last order already finished used to just see
// old history on reopening /wa/:token, with nothing nudging them to start
// again.
//
// Chidera, 2026-09-26: "instead of just the welcome back! tap to see menu,
// they should get the what would you like to do place an order or make a
// complaint thing" -- the single "See menu" CTA (order_again_prompt) is
// now the same first_choice buttons bubble a brand-new visitor gets
// (Place an order / Make a complaint), not an assumption they're only
// ever back to reorder. GET /:token still only sends it once per "no open
// order" stretch (so refreshing the page twice doesn't double it up).
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3945';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3945';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3945';

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

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012354001', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);

  // First visit -- the ordinary first-choice greeting, no "welcome back" wording yet.
  const html1 = await (await fetch(`${BASE}/wa/${token}`)).text();
  assert(html1.includes('What would you like to do?') && !html1.includes('Welcome back!'), 'a brand-new customer gets the normal first-choice greeting, not the returning-customer wording');

  // Order 1: placed and fully completed.
  await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-AGAIN-1', 'pickup', 3500, 'completed', 'confirmed', 'completed', 'whatsapp')`,
    [customer.id]
  );

  // Reopening the link with no order in progress -- should get the
  // returning-customer prompt, same 2-button choice as a fresh visitor.
  const html2 = await (await fetch(`${BASE}/wa/${token}`)).text();
  assert(html2.includes('Welcome back! What would you like to do?'), 'reopening the chat with no order in progress resends the choice prompt, "welcome back" worded');
  assert(html2.includes('Place an order') && html2.includes('Make a complaint'), 'with both real buttons, same as a brand-new visitor gets');

  const { rows: countAfterFirstPrompt } = await pool.query(
    `select count(*)::int as n from message where customer_id = $1 and trigger = 'order_again_prompt'`,
    [customer.id]
  );
  assert(countAfterFirstPrompt[0].n === 1, 'exactly one order_again_prompt bubble logged so far -- distinct from the original first-visit first_choice bubble');

  // Reopening AGAIN, still no order started -- must NOT double up.
  await fetch(`${BASE}/wa/${token}`);
  const { rows: countAfterSecondVisit } = await pool.query(
    `select count(*)::int as n from message where customer_id = $1 and trigger = 'order_again_prompt'`,
    [customer.id]
  );
  assert(countAfterSecondVisit[0].n === 1, 'reopening a second time with still no order in progress does not resend the prompt again');

  // Now a real new order starts (order 2, in progress) -- reopening should
  // NOT show the prompt again, since there's an order to keep going.
  await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-AGAIN-2', 'pickup', 5000, 'new', 'pending', 'collect_info', 'whatsapp')`,
    [customer.id]
  );
  const html3 = await (await fetch(`${BASE}/wa/${token}`)).text();
  const { rows: countWithOpenOrder } = await pool.query(
    `select count(*)::int as n from message where customer_id = $1 and trigger = 'order_again_prompt'`,
    [customer.id]
  );
  assert(countWithOpenOrder[0].n === 1, 'still no extra order_again_prompt bubble was sent -- order 2 is genuinely in progress');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
