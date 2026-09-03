#!/usr/bin/env node
// Regression test for a real bug (Chidera's report, 2026-09-03): "john
// refresh his page and went off duty?? what of his existing ride he was
// on?" -- routes/rider.js's /me used to just echo back the login-time
// session object ({id, name, phone}, no status), so the client always
// defaulted a missing status to 'off_duty' on every refresh, and an
// in-progress delivery (plain React state, nothing server-side to
// restore it from) vanished the same way. Fixed by loadRiderState()
// reading the rider's real status and any in-progress assignment
// straight from the database on every /me call.
//
// Set EBOS_TEST_PGLITE=1 to run against a real, throwaway, in-process
// Postgres (see lib/db.js) -- schema.sql is applied automatically.
import { pool } from '../lib/db.js';
import { loadRiderState } from '../routes/rider.js';

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
  const { rows: riderRows } = await pool.query(
    `insert into rider (name, phone, status) values ('John Rider', '2348030009999', 'on_duty') returning id`
  );
  const riderId = riderRows[0].id;

  console.log('=== A rider on duty with no active delivery ===');
  await check('status reported as on_duty, no active delivery', async () => {
    const state = await loadRiderState(riderId);
    assert(state.rider.status === 'on_duty', `expected on_duty, got ${state.rider.status}`);
    assert(state.active === null, 'expected no active delivery');
  });

  console.log('=== A rider mid-delivery (ASSIGNED) ===');
  const { rows: custRows } = await pool.query(
    `insert into customers (name, phone_number, channel, address) values ('Jane Customer', '2348050001111', 'manual', '12 Example Street, Wuse') returning id`
  );
  const customerId = custRows[0].id;
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, status)
     values ($1, 'TEST-0001', 'delivery', 'delivery') returning id`,
    [customerId]
  );
  const orderId = orderRows[0].id;
  const { rows: zoneRows } = await pool.query(
    `insert into delivery_zone (name, customer_fee, rider_payout) values ('Wuse', 1500, 1000) returning id`
  );
  const zoneId = zoneRows[0].id;
  const { rows: offerRows } = await pool.query(
    `insert into delivery_offer (order_id, zone_id, status, tracking_token) values ($1, $2, 'CLAIMED', 'test-token-1') returning id`,
    [orderId, zoneId]
  );
  const offerId = offerRows[0].id;
  await pool.query(
    `insert into delivery_assignment (offer_id, order_id, rider_id, status, delivery_code, tracking_token)
     values ($1, $2, $3, 'PICKED_UP', '1234', 'test-token-1')`,
    [offerId, orderId, riderId]
  );

  await check('a refresh (a fresh /me call) restores the in-progress delivery, not just the status', async () => {
    const state = await loadRiderState(riderId);
    assert(state.rider.status === 'on_duty', 'refreshing must never change duty status by itself');
    assert(state.active !== null, 'expected the in-progress delivery to be restored');
    assert(state.active.assignment.status === 'PICKED_UP', `expected PICKED_UP, got ${state.active.assignment.status}`);
    assert(state.active.offer.zoneName === 'Wuse', `expected zone name Wuse, got ${state.active.offer.zoneName}`);
    assert(state.active.offer.payout === '1000.00' || Number(state.active.offer.payout) === 1000, 'expected the zone payout to carry through');
    assert(state.active.dropoffAddress === '12 Example Street, Wuse', `expected the customer's address, got ${state.active.dropoffAddress}`);
    assert(state.active.customerPhone === '2348050001111', `expected the customer's phone, got ${state.active.customerPhone}`);
  });

  console.log('=== Rider marks picked up: order auto-advances ready -> in_transit ===');
  const { rows: order2Rows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, status) values ($1, 'TEST-0002', 'delivery', 'ready') returning id`,
    [customerId]
  );
  const order2Id = order2Rows[0].id;
  const { rows: offer2Rows } = await pool.query(
    `insert into delivery_offer (order_id, zone_id, status, tracking_token) values ($1, $2, 'CLAIMED', 'test-token-2') returning id`,
    [order2Id, zoneId]
  );
  const offer2Id = offer2Rows[0].id;
  const { rows: assignment2Rows } = await pool.query(
    `insert into delivery_assignment (offer_id, order_id, rider_id, status, delivery_code, tracking_token)
     values ($1, $2, $3, 'ASSIGNED', '5678', 'test-token-2') returning id`,
    [offer2Id, order2Id, riderId]
  );
  const assignment2Id = assignment2Rows[0].id;

  // Mirrors exactly what routes/rider.js's POST /assignments/:id/picked-up
  // does -- Chidera's call, 2026-09-03: "when rider press ive picked up,
  // order is meant to go to in transit automatically."
  await check('marking picked up flips order.status from ready to in_transit', async () => {
    await pool.query(
      `update delivery_assignment set status = 'PICKED_UP', picked_up_at = now() where id = $1 and status = 'ASSIGNED'`,
      [assignment2Id]
    );
    await pool.query(`update "order" set status = 'in_transit' where id = $1 and status = 'ready'`, [order2Id]);
    const { rows } = await pool.query('select status from "order" where id = $1', [order2Id]);
    assert(rows[0].status === 'in_transit', `expected in_transit, got ${rows[0].status}`);
  });

  await check('the ready-only guard is a harmless no-op on a repeat call', async () => {
    // order2 is already in_transit -- a retried request or a rider double
    // tap must never error or move it somewhere unexpected.
    await pool.query(`update "order" set status = 'in_transit' where id = $1 and status = 'ready'`, [order2Id]);
    const { rows } = await pool.query('select status from "order" where id = $1', [order2Id]);
    assert(rows[0].status === 'in_transit', 'a repeat call must be a harmless no-op');
  });

  console.log('=== Once delivered, a later /me must stop restoring it ===');
  // Every assignment this rider has picked up in this fixture run --
  // loadRiderState only ever restores the MOST RECENT non-terminal one, so
  // this has to close out both to actually prove "none of them" restore.
  await pool.query(`update delivery_assignment set status = 'DELIVERED' where rider_id = $1`, [riderId]);
  await check('a completed delivery is not treated as still active', async () => {
    const state = await loadRiderState(riderId);
    assert(state.active === null, 'a DELIVERED assignment must not be restored as active');
  });

  console.log(`\n${passed} checks passed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
