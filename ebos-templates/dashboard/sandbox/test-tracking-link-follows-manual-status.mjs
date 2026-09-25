// Chidera, 2026-09-25: "whenever an actual rider doesn't accept order, the
// tracking link marks it as could not be completed but let the tracking
// link be able to update based on if the stage is manually updated as
// well." A stuck OPEN offer nobody accepted gets dismissed from staff's
// own Needs Attention queue (routes/delivery.js's /offers/:id/cancel,
// "the order itself is untouched -- staff handle the actual delivery
// outside this system from here") -- the customer's tracking link used to
// freeze on "This delivery could not be completed. Please contact us."
// forever after that, even once staff actually got the order moving again
// through the normal status pipeline (Mark in delivery -> Delivered).
//
// Set EBOS_TEST_PGLITE=1 to run against a real, throwaway, in-process
// Postgres (see lib/db.js) -- schema.sql is applied automatically.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3939';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3939';

const BASE = 'http://localhost:3939';

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

  const { rows: custRows } = await pool.query(
    `insert into customers (name, phone_number, channel, address) values ('Manual Track Cust', '2348050005555', 'whatsapp', '5 Test Close') returning id`
  );
  const { rows: zoneRows } = await pool.query(
    `insert into delivery_zone (name, customer_fee, rider_payout) values ('Test Zone', 1500, 1000) returning id`
  );
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, status, delivery_zone_id) values ($1, 'TRACK-MANUAL-1', 'delivery', 'ready', $2) returning id`,
    [custRows[0].id, zoneRows[0].id]
  );
  const orderId = orderRows[0].id;
  const { rows: offerRows } = await pool.query(
    `insert into delivery_offer (order_id, zone_id, status, tracking_token) values ($1, $2, 'OPEN', 'track-manual-token-1') returning id`,
    [orderId, zoneRows[0].id]
  );

  // === Stage 1: nobody accepts -- staff dismisses it from Needs Attention (routes/delivery.js's /offers/:id/cancel) ===
  await pool.query(`update delivery_offer set status = 'CANCELLED' where id = $1`, [offerRows[0].id]);

  const stuckStatus = await (await fetch(`${BASE}/track/track-manual-token-1/status`)).json();
  assert(stuckStatus.failed === true, 'genuinely stuck (offer cancelled, order still just "ready") correctly shows failed');

  // The "could not be completed" string is also part of the page's own
  // static client-side JS source (renderBody, for the live-poll refresh)
  // -- that literal text is present in every render regardless of runtime
  // state, so checking the whole HTML would always false-positive. The
  // server-rendered body (trackingBody, before the <script> tag) is what
  // actually reflects the current state.
  const stuckHtml = (await (await fetch(`${BASE}/track/track-manual-token-1`)).text()).split('<script>')[0];
  assert(/could not be completed/i.test(stuckHtml), 'the page itself shows the contact-us message while genuinely stuck');

  // === Stage 2: staff handled it manually and hit "Mark in delivery" -- the order moves on with no assignment row at all ===
  await pool.query(`update "order" set status = 'in_transit' where id = $1`, [orderId]);

  const inTransitStatus = await (await fetch(`${BASE}/track/track-manual-token-1/status`)).json();
  assert(inTransitStatus.failed === false, 'the SAME link stops showing failed the moment the order actually moves again');
  assert(inTransitStatus.stageIndex >= 2, `expects real progress reflected (picked up/on the way or later), got stageIndex ${inTransitStatus.stageIndex}`);

  const inTransitHtml = (await (await fetch(`${BASE}/track/track-manual-token-1`)).text()).split('<script>')[0];
  assert(!/could not be completed/i.test(inTransitHtml), 'the page no longer shows the dead "contact us" message');

  // === Stage 3: staff marks it completed ===
  await pool.query(`update "order" set status = 'completed' where id = $1`, [orderId]);

  const completedStatus = await (await fetch(`${BASE}/track/track-manual-token-1/status`)).json();
  assert(completedStatus.failed === false, 'still not failed once genuinely delivered');
  assert(completedStatus.stageIndex === 4, `expects the final "Delivered" stage, got ${completedStatus.stageIndex}`);

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
