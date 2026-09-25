// Chidera, 2026-09-25: "hope dine in has receipt too and the receipt has
// back to chat?" -- dine-in settles in person via staff's "Mark paid"
// button (InHouse.jsx -> POST /api/orders/:id/payment-method), which never
// goes through engine/flow.js's completePayment (payment_status never
// reaches 'confirmed'/'accepted' for a dine-in round settled this way --
// see completePayment's own comment), so it never sent any receipt at all
// until now. Verifies the route now sends the same real receipt
// (sendReceiptMessage, shared with completePayment) once a dine-in round
// is marked paid -- both the straightforward full-cash case and the
// shortfall-but-"close anyway" case, since the route reaches this send
// from two different branches.
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

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@samplerestaurant.test', password: 'testpass123' }),
  });
  const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert(loginRes.status === 200 && !!cookie, 'staff login succeeded, got a real session cookie');
  const authedPost = (url, body) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body),
  });

  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '20', 'qrtest20') returning id`, [branchId]);
  const { rows: sessionRows } = await pool.query(`insert into table_session (table_id, branch_id) values ($1, $2) returning id`, [tableRows[0].id, branchId]);
  const { rows: prodRows } = await pool.query(`insert into product (name, price, category, branch_id) values ('Jollof Rice', 3500, 'MAINS', $1) returning id`, [branchId]);
  const { rows: custRows } = await pool.query(`insert into customers (phone_number, channel) values ('2348099990009', 'whatsapp') returning *`);
  const customer = custRows[0];

  // === 1. Full cash payment: marks paid, sends a real receipt ===
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, session_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, $2, 'REF-MARKPAID-1', 'table', 3500, 'preparation', 'pending', 'fulfilment', 'dinein') returning id`,
    [customer.id, sessionRows[0].id]
  );
  const order = orderRows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, 3500)`, [order.id, prodRows[0].id]);

  const res = await authedPost(`${BASE}/api/orders/${order.id}/payment-method`, { paymentMethod: 'cash', cashCollected: 3500 });
  const resBody = await res.json();
  assert(res.status === 200 && resBody.closed === true, `mark-paid succeeds and closes the order (got ${res.status}, closed=${resBody.closed})`);

  await new Promise((r) => setTimeout(r, 500));
  const { rows: sentMessages } = await pool.query(
    `select body, trigger, interactive from message where customer_id = $1 and direction = 'outbound' order by created_at`,
    [customer.id]
  );
  const receiptRow = sentMessages.find((m) => m.trigger === 'receipt_pdf');
  assert(!!receiptRow, 'a real receipt was sent for a dine-in order marked paid via the staff "Mark paid" button');
  const followUp = sentMessages[sentMessages.length - 1];
  assert(followUp.body.startsWith('Your payment has been received.'), `the follow-up leads with the real "payment received" confirmation (got "${followUp.body}")`);
  assert(followUp.body.includes('Thank you for dining with us!'), `the follow-up has dine-in-appropriate wording, not delivery/pickup text (got "${followUp.body}")`);

  // === 2. Shortfall, but staff closes anyway: still sends a receipt ===
  const { rows: order2Rows } = await pool.query(
    `insert into "order" (customer_id, session_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, $2, 'REF-MARKPAID-2', 'table', 3500, 'preparation', 'pending', 'fulfilment', 'dinein') returning id`,
    [customer.id, sessionRows[0].id]
  );
  const order2 = order2Rows[0];
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, 3500)`, [order2.id, prodRows[0].id]);

  const shortRes = await authedPost(`${BASE}/api/orders/${order2.id}/payment-method`, { paymentMethod: 'cash', cashCollected: 2000, closeAnyway: true });
  const shortBody = await shortRes.json();
  assert(shortRes.status === 200 && shortBody.closed === true && shortBody.shortfall === 1500, `shortfall + closeAnyway closes the order anyway (got closed=${shortBody.closed}, shortfall=${shortBody.shortfall})`);

  await new Promise((r) => setTimeout(r, 500));
  const { rows: sentMessages2 } = await pool.query(
    `select trigger from message where customer_id = $1 and direction = 'outbound' and trigger = 'receipt_pdf'`,
    [customer.id]
  );
  assert(sentMessages2.length === 2, `a receipt was also sent for the shortfall-but-closed-anyway order (expected 2 total receipts across both orders, got ${sentMessages2.length})`);

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
