// Chidera, 2026-09-23, live report on era-demo: "in era demo current chat
// after i typed add zobo it gave me a bill of food with total of 4700 my
// food way 1700 but it didnt state the delivery there, one could easily
// misunderstand." summariseOrder's own `total` has always silently
// included delivery_fee (itemsTotal + deliveryFee) -- the confirm message
// shown after modifying an order (adding/removing/changing items once
// delivery/fulfilment is already known) only ever listed the items, never
// the fee itself, so the total looked unexplained: items summed to less
// than what was actually being charged.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  const { rows: bizRows } = await pool.query(
    `insert into business (name, type, address, phone_number, delivery_enabled, whatsapp_connection)
     values ('Test Biz', 'restaurant', '1 Test Street', '2348010000000', true, 'api_only') returning id`
  );
  const { rows: prod1 } = await pool.query(`insert into product (name, description, price, availability_type) values ('Jollof Rice', 'desc', 1700, 'stock') returning id, price`);
  const { rows: prod2 } = await pool.query(`insert into product (name, description, price, availability_type) values ('Zobo', 'desc', 1500, 'stock') returning id, price`);

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012350001', channel: 'whatsapp' });

  // An order that ALREADY has a real delivery fee set (fulfilment already
  // collected, same state a customer adding on mid-order is really in) --
  // 1700 (food) + 1500 (delivery) = 3200, matching the shape of her real
  // report (a total that doesn't match the visible items).
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, delivery_fee, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-DELFEE-1', 'delivery', 1500, 1700, 'new', 'pending', 'confirm_order', 'whatsapp') returning *`,
    [customer.id]
  );
  const order = orderRows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order.id, prod1[0].id, prod1[0].price]);

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); originalLog(...args); };
  // "add zobo" -- resubmitting the full basket (existing item + the new
  // one), the exact shape the real web menu page's review route sends.
  await flow.handleWebMenuOrder(customer, [
    { productId: prod1[0].id, name: 'Jollof Rice', price: prod1[0].price, quantity: 1, answers: {} },
    { productId: prod2[0].id, name: 'Zobo', price: prod2[0].price, quantity: 1, answers: {} },
  ], null);
  console.log = originalLog;

  const relevant = logs.find((l) => l.includes(customer.phone_number));
  assert(Boolean(relevant), 'the customer gets a real confirm message back');
  assert(relevant?.includes('Delivery fee: NGN 1500'), 'the delivery fee is now shown as its own explicit line, not just folded silently into the total');
  assert(relevant?.includes('New total: NGN 4700'), 'and the total is still correct (1700 jollof + 1500 zobo + 1500 delivery)');

  const { rows: finalOrder } = await pool.query(`select total, delivery_fee from "order" where id = $1`, [order.id]);
  assert(Number(finalOrder[0].total) === 4700, 'the real stored order total is correct in the database too');
  assert(Number(finalOrder[0].delivery_fee) === 1500, 'delivery_fee itself is untouched by the item change');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
