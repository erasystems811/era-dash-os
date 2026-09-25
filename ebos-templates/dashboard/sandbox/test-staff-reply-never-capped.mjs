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

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
