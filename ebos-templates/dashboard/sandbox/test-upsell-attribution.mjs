// Chidera, real report: "what do you mean by a guest-chicken? was it not
// the same number that ordered chicken through an upsell? why are you
// seperating it?" Root cause: several SEPARATE order_item insert paths
// never set added_by_customer_id, unlike the web-menu review route's
// insert, which always did -- so an item added through any of them landed
// with added_by_customer_id null, and pendingOrderPayload's labelFor had
// no real customer to resolve a name/phone from, falling back to "a
// guest" even for the same real number that placed the rest of the order.
// This was fixed and re-broken piecemeal across the same session --
// Chidera hit it a THIRD time, 2026-09-20, this time specifically on the
// upsell's own WhatsApp LIST tap ("water is still categorized as guest"),
// which had never been covered by either earlier pass or this test file.
// Every known order_item insert path that can plausibly run for a real
// customer message/tap is covered here now, in one file, so a fourth
// report in a fifth location doesn't happen.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3921';
process.env.SESSION_SECRET = 'testsecret';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.anthropic.com')) {
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"items": [{"index": 1, "quantity": 1}], "ambiguous": []}' }], usage: {} }), { status: 200 });
    }
    return realFetch(url, opts);
  };

  try {
    // === 1. applyOrderModifications -- e.g. a typed "yes" to an upsell offer ===
    const customer1 = await flow.findOrCreateCustomer({ phoneNumber: '2348011119991', channel: 'whatsapp' });
    const { rows: prod1 } = await pool.query(`insert into product (name, price, category) values ('Grilled Chicken', 2500, 'PROTEIN') returning id`);
    const { rows: order1Rows } = await pool.query(
      `insert into "order" (customer_id, reference, status, engine_state) values ($1, 'REF-UP1', 'new', 'collect_info') returning *`,
      [customer1.id]
    );
    const order1 = order1Rows[0];
    await flow.applyOrderModifications(order1, { adds: [{ productId: prod1[0].id, quantity: 1, price: 2500, name: 'Grilled Chicken' }], removes: [], sets: [] }, { allowRemovals: true }, customer1);
    const { rows: item1 } = await pool.query(`select added_by_customer_id from order_item where order_id = $1`, [order1.id]);
    assert(item1[0]?.added_by_customer_id === customer1.id, 'applyOrderModifications (typed "yes" to an upsell) attributes correctly');

    // === 2. handlePendingUpsell's own typed-exact-match insert ("chicken") ===
    const customer2 = await flow.findOrCreateCustomer({ phoneNumber: '2348011119992', channel: 'whatsapp' });
    const { rows: prod2 } = await pool.query(`insert into product (name, price, category) values ('Suya Wrap', 3000, 'PROTEIN') returning id`);
    const { rows: order2Rows } = await pool.query(
      `insert into "order" (customer_id, reference, status, engine_state, pending_upsell_category) values ($1, 'REF-UP2', 'new', 'collect_info', 'protein') returning *`,
      [customer2.id]
    );
    const order2 = order2Rows[0];
    // Forces the exact-match branch (extractOrderModifications must return
    // null first) -- an unambiguous product name with no "add"/"remove"
    // verb reads as a plain item mention, not a modification.
    await pool.query(`update product set name = 'Suya Wrap' where id = $1`, [prod2[0].id]);
    await flow.handlePendingUpsell(customer2, order2, 'Suya Wrap');
    const { rows: item2 } = await pool.query(`select added_by_customer_id from order_item where order_id = $1`, [order2.id]);
    assert(item2[0]?.added_by_customer_id === customer2.id, 'handlePendingUpsell\'s own typed-match insert attributes correctly');

    // === 3. handleUpsellListTap -- the ACTUAL real report: tapping the upsell's own WhatsApp list ===
    const customer3 = await flow.findOrCreateCustomer({ phoneNumber: '2348011119993', channel: 'whatsapp' });
    const { rows: prod3 } = await pool.query(`insert into product (name, price, category, availability) values ('Zobo Drink', 1200, 'DRINKS', true) returning id`);
    const { rows: order3Rows } = await pool.query(
      `insert into "order" (customer_id, reference, status, engine_state, pending_upsell_category) values ($1, 'REF-UP3', 'new', 'collect_info', 'drinks') returning *`,
      [customer3.id]
    );
    const order3 = order3Rows[0];
    await flow.handleUpsellListTap({ phoneNumber: '2348011119993', channelId: '2348011119993', rowId: `upsell::${prod3[0].id}`, channel: 'whatsapp' });
    const { rows: item3 } = await pool.query(`select added_by_customer_id from order_item where order_id = $1`, [order3.id]);
    assert(item3[0]?.added_by_customer_id === customer3.id, 'handleUpsellListTap (a real tap on the upsell\'s own WhatsApp list -- the exact real report, "water is still categorized as guest") attributes correctly');

    // === 4. handleCollectInfo's own first-typed-item insert ===
    const customer4 = await flow.findOrCreateCustomer({ phoneNumber: '2348011119994', channel: 'whatsapp' });
    const { rows: prod4 } = await pool.query(`insert into product (name, price, category) values ('Jollof Rice', 3500, 'MAINS') returning id`);
    const { rows: order4Rows } = await pool.query(
      `insert into "order" (customer_id, reference, status, engine_state) values ($1, 'REF-UP4', 'new', 'collect_info') returning *`,
      [customer4.id]
    );
    const order4 = order4Rows[0];
    await flow.handleCollectInfo(customer4, order4, 'I want jollof rice');
    const { rows: item4 } = await pool.query(`select added_by_customer_id from order_item where order_id = $1`, [order4.id]);
    assert(item4[0]?.added_by_customer_id === customer4.id, 'handleCollectInfo\'s own first-typed-item insert attributes correctly');

    // === 5. handleMenuItemTap -- a WhatsApp catalog product tap ===
    const customer5 = await flow.findOrCreateCustomer({ phoneNumber: '2348011119995', channel: 'whatsapp' });
    const { rows: prod5 } = await pool.query(`insert into product (name, price, category) values ('Puff Puff', 800, 'SNACKS') returning id`);
    await flow.handleMenuItemTap({ phoneNumber: '2348011119995', channelId: '2348011119995', product: { id: prod5[0].id, name: 'Puff Puff', price: 800 }, channel: 'whatsapp' });
    const { rows: order5 } = await pool.query(`select id from "order" where customer_id = $1`, [customer5.id]);
    const { rows: item5 } = await pool.query(`select added_by_customer_id from order_item where order_id = $1`, [order5[0].id]);
    assert(item5[0]?.added_by_customer_id === customer5.id, 'handleMenuItemTap (a WhatsApp catalog product tap) attributes correctly');
  } finally {
    global.fetch = realFetch;
  }

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
