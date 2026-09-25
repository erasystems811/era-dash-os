// Chidera, 2026-09-25: "can in house have its own dashboard, with cash
// collected." GET /api/dinein/stats/today (routes/dinein.js) -- always
// dine-in-scoped regardless of who's viewing, unlike /orders/stats/today's
// own in_house branch (only filters for a staff account whose OWN
// work_area happens to be in_house). Cherry-picked from main (commit
// 9479ed1) onto web-chat-sandbox-test, isolated from that same commit's
// other two fixes (payment-received button, cancel-order-closes-table) at
// Chidera's request -- this is the standalone coverage for just this piece.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3975';
process.env.SESSION_SECRET = 'testsecret';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3975';

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
  const authed = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), cookie } });

  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length
    ? existingBranch[0].id
    : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;
  const { rows: tableRows } = await pool.query(`insert into restaurant_table (branch_id, label, qr_token) values ($1, '41', 'qrstats41') returning id`, [branchId]);
  const table = tableRows[0];
  const { rows: custRows } = await pool.query(`insert into customers (phone_number, branch_id) values ('2348011110041', $1) returning id`, [branchId]);
  const customerId = custRows[0].id;

  async function makeOrder({ total, paymentMethod, paymentStatus, cashCollected, channel = 'dinein' }) {
    const { rows } = await pool.query(
      `insert into "order" (customer_id, reference, branch_id, channel, table_id, fulfilment_type, payment_mode, engine_state, status, total, payment_method, payment_status, cash_collected)
       values ($1, $2, $3, $4, $5, 'table', 'at_table', 'fulfilment', 'preparation', $6, $7, $8, $9) returning *`,
      [customerId, `REF-STATS-${Math.random().toString(36).slice(2, 8)}`, branchId, channel, channel === 'dinein' ? table.id : null, total, paymentMethod, paymentStatus, cashCollected || null]
    );
    return rows[0];
  }

  // A cash-paid dine-in order today.
  await makeOrder({ total: 4700, paymentMethod: 'cash', paymentStatus: 'confirmed', cashCollected: 4700 });
  // A card-paid dine-in order today.
  await makeOrder({ total: 3500, paymentMethod: 'card', paymentStatus: 'confirmed' });
  // A dine-in order paid via a real Paystack link -- no payment_method set
  // at all (Mark-paid's manual flow is the only thing that ever sets it) --
  // must fall into "other", not silently vanish from the total.
  await makeOrder({ total: 2200, paymentMethod: null, paymentStatus: 'confirmed' });
  // An unpaid dine-in order today -- must NOT count toward collected.
  await makeOrder({ total: 9999, paymentMethod: null, paymentStatus: 'pending' });
  // A real ONLINE order today, same amount pattern -- must never leak into
  // dine-in's own stats, the entire point of this not reusing
  // /orders/stats/today's own in_house branch.
  await makeOrder({ total: 50000, paymentMethod: 'cash', paymentStatus: 'confirmed', channel: 'whatsapp' });

  const res = await authed(`${BASE}/api/dinein/stats/today`);
  const stats = await res.json();
  assert(res.status === 200, 'the route is accepted for a real staff session');
  assert(stats.collected === 4700 + 3500 + 2200, `collected sums only the confirmed dine-in orders, excluding the pending one and the online one (got ${stats.collected})`);
  assert(stats.cash === 4700, 'cash figure matches only the real cash_collected amount');
  assert(stats.card === 3500, 'card figure matches only the card-tagged order');
  assert(stats.transfer === 0, 'no transfer-paid order exists yet');
  assert(stats.other === 2200, 'the link-paid order (no payment_method set) correctly falls into "other", not lost');
  assert(stats.cash + stats.card + stats.transfer + stats.other === stats.collected, 'the four figures always sum to exactly collected -- no drift');
  assert(stats.tablesServed === 1, 'tablesServed counts the one distinct table, not the three dine-in orders on it');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
