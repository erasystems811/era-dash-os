// Chidera, 2026-09-25: "even online delivery should have a back to chat
// button on the web menu." Checked first, not assumed -- routes/
// menu-page.js's GET /:token already wires webChatPath the same way
// routes/dinein-menu.js's own copy does (test-dinein-menu-page-channel.mjs
// covers that one), sharing the same menu-page-template.js rendering. No
// code changes needed; this just locks the existing behavior in with a
// dedicated test, since only the dine-in case had one before.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3971';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3971';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3971';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function main() {
  await import('../server.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012223344', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);

  // === 1. Never visited the web chat -- no back-to-chat link, nothing to
  // go back to yet. Not the bug, just confirming the fix doesn't over-fire. ===
  const before = await (await fetch(`${BASE}/m/${token}`)).text();
  assert(!before.includes('<a class="back-to-chat"'), 'a guest who never visited the web chat gets no back-to-chat link on the online menu');

  // === 2. Genuinely visits the online web chat first, THEN the menu page
  // -- the real fix, same gate dine-in's own already has. ===
  await fetch(`${BASE}/wa/${token}`);
  const after = await (await fetch(`${BASE}/m/${token}`)).text();
  assert(after.includes('<a class="back-to-chat"'), 'after a genuine web-chat visit, the online menu page shows the back-to-chat link');
  const hrefMatch = after.match(/<a class="back-to-chat" href="([^"]*)"/);
  assert(hrefMatch && hrefMatch[1] === `/wa/${token}`, 'and it points at the generic online thread, not a dine-in one');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
