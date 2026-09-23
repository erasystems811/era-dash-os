// Chidera, 2026-09-20: "when there is a paystack already no need for
// invoice to have account number" -- routes/documents.js's PAYMENT
// INFORMATION box used to always show bank details whenever business.
// bank_name was set, even for an order with a real, unexpired Paystack
// link (showPayNow) already available. Confirms an order WITH a real
// payment_link_url shows "Pay now" and never the account number, and an
// order with none falls back to the account number exactly as before.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3916';
process.env.SESSION_SECRET = 'testsecret';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3916';

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

  await pool.query(`update business set bank_name='GTBank', bank_account_number='0123456789', bank_account_name='Test Biz'`);
  const { rows: custRows } = await pool.query(`insert into customers (phone_number) values ('2348011112222') returning id`);
  const customerId = custRows[0].id;

  const { rows: withLink } = await pool.query(
    `insert into "order" (customer_id, reference, total, payment_link_url, payment_status) values ($1, 'REF1', 1000, 'https://paystack.com/pay/abc', 'pending') returning id`,
    [customerId]
  );
  const { rows: withoutLink } = await pool.query(
    `insert into "order" (customer_id, reference, total, payment_status) values ($1, 'REF2', 1000, 'pending') returning id`,
    [customerId]
  );
  const { rows: alreadyPaid } = await pool.query(
    `insert into "order" (customer_id, reference, total, payment_link_url, payment_status) values ($1, 'REF3', 1000, 'https://paystack.com/pay/def', 'confirmed') returning id`,
    [customerId]
  );

  const res1 = await fetch(`${BASE}/documents/invoice/${withLink[0].id}`);
  const html1 = await res1.text();
  assert(res1.status === 200 && html1.includes('Pay now') && !html1.includes('Account:'), 'order WITH a real Paystack link shows Pay now, never the account number');

  const res2 = await fetch(`${BASE}/documents/invoice/${withoutLink[0].id}`);
  const html2 = await res2.text();
  assert(res2.status === 200 && !html2.includes('Pay now') && html2.includes('Account:'), 'order with NO Paystack link still falls back to the account number');

  const res3 = await fetch(`${BASE}/documents/invoice/${alreadyPaid[0].id}`);
  const html3 = await res3.text();
  assert(res3.status === 200 && !html3.includes('Pay now'), 'an already-confirmed order does not show a stale Pay now button');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
