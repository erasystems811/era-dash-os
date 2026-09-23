// Chidera, real report: "what do you mean by a guest-chicken? was it not
// the same number that ordered chicken through an upsell? why are you
// seperating it?" Root cause: applyOrderModifications (the function
// behind BOTH handleCollectInfo's typed-item-add path and
// handlePendingUpsell's own upsell-acceptance path) never set
// added_by_customer_id on its own order_item insert, unlike the web-menu
// review route's insert, which always did. Any item added by typed chat
// or accepting an upsell offer landed with added_by_customer_id null --
// pendingOrderPayload's labelFor then had no real customer to resolve a
// name/phone from and fell back to "a guest," even though it was
// unmistakably the same real number that placed the rest of the order.
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

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348011119999', channel: 'whatsapp' });
  const { rows: prodRows } = await pool.query(`insert into product (name, price, category) values ('Grilled Chicken', 2500, 'PROTEIN') returning id`);
  const productId = prodRows[0].id;
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, status, engine_state) values ($1, 'REF-UPSELL', 'new', 'collect_info') returning *`,
    [customer.id]
  );
  const order = orderRows[0];

  // Exactly what handlePendingUpsell does when a customer accepts a
  // cross-sell offer (e.g. "yeah add the chicken") -- a genuinely new
  // item, this exact customer, same real phone number as the rest of
  // their order.
  await flow.applyOrderModifications(
    order,
    { adds: [{ productId, quantity: 1, price: 2500, name: 'Grilled Chicken' }], removes: [], sets: [] },
    { allowRemovals: true },
    customer
  );

  const { rows: itemRows } = await pool.query(`select added_by_customer_id from order_item where order_id = $1`, [order.id]);
  assert(itemRows[0]?.added_by_customer_id === customer.id, 'the upsell-accepted item is attributed to the real customer who accepted it, not left null ("a guest")');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
