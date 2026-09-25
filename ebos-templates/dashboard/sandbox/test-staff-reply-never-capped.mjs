// Chidera, 2026-09-25, real live report: "i texted a customer on dee from
// staff dashboard on conversations and the customer didnt get the text?
// so when i say 3 text max i mean 3 GREETING text, when a staff is
// texting... why isnt it sending atall?" Real bug: needsChatRedirect's
// 3-ping cap was shared between the bot's own automatic bare-WhatsApp
// redirect (which SHOULD cap at 3) and sendStaffReply (a real human
// staff member reaching out), so a customer who'd already exhausted
// their 3 bot pings went permanently silent for staff too. Fixed with a
// `capped: false` override, staff-only.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3954';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3954';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

async function outboundRows(pool, customerId) {
  const { rows } = await pool.query(
    `select channel, sender, body, trigger from message where customer_id = $1 and direction = 'outbound' order by created_at asc`,
    [customerId]
  );
  return rows;
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const flow = await import('../engine/flow.js');

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012370001', channel: 'whatsapp' });

  // Exhaust the bot's own 3-ping cap first, exactly as if this customer
  // had been texting bare WhatsApp repeatedly with no chat visit.
  await pool.query(`update customers set chat_redirect_sent_at = now() - interval '10 minutes', chat_redirect_count = 3 where id = $1`, [customer.id]);

  // The bot's own redirect gate must now correctly be exhausted.
  const exhausted = await pool.query('select * from customers where id = $1', [customer.id]);
  assert((await flow.needsChatRedirect(exhausted.rows[0])) === false, 'sanity check: the bot-redirect gate really is capped out (default capped:true)');

  // But a staff member reaching out right now must ALWAYS get through.
  await flow.sendStaffReply(customer.id, 'Hi, just checking on your order.', null);
  const rows = await outboundRows(pool, customer.id);
  const bubble = rows.find((r) => r.trigger === 'staff_reply');
  const ping = rows.find((r) => r.trigger === 'staff_reply_ping');
  assert(Boolean(bubble), 'the real staff message is logged as a bubble');
  assert(Boolean(ping), 'a real WhatsApp ping IS sent for staff, even with the bot-redirect cap already exhausted');
  assert(ping.channel === 'whatsapp', 'the ping is a real WhatsApp send');

  // A SECOND staff message right after, still no visit -- must also go
  // through every time, no cap at all for staff.
  await flow.sendStaffReply(customer.id, 'Update #2.', null);
  const rows2 = await outboundRows(pool, customer.id);
  const pings2 = rows2.filter((r) => r.trigger === 'staff_reply_ping');
  assert(pings2.length === 2, 'a second staff message right after still gets its own real ping -- staff is never capped');

  // Chidera, 2026-09-25, same live report, checked directly against dee's
  // real DB: `capped: false` alone didn't actually fix it -- 3 real staff
  // replies there, zero pings, because this customer's web_chat_active_at
  // was still inside the 30-min "actively on the page" window (stale from
  // browsing the web chat ~15 minutes earlier, unrelated to this exact
  // moment) -- `activelyOnPage` skipped the ping before capped was ever
  // even reached. Reproduces that exact real state here.
  const customer2 = await flow.findOrCreateCustomer({ phoneNumber: '2348012370002', channel: 'whatsapp' });
  await pool.query(`update customers set web_chat_active_at = now() - interval '15 minutes' where id = $1`, [customer2.id]);
  const fresh2 = await pool.query('select * from customers where id = $1', [customer2.id]);
  assert((await flow.needsChatRedirect(fresh2.rows[0])) === false, 'sanity check: the bot-redirect gate really is suppressed by a recent web-chat visit (default checkActive:true)');

  await flow.sendStaffReply(customer2.id, 'Hi, just checking on your order.', null);
  const rows3 = await outboundRows(pool, customer2.id);
  const ping3 = rows3.find((r) => r.trigger === 'staff_reply_ping');
  assert(Boolean(ping3), 'a staff reply still gets a real ping even when web_chat_active_at is recent -- staff never relies on that heuristic either');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
