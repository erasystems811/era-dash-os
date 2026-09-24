// Chidera, 2026-09-24, first pass: "i dont want the same drinks,protein
// snack upsell, it could be a side too, but max 3 upsells... just ask
// them in webchat the peppered or not and all" plus "let them be able to
// pick multiple and also when they pick one let the + and - thing show
// so they can buy more than 1."
//
// Then corrected: "no you got upsell wronggg...you dont make it obvious,
// you said want to complete your oeder like that is a pre requiste, the
// former would you like to add a drink is very okay just that it was to
// enable multi selesct and all and after theyve added drink then ask
// again would you like to add one of our special sides." So: SEQUENTIAL
// single-category offers (not one combined list), each with its own full
// catalogue + multi-select + quantity, up to 3 categories total per order.
//
// Also fixes a real bug found live: "after i said no thanks and later on
// i wanted to add, the bot was not acknowledging my new selection, a
// person can alsways select and itll be added" -- tapping an item on an
// OLDER, already-answered upsell bubble used to silently no-op once
// pending_upsell_category had moved on.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3950';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3950';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3950';

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

  const { rows: drinkRows } = await pool.query(`insert into product (name, description, price, category, availability_type) values ('Zobo', 'd', 1200, 'Drinks', 'stock') returning id, price`);
  const { rows: sideRows } = await pool.query(`insert into product (name, description, price, category, availability_type) values ('Fried Plantain', 'd', 1000, 'Side', 'stock') returning id, price`);
  const { rows: mainRows } = await pool.query(`select id, price from product where name = 'Jollof Rice and Chicken'`);

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012359001', channel: 'whatsapp' });
  customer.channel = 'website';
  const token = await flow.ensureMenuToken(customer);
  // engine_state starts at collect_info (a realistic pre-upsell state) --
  // not confirm_order, which finishItemsCollection's own tail assumes it
  // is transitioning FORWARD into once every category's been asked about,
  // not already sitting at.
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-UPMULTI-1', 'pickup', $2, 'new', 'pending', 'collect_info', 'whatsapp') returning *`,
    [customer.id, mainRows[0].price]
  );
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [orderRows[0].id, mainRows[0].id, mainRows[0].price]);

  // === 1. First offer is ONE category (drink) with its FULL catalogue --
  // not a combined multi-category list, and the plain "would you like to
  // add a drink?" wording, not "complete your order". ===
  await flow.finishItemsCollection(customer, orderRows[0], '');
  let messages = await (await fetch(`${BASE}/wa/${token}/messages`)).json();
  let upsellMsg = messages.filter((m) => m.interactive?.type === 'list').pop();
  assert(Boolean(upsellMsg), 'the first upsell offer went out');
  assert(/would you like to add a drink/i.test(upsellMsg.body), 'plain, natural single-category wording, not the combined-list phrasing');
  assert(!/complete your order/i.test(upsellMsg.body), 'never the "pre-requisite" sounding phrasing');
  const drinkRowsOffered = (upsellMsg.interactive.rows || []).filter((r) => r.id !== 'upsell::skip');
  assert(drinkRowsOffered.some((r) => r.title === 'Zobo') && drinkRowsOffered.some((r) => r.title === 'Chapman'), 'the FULL drink catalogue is offered (both Zobo and the seed\'s own Chapman), not just one representative product');

  // === 2. Decline this one (multi-select "No thanks" tap). ===
  await fetch(`${BASE}/wa/${token}/tap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowId: 'upsell::skip' }),
  });

  // === 3. A SECOND, sequential offer for the NEXT category (side) --
  // proving "after theyve added [or declined] drink then ask again would
  // you like to add one of our special sides". ===
  messages = await (await fetch(`${BASE}/wa/${token}/messages`)).json();
  const sideMsg = messages.filter((m) => m.interactive?.type === 'list').pop();
  assert(Boolean(sideMsg), 'a second, sequential upsell offer went out after declining the first');
  assert(/would you like to add a side/i.test(sideMsg.body), 'this one asks about the side specifically, not a repeat of drink');

  // === 4. Multi-select + quantity on the side offer: pick the side with
  // quantity 2. ===
  const sideRow = (sideMsg.interactive.rows || []).find((r) => r.title === 'Fried Plantain');
  const tapRes = await fetch(`${BASE}/wa/${token}/tap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upsellPicks: [{ productId: sideRow.id.slice('upsell::'.length), quantity: 2 }] }),
  });
  assert(tapRes.status === 200, 'the multi-select tap on the second offer succeeds');
  const { rows: itemRows } = await pool.query(
    `select p.name, oi.quantity from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1 and p.name = 'Fried Plantain'`,
    [orderRows[0].id]
  );
  assert(itemRows.length === 1 && Number(itemRows[0].quantity) === 2, 'the side was added with its real picked quantity (2)');

  // === 5. THE REAL BUG: tapping an item on the FIRST (drink) bubble --
  // already declined and long superseded by the side offer -- still
  // adds it. "after i said no thanks and later on i wanted to add, the
  // bot was not acknowledging my new selection." ===
  const zoboRow = (upsellMsg.interactive.rows || []).find((r) => r.title === 'Zobo');
  const lateAddRes = await fetch(`${BASE}/wa/${token}/tap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowId: zoboRow.id }),
  });
  assert(lateAddRes.status === 200, 'tapping an item on the OLD, already-declined drink bubble does not error');
  const { rows: zoboRows } = await pool.query(
    `select oi.quantity from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1 and p.name = 'Zobo'`,
    [orderRows[0].id]
  );
  assert(zoboRows.length === 1, 'and it genuinely gets added -- a change of mind after declining is acknowledged, not silently ignored');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
