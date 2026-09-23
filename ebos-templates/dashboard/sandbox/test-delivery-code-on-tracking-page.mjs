// Chidera, 2026-09-23: "there is also the rider tracking message, usually
// they send 2 one with normal link and one to track ride so now i need it
// to be 1, the code should be in the link." Before this, an own_riders
// delivery order got TWO real WhatsApp messages for tracking: one when the
// offer broadcasts (notifyDeliverySearching, "we're finding you a rider,
// track it here"), and a SECOND one the instant a rider accepted
// (notifyDeliveryAssigned, "your order is on its way... here's your
// code"), even though both pointed at the exact same /track/:token link.
//
// Fix: notifyDeliveryAssigned (the second real send) is removed entirely.
// The tracking page (routes/tracking.js, already live-polling its own
// status every 12s) now also carries the delivery_code once a rider's
// assigned -- the SAME link the customer already has shows it, live, no
// second message needed.
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

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  assert(flow.notifyDeliveryAssigned === undefined, 'notifyDeliveryAssigned is gone -- no second real WhatsApp send exists to call any more');

  const { rows: custRows } = await pool.query(
    `insert into customers (name, phone_number, channel, address) values ('Jane Customer', '2348050002222', 'whatsapp', '12 Example Street, Wuse') returning id`
  );
  const customerId = custRows[0].id;
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, status) values ($1, 'TEST-TRACK-1', 'delivery', 'delivery') returning id`,
    [customerId]
  );
  const orderId = orderRows[0].id;
  const { rows: zoneRows } = await pool.query(
    `insert into delivery_zone (name, customer_fee, rider_payout) values ('Wuse', 1500, 1000) returning id`
  );
  const zoneId = zoneRows[0].id;
  const { rows: offerRows } = await pool.query(
    `insert into delivery_offer (order_id, zone_id, status, tracking_token) values ($1, $2, 'OPEN', 'test-track-token-1') returning id`,
    [orderId, zoneId]
  );
  const offerId = offerRows[0].id;

  // === Stage 1: still searching for a rider -- no code exists yet, must not appear ===
  const searchingRes = await fetch(`${BASE}/track/test-track-token-1`);
  assert(searchingRes.status === 200, 'the tracking page loads while still searching for a rider');
  const searchingHtml = await searchingRes.text();
  // The "Give this code..." string is also part of the page's own static
  // client-side JS source (renderBody, for the live-poll refresh) -- that
  // literal text is present in every render regardless of runtime state,
  // so checking for it directly would always false-positive. The initial
  // SERVER-rendered body (trackingBody, before the <script> tag) is what
  // actually reflects "no code yet" -- its own wrapper div only appears
  // when deliveryCode is truthy.
  const searchingBodyOnly = searchingHtml.split('<script>')[0];
  assert(!searchingBodyOnly.includes('class="code"'), 'no code box rendered before a rider is even assigned -- nothing to give yet');

  const searchingStatus = await (await fetch(`${BASE}/track/test-track-token-1/status`)).json();
  assert(searchingStatus.deliveryCode === null, 'the status JSON also carries no code yet');

  // === Stage 2: a rider accepts (same DB shape the real /offers/:id/accept route writes) ===
  const { rows: riderRows } = await pool.query(
    `insert into rider (name, phone, status) values ('John Rider', '2348030009999', 'on_duty') returning id`
  );
  const riderId = riderRows[0].id;
  await pool.query(
    `insert into delivery_assignment (offer_id, order_id, rider_id, status, delivery_code, tracking_token)
     values ($1, $2, $3, 'ASSIGNED', '4821', 'test-track-token-1')`,
    [offerId, orderId, riderId]
  );

  const assignedRes = await fetch(`${BASE}/track/test-track-token-1`);
  const assignedHtml = await assignedRes.text();
  assert(/Give this code to your rider/i.test(assignedHtml), 'the SAME link now shows the code, live, once a rider is assigned');
  assert(assignedHtml.includes('4821'), 'the real delivery code appears on the page');
  assert(/John/i.test(assignedHtml), "the rider's own card still shows too, same as before this fix");

  const assignedStatus = await (await fetch(`${BASE}/track/test-track-token-1/status`)).json();
  assert(assignedStatus.deliveryCode === '4821', 'the polling JSON endpoint (what the page\'s own live-refresh reads) also carries the real code');

  // === Confirm no real WhatsApp message went out AT ALL for this stage
  // transition -- the whole point of this fix. ===
  const { rows: outboundMsgs } = await pool.query(
    `select count(*)::int as n from message where customer_id = $1 and direction = 'outbound' and channel = 'whatsapp'`,
    [customerId]
  );
  assert(outboundMsgs[0].n === 0, 'assigning a rider sends ZERO real WhatsApp messages now -- the customer never even got the first "searching" one here (seeded directly), and assignment itself adds none either');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
