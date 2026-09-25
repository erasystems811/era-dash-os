// Chidera, 2026-09-25: "the bot ANT BE SILENT FOREVER AFTER THE FIRST FIVE
// TIMES, AFTER 24 HOURS RENEW THE 5 TIMES TRIAL." Without a genuine web-
// chat visit, needsChatRedirect's own 5-ping cap used to stay exhausted
// permanently -- a customer who never once opens the web chat link would
// have been silently ignored forever after their 5th bare text. 24h of
// real silence since the last ping is now its own reset, same as a
// genuine visit already was.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3980';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3980';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function freshCustomer(pool, id) {
  const { rows } = await pool.query('select * from customers where id = $1', [id]);
  return rows[0];
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  for (let i = 0; i < 50; i++) {
    try { await fetch('http://localhost:3980/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // === 1. Exhausted cap (5 pings already sent), no web-chat visit at
  // all, but the last ping was over 24h ago -- must renew, not stay silent. ===
  const stale = await flow.findOrCreateCustomer({ phoneNumber: '2348013380100', channel: 'whatsapp' });
  await pool.query(`update customers set chat_redirect_sent_at = now() - interval '25 hours', chat_redirect_count = 5 where id = $1`, [stale.id]);
  const staleCustomer = await freshCustomer(pool, stale.id);
  assert((await flow.needsChatRedirect(staleCustomer)) === true, 'exhausted cap + 25h of real silence since the last ping -- renewed, not permanently silent');

  // === 2. Same exhausted cap, but the last ping was only recently (under
  // 24h) -- still genuinely capped, no renewal yet. ===
  const recent = await flow.findOrCreateCustomer({ phoneNumber: '2348013380101', channel: 'whatsapp' });
  await pool.query(`update customers set chat_redirect_sent_at = now() - interval '2 hours', chat_redirect_count = 5 where id = $1`, [recent.id]);
  const recentCustomer = await freshCustomer(pool, recent.id);
  assert((await flow.needsChatRedirect(recentCustomer)) === false, 'exhausted cap + only 2h since the last ping -- still genuinely capped, no premature renewal');

  // === 3. markChatRedirectSent itself must treat the 24h renewal as a
  // fresh start (count resets to 1), not just let the count keep climbing
  // past 5 forever. ===
  await flow.sendChatRedirectPing(staleCustomer, 'Renewed ping.', { trigger: 'chat_redirect_ping' });
  const { rows: afterRows } = await pool.query('select chat_redirect_count from customers where id = $1', [stale.id]);
  assert(afterRows[0].chat_redirect_count === 1, `the count genuinely resets to 1 on a 24h renewal, not 6 (got ${afterRows[0].chat_redirect_count})`);

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
