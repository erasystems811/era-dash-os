// Chidera, 2026-09-25: "i need a place where cash collected history will be
// logged with amount and name of staff and table name too and somehow let
// it be flagged if there is an imbalance -- for accountability sake."
// Follow-up, same day: "online delivery never use cash or pos they use
// monnify or paystack or manual confirmation, this is only about dine in."
// Verifies GET /api/cash-log: a full-cash dine-in mark-paid shows up with
// the real staff name, table, and amount, flagged "Full"; a shortfall
// (staff cash short + closed anyway) shows up flagged as an imbalance with
// the real shortfall amount; and a card payment never appears at all
// (never cash, nothing to reconcile).
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3950';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3950';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3950';

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
  const authed = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), 'Content-Type': 'application/json', cookie } });

  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '7', 'qrtest7') returning id`, [branchId]);
  const table = tableRows[0];
  const { rows: sessionRows } = await pool.query(`insert into table_session (table_id, branch_id) values ($1, $2) returning id`, [table.id, branchId]);
  const { rows: prodRows } = await pool.query(`insert into product (name, price, category, branch_id) values ('Jollof Rice', 3500, 'MAINS', $1) returning id`, [branchId]);
  const { rows: custRows } = await pool.query(`insert into customers (phone_number, channel) values ('2348099990011', 'whatsapp') returning *`);
  const customer = custRows[0];

  async function makeOrder(reference) {
    const { rows } = await pool.query(
      `insert into "order" (customer_id, table_id, session_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
       values ($1, $2, $3, $4, 'table', 3500, 'preparation', 'pending', 'fulfilment', 'dinein') returning id`,
      [customer.id, table.id, sessionRows[0].id, reference]
    );
    await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, 3500)`, [rows[0].id, prodRows[0].id]);
    return rows[0].id;
  }

  // === 1. Full cash payment shows up, table + staff name real, not flagged ===
  const order1 = await makeOrder('REF-CASHLOG-1');
  await authed(`${BASE}/api/orders/${order1}/payment-method`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'cash', cashCollected: 3500 }) });

  let log = await (await authed(`${BASE}/api/cash-log`)).json();
  let entry1 = log.find((e) => e.orderReference === 'REF-CASHLOG-1');
  assert(!!entry1, 'the full-cash payment shows up in the cash log');
  assert(entry1?.tableLabel === '7', `the real table label is shown (got "${entry1?.tableLabel}")`);
  assert(entry1?.staffName === 'Chidera Owner', `the real staff name is shown (got "${entry1?.staffName}")`);
  assert(entry1?.collected === 3500, `the full amount collected is shown (got ${entry1?.collected})`);
  assert(entry1?.imbalance === false, 'a fully-paid entry is not flagged as an imbalance');

  // === 2. Shortfall + closed anyway shows up, flagged with the real shortfall ===
  const order2 = await makeOrder('REF-CASHLOG-2');
  await authed(`${BASE}/api/orders/${order2}/payment-method`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'cash', cashCollected: 2000, closeAnyway: true }) });

  log = await (await authed(`${BASE}/api/cash-log`)).json();
  let entry2 = log.find((e) => e.orderReference === 'REF-CASHLOG-2');
  assert(!!entry2, 'the shortfall-but-closed-anyway payment shows up in the cash log');
  assert(entry2?.collected === 2000, `the real (short) amount actually collected is shown (got ${entry2?.collected})`);
  assert(entry2?.shortfall === 1500, `the real shortfall is shown (got ${entry2?.shortfall})`);
  assert(entry2?.imbalance === true, 'a shortfall entry is flagged as an imbalance');

  // === 3. Card payment never appears -- never cash, nothing to reconcile ===
  const order3 = await makeOrder('REF-CASHLOG-3');
  await authed(`${BASE}/api/orders/${order3}/payment-method`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'card' }) });

  log = await (await authed(`${BASE}/api/cash-log`)).json();
  assert(!log.some((e) => e.orderReference === 'REF-CASHLOG-3'), 'a card payment never appears in the cash log');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
