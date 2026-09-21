// Chidera, 2026-09-21: "LET DINE IN SUPPORT PAYSTACK O" -- dine-in's own
// pay page never had a Paystack option at all (only POS transfer or a
// generic "pay at the counter" line, see routes/dinein-menu.js's own
// header comment before this). Confirms a real Paystack transaction gets
// initialized for a SPECIFIC order_payment (a split share, not the whole
// order -- a table can have more than one payment in flight at once,
// unlike a regular order), that the real webhook (HMAC-verified, same as
// every other Paystack confirm) auto-confirms it via
// flow.js's confirmOrderPayment, and that reopening the pay page reuses
// the already-generated link rather than initializing a second Paystack
// transaction for no reason.
import crypto from 'node:crypto';

process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3938';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3938';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';
process.env.PAYMENT_PROVIDER = 'paystack';
process.env.PAYMENT_SECRET_KEY = 'sk_test_fakekey123';

const BASE = 'http://localhost:3938';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

let initializeCallCount = 0;
const generatedReferences = [];

async function main() {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url) === 'https://api.paystack.co/transaction/initialize') {
      initializeCallCount += 1;
      const body = JSON.parse(opts.body);
      generatedReferences.push(body.reference);
      return new Response(
        JSON.stringify({ status: true, data: { reference: body.reference, authorization_url: `https://checkout.paystack.com/${body.reference}` } }),
        { status: 200 }
      );
    }
    return realFetch(url, opts);
  };

  try {
    await import('../server.js');
    const { pool } = await import('../lib/db.js');
    const flow = await import('../engine/flow.js');

    for (let i = 0; i < 50; i++) {
      try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }

    const { rows: bizRows } = await pool.query(`select id from business limit 1`);
    await pool.query(`insert into dinein_config (business_id, enabled) values ($1, true) on conflict (business_id) do update set enabled = true`, [bizRows[0].id]);
    await pool.query(`insert into payment_config (business_id, provider) values ($1, 'paystack') on conflict (business_id) do update set provider = 'paystack'`, [bizRows[0].id]);

    const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
    const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
    const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '20', 'qrpaystack') returning id`, [branchId]);
    const tableId = tableRows[0].id;
    const { rows: prod1 } = await pool.query(`insert into product (name, price, category, branch_id) values ('Jollof Rice', 3500, 'MAINS', $1) returning id`, [branchId]);

    const sendAndWait = async (args) => { await flow.handleInboundMessage(args); await wait(flow.DEBOUNCE_MS + 1000); };
    await sendAndWait({ phoneNumber: '2348099001122', text: 'Menu Table 20', channel: 'whatsapp', messageId: 'm1', branchId });
    const { rows: c1Rows } = await pool.query(`select * from customers where phone_number = $1`, ['2348099001122']);
    const customer1 = c1Rows[0];
    await flow.handleDineinButtonTap({ phoneNumber: '2348099001122', buttonId: 'dinein_menu', channel: 'whatsapp', branchId });
    const { rows: g1Link } = await pool.query(`select body from message where customer_id = $1 and trigger = 'dinein_menu_sent' order by created_at desc limit 1`, [customer1.id]);
    const g1 = /[?&]g=([a-f0-9]+)/.exec(g1Link[0]?.body || '')?.[1];
    await fetch(`${BASE}/t/qrpaystack/review?g=${g1}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ productId: prod1[0].id, quantity: 1, answers: {} }] }),
    });
    const { rows: sessionRows } = await pool.query(`select * from table_session where table_id = $1`, [tableId]);
    const { rows: orderRows } = await pool.query(`select * from "order" where session_id = $1`, [sessionRows[0].id]);
    const order = orderRows[0];
    await pool.query(`update "order" set status = 'preparation', served_at = now() where id = $1`, [order.id]);

    // === 1. The pay page shows a Paystack "Pay" button, not POS transfer instructions ===
    const payPageBefore = await (await fetch(`${BASE}/t/qrpaystack/pay?g=${g1}`)).text();
    assert(payPageBefore.includes('id="paystackBtn"'), 'the Paystack "Pay" button is on the page');

    // === 2. Requesting payment initializes a REAL Paystack transaction for this specific payment ===
    const create1 = await fetch(`${BASE}/t/qrpaystack/pay/create?g=${g1}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guestIds: [customer1.id] }),
    });
    const create1Data = await create1.json();
    assert(create1Data.amount === 3500, 'a single guest at a solo table is a whole-order payment (matches earlier scenarios)');
    assert(create1Data.paystackUrl?.startsWith('https://checkout.paystack.com/'), 'a real Paystack checkout URL is returned, not POS/manual instructions');
    assert(initializeCallCount === 1, 'exactly one real Paystack initialize call made');

    const { rows: paymentRows } = await pool.query(`select * from order_payment where order_id = $1`, [order.id]);
    const payment = paymentRows[0];
    assert(payment.payment_reference === generatedReferences[0], "the payment's own reference matches what Paystack was actually given");
    assert(payment.payment_link_url === create1Data.paystackUrl, 'the checkout URL is saved on the order_payment row');

    // === 3. Reopening the pay page reuses the SAME link -- no second Paystack transaction for no reason ===
    const payPageAfter = await (await fetch(`${BASE}/t/qrpaystack/pay?g=${g1}`)).text();
    assert(payPageAfter.includes(create1Data.paystackUrl), 'reopening the page shows the same real checkout link');
    assert(initializeCallCount === 1, 'still only ONE Paystack initialize call -- an existing link is reused, not regenerated');

    // === 4. THE REAL ASK: the real Paystack webhook auto-confirms this specific dine-in payment ===
    const secret = process.env.PAYMENT_SECRET_KEY;
    const webhookBody = JSON.stringify({ event: 'charge.success', data: { reference: payment.payment_reference, amount: 350000 } });
    const signature = crypto.createHmac('sha512', secret).update(webhookBody).digest('hex');
    const webhookRes = await fetch(`${BASE}/webhook/paystack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
      body: webhookBody,
    });
    assert(webhookRes.status === 200, 'the Paystack webhook is accepted');
    await wait(300);

    const { rows: confirmedPayment } = await pool.query(`select status, confirmed_at from order_payment where id = $1`, [payment.id]);
    assert(confirmedPayment[0].status === 'confirmed' && confirmedPayment[0].confirmed_at, 'the dine-in payment auto-confirms from a real Paystack charge, same as online orders already did');

    const { rows: orderAfter } = await pool.query(`select status, engine_state, completed_at from "order" where id = $1`, [order.id]);
    assert(orderAfter[0].status === 'completed' && orderAfter[0].completed_at, 'a whole-table payment completes the order, same as the POS confirm path');

    // === 5. A wrong/unsigned webhook is rejected, never confirms anything ===
    const badRes = await fetch(`${BASE}/webhook/paystack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': 'not-a-real-signature' },
      body: webhookBody,
    });
    assert(badRes.status === 401, 'a webhook with a wrong signature is flatly rejected, not silently accepted');

    console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
    process.exit(process.exitCode === 1 ? 1 : 0);
  } finally {
    global.fetch = realFetch;
  }
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
