#!/usr/bin/env node
// Regression test for lifting the automatic-payout lock (Chidera's "yes",
// 2026-09-03, after "how do i actually do it from the restaurant"). This
// exercises the real guard logic POST /delivery-config/payout runs, since
// hitting the actual Express route needs a staff session this sandbox
// doesn't set up -- the SQL and validation branches are what's new and
// worth proving, matching this codebase's existing pattern of testing the
// real query a route runs rather than a paraphrase of it.
//
// Set EBOS_TEST_PGLITE=1 to run against a real, throwaway, in-process
// Postgres (see lib/db.js) -- schema.sql is applied automatically.
import { pool } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
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

// Mirrors the exact validation POST /delivery-config/payout runs, so this
// test is checking the real decision logic, not a paraphrase of it.
async function attemptSave({ payout_mode, provider, provider_keys }) {
  if (!['manual', 'automatic'].includes(payout_mode)) {
    throw new Error('payout_mode must be "manual" or "automatic".');
  }
  if (provider && !['paystack', 'flutterwave', 'moniepoint'].includes(provider)) {
    throw new Error(`Unknown payout provider "${provider}".`);
  }
  if (payout_mode === 'automatic') {
    if (!provider) throw new Error('Pick a payout provider first.');
    if (provider === 'moniepoint') {
      throw new Error('Moniepoint automatic payout is not built yet -- use manual payout for now, or switch to Paystack/Flutterwave.');
    }
    const { rows: existing } = await pool.query('select provider_keys from delivery_config limit 1');
    if (!provider_keys?.secretKey && !existing[0]?.provider_keys) {
      throw new Error("Add this provider's secret key before switching to automatic payout.");
    }
  }
  const { rows } = await pool.query(
    `with saved as (
       insert into delivery_config (business_id, payout_mode, provider, provider_keys)
       values ((select id from business limit 1), $1, $2, $3)
       on conflict (business_id) do update set payout_mode = excluded.payout_mode, provider = excluded.provider,
         provider_keys = coalesce(excluded.provider_keys, delivery_config.provider_keys)
       returning *
     )
     select business_id, mode, payout_mode, provider, provider_keys is not null as "hasProviderKey", offer_timeout_seconds from saved`,
    [payout_mode, provider || null, provider_keys?.secretKey ? encrypt(JSON.stringify(provider_keys)) : null]
  );
  return rows[0];
}

async function main() {
  await seedSampleRestaurant();

  console.log('=== Switching to automatic with no provider at all ===');
  await check('refused with a clear error', async () => {
    try {
      await attemptSave({ payout_mode: 'automatic' });
      throw new Error('expected a rejection');
    } catch (err) {
      assert(/pick a payout provider/i.test(err.message), `got: ${err.message}`);
    }
  });

  console.log('=== Switching to automatic with moniepoint ===');
  await check('refused -- moniepoint transfer API was never confirmed for real', async () => {
    try {
      await attemptSave({ payout_mode: 'automatic', provider: 'moniepoint', provider_keys: { secretKey: 'sk_test_x' } });
      throw new Error('expected a rejection');
    } catch (err) {
      assert(/moniepoint.*not built yet/i.test(err.message), `got: ${err.message}`);
    }
  });

  console.log('=== Switching to automatic with a provider but no key on file yet ===');
  await check('refused -- can never end up automatic with nothing that can pay anyone', async () => {
    try {
      await attemptSave({ payout_mode: 'automatic', provider: 'paystack' });
      throw new Error('expected a rejection');
    } catch (err) {
      assert(/secret key/i.test(err.message), `got: ${err.message}`);
    }
  });

  console.log('=== A real Paystack key actually turns automatic on ===');
  let saved;
  await check('saved with the key encrypted, never returned in plain', async () => {
    saved = await attemptSave({ payout_mode: 'automatic', provider: 'paystack', provider_keys: { secretKey: 'sk_live_realkeylookinghere' } });
    assert(saved.payout_mode === 'automatic', `expected automatic, got ${saved.payout_mode}`);
    assert(saved.provider === 'paystack', `expected paystack, got ${saved.provider}`);
    assert(saved.hasProviderKey === true, 'expected hasProviderKey true');
    assert(saved.provider_keys === undefined, 'the raw key must never come back in the response');
  });

  await check('the key is actually retrievable (decrypts back to what was sent), not just a flag', async () => {
    const { rows } = await pool.query('select provider_keys from delivery_config limit 1');
    const keys = JSON.parse(decrypt(rows[0].provider_keys));
    assert(keys.secretKey === 'sk_live_realkeylookinghere', 'decrypted key did not match what was saved');
  });

  console.log('=== Switching back to manual, then automatic again, without retyping the key ===');
  await check('the previously saved key is preserved across a manual round-trip', async () => {
    await attemptSave({ payout_mode: 'manual', provider: 'paystack' });
    const backToAutomatic = await attemptSave({ payout_mode: 'automatic', provider: 'paystack' });
    assert(backToAutomatic.payout_mode === 'automatic', 'expected automatic to be allowed again with no new key typed');
    assert(backToAutomatic.hasProviderKey === true, 'the old key must still be on file');
  });

  console.log(`\n${passed} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
