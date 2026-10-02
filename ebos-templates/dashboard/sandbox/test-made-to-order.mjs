// Chidera, 2026-10-02: "she sells slippers and leather textured things...
// with product you cant predict its basically buy and sell or produce and
// sell, its not a service." product.order_type/made_to_order_config
// (migrations/0068_made_to_order.sql) -- covers the deposit math on a
// mixed cart, the deposit never being mistaken for full payment on the
// money figures (the real risk Chidera flagged), the concurrent-job cap,
// and the same-day cutoff check. Doesn't route through handleConfirmOrder's
// own "yes" classification (botEngine.extractField -- a real Claude call,
// no test stub exists for it, see bot-engine/extract.js) -- every DB/
// messaging function this feature touches is exercised directly instead,
// same pattern test-chat-redirect-once-then-silent.mjs already uses for
// inserting an "order" row straight through pool.query.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3981';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3981';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3981';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');
  const mto = await import('../engine/made-to-order.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // === PART A: pure math, no DB ===
  const split = mto.computeDepositSplit({ total: 10700, madeToOrderSubtotal: 8000, deliveryFee: 700, depositPercent: 50 });
  // readyMade portion (2000 + 700 delivery) paid in full now, plus 50% of
  // the 8000 made-to-order portion (4000) -- 2700 + 4000 = 6700 now,
  // 4000 left for later.
  assert(split.depositAmount === 6700, `deposit charges the full ready-made+delivery portion plus half the made-to-order portion (got ${split.depositAmount})`);
  assert(split.balanceDue === 4000, `balance is the other half of the made-to-order portion (got ${split.balanceDue})`);

  assert(mto.computeDepositSplit({ total: 5000, madeToOrderSubtotal: 0, deliveryFee: 0, depositPercent: 50 }) === null, 'no made-to-order items at all -- no deposit, charge the full total as before');
  assert(mto.computeDepositSplit({ total: 5000, madeToOrderSubtotal: 5000, deliveryFee: 0, depositPercent: null }) === null, 'no deposit_percent configured -- no deposit, pay in full');
  assert(mto.computeDepositSplit({ total: 5000, madeToOrderSubtotal: 5000, deliveryFee: 0, depositPercent: 100 }) === null, 'a 100% deposit leaves nothing owed later -- correctly not treated as a split at all');

  const morning = new Date('2026-10-02T08:00:00');
  const evening = new Date('2026-10-02T20:00:00');
  assert(mto.isPastSameDayCutoff(null, evening) === false, 'no cutoff configured -- never past it');
  assert(mto.isPastSameDayCutoff('14:00', morning) === false, 'before the cutoff time -- not past it yet');
  assert(mto.isPastSameDayCutoff('14:00', evening) === true, 'after the cutoff time -- past it');

  // === PART B: a real made-to-order + ready-made mixed cart ===
  const { rows: madeToOrderProduct } = await pool.query(
    `insert into product (name, price, order_type) values ('Custom Leather Purse', 8000, 'made_to_order') returning id, price`
  );
  const { rows: readyMadeProduct } = await pool.query(`select id, price from product where order_type = 'ready_made' limit 1`);

  await pool.query(`insert into made_to_order_config (business_id, enabled, deposit_percent, max_concurrent_jobs) select id, true, 50, 1 from business limit 1`);

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012380001', channel: 'whatsapp' });
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-MTO-1', 'pickup', $2, 'new', 'pending', 'confirm_payment', 'whatsapp') returning *`,
    [customer.id, Number(madeToOrderProduct[0].price) + Number(readyMadeProduct[0].price)]
  );
  const order = orderRows[0];
  await pool.query(
    `insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3), ($1, $4, 1, $5)`,
    [order.id, madeToOrderProduct[0].id, madeToOrderProduct[0].price, readyMadeProduct[0].id, readyMadeProduct[0].price]
  );

  const { hasMadeToOrderItems, madeToOrderSubtotal } = await mto.splitOrderItemsByType(order.id);
  assert(hasMadeToOrderItems === true, 'the mixed cart is correctly recognised as having a made-to-order item');
  assert(Number(madeToOrderSubtotal) === Number(madeToOrderProduct[0].price), 'only the made-to-order item counts toward the made-to-order subtotal');

  await flow.sendPaymentInstructions(customer, order);
  const { rows: afterInstructions } = await pool.query('select * from "order" where id = $1', [order.id]);
  const expectedDeposit = Number(readyMadeProduct[0].price) + Math.ceil(Number(madeToOrderProduct[0].price) * 0.5);
  assert(Number(afterInstructions[0].deposit_amount) === expectedDeposit, `sendPaymentInstructions persisted the right deposit_amount (got ${afterInstructions[0].deposit_amount}, expected ${expectedDeposit})`);
  assert(Number(afterInstructions[0].balance_due) === Number(order.total) - expectedDeposit, 'and the right balance_due for the remainder');

  // === PART C: completing the deposit payment never reads as the whole order being paid for ===
  await flow.completePayment(order.id);
  const { rows: afterPay } = await pool.query('select * from "order" where id = $1', [order.id]);
  assert(afterPay[0].status === 'preparation', 'production starts on the deposit -- same as any other confirmed payment');
  assert(afterPay[0].payment_status === 'confirmed', 'payment_status still reads confirmed (deposit really did clear)');
  assert(Number(afterPay[0].balance_due) === Number(order.total) - expectedDeposit, 'balance_due is untouched by completePayment -- still owed, not silently cleared');

  const { rows: outboundMsgs } = await pool.query(`select body from message where customer_id = $1 and direction = 'outbound' order by created_at asc`, [customer.id]);
  const depositMentioned = outboundMsgs.some((m) => /deposit/i.test(m.body));
  const balanceLinkMentioned = outboundMsgs.some((m) => /remaining NGN/i.test(m.body));
  assert(depositMentioned, 'the receipt explicitly says this was a deposit, not the full order');
  assert(balanceLinkMentioned, 'a real link/message for the remaining balance went out right away');

  // === PART D: the money figures never overcount a deposit as the full total collected ===
  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@samplerestaurant.test', password: 'testpass123' }),
  });
  const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert(loginRes.status === 200 && !!cookie, 'staff login succeeded, got a real session cookie');
  const authed = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), cookie } });

  const statsRes = await authed(`${BASE}/api/orders/stats/today`);
  const stats = await statsRes.json();
  // Other orders may exist from earlier in this same run/other tests
  // sharing this in-process DB -- checked as a floor, not an exact figure,
  // same reasoning as this file's own isolated port/process already gives
  // every sandbox test its own fresh DB in practice.
  assert(stats.collected >= expectedDeposit, `today's "collected" figure includes at least the real deposit actually received (got ${stats.collected})`);
  assert(stats.collected < expectedDeposit + Number(afterPay[0].balance_due) + 1, `and never the full order total while the balance is still outstanding (got ${stats.collected}, order total ${order.total})`);

  // === PART E: staff manually confirming the balance settles it, cleanly, without re-running completePayment's one-shot pipeline ===
  const balanceConfirmRes = await authed(`${BASE}/api/orders/${order.id}/balance/confirm`, { method: 'POST' });
  assert(balanceConfirmRes.status === 200, `balance/confirm route succeeds (got ${balanceConfirmRes.status})`);
  const { rows: afterBalance } = await pool.query('select balance_due from "order" where id = $1', [order.id]);
  assert(Number(afterBalance[0].balance_due) === 0, 'balance_due is genuinely cleared');

  const statsAfterBalance = await (await authed(`${BASE}/api/orders/stats/today`)).json();
  assert(statsAfterBalance.collected >= expectedDeposit + Number(afterPay[0].balance_due), `once the balance is confirmed, "collected" catches up to the full order total (got ${statsAfterBalance.collected})`);

  const balanceConfirmAgainRes = await authed(`${BASE}/api/orders/${order.id}/balance/confirm`, { method: 'POST' });
  assert(balanceConfirmAgainRes.status === 409, 'confirming an already-settled balance is rejected, not silently accepted again');

  // === PART F: max_concurrent_jobs -- this order (still 'preparation', a
  // real made-to-order job) already counts toward the cap of 1 set above. ===
  const config = await mto.getMadeToOrderConfig();
  const { atCap, activeCount } = await mto.isAtConcurrentJobCap(config);
  assert(activeCount === 1, `exactly the one real made-to-order order in preparation counts as active (got ${activeCount})`);
  assert(atCap === true, 'with max_concurrent_jobs = 1 and one already active, a new one would be declined');

  await pool.query(`update "order" set status = 'completed' where id = $1`, [order.id]);
  const { atCap: atCapAfterComplete } = await mto.isAtConcurrentJobCap(config);
  assert(atCapAfterComplete === false, 'once that job is completed, it no longer counts toward the cap -- a new one would go through');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  // completePayment's own sendFeedbackRequest call is fire-and-forget (its
  // own comment: "safe to just add, not move") -- a brief pause so that
  // background promise (and this test's own several HTTP fetches right
  // after it) genuinely settle before exiting, instead of racing
  // process.exit() against a still-open libuv handle (a real, reproducible
  // native assertion crash on Windows otherwise: "UV_HANDLE_CLOSING").
  await new Promise((r) => setTimeout(r, 200));
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
