#!/usr/bin/env node
// Regression test for the manual "Ring rider" button (Chidera's ask,
// 2026-09-03, right after "it didnt even ring atall this time"). Covers
// both branches of manuallyRingForRider: an OPEN offer (nobody accepted
// yet -- re-broadcast to the whole fleet) and a CLAIMED one (a specific
// rider already has it -- a direct reminder, never a second broadcast).
//
// Set EBOS_TEST_PGLITE=1 to run against a real, throwaway, in-process
// Postgres (see lib/db.js) -- schema.sql is applied automatically.
import { pool } from '../lib/db.js';
import { manuallyRingForRider } from '../engine/delivery-dispatch.js';

let passed = 0;

async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const { rows: custRows } = await pool.query(
    `insert into customers (name, phone_number, channel, address) values ('Jane Customer', '2348050002222', 'manual', '5 Test Street') returning id`
  );
  const customerId = custRows[0].id;
  const { rows: zoneRows } = await pool.query(
    `insert into delivery_zone (name, customer_fee, rider_payout) values ('Garki', 1500, 1000) returning id`
  );
  const zoneId = zoneRows[0].id;

  console.log('=== No offer exists for this order at all ===');
  const { rows: bareOrderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, status) values ($1, 'RING-0001', 'delivery', 'ready') returning id`,
    [customerId]
  );
  await check('a clear error, not a crash, when nothing has dispatched yet', async () => {
    try {
      await manuallyRingForRider(bareOrderRows[0].id);
      throw new Error('expected manuallyRingForRider to throw');
    } catch (err) {
      assert(/no rider offer/i.test(err.message), `expected a clear "no offer" message, got: ${err.message}`);
    }
  });

  console.log('=== An OPEN offer (nobody has accepted yet) ===');
  const { rows: order2Rows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, status) values ($1, 'RING-0002', 'delivery', 'ready') returning id`,
    [customerId]
  );
  const order2Id = order2Rows[0].id;
  await pool.query(
    `insert into delivery_offer (order_id, zone_id, status, tracking_token) values ($1, $2, 'OPEN', 'ring-token-1')`,
    [order2Id, zoneId]
  );
  await check('an OPEN offer re-broadcasts rather than nudging anyone specific', async () => {
    const result = await manuallyRingForRider(order2Id);
    assert(result.mode === 'broadcast', `expected mode "broadcast", got ${result.mode}`);
  });

  console.log('=== A CLAIMED offer (a specific rider already has it) ===');
  const { rows: riderRows } = await pool.query(
    `insert into rider (name, phone, status, push_subscription)
     values ('Ada Rider', '2348030001234', 'on_duty', '{"endpoint":"https://example.invalid/push","keys":{"p256dh":"x","auth":"y"}}') returning id`
  );
  const riderId = riderRows[0].id;
  const { rows: order3Rows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, status) values ($1, 'RING-0003', 'delivery', 'ready') returning id`,
    [customerId]
  );
  const order3Id = order3Rows[0].id;
  const { rows: offer3Rows } = await pool.query(
    `insert into delivery_offer (order_id, zone_id, status, tracking_token) values ($1, $2, 'CLAIMED', 'ring-token-2') returning id`,
    [order3Id, zoneId]
  );
  await pool.query(
    `insert into delivery_assignment (offer_id, order_id, rider_id, status, delivery_code, tracking_token)
     values ($1, $2, $3, 'ASSIGNED', '9999', 'ring-token-2')`,
    [offer3Rows[0].id, order3Id, riderId]
  );
  await check('a CLAIMED offer nudges the specific rider who has it, not a broadcast', async () => {
    // No VAPID keys configured in this sandbox -- pushReminderToRider's
    // ensureConfigured() short-circuits before ever trying the fake
    // endpoint above, which is the real, honest behaviour to test here:
    // the function must still report WHO it tried to reach.
    const result = await manuallyRingForRider(order3Id);
    assert(result.mode === 'reminder', `expected mode "reminder", got ${result.mode}`);
    assert(result.riderName === 'Ada Rider', `expected Ada Rider, got ${result.riderName}`);
  });

  console.log(`\n${passed} checks passed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
