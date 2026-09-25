// Chidera, 2026-09-21, real live investigation: "THE IDEA IS FOR IT TO
// APROVE AUTO CONFIRME HOW PAYSTACK DOES AND SAME FLOW OF CUSTOMER TAPING
// IVE SENT MONEY" -- confirmed live against a real Moniepoint account
// that POST channel.moniepoint.com/v1/transactions ("Push Payment
// Request") generates a real, ONE-TIME account per payment, and that
// GET /v1/transactions/merchants/{reference} (the SAME reference) reports
// back actualAmount once a matching transfer clears -- null the whole
// time it's pending or expired. The pay page's own "I've sent it" tap
// checks that directly and auto-confirms instantly if it's already
// there, only falling back to the existing staff-alert path (sandbox/
// test-online-pos-payment.mjs, test-dinein-pos-payment.mjs) when it
// isn't.
//
// Chidera, 2026-09-21, real live report AFTER the above: tried quoting
// the static account instead (nubanAccount) to sidestep a real KYC
// rejection -- but confirmed live that Moniepoint's own tracking only
// ever follows the specific one-time accountNumber, never the static
// one (an ordinary transfer to the static account is never even seen as
// a "POS transaction" on their side at all -- their webhook confirmed
// dead for the same reason). So it's back to the one-time accountNumber
// -- the only thing that was ever going to work -- but now hidden behind
// a short "preparing" delay (READY_DELAY_MS, dynamic_account_ready_at)
// before ever being shown to a customer, since the KYC rejection is
// consistent with a real NIBSS propagation delay for brand-new virtual
// accounts. "YES" (go ahead and build it this way). Also confirmed live:
// a request expires ~5 minutes after creation (server-side TTL kept at
// 4, DYNAMIC_ACCOUNT_TTL_MS), and a transfer that lands after expiry
// still reaches the real account safely -- Moniepoint just stops auto-
// matching it, which is exactly why a "not paid yet" check here is never
// treated as a failure.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3937';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3937';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3937';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

// Mocked exactly like the real account behaves: PENDING push, and a
// separate map the test flips to simulate a transfer actually clearing --
// same shape confirmed live (actualAmount null until it clears). Maps to
// the actualAmount (kobo) Moniepoint reports for that reference, so short
// transfers can be simulated too, not just "paid or not".
const paidReferences = new Map();
let pushCallCount = 0;

