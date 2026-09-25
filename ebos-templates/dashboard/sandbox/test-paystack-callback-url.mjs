// Chidera, 2026-09-23: "when i click pay now and go to pay stack i cant
// see back to chat so it takes me back to main chat which shouldnt." No
// callback_url was ever sent to Paystack's own initialize call, so a
// finished (or cancelled) checkout had nowhere app-specific to send the
// customer back to. Verifies the real request payment.js sends Paystack
// now carries callback_url pointing at the customer's own /wa/:token page
// -- stubs global.fetch rather than hitting Paystack's real API.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PUBLIC_URL = 'https://era-demo.erasystems.com.ng';
process.env.PAYMENT_PROVIDER = 'paystack';
process.env.PAYMENT_SECRET_KEY = 'sk_test_fake';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  const { pool } = await import('../lib/db.js');
  const payment = await import('../engine/payment.js');

  const { rows: customerRows } = await pool.query(
    `insert into customers (phone_number, channel, menu_token) values ('2348012352001', 'whatsapp', 'tok-callback-1') returning *`
  );
  const customer = customerRows[0];
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-CB-1', 'pickup', 3500, 'new', 'pending', 'confirm_payment', 'whatsapp') returning *`,
    [customer.id]
  );
  const order = orderRows[0];

  let capturedBody = null;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('paystack.co/transaction/initialize')) {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ data: { reference: 'PSK-TEST-1', authorization_url: 'https://checkout.paystack.com/fake' } }) };
    }
    return realFetch(url, opts);
  };

  const url = await payment.initializePaystackTransaction({
    order,
    customer,
    amount: 3500,
    callbackUrl: `${process.env.PUBLIC_URL}/wa/${customer.menu_token}`,
  });
  global.fetch = realFetch;

  assert(url === 'https://checkout.paystack.com/fake', 'the real Paystack authorization_url still comes back correctly');
  assert(Boolean(capturedBody), 'the outgoing Paystack request was captured');
  assert(capturedBody?.callback_url === 'https://era-demo.erasystems.com.ng/wa/tok-callback-1', 'and it carries callback_url pointing at this exact customer\'s own chat page');

  // === Omitting callbackUrl (e.g. a surface with no chat page to return
  // to) must not send a broken/empty callback_url -- Paystack itself would
  // reject a malformed one, so it's left out entirely, not sent as ''. ===
  let capturedBody2 = null;
  global.fetch = async (url2, opts2) => {
    if (String(url2).includes('paystack.co/transaction/initialize')) {
      capturedBody2 = JSON.parse(opts2.body);
      return { ok: true, json: async () => ({ data: { reference: 'PSK-TEST-2', authorization_url: 'https://checkout.paystack.com/fake2' } }) };
    }
    return realFetch(url2, opts2);
  };
  await payment.initializePaystackTransaction({ order, customer, amount: 3500 });
  global.fetch = realFetch;
  assert(!('callback_url' in capturedBody2), 'no callbackUrl passed in -- callback_url is left out of the request entirely, not sent malformed');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
