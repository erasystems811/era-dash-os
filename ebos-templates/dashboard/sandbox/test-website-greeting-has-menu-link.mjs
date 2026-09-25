// Chidera, 2026-09-25, real report: "i texted hi and it replied me welcome
// what would you like to order? in just text it didnt send the menu
// attached to it? why is the flow scattering?" Root cause, confirmed by
// reading: handleGreeting's own website-channel branch was written as a
// "shouldn't normally be reached" defensive fallback, but IS reachable --
// typing free text like "hi" directly into an already-open web chat
// (instead of tapping a button) goes through the normal AI intent
// classification, which lands here for a pure greeting. It sent
// buildGreetingContent's bare message with no menu link/button at all.
// Testing handleGreeting directly (now exported) rather than through the
// full dispatch()/classifyIntent pipeline -- that needs a real Anthropic
// API key this sandbox doesn't have (see test-whatsapp-redirect-and-
// cover-photo.mjs's own comment on the same constraint).
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3976';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3976';
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
    try { await fetch('http://localhost:3976/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348013380060', channel: 'whatsapp' });
  // In-memory override, same as routes/web-chat.js's own POST /:token/message
  // sets right before calling into the engine for a real typed message.
  customer.channel = 'website';

  await flow.handleGreeting(customer, 'hi');

  const { rows } = await pool.query(
    `select body, trigger, interactive from message where customer_id = $1 and direction = 'outbound' and channel = 'website' order by created_at desc limit 1`,
    [customer.id]
  );
  const bubble = rows[0];
  assert(Boolean(bubble), 'a bubble was produced');
  assert(bubble?.trigger === 'greeting', 'tagged as the real greeting trigger');
  assert(bubble?.interactive?.type === 'cta_url' && typeof bubble.interactive.url === 'string' && bubble.interactive.url.includes('/m/'), 'the greeting now carries a real "See menu" button, not just bare text');
  assert(bubble?.interactive?.buttonText === 'See menu', 'with the same "See menu" wording every other menu-link bubble uses');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
