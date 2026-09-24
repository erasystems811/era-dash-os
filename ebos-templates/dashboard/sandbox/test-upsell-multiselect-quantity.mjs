// Chidera, 2026-09-24: "i dont want the same drinks,protein snack upsell,
// it could be a side too, but max 3 upsells and since upsells are more
// than 1 dont take them back to the menu to ask all those finish your
// order questions, just ask them in webchat the peppered or not and
// all." And, same message thread: "let them be able to pick multiple and
// also when they pick one let the + and - thing show so they can buy
// more than 1."
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

  // A drink, a protein, a side, AND a snack -- all four UPSELL_GROUPS
  // categories -- so an order missing everything is the real "which 3 get
  // picked" test, not just "does side work at all".
  const { rows: drinkRows } = await pool.query(`insert into product (name, description, price, category, availability_type) values ('Zobo', 'd', 1200, 'Drinks', 'stock') returning id, price`);
  const { rows: proteinRows } = await pool.query(`insert into product (name, description, price, category, availability_type) values ('Grilled Chicken', 'd', 2000, 'Protein', 'stock') returning id, price`);
  const { rows: sideRows } = await pool.query(`insert into product (name, description, price, category, availability_type) values ('Fried Plantain', 'd', 1000, 'Side', 'stock') returning id, price`);
  const { rows: snackRows } = await pool.query(`insert into product (name, description, price, category, availability_type) values ('Puff Puff', 'd', 800, 'Snacks', 'stock') returning id, price`);
  // A real item-customization question on the protein -- proving the
  // multi-select add still asks it INLINE, not by redirecting to the menu.
  await pool.query(`insert into product_question (product_id, question) values ($1, 'Peppered or not?')`, [proteinRows[0].id]);

  const { rows: mainRows } = await pool.query(`select id, price from product where name = 'Jollof Rice and Chicken'`);

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012359001', channel: 'whatsapp' });
  customer.channel = 'website';
  const token = await flow.ensureMenuToken(customer);
  // fulfilment_type already set (pickup) so finishItemsCollection's own
  // missingFieldsForOrder check finds nothing outstanding and falls
  // straight through to the real nextUpsellGroup/pickUpsellOptions logic
  // -- both fully AI-free (deterministic keyword matching), so this can
  // be driven directly, no Anthropic key needed.
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-UPMULTI-1', 'pickup', $2, 'new', 'pending', 'confirm_order', 'whatsapp') returning *`,
    [customer.id, mainRows[0].price]
  );
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [orderRows[0].id, mainRows[0].id, mainRows[0].price]);

  // === 1. Drive the REAL nextUpsellGroup/pickUpsellOptions logic directly
  // via finishItemsCollection -- fully AI-free (missingFieldsForOrder and
  // the upsell matching are both deterministic), no Anthropic key needed. ===
  await flow.finishItemsCollection(customer, orderRows[0], '');
  const messages = await (await fetch(`${BASE}/wa/${token}/messages`)).json();
  const upsellMsg = messages.find((m) => m.interactive?.type === 'list');
  assert(Boolean(upsellMsg), 'the upsell list bubble was sent');
  const offeredRows = (upsellMsg.interactive.rows || []).filter((r) => r.id !== 'upsell::skip');
  assert(offeredRows.length === 3, `exactly 3 real upsell items offered (max 3), got ${offeredRows.length}`);
  const offeredNames = offeredRows.map((r) => r.title);
  // Drink picks the seed's own OTHER drink (Chapman, already in the
  // catalogue before this test's Zobo) -- both real, categoryMatchesGroup
  // just picks the first match, which is correct: Zobo was never claimed
  // to be guaranteed picked over an existing product in the same category.
  assert(offeredNames.includes('Chapman') && offeredNames.includes('Grilled Chicken') && offeredNames.includes('Fried Plantain'), `drink, protein, and side -- the first 3 UPSELL_GROUPS categories, in priority order -- not the snack, which comes 4th (got: ${offeredNames.join(', ')})`);
  assert(!offeredNames.includes('Puff Puff'), 'the snack (4th category, over the cap) is never offered alongside these three');

  // === 2. Multi-select + quantity: pick 2 of the 3 actually-offered rows,
  // one with quantity 3 -- using the real row ids the bubble sent, not
  // assumed ones. ===
  const drinkRow = offeredRows.find((r) => r.title === 'Chapman');
  const proteinRow = offeredRows.find((r) => r.title === 'Grilled Chicken');
  const drinkProductId = drinkRow.id.slice('upsell::'.length);
  const proteinProductId = proteinRow.id.slice('upsell::'.length);
  const tapRes = await fetch(`${BASE}/wa/${token}/tap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upsellPicks: [{ productId: drinkProductId, quantity: 2 }, { productId: proteinProductId, quantity: 3 }] }),
  });
  assert(tapRes.status === 200, 'the multi-select tap succeeds');

  const { rows: itemRows } = await pool.query(
    `select p.name, oi.quantity from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1 order by p.name`,
    [orderRows[0].id]
  );
  const drinkItem = itemRows.find((r) => r.name === 'Chapman');
  const proteinItem = itemRows.find((r) => r.name === 'Grilled Chicken');
  assert(Boolean(drinkItem) && Boolean(proteinItem), 'BOTH picked items were actually added, not just one');
  assert(Number(drinkItem.quantity) === 2, 'the drink got its real picked quantity (2), not just 1');
  assert(Number(proteinItem.quantity) === 3, 'the protein got its real picked quantity (3)');
  assert(!itemRows.some((r) => r.name === 'Fried Plantain'), 'the side, offered but never picked, was never added');

  // === 3. The protein's own item-customization question gets asked
  // INLINE in the chat -- not a redirect to the menu page. ===
  const { rows: orderAfter } = await pool.query(`select pending_question_id, pending_question_order_item_id from "order" where id = $1`, [orderRows[0].id]);
  assert(orderAfter[0].pending_question_id !== null, 'a real pending item-question is now set on the order');

  const allMessages = await (await fetch(`${BASE}/wa/${token}/messages`)).json();
  const questionMsg = allMessages.find((m) => /peppered or not/i.test(m.body || ''));
  assert(Boolean(questionMsg), 'the "Peppered or not?" question was actually asked as a real chat bubble');
  if (questionMsg) {
    assert(!questionMsg.interactive || questionMsg.interactive.type !== 'cta_url', 'asked directly in chat text, not as a link out to the menu page');
  }

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
