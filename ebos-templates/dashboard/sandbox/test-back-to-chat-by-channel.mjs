// Chidera, 2026-09-26: "instagram doesnt need the web chat, after linking
// monify, the back to merchant site button on instagram is taking customer
// back to web chat instead of the normal instagram chat." Monnify/Paystack's
// callbackUrl was hardcoded to /wa/:token (the real web-chat page) for
// every channel -- only ever correct for the website channel itself.
// Verifies resolveBackToChatUrl (now shared by all three payment-link call
// sites) sends a website customer back to the web-chat thread, but an
// Instagram customer to their own ig.me DM instead -- never the web chat
// they never used.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3953';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3953';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch('http://localhost:3953/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const { rows: branchRows } = await pool.query(
    `insert into branch (name, address, instagram_handle) values ('Main', '1 Test St', 'sample_restaurant_ig') returning id`
  );
  const branchId = branchRows[0].id;

  // === 1. Website: still the real web-chat thread, unchanged ===
  const webCustomer = await flow.findOrCreateCustomer({ phoneNumber: 'web-user-1', channel: 'website' });
  await pool.query(`update customers set branch_id = $1 where id = $2`, [branchId, webCustomer.id]);
  const webUrl = await flow.resolveBackToChatUrl({ ...webCustomer, branch_id: branchId, channel: 'website' }, 'menu-token-abc');
  assert(webUrl === 'http://localhost:3953/wa/menu-token-abc', `website still goes to the real web-chat thread (got "${webUrl}")`);

  // === 2. Instagram: the business's own ig.me DM, NOT the web chat ===
  const igCustomer = await flow.findOrCreateCustomer({ phoneNumber: 'ig-user-3', channel: 'instagram' });
  const igUrl = await flow.resolveBackToChatUrl({ ...igCustomer, branch_id: branchId, channel: 'instagram' }, 'menu-token-abc');
  assert(igUrl === 'https://ig.me/m/sample_restaurant_ig', `Instagram goes to the business's own ig.me DM (got "${igUrl}")`);
  assert(!igUrl?.includes('/wa/'), 'Instagram never gets the web-chat link');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
