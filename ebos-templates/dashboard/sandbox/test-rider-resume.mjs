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

  console.log('=== Once delivered, a later /me must stop restoring it ===');
  await pool.query(`update delivery_assignment set status = 'DELIVERED' where offer_id = $1`, [offerId]);
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
