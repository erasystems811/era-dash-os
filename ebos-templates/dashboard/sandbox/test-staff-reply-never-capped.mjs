// Chidera, 2026-09-25, real live report: "i texted a customer on dee from
// staff dashboard on conversations and the customer didnt get the text?
// so when i say 3 text max i mean 3 GREETING text, when a staff is
// texting... why isnt it sending atall?" Then, same day, found live on
// dee's own DB: "activelyOnPage" (a stale web_chat_active_at) ALSO
// silenced it. Then, same day, a third correction after both of those
// were fixed: "its not every single text that you send we are trying to
// reach out to you, only the first staff reach out text, everything else
// is expected to go on in web chat." A fourth correction, 2026-10-01:
// "after i took over from bot it sent me one we are trying to reach out
// to you, upon handing back to bot why did it send another... it ended
// up sending 3 times, i said its once per take over" -- the "real visit"
// re-arm from the third correction turned out to be the same bug in a
// new shape (tapping the ping's own link IS a visit), so that's gone now
// too. All four taught the same lesson: staff pings can't share
// needsChatRedirect's own chat_redirect_sent_at/chat_redirect_count
// columns with the bot's automated redirect -- see needsStaffChatRedirect's
// own comment in engine/flow.js for the full story. This file verifies
// the FINAL, session-scoped behavior: staff always gets through the
// bot's own exhausted cap, but only ever gets exactly ONE ping per
// takeover (handover_at), full stop -- not per visit, not per 24h, only
// a genuinely new takeover (resumeBotControl, then escalated again)
// earns another.
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

  // === 1. Staff's genuine first-ever message to a customer whose bot-
  // redirect cap is already exhausted -- must still get through. ===
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012370001', channel: 'whatsapp' });
  await pool.query(`update customers set chat_redirect_sent_at = now() - interval '10 minutes', chat_redirect_count = 3 where id = $1`, [customer.id]);

  const exhausted = await pool.query('select * from customers where id = $1', [customer.id]);
  assert((await flow.needsChatRedirect(exhausted.rows[0])) === false, 'sanity check: the bot-redirect gate really is capped out');

  await flow.sendStaffReply(customer.id, 'Hi, just checking on your order.', null);
  const rows = await outboundRows(pool, customer.id);
  const bubble = rows.find((r) => r.trigger === 'staff_reply');
  const ping = rows.find((r) => r.trigger === 'staff_reply_ping');
  assert(Boolean(bubble), 'the real staff message is logged as a bubble');
  assert(Boolean(ping), 'staff still gets its own real ping, even though the bot-redirect cap is already exhausted');
  assert(ping.channel === 'whatsapp', 'the ping is a real WhatsApp send');

  // === 2. A SECOND staff message right after, still no visit -- must NOT
  // re-ping. "only the first staff reach out text, everything else is
  // expected to go on in web chat." ===
  await flow.sendStaffReply(customer.id, 'Update #2.', null);
  const rows2 = await outboundRows(pool, customer.id);
  const pings2 = rows2.filter((r) => r.trigger === 'staff_reply_ping');
  assert(pings2.length === 1, `a second staff message right after does NOT get its own ping -- exactly one ping total so far (got ${pings2.length})`);

  // A third, for good measure -- still exactly one ping total.
  await flow.sendStaffReply(customer.id, 'Update #3.', null);
  const rows3 = await outboundRows(pool, customer.id);
  const pings3 = rows3.filter((r) => r.trigger === 'staff_reply_ping');
  assert(pings3.length === 1, `a third staff message still doesn't re-ping -- still exactly one ping total (got ${pings3.length})`);

  // === 3. Found live on dee's own DB: a stale (but within-30-min)
  // web_chat_active_at must not suppress staff's OWN first ping either --
  // needsStaffChatRedirect never looks at that "actively on page"
  // heuristic at all, only at staff's own prior pings. ===
  const customer2 = await flow.findOrCreateCustomer({ phoneNumber: '2348012370002', channel: 'whatsapp' });
  await pool.query(`update customers set web_chat_active_at = now() - interval '15 minutes' where id = $1`, [customer2.id]);
  const fresh2 = await pool.query('select * from customers where id = $1', [customer2.id]);
  assert((await flow.needsChatRedirect(fresh2.rows[0])) === false, 'sanity check: the BOT-redirect gate really is suppressed by a recent web-chat visit');

  await flow.sendStaffReply(customer2.id, 'Hi, just checking on your order.', null);
  const rowsC2 = await outboundRows(pool, customer2.id);
  const pingC2 = rowsC2.find((r) => r.trigger === 'staff_reply_ping');
  assert(Boolean(pingC2), 'a staff reply still gets its real first ping even when web_chat_active_at is recent -- staff never relies on that heuristic');

  // A second message for THIS customer too -- still no re-ping, no visit
  // since that one real ping.
  await flow.sendStaffReply(customer2.id, 'Update #2.', null);
  const rowsC2b = await outboundRows(pool, customer2.id);
  const pingsC2b = rowsC2b.filter((r) => r.trigger === 'staff_reply_ping');
  assert(pingsC2b.length === 1, `still exactly one ping total for this customer too (got ${pingsC2b.length})`);

  // === 4. Chidera, 2026-10-01, real live report: "after i took over from
  // bot it sent me one we are trying to reach out to you, upon handing
  // back to bot why did it send another... it ended up sending 3 times, i
  // said its once per take over." A web-chat visit AFTER the one staff
  // ping used to earn a fresh nudge (the old #4 here) -- but a visit is
  // exactly what tapping the ping's own link looks like, so the ping
  // doing its job was re-arming itself. "Once per takeover" now means
  // exactly that: a visit, even a real one, earns nothing more this
  // session. ===
  await pool.query(`update customers set web_chat_active_at = now() where id = $1`, [customer2.id]);
  await flow.sendStaffReply(customer2.id, 'Following up again.', null);
  const rowsC2c = await outboundRows(pool, customer2.id);
  const pingsC2c = rowsC2c.filter((r) => r.trigger === 'staff_reply_ping');
  assert(pingsC2c.length === 1, `a visit since the last ping no longer earns a fresh one -- still exactly one ping this takeover (got ${pingsC2c.length})`);

  // === 5. A genuinely NEW takeover (resumeBotControl, then escalated
  // again) is a different session -- gets its own fresh ping. ===
  await flow.resumeBotControl(customer2.id);
  const afterResume = await pool.query('select handover_at from customers where id = $1', [customer2.id]);
  assert(afterResume.rows[0].handover_at === null, 'sanity check: resumeBotControl genuinely cleared handover_at');
  await flow.sendStaffReply(customer2.id, 'Taking this over again.', null);
  const rowsC2d = await outboundRows(pool, customer2.id);
  const pingsC2d = rowsC2d.filter((r) => r.trigger === 'staff_reply_ping');
  assert(pingsC2d.length === 2, `a genuinely new takeover after resumeBotControl earns its own one ping (got ${pingsC2d.length})`);
  await flow.sendStaffReply(customer2.id, 'Still following up.', null);
  const rowsC2e = await outboundRows(pool, customer2.id);
  const pingsC2e = rowsC2e.filter((r) => r.trigger === 'staff_reply_ping');
  assert(pingsC2e.length === 2, `and still no re-ping within THIS new takeover either (got ${pingsC2e.length})`);

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
