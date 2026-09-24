// Real incident, 2026-09-20 -- Chidera: "for delivery and pick up why is jv
// on my table already ordering through table qr and bot start process an
// online delivery for him?" Confirmed against era-demo's real order rows:
// JV (a non-owner dine-in guest) replied "Yes, confirm" to his table's own
// add-on prompt; the shared order's own customer_id was the ORIGINAL
// scanner (always is, by design -- getOrCreateTableOrder never changes it),
// so getOpenOrder(JV.id) found nothing, his reply fell through
// handlePendingBatch's dispatch gate into classifyIntent, and a brand new,
// unrelated online/pickup order got created for him -- complete with a
// real Paystack link -- while his actual dine-in order sat stuck at
// confirm_order, never reaching the kitchen.
//
// Two scenarios, matching Chidera's own follow-up correction: "just
// seperate dine in and online order, a person already on dine in shouldnt
// transition to online same with online."
//   A) the shared order already exists (JV's exact case) -- resolveCustomerOrder
//      must find it through table_session_guest, not just customer_id.
//   B) no order exists yet for the table (a guest who's scanned and joined
//      but hasn't ordered anything, typing free text instead of tapping the
//      menu link) -- must never fall through to classifyIntent/online order
//      creation either; handlePendingBatch's own dine-in-session guard
//      (added straight after resolveCustomerOrder) must catch it.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3927';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3927';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3927';

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

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  const businessId = bizRows[0].id;
  await pool.query(
    `insert into dinein_config (business_id, enabled) values ($1, true)
     on conflict (business_id) do update set enabled = true`,
    [businessId]
  );
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length
    ? existingBranch[0].id
    : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: prodRows } = await pool.query(
    `insert into product (name, description, price, category, branch_id) values
     ('Suya Wrap', 'spicy wrap', 4700, 'MAINS', $1) returning id`,
    [branchId]
  );
  const product1 = prodRows[0].id;

  // Anthropic mock, network boundary only -- same technique already
  // established in test-dinein-joint.mjs, extended to distinguish the
  // THREE different AI calls dispatch()'s confirm_order branch can make
  // (extractOrderModifications, extractFulfilmentChange, then
  // handleConfirmOrder's own yes/no read) by the distinctive wording each
  // one's own system prompt uses.
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.anthropic.com')) {
      const bodyStr = opts?.body ? String(opts.body) : '';
      let text;
      if (bodyStr.includes('has_changes')) text = '{"has_changes": false}';
      else if (bodyStr.includes('change_to')) text = '{"change_to": null}';
      else text = '{"confirmed": true}';
      return new Response(JSON.stringify({ content: [{ type: 'text', text }], usage: {} }), { status: 200 });
    }
    return realFetch(url, opts);
  };

  try {
    // === Scenario A: JV's exact case -- a real shared order already exists ===
    const { rows: tableRowsA } = await pool.query(
      `insert into restaurant_table (branch_id, label, qr_token) values ($1, '1', 'qrtestA') returning id`,
      [branchId]
    );
    const tableA = tableRowsA[0];

    // Guest 1 (the original scanner) opens the table.
    await sendAndWait({ phoneNumber: '2348011110101', text: 'Menu Table 1', channel: 'whatsapp', messageId: 'a1', branchId });
    const { rows: c1Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348011110101']);
    const customer1 = c1Rows[0];
    const { rows: sessionRows } = await pool.query(`select * from table_session where table_id = $1 and closed_at is null`, [tableA.id]);
    const session = sessionRows[0];

    // Guest 2 (JV) scans the SAME table -- joins as a guest, not the owner.
    await sendAndWait({ phoneNumber: '2348011110102', text: 'Menu Table 1', channel: 'whatsapp', messageId: 'a2', branchId });
    const { rows: c2Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348011110102']);
    const customer2 = c2Rows[0];
    const { rows: guestRows } = await pool.query(`select 1 from table_session_guest where session_id = $1 and customer_id = $2`, [session.id, customer2.id]);
    assert(guestRows.length === 1, 'guest 2 (JV) registered as a table_session_guest on scan');

    // The real shared order -- customer_id is the ORIGINAL scanner
    // (guest 1), exactly like every real dine-in order, sitting at
    // confirm_order/preparation exactly like JV's real bfe3a420 did.
    const { rows: orderRowsA } = await pool.query(
      `insert into "order" (customer_id, reference, branch_id, channel, table_id, session_id, fulfilment_type, payment_mode, engine_state, status, confirmed_at)
       values ($1, 'REF-JV-A', $2, 'dinein', $3, $4, 'table', 'at_table', 'confirm_order', 'preparation', null) returning *`,
      [customer1.id, branchId, tableA.id, session.id]
    );
    const order = orderRowsA[0];
    await pool.query(`insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 3, 4700, $3)`, [order.id, product1, customer2.id]);

    // JV's own real message, verbatim -- Chidera, 2026-09-24: "now we need
    // dine in to go through web chat too." Dine-in is now folded into the
    // universal redirect gate, so this raw bare-WhatsApp text no longer
    // reaches classifyIntent/dispatch at all -- it gets redirected to the
    // chat instead, same as any other first-ever bare text with no chat
    // visit yet.
    await sendAndWait({ phoneNumber: '2348011110102', text: 'Yes, confirm', channel: 'whatsapp', messageId: 'a3', branchId });
    const { rows: jvRedirectRows } = await pool.query(
      `select trigger from message where customer_id = $1 and direction = 'outbound' and channel = 'whatsapp' order by created_at desc limit 1`,
      [customer2.id]
    );
    assert(jvRedirectRows[0]?.trigger === 'greeting', 'JV\'s raw "Yes, confirm" text redirects to the chat now instead of reaching classifyIntent/dispatch directly');

    const { rows: reloadedOrderA0 } = await pool.query(`select * from "order" where id = $1`, [order.id]);
    assert(reloadedOrderA0[0].confirmed_at === null, 'and the real order is genuinely still unconfirmed -- the redirect, not a silent real confirm');

    // JV actually opens the chat and taps "Yes, confirm" there instead --
    // the real, still-current path a dine-in guest confirms through. This
    // is what the original rogue-order bug was actually about
    // (resolveCustomerOrder finding JV's shared order via
    // table_session_guest, not just customer_id) -- same shared lookup,
    // just reached through the tap handler now instead of raw text.
    const { rows: jv2Rows } = await pool.query(`select menu_token from customers where id = $1`, [customer2.id]);
    await fetch(`${BASE}/wa/${jv2Rows[0].menu_token}`);
    const tapRes = await fetch(`${BASE}/wa/${jv2Rows[0].menu_token}/tap`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buttonId: 'order_confirm_yes' }),
    });
    assert(tapRes.status === 200, 'JV\'s real "Yes, confirm" tap on the chat page is accepted');

    const { rows: ordersForSessionA } = await pool.query(`select * from "order" where session_id = $1`, [session.id]);
    assert(ordersForSessionA.length === 1, 'still exactly one order for the table -- JV\'s confirm did not spawn a second one');

    const { rows: rogueOrdersA } = await pool.query(`select * from "order" where customer_id = $1 and channel <> 'dinein'`, [customer2.id]);
    assert(rogueOrdersA.length === 0, 'no separate online/pickup order got created for JV -- the exact rogue-order bug from the live incident');

    const { rows: reloadedOrderA } = await pool.query(`select * from "order" where id = $1`, [order.id]);
    assert(reloadedOrderA[0].confirmed_at !== null, "JV's real dine-in order actually got confirmed -- his tap reached the real shared order, not a rogue one");

    // === Scenario B: guest joined the table but no order exists yet at all ===
    const { rows: tableRowsB } = await pool.query(
      `insert into restaurant_table (branch_id, label, qr_token) values ($1, '2', 'qrtestB') returning id`,
      [branchId]
    );
    const tableB = tableRowsB[0];

    await sendAndWait({ phoneNumber: '2348011110201', text: 'Menu Table 2', channel: 'whatsapp', messageId: 'b1', branchId });
    const { rows: c3Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348011110201']);
    const customer3 = c3Rows[0];

    // Instead of tapping the menu link, this guest just types -- no order
    // exists yet anywhere for the table.
    await sendAndWait({ phoneNumber: '2348011110201', text: 'I want to order jollof rice', channel: 'whatsapp', messageId: 'b2', branchId });

    const { rows: rogueOrdersB } = await pool.query(`select * from "order" where customer_id = $1`, [customer3.id]);
    assert(rogueOrdersB.length === 0, 'a dine-in guest typing free text before any order exists still never got routed into a fresh online order');

    // Chidera, 2026-09-24: the old real-message "here's your table's menu
    // link" re-send this used to check for is genuinely gone now -- the
    // universal redirect gate fires first for ANY whatsapp customer and
    // returns before that dine-in-specific code could ever run (it's dead
    // code, removed this session). This guest's free text redirects to the
    // chat instead, same as scenario A's JV.
    const { rows: lastMsgB } = await pool.query(
      `select trigger from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`, [customer3.id]
    );
    assert(lastMsgB[0]?.trigger === 'greeting', 'instead, redirected to the chat -- still never a rogue online order, and never the AI-dependent path');
  } finally {
    global.fetch = realFetch;
  }

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
