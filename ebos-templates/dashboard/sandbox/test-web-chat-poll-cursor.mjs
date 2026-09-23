// Chidera, 2026-09-23, live report on era-demo (with a screenshot): the same
// bubble (an upsell offer, in her case) repeating forever on the /wa chat
// page, roughly every 3 seconds -- exactly matching the page's own poll()
// interval. Root cause: Postgres stores message.created_at at microsecond
// precision, but the client's own polling cursor (lastCursor, built by
// JSON.stringify-ing a JS Date the browser got back from a previous poll)
// can only round-trip millisecond precision -- JS Date has no concept of
// microseconds. So the real stored value (e.g. ...522672) is ALWAYS
// strictly greater than the truncated cursor sent back (...522000), and
// the exact same last row matched `created_at > $2` on every single poll,
// forever -- not just the one time it was genuinely new. Only ONE database
// row existed the whole time (confirmed live via psql before this fix);
// this was purely a display bug from the polling query re-fetching its own
// last row endlessly.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3939';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3939';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3939';

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

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012347001', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);

  // Insert a message with real microsecond precision, the same way
  // Postgres's own now() would -- not a round, ms-aligned timestamp,
  // which would accidentally hide this exact bug.
  const { rows: inserted } = await pool.query(
    `insert into message (customer_id, direction, channel, sender, body, trigger, created_at)
     values ($1, 'outbound', 'website', 'bot', 'Would you like to add a drink?', 'upsell_offered_list', now())
     returning id, created_at`,
    [customer.id]
  );
  const realCreatedAt = inserted[0].created_at;

  // Exactly what the browser does: JSON.stringify a JS Date built from the
  // server's own value -- this is where microsecond precision genuinely
  // gets lost, same as web-chat-page-template.js's own `lastCursor =
  // rows[rows.length - 1].created_at` followed by it going through
  // JSON.stringify on the next poll() call.
  const clientCursor = JSON.parse(JSON.stringify(new Date(realCreatedAt)));

  // First poll with this cursor -- must return nothing new (this message
  // was already delivered in the initial page load, this is what a REAL
  // poll() tick right after would send).
  const res1 = await fetch(`${BASE}/wa/${token}/messages?since=${encodeURIComponent(clientCursor)}`);
  const rows1 = await res1.json();
  assert(res1.status === 200, 'the poll endpoint responds');
  assert(Array.isArray(rows1) && rows1.length === 0, `the same message is NOT re-sent on the very next poll (got ${rows1.length} rows) -- this is the actual bug, confirmed reproducing`);

  // Simulate several more poll ticks with the SAME cursor (what actually
  // happened live -- lastCursor never advances once it's stuck repeating
  // its own last value) -- must stay empty every time, not just once.
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${BASE}/wa/${token}/messages?since=${encodeURIComponent(clientCursor)}`);
    const rows = await res.json();
    assert(rows.length === 0, `poll tick ${i + 2} also stays empty -- confirms this isn't a one-off, it would have looped forever before the fix`);
  }

  // A genuinely NEW message after this point must still come through --
  // proves the fix doesn't just suppress everything, only the already-seen row.
  await pool.query(
    `insert into message (customer_id, direction, channel, sender, body, trigger, created_at)
     values ($1, 'outbound', 'website', 'bot', 'A genuinely new message', 'test_new', now() + interval '10 milliseconds')`,
    [customer.id]
  );
  const res2 = await fetch(`${BASE}/wa/${token}/messages?since=${encodeURIComponent(clientCursor)}`);
  const rows2 = await res2.json();
  assert(rows2.length === 1 && rows2[0].body === 'A genuinely new message', 'a real new message still comes through correctly -- the fix only suppresses the already-seen one');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
