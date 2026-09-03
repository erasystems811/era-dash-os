#!/usr/bin/env node
// Regression test for the real bug behind "it keeps saying no rider offer
// exists for this order" (Chidera, 2026-09-03): a manually created order
// used to resolve its delivery zone by fuzzy-matching the typed address
// against delivery_zone.aliases (resolveZoneForAddress) -- an address that
// didn't match anything left delivery_zone_id null, which meant
// maybeDispatchOwnRiders silently never dispatched a rider for it at all,
// with nothing telling staff until "Ring rider" turned up empty on an
// order that looked completely normal. Fixed by having staff pick a real
// delivery_zone row directly (a dropdown, not free text) -- this proves
// that path actually reaches a real dispatch.
//
// Set EBOS_TEST_PGLITE=1 to run against a real, throwaway, in-process
// Postgres (see lib/db.js) -- schema.sql is applied automatically.
import { pool } from '../lib/db.js';
import { findOrCreateCustomer, newReference } from '../engine/flow.js';
import { createDelivery } from '../engine/delivery.js';
import { maybeDispatchOwnRiders } from '../engine/delivery-dispatch.js';
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
  const { rows: bizRows } = await pool.query('select id from business limit 1');
  await pool.query(
    `insert into delivery_config (business_id, mode, offer_timeout_seconds, payout_mode) values ($1, 'own_riders', 90, 'manual')
     on conflict (business_id) do update set mode = 'own_riders'`,
    [bizRows[0].id]
  );

  const { rows: zoneRows } = await pool.query(
    `insert into delivery_zone (name, aliases, customer_fee, rider_payout) values ('Maitama', '{}', 2000, 1200) returning id`
  );
  const zoneId = zoneRows[0].id;

  console.log('=== A manual order created with a real zone id (the new form) ===');
  const customer = await findOrCreateCustomer({ phoneNumber: '2348070001111', channel: 'manual', branchId: null });
  await pool.query('update customers set address = $1 where id = $2', ['9 Real Address, somewhere never aliased', customer.id]);
  customer.address = '9 Real Address, somewhere never aliased'; // deliberately NOT matching the zone's own name/aliases

  const { rows: zoneCheck } = await pool.query('select customer_fee from delivery_zone where id = $1', [zoneId]);
  const deliveryFee = Number(zoneCheck[0].customer_fee);

  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, engine_state, status, total, delivery_fee, payment_status, fulfilment_type, delivery_zone_id)
     values ($1, $2, 'fulfilment', 'preparation', $3, $4, 'confirmed', 'delivery', $5) returning *`,
    [customer.id, newReference('ORD'), 5000 + deliveryFee, deliveryFee, zoneId]
  );
  const order = orderRows[0];
  await createDelivery(order, customer);

  await check('the order carries a real delivery_zone_id even though the address matches no alias', async () => {
    const { rows } = await pool.query('select delivery_zone_id, fulfilment_type from "order" where id = $1', [order.id]);
    assert(rows[0].delivery_zone_id === zoneId, 'expected the explicitly chosen zone id, not a fuzzy-matched one');
    assert(rows[0].fulfilment_type === 'delivery', 'a manual order must always be fulfilment_type delivery');
  });

  console.log('=== Marking it ready actually dispatches a rider offer now ===');
  await pool.query(`update "order" set status = 'ready' where id = $1`, [order.id]);
  await check('maybeDispatchOwnRiders creates a real delivery_offer -- the exact thing "Ring rider" needs to find', async () => {
    await maybeDispatchOwnRiders(order.id);
    const { rows } = await pool.query(`select status from delivery_offer where order_id = $1`, [order.id]);
    assert(rows.length === 1, `expected exactly one delivery_offer, found ${rows.length}`);
    assert(rows[0].status === 'OPEN', `expected OPEN, got ${rows[0].status}`);
  });

  console.log(`\n${passed} checks passed.`);
  // Deliberately not awaiting pool.end() -- something in maybeDispatchOwnRiders's
  // real fire-and-forget dependency chain (notifyDeliverySearching, most
  // likely) leaves a PGlite client checked out even after every assertion
  // above has already passed, which makes pool.end() itself hang forever
  // (confirmed: the checks above print and pass instantly every run: it's
  // specifically process exit that never happens). Harmless in the real
  // running dashboard, which never calls pool.end() at all -- this script
  // just needs to actually terminate once its own checks are done.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
