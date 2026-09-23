#!/usr/bin/env node
// Regression test for Chidera's ask, 2026-09-11: "when an order is marked
// in delivery manually from the pipeline, it should stop showing as
// accept on riders phones as well." Staff's "Mark in delivery" button
// (POST /orders/:id/status with status='in_transit') must cancel any
// still-OPEN own_riders offer for that order, so it stops appearing to
// riders who haven't accepted it -- but must leave an already-CLAIMED
// offer alone, since that rider genuinely has the job.
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

// Mirrors exactly the new branch in routes/api.js's POST /orders/:id/status.
async function markInDelivery(orderId) {
  await pool.query(`update "order" set status = 'in_transit', updated_at = now() where id = $1`, [orderId]);
  const { rows: cancelledOffers } = await pool.query(
    `update delivery_offer set status = 'CANCELLED' where order_id = $1 and status = 'OPEN' returning id, branch_id`,
    [orderId]
  );
  return cancelledOffers;
}

async function main() {
  await seedSampleRestaurant();
  const { rows: custRows } = await pool.query(
    `insert into customers (name, phone_number, channel, address) values ('Test Cust', '2348050004444', 'manual', '1 Test Way') returning id`
  );
  const { rows: zoneRows } = await pool.query(
    `insert into delivery_zone (name, customer_fee, rider_payout) values ('Wuse 2', 1500, 1000) returning id`
  );

  console.log('=== Staff marks a STILL-OPEN offer "in delivery" themselves ===');
  const { rows: order1Rows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, status, delivery_zone_id) values ($1, 'RETRACT-0001', 'delivery', 'ready', $2) returning id`,
    [custRows[0].id, zoneRows[0].id]
  );
  const { rows: offer1Rows } = await pool.query(
    `insert into delivery_offer (order_id, zone_id, status, tracking_token) values ($1, $2, 'OPEN', 'retract-token-1') returning id`,
    [order1Rows[0].id, zoneRows[0].id]
  );

  await check('the open offer is cancelled, and reported back for retraction', async () => {
    const cancelled = await markInDelivery(order1Rows[0].id);
    assert(cancelled.length === 1, `expected exactly one cancelled offer, got ${cancelled.length}`);
    assert(cancelled[0].id === offer1Rows[0].id, 'expected the right offer to be the one cancelled');
    const { rows } = await pool.query('select status from delivery_offer where id = $1', [offer1Rows[0].id]);
    assert(rows[0].status === 'CANCELLED', `expected CANCELLED, got ${rows[0].status}`);
  });

  await check('it no longer shows up in the open-offers replay riders reconnect to', async () => {
    const { rows } = await pool.query(`select id from delivery_offer where status = 'OPEN' and order_id = $1`, [order1Rows[0].id]);
    assert(rows.length === 0, 'expected zero OPEN offers for this order');
  });

  console.log('=== Staff marks an ALREADY-CLAIMED offer "in delivery" -- must not touch it ===');
  const { rows: order2Rows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, status, delivery_zone_id) values ($1, 'RETRACT-0002', 'delivery', 'ready', $2) returning id`,
    [custRows[0].id, zoneRows[0].id]
  );
  const { rows: offer2Rows } = await pool.query(
    `insert into delivery_offer (order_id, zone_id, status, tracking_token) values ($1, $2, 'CLAIMED', 'retract-token-2') returning id`,
    [order2Rows[0].id, zoneRows[0].id]
  );

  await check('a rider who already has the job keeps it -- nothing gets cancelled', async () => {
    const cancelled = await markInDelivery(order2Rows[0].id);
    assert(cancelled.length === 0, `expected zero cancellations, got ${cancelled.length}`);
    const { rows } = await pool.query('select status from delivery_offer where id = $1', [offer2Rows[0].id]);
    assert(rows[0].status === 'CLAIMED', `expected CLAIMED untouched, got ${rows[0].status}`);
  });

  console.log(`\n${passed} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
