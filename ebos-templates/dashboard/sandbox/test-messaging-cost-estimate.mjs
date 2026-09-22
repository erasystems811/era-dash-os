// Chidera, 2026-09-22: "meta will start charging 14 naira per message on
// october first and that leaves me at a very vulnurable situation cause
// my bot can end up texting lots of messages for just one order if
// customer keeps typing back and forth cause you cant predetermine human
// behaviour." Verifies routes/api.js's GET /monitor/messaging-cost turns
// that fear into a real, checkable number: outbound WhatsApp messages per
// order over a real window, and what October 1 would cost at today's
// volume -- not just that the endpoint returns 200.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3941';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3941';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3941';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348011110001', channel: 'whatsapp' });
  const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);
  const product = prodRows[0];
  const { rows: existingBranch } = await pool.query(`select id from branch limit 1`);
  const branchId = existingBranch.length ? existingBranch[0].id : (await pool.query(`insert into branch (name, address) values ('Main', '1 Test St') returning id`)).rows[0].id;

  // === 1. No real activity yet -- must not divide by zero or blow up ===
  const emptyRes = await fetch(`${BASE}/api/monitor/messaging-cost`, { headers: { 'x-era-admin-token': 'testadmin' } });
  const empty = await emptyRes.json();
  assert(emptyRes.status === 200, 'endpoint responds even with zero orders/messages');
  assert(empty.avgMessagesPerOrder === null, 'zero orders reports null average, not Infinity/NaN');

  // === 2. Wrong/missing admin token is rejected, same trust boundary as every other ERA-admin route ===
  const noAuthRes = await fetch(`${BASE}/api/monitor/messaging-cost`);
  assert(noAuthRes.status === 403, 'no x-era-admin-token header is rejected');

  // === 3. Seed real activity: 21 orders, 1050 outbound WhatsApp messages (deliberately past the 1,000 free tier) ===
  for (let i = 0; i < 21; i++) {
    await pool.query(
      `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state)
       values ($1, $2, 'pickup', $3, 'new', 'pending', 'confirm_payment')`,
      [customer.id, `REF-COST-${i}`, product.price]
    );
  }
  await pool.query(
    `insert into message (customer_id, direction, channel, sender, body)
     select $1, 'outbound', 'whatsapp', 'bot', 'msg ' || gs from generate_series(1, 1050) gs`,
    [customer.id]
  );
  // Must NOT be counted: inbound (customer never billed) and a non-WhatsApp outbound channel.
  await pool.query(`insert into message (customer_id, direction, channel, sender, body) values ($1, 'inbound', 'whatsapp', 'customer', 'hi')`, [customer.id]);
  await pool.query(`insert into message (customer_id, direction, channel, sender, body) values ($1, 'outbound', 'instagram', 'bot', 'hi')`, [customer.id]);
  // One WhatsApp number on record for this business.
  await pool.query(
    `insert into branch_channel (branch_id, channel, phone_number_id) values ($1, 'whatsapp', 'PNI-TEST-1')
     on conflict (branch_id, channel) do update set phone_number_id = excluded.phone_number_id`,
    [branchId]
  );

  const res = await fetch(`${BASE}/api/monitor/messaging-cost`, { headers: { 'x-era-admin-token': 'testadmin' } });
  const data = await res.json();
  assert(data.outboundWhatsapp === 1050, `counts exactly the outbound WhatsApp messages, ignoring inbound/other channels (got ${data.outboundWhatsapp})`);
  assert(data.orders === 21, `counts orders in the window (got ${data.orders})`);
  assert(data.avgMessagesPerOrder === 50, `1050 messages / 21 orders = 50 exactly (got ${data.avgMessagesPerOrder}) -- this is the number that actually explains the risk`);
  assert(data.whatsappNumbers === 1, 'one WhatsApp number on record for this business');
  assert(data.freeAllowance === 1000, 'first 1,000/month per number stays free (got ' + data.freeAllowance + ')');
  assert(data.billableMessages === 50, `only the 50 messages past the free tier are billable (got ${data.billableMessages})`);
  assert(data.projectedCostNaira === 700, `50 billable messages x NGN14 = NGN700 (got ${data.projectedCostNaira})`);

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
