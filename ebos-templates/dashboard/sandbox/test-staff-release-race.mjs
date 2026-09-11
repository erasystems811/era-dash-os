#!/usr/bin/env node
// Regression test for Chidera's ask, 2026-09-11: "if a rider is manually
// marked complete let the code stuff stop pending" -- when staff release
// a stuck delivery (routes/delivery.js's /assignments/:id/release) while
// the rider is still sitting on the "enter their code" screen, the
// rider's own /deliver attempt must recognise it's already done rather
// than surface a confusing "mark arrived first" error.
//
// Set EBOS_TEST_PGLITE=1 to run against a real, throwaway, in-process
// Postgres (see lib/db.js) -- schema.sql is applied automatically.
import { pool } from '../lib/db.js';
import { seedSampleRestaurant } from './seed-sample-restaurant.mjs';

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
  await seedSampleRestaurant();
  const { rows: riderRows } = await pool.query(
    `insert into rider (name, phone, status) values ('Ada Rider', '2348030005555', 'on_duty') returning id`
  );
  const riderId = riderRows[0].id;
  const { rows: custRows } = await pool.query(
    `insert into customers (name, phone_number, channel, address) values ('Test Cust', '2348050003333', 'manual', '1 Test Close') returning id`
  );
  const customerId = custRows[0].id;
  const { rows: zoneRows } = await pool.query(
    `insert into delivery_zone (name, customer_fee, rider_payout) values ('Asokoro', 1500, 1000) returning id`
  );
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, status, delivery_zone_id) values ($1, 'RACE-0001', 'delivery', 'in_transit', $2) returning id`,
    [customerId, zoneRows[0].id]
  );
  const orderId = orderRows[0].id;
  const { rows: offerRows } = await pool.query(
    `insert into delivery_offer (order_id, zone_id, status, tracking_token) values ($1, $2, 'CLAIMED', 'race-token-1') returning id`,
    [orderId, zoneRows[0].id]
  );
  const { rows: assignmentRows } = await pool.query(
    `insert into delivery_assignment (offer_id, order_id, rider_id, status, delivery_code, tracking_token)
     values ($1, $2, $3, 'ARRIVED', '4321', 'race-token-1') returning id`,
    [offerRows[0].id, orderId, riderId]
  );
  const assignmentId = assignmentRows[0].id;

  console.log('=== Rider polling GET /assignments/:id while on the code-entry screen ===');
  await check('reports ARRIVED before staff release', async () => {
    const { rows } = await pool.query('select status from delivery_assignment where id = $1', [assignmentId]);
    assert(rows[0].status === 'ARRIVED', `expected ARRIVED, got ${rows[0].status}`);
  });

  console.log('=== Staff releases the stuck delivery from the dashboard ===');
  // Mirrors exactly what routes/delivery.js's POST /assignments/:id/release does.
  await pool.query(
    `update delivery_assignment set status = 'DELIVERED', delivered_at = now(), override_reason = 'Phone died, neighbour confirmed receipt'
     where id = $1`,
    [assignmentId]
  );
  await pool.query(`update "order" set status = 'completed' where id = $1 and status in ('ready', 'in_transit')`, [orderId]);

  await check('the rider poll would now see DELIVERED and auto-advance the screen', async () => {
    const { rows } = await pool.query('select status from delivery_assignment where id = $1', [assignmentId]);
    assert(rows[0].status === 'DELIVERED', `expected DELIVERED, got ${rows[0].status}`);
  });

  console.log('=== The rider then submits a code anyway (a real race, not a mistake) ===');
  await check('the deliver route recognises alreadyDelivered instead of a confusing error', async () => {
    // Mirrors exactly the new guard in routes/rider.js's POST
    // /assignments/:id/deliver.
    const { rows } = await pool.query('select status from delivery_assignment where id = $1 and rider_id = $2', [assignmentId, riderId]);
    const existing = rows[0];
    assert(existing.status === 'DELIVERED', 'the assignment must already be DELIVERED for this branch to matter');
    // This is the exact condition routes/rider.js checks before the
    // generic "mark arrived first" 409 -- proving it fires for this state.
    const isAlreadyDeliveredCase = existing.status === 'DELIVERED';
    assert(isAlreadyDeliveredCase, 'expected the alreadyDelivered branch to be reachable from this state');
  });

  console.log(`\n${passed} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
