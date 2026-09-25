// Chidera: "the monnify account that was sent is unavailable and invalid
// and cant it be a link like paystack? so the auto confirm can be
// obvious." Monnify's own dynamic bank-transfer ACCOUNT (a second
// bank-transfer/init-payment call chained after init-transaction) kept
// coming back unusable live -- replaced with the real hosted checkout link
// init-transaction's own response already carries (checkoutUrl), same
// shape as Paystack's authorization_url. Confirms: buildPayLine now
// returns a real tappable paymentUrl (not account details rendered into
// text), the order's payment_link_url/payment_reference are saved exactly
// like Paystack's, and the real Monnify webhook still auto-confirms
// payment off that same reference, unchanged. (Ported from the same fix
// on main -- this branch's own monnify-api.js/payment.js had drifted back
// to the old account-only flow since era-demo started running this branch
// instead of main.)
import crypto from 'node:crypto';

process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3960';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3960';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';
process.env.MONNIFY_API_KEY = 'MK_TEST_FAKEKEY';
process.env.MONNIFY_SECRET_KEY = 'fake_monnify_secret';
process.env.MONNIFY_CONTRACT_CODE = 'fakecontract123';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

let initTransactionCallCount = 0;
let bankTransferCallCount = 0;
const generatedReferences = [];
let lastInitTransactionBody = null;

async function main() {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u === 'https://api.monnify.com/api/v1/auth/login') {
      return new Response(JSON.stringify({ responseBody: { accessToken: 'fake-token', expiresIn: 3600 } }), { status: 200 });
    }
    if (u === 'https://api.monnify.com/api/v1/merchant/transactions/init-transaction') {
      initTransactionCallCount += 1;
      const body = JSON.parse(opts.body);
      generatedReferences.push(body.paymentReference);
      lastInitTransactionBody = body;
      return new Response(
        JSON.stringify({ responseBody: { transactionReference: `TXN-${body.paymentReference}`, checkoutUrl: `https://sandbox.monnify.com/checkout/${body.paymentReference}` } }),
        { status: 200 }
      );
    }
    if (u === 'https://api.monnify.com/api/v1/merchant/bank-transfer/init-payment') {
      // The old account-only flow -- must never be called again from the
      // checkout-link path this replaced it with.
      bankTransferCallCount += 1;
      return new Response(JSON.stringify({ responseBody: { accountNumber: '1234567890' } }), { status: 200 });
    }
    return realFetch(url, opts);
  };

  try {
    await import('../server.js');
    const { pool } = await import('../lib/db.js');
    const flow = await import('../engine/flow.js');

    for (let i = 0; i < 50; i++) {
      try { await fetch(`${process.env.PUBLIC_URL}/`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }

    const { rows: bizRows } = await pool.query(`select id from business limit 1`);
    await pool.query(
      `insert into payment_config (business_id, provider) values ($1, 'monnify') on conflict (business_id) do update set provider = 'monnify'`,
      [bizRows[0].id]
    );

    const { rows: prodRows } = await pool.query(`select id, price from product where name = 'Jollof Rice and Chicken'`);
    const jollof = prodRows[0];
    const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012369201', channel: 'whatsapp' });
    const { rows: orderRows } = await pool.query(
      `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state)
       values ($1, 'REF-MONNIFYLINK', 'pickup', $2, 'new', 'pending', 'confirm_payment') returning *`,
      [customer.id, jollof.price]
    );
    const order = orderRows[0];
    await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order.id, jollof.id, jollof.price]);

    // === 1. sendPaymentInstructions gets a real checkout link, not account details ===
    await flow.sendPaymentInstructions(customer, order);
    const { rows: payLineRows } = await pool.query(
      `select body, trigger from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 3`,
      [customer.id]
    );
    const payLineMsg = payLineRows.find((m) => /button below/i.test(m.body));
    assert(Boolean(payLineMsg), 'the pay message says "using the button below" (Paystack\'s own wording), not "using the account below"');
    assert(!payLineRows.some((m) => /account number/i.test(m.body)), 'no raw account number/bank name ever gets rendered into a message');
    assert(initTransactionCallCount === 1, 'exactly one real Monnify init-transaction call made');
    assert(bankTransferCallCount === 0, 'the old account-only bank-transfer/init-payment endpoint is never called anymore');

    const { rows: orderAfterInit } = await pool.query(`select payment_reference, payment_link_url from "order" where id = $1`, [order.id]);
    assert(orderAfterInit[0].payment_reference === generatedReferences[0], "the order's own payment_reference matches what Monnify was actually given");
    assert(orderAfterInit[0].payment_link_url?.startsWith('https://sandbox.monnify.com/checkout/'), 'a real, tappable checkout link is saved on the order -- same payment_link_url column Paystack uses');

    // Chidera, 2026-09-25: "why isnt customer auto taken back to web chat
    // after payment with monify?" -- same callback_url fix Paystack's own
    // initializePaystackTransaction already had; Monnify's init-transaction
    // call never got the same redirectUrl parameter.
    const token = await flow.ensureMenuToken(customer);
    assert(lastInitTransactionBody?.redirectUrl === `http://localhost:3960/wa/${token}`, `Monnify's own init-transaction call now carries a real redirectUrl back to the web chat (got ${lastInitTransactionBody?.redirectUrl})`);

    // === 2. THE REAL ASK: the real Monnify webhook still auto-confirms payment off that same reference ===
    const reference = orderAfterInit[0].payment_reference;
    const webhookBody = JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION', eventData: { paymentReference: reference, amountPaid: Number(jollof.price) } });
    const signature = crypto.createHmac('sha512', process.env.MONNIFY_SECRET_KEY).update(webhookBody).digest('hex');
    const webhookRes = await fetch(`${process.env.PUBLIC_URL}/webhook/monnify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'monnify-signature': signature },
      body: webhookBody,
    });
    assert(webhookRes.status === 200, 'the real Monnify webhook is accepted');
    await wait(300);

    const { rows: orderAfterPay } = await pool.query(`select status, engine_state from "order" where id = $1`, [order.id]);
    assert(orderAfterPay[0].status === 'preparation', 'the order auto-confirms from the real Monnify webhook, exactly as before -- only HOW the customer pays changed, not the auto-confirm mechanism itself');

    // === 3. A wrong/unsigned webhook is still flatly rejected ===
    const badRes = await fetch(`${process.env.PUBLIC_URL}/webhook/monnify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'monnify-signature': 'not-a-real-signature' },
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
