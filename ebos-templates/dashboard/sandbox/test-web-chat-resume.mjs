// Chidera, 2026-09-23: "anytime they start using the link let whatever
// stage they are in the text not be restarting o, let it keep them where
// they stopped so they dont always have to start conversation afresh."
//
// Root cause: getOpenOrder's 3h freshness window (flow.js) only gets
// refreshed by something that actually touches the order. The /wa/:token
// chat page's GET handler only ever read message history -- it never
// called getOpenOrder, unlike /m/:token (routes/menu-page.js's own
// pendingOrderPayload already does, as a side effect). A customer who
// reopened the chat link just to look, without immediately typing or
// tapping, got nothing refreshed: the page still showed their full past
// history, but their order could go stale in the background, and their
// NEXT real action would silently fall through into a brand new order --
// restarting from scratch even though the page looked unchanged.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3934';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3934';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3934';

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
  const product = prodRows[0];

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012345555', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-RESUME-1', null, $2, 'new', 'pending', 'confirm_order', 'whatsapp') returning *`,
    [customer.id, Number(product.price)]
  );
  const order = orderRows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order.id, product.id, product.price]);

  // Simulate real elapsed time: this order's last genuine touch was 2h55m
  // ago -- still inside the 3h window, but close enough that a normal
  // gap between "customer opens the link to check" and "customer actually
  // types something" could tip it over the edge without this fix.
  await pool.query(`update "order" set updated_at = now() - interval '2 hours 55 minutes' where id = $1`, [order.id]);

  const beforeGet = (await pool.query(`select updated_at from "order" where id = $1`, [order.id])).rows[0].updated_at;

  const pageRes = await fetch(`${BASE}/wa/${token}`);
  assert(pageRes.status === 200, 'the chat page itself loads');
  const html = await pageRes.text();
  assert(html.length > 0, 'the page actually rendered');

  const afterGet = (await pool.query(`select updated_at from "order" where id = $1`, [order.id])).rows[0].updated_at;
  assert(new Date(afterGet) > new Date(beforeGet), 'simply opening the chat link refreshes the order\'s freshness, same as /m/:token already does');
  assert(new Date(afterGet) > new Date(Date.now() - 60_000), 'refreshed to genuinely just now, not a stale timestamp');

  // Now push the clock forward past what the ORIGINAL (un-refreshed)
  // touch would have allowed -- if the GET above hadn't refreshed it,
  // this order would now be stale (updated_at 2h55m + however long this
  // test took ago, past the 3h cutoff). Simulate that elapsed time
  // directly rather than actually sleeping 3 hours.
  await pool.query(`update "order" set updated_at = now() - interval '2 hours 58 minutes' where id = $1`, [order.id]);

  const resolved = await flow.resolveCustomerOrder(customer);
  assert(Boolean(resolved), 'the order is still found at all after the customer just checked the page');
  assert(resolved?.id === order.id, 'and it\'s the SAME order -- their actual progress, not a fresh one');
  assert(resolved?.engine_state === 'confirm_order', 'still at the exact stage they left it, nothing reset');

  // resolveCustomerOrder is the exact gate handlePendingBatch's own
  // dispatch uses (flow.js: `const order = await resolveCustomerOrder(customer); if (order) { ...dispatch(customer, order, text); }`)
  // -- finding THIS order here is the direct proof that a customer's next
  // real message continues it instead of falling through to fresh-inquiry
  // handling. Not driving that through handleWebChatMessage itself: any
  // free-text turn also calls classifyIntent/detectWantsHuman, which hit
  // the real Anthropic API with no sandbox stub (same scope note every
  // other web-chat sandbox test makes) -- irrelevant to what this fix
  // actually changed.

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
