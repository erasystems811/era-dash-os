// Chidera, 2026-09-20: "how do we integrate the pos now, we really need to
// figure that out." Her real Moniepoint account's own webhook subscription
// (created through their Settings UI, already Active, correctly pointed at
// era-demo) authenticates deliveries with HMAC-SHA256 over the raw body
// (moniepoint-webhook-id__moniepoint-webhook-timestamp__body, base64,
// moniepoint-webhook-signature header) -- a completely different mechanism
// than the Basic-auth one this route used to check, which was built
// against the API-key "POS as a Platform" system that never actually
// worked (every generated key came back "Invalid key provided"). This
// specifically covers the signature verification itself: a correctly
// signed real transaction auto-confirms, a wrong secret / tampered body /
// missing headers gets rejected outright, and a non-COMPLETED transaction
// status is never treated as a real payment.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3938';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3938';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

import crypto from 'node:crypto';

const BASE = 'http://localhost:3938';
const REAL_SECRET = 'real-webhook-secret';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

function sign(secret, webhookId, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${webhookId}__${timestamp}__${body}`).digest('base64');
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const { rows: bizRows } = await pool.query(`select id from business limit 1`);
  await pool.query(
    `insert into pos_sync_config (business_id, enabled, webhook_secret) values ($1, true, $2)
     on conflict (business_id) do update set enabled = true, webhook_secret = $2`,
    [bizRows[0].id, REAL_SECRET]
  );

  const makeBody = (ref, status = 'COMPLETED') => JSON.stringify({
    eventId: `evt-${ref}`,
    eventType: 'V1_POS_TRANSFER_TRANSACTION',
    data: { transactionReference: ref, amount: 350000, transactionTime: new Date().toISOString(), transactionStatus: status },
    createdAt: new Date().toISOString(),
  });

  // === Correctly signed, real transaction -- accepted and logged ===
  const body1 = makeBody('SIG-REAL-1');
  const webhookId1 = 'wh-1';
  const timestamp1 = String(Date.now());
  const res1 = await fetch(`${BASE}/webhook/moniepoint`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'moniepoint-webhook-id': webhookId1,
      'moniepoint-webhook-timestamp': timestamp1,
      'moniepoint-webhook-signature': sign(REAL_SECRET, webhookId1, timestamp1, body1),
    },
    body: body1,
  });
  assert(res1.status === 200, 'a correctly signed real delivery is accepted');
  await new Promise((r) => setTimeout(r, 200));
  const { rows: logged1 } = await pool.query(`select amount from pos_transaction where provider_reference = 'SIG-REAL-1'`);
  assert(logged1.length === 1 && Number(logged1[0].amount) === 3500, 'the transaction actually got logged with the real amount');

  // === Wrong secret -- rejected outright ===
  const body2 = makeBody('SIG-WRONG-SECRET');
  const webhookId2 = 'wh-2';
  const timestamp2 = String(Date.now());
  const res2 = await fetch(`${BASE}/webhook/moniepoint`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'moniepoint-webhook-id': webhookId2,
      'moniepoint-webhook-timestamp': timestamp2,
      'moniepoint-webhook-signature': sign('some-other-secret', webhookId2, timestamp2, body2),
    },
    body: body2,
  });
  assert(res2.status === 401, 'a delivery signed with the wrong secret is rejected');
  const { rows: notLogged2 } = await pool.query(`select 1 from pos_transaction where provider_reference = 'SIG-WRONG-SECRET'`);
  assert(notLogged2.length === 0, 'the rejected delivery never gets logged as a real transaction');

  // === Tampered body (signature doesn't match what was actually sent) ===
  const body3 = makeBody('SIG-TAMPERED');
  const webhookId3 = 'wh-3';
  const timestamp3 = String(Date.now());
  const realSignature3 = sign(REAL_SECRET, webhookId3, timestamp3, body3);
  const tamperedBody3 = body3.replace('350000', '1'); // someone tried to change the amount in transit
  const res3 = await fetch(`${BASE}/webhook/moniepoint`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'moniepoint-webhook-id': webhookId3,
      'moniepoint-webhook-timestamp': timestamp3,
      'moniepoint-webhook-signature': realSignature3,
    },
    body: tamperedBody3,
  });
  assert(res3.status === 401, 'a tampered body no longer matches its own signature and is rejected');

  // === Missing signature header entirely ===
  const body4 = makeBody('SIG-NO-HEADER');
  const res4 = await fetch(`${BASE}/webhook/moniepoint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body4,
  });
  assert(res4.status === 401, 'a delivery with no signature headers at all is rejected, not treated as trusted');

  // === Real signature, but the transaction itself never actually completed ===
  const body5 = makeBody('SIG-PENDING', 'PENDING');
  const webhookId5 = 'wh-5';
  const timestamp5 = String(Date.now());
  const res5 = await fetch(`${BASE}/webhook/moniepoint`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'moniepoint-webhook-id': webhookId5,
      'moniepoint-webhook-timestamp': timestamp5,
      'moniepoint-webhook-signature': sign(REAL_SECRET, webhookId5, timestamp5, body5),
    },
    body: body5,
  });
  assert(res5.status === 200, 'a correctly signed PENDING-status delivery is still acknowledged (200)');
  await new Promise((r) => setTimeout(r, 200));
  const { rows: notLogged5 } = await pool.query(`select 1 from pos_transaction where provider_reference = 'SIG-PENDING'`);
  assert(notLogged5.length === 0, 'but a non-COMPLETED transaction is never treated as a real payment');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