async function main() {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u === 'https://channel.moniepoint.com/v1/auth') {
      return new Response(JSON.stringify({ accessToken: 'fake-token', tokenType: 'bearer', expiresIn: 86399 }), { status: 200 });
    }
    if (u === 'https://channel.moniepoint.com/v1/transactions') {
      pushCallCount += 1;
      return new Response('', { status: 202 });
    }
    if (u.startsWith('https://channel.moniepoint.com/v1/transactions/merchants/')) {
      const ref = decodeURIComponent(u.split('/').pop());
      const actualAmount = paidReferences.has(ref) ? paidReferences.get(ref) : null;
      return new Response(
        JSON.stringify({
          merchantReference: ref,
          transactionReference: `INTEGRATIONS__123__${ref}`,
          accountNumber: '5703718501',
          accountName: 'MAD PARTY ENT  ENTERPRISE',
          nubanAccount: '5103262837',
          processingStatus: actualAmount != null ? 'SUCCESSFUL' : 'PENDING',
          actualAmount,
        }),
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
    await pool.query(
      `insert into pos_sync_config (business_id, enabled, provider, client_id, client_secret, terminal_serial)
       values ($1, true, 'moniepoint', 'test-client-id', 'test-client-secret', 'C54P008D04914079')
       on conflict (business_id) do update set client_id = excluded.client_id, client_secret = excluded.client_secret, terminal_serial = excluded.terminal_serial, enabled = true`,
      [bizRows[0].id]
    );
    await pool.query(`insert into payment_config (business_id, provider) values ($1, 'pos') on conflict (business_id) do update set provider = 'pos'`, [bizRows[0].id]);
    await pool.query(`update business set bank_name = 'Moniepoint MFB', bank_account_number = '5103262837', bank_account_name = 'MAD PARTY ENT ENTERPRISE' where id = $1`, [bizRows[0].id]);
    await pool.query(`insert into staff (name, phone_number, handover_alerts, role) values ('Owner', '2348099990003', true, 'owner')`);

    const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348013330001', channel: 'whatsapp' });
    const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);
    const product = prodRows[0];
    const total = Number(product.price);
    const { rows: orderRows } = await pool.query(
      `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state)
       values ($1, 'REF-DYNPOS', 'pickup', $2, 'new', 'pending', 'confirm_payment') returning *`,
      [customer.id, total]
    );
    const order = orderRows[0];
    await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [order.id, product.id, product.price]);
    await flow.sendPaymentInstructions(customer, order);

    const { rows: paymentRows } = await pool.query(`select * from order_payment where order_id = $1`, [order.id]);
    const payment = paymentRows[0];

    // === 1. ensureDynamicPosAccount generates a real, one-time account, with a ready-delay ===
    const dynamic1 = await flow.ensureDynamicPosAccount(payment);
    assert(dynamic1?.accountNumber === '5703718501', 'a real, one-time account number is generated for this exact payment');
    assert(pushCallCount === 1, 'exactly one push request made to Moniepoint for it');
    const { rows: afterPush1 } = await pool.query(`select dynamic_account_number, dynamic_account_expires_at, dynamic_account_ready_at from order_payment where id = $1`, [payment.id]);
    assert(afterPush1[0].dynamic_account_number === '5703718501', 'the dynamic account is saved on the payment row');
    assert(new Date(afterPush1[0].dynamic_account_expires_at) > new Date(), 'a real future expiry is stored');
    assert(new Date(afterPush1[0].dynamic_account_ready_at) > new Date(), 'a real future ready-at is stored -- not payable the instant it is generated');

    // === 2. Reused within its TTL window -- no second push, no re-flashing the physical terminal for no reason ===
    const dynamic2 = await flow.ensureDynamicPosAccount({ ...payment, ...afterPush1[0] });
    assert(dynamic2?.accountNumber === '5703718501', 'the cached account is returned on a second call');
    assert(pushCallCount === 1, 'still only ONE push call -- an unexpired dynamic account is reused, not regenerated');

    // === 3. The real pay page hides the account behind "preparing" while not yet ready -- "KYC registration is incomplete" was real, live ===
    const { rows: tokenRows } = await pool.query(`select menu_token from customers where id = $1`, [customer.id]);
    const token = tokenRows[0].menu_token;
    const payPageHtmlNotReady = await (await fetch(`${BASE}/m/${token}/pay`)).text();
    // The account number is still embedded as page DATA (client-side JS
    // decides what to render, same as everywhere else on this page) --
    // what actually matters is that it is NOT rendered into the visible
    // transferBox markup itself, which stays an empty shell until the
    // client-side ready check fills it in.
    assert(payPageHtmlNotReady.includes('<div class="transferBox" id="transferBox"></div>'), 'the visible transferBox starts empty -- not server-rendered with the account while still preparing');
    assert(payPageHtmlNotReady.includes('DYNAMIC_READY_AT'), 'the ready-at timestamp is on the page for the client-side countdown');

    // Ready now -- simulate the ~60s delay elapsing.
    await pool.query(`update order_payment set dynamic_account_ready_at = now() - interval '1 second' where id = $1`, [payment.id]);
    const payPageHtml = await (await fetch(`${BASE}/m/${token}/pay`)).text();
    assert(payPageHtml.includes('5703718501'), 'once ready, the pay page shows the real dynamic account, not the static business one');
    assert(!payPageHtml.includes('5103262837'), 'the static account number is NOT shown once a dynamic one exists');
    assert(payPageHtml.includes('expiryTimer'), 'the 4-minute countdown timer is on the page');
    assert(pushCallCount === 1, 'becoming ready did not trigger a second push -- same already-generated account, just now past its ready-at');

    // === 4. checkMoniepointPaymentPaid -- not paid yet ===
    const paidBefore = await flow.checkMoniepointPaymentPaid(payment);
    assert(paidBefore === false, 'reports not paid while Moniepoint still shows no actualAmount');

    // === 5. "I've sent it" tap BEFORE the money actually clears -- falls back to the existing staff alert, exactly like before this feature ===
    const claimLogsBefore = [];
    const originalLog = console.log;
    console.log = (...args) => { claimLogsBefore.push(args.join(' ')); originalLog(...args); };
    await fetch(`${BASE}/m/${token}/pay/claim`, { method: 'POST' });
    console.log = originalLog;
    const { rows: stillPending } = await pool.query(`select status from order_payment where id = $1`, [payment.id]);
    assert(stillPending[0].status === 'pending', 'tapping before the transfer clears does NOT auto-confirm anything');
    assert(claimLogsBefore.some((l) => l.includes('2348099990003') && l.includes('POS transfer')), 'staff still gets the existing fallback alert when Moniepoint shows nothing yet');

    // === 6a. A SHORT transfer clears (bank fee, mistyped amount) -- must NOT be reported as paid ===
    const expectedKobo = Math.round(Number(payment.amount) * 100);
    paidReferences.set(payment.reference, expectedKobo - 100);
    const paidShort = await flow.checkMoniepointPaymentPaid(payment);
    assert(paidShort === false, 'a transfer for less than what is owed is NOT reported as paid');

    // === 6b. The real transfer clears for the FULL amount -- tap again, THIS TIME it auto-confirms instantly, no staff step ===
    paidReferences.set(payment.reference, expectedKobo);
    const paidAfter = await flow.checkMoniepointPaymentPaid(payment);
    assert(paidAfter === true, 'reports paid once Moniepoint shows actualAmount covering the full amount owed');

    const claimLogsAfter = [];
    console.log = (...args) => { claimLogsAfter.push(args.join(' ')); originalLog(...args); };
    const claimRes2 = await fetch(`${BASE}/m/${token}/pay/claim`, { method: 'POST' });
    console.log = originalLog;
    assert(claimRes2.status === 200, 'the second tap is accepted');
    const { rows: confirmedNow } = await pool.query(`select status, confirmed_at from order_payment where id = $1`, [payment.id]);
    assert(confirmedNow[0].status === 'confirmed' && confirmedNow[0].confirmed_at, 'THE REAL ASK: tapping "I\'ve sent it" auto-confirms instantly once Moniepoint shows it paid -- how Paystack does it');
    assert(!claimLogsAfter.some((l) => l.includes('2348099990003') && l.includes('POS transfer')), 'no staff alert sent this time -- it auto-confirmed, nothing for a person to check');
    assert(claimLogsAfter.some((l) => l.includes('2348013330001') && (l.includes('Payment received') || l.includes('receipt'))), 'the customer gets their own real payment-received message, same as any other confirm path');

    console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
    process.exit(process.exitCode === 1 ? 1 : 0);
  } finally {
    global.fetch = realFetch;
  }
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
