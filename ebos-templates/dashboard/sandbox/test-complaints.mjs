// Chidera, 2026-09-24: "there is also nowhere for complaint to go to,
// there is no database table, in that feedback tab in dashboard create a
// tab for complaint and let every complaint ping the manager on whatsapp,
// and if they want to reply, let reply not come to the bare chat let the
// customer be pinged with a you have a message from our manager, with tap
// here to chat button."
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3949';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3949';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3949';

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

  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@samplerestaurant.test', password: 'testpass123' }),
  });
  const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert(loginRes.status === 200 && !!cookie, 'staff login succeeded, got a real session cookie');
  const authed = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), 'Content-Type': 'application/json', cookie } });

  // === 1. A complaint submitted through the real form creates a real,
  // persistent row -- not just an ephemeral handover() alert. ===
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012358001', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);
  try {
    await fetch(`${BASE}/c/${token}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'My food arrived cold.' }),
    });
  } catch (err) {} // handover()'s own askText needs a real Anthropic key this sandbox doesn't have

  const { rows: complaintRows } = await pool.query('select * from complaint where customer_id = $1', [customer.id]);
  assert(complaintRows.length === 1, 'exactly one complaint row was created');
  assert(complaintRows[0].message === 'My food arrived cold.', 'with the customer\'s real words');
  assert(complaintRows[0].status === 'open', 'starting in the open status');

  // === 2. It shows up on the dashboard's own /complaints list. ===
  const list = await (await authed(`${BASE}/api/complaints`)).json();
  const listedComplaint = list.find((c) => c.id === complaintRows[0].id);
  assert(Boolean(listedComplaint), 'the complaint appears in the dashboard list');
  assert(listedComplaint.customer_phone === '2348012358001', 'with the real customer phone joined in');

  // === 3. Staff replying does NOT land silently in the bare chat -- it
  // logs as a real website bubble AND pings the customer for real. ===
  const replyRes = await authed(`${BASE}/api/complaints/${complaintRows[0].id}/reply`, {
    method: 'POST', body: JSON.stringify({ text: "So sorry about that -- we'll make it right on your next order." }),
  });
  assert(replyRes.status === 200, 'submitting the reply succeeds');

  const { rows: afterReply } = await pool.query('select status, staff_reply, replied_at from complaint where id = $1', [complaintRows[0].id]);
  assert(afterReply[0].status === 'replied', 'the complaint row itself moves to replied');
  assert(afterReply[0].staff_reply === "So sorry about that -- we'll make it right on your next order.", 'with the real reply text stored');
  assert(afterReply[0].replied_at !== null, 'and a real timestamp');

  const { rows: outboundRows } = await pool.query(
    `select body, channel, trigger from message where customer_id = $1 and direction = 'outbound' order by created_at asc`,
    [customer.id]
  );
  const bubbleMsg = outboundRows.find((m) => m.trigger === 'complaint_reply');
  const pingMsg = outboundRows.find((m) => m.trigger === 'complaint_reply_ping');
  assert(Boolean(bubbleMsg), 'the real reply content is logged as a website bubble');
  assert(bubbleMsg.channel === 'website', 'on the free website channel, not a real send');
  assert(bubbleMsg.body === "So sorry about that -- we'll make it right on your next order.", 'carrying the manager\'s actual words');
  assert(Boolean(pingMsg), 'a SEPARATE real ping was also sent');
  assert(pingMsg.channel === 'whatsapp', 'the ping itself is a real WhatsApp send -- the whole point is reaching them off-page');
  assert(/message from our manager/i.test(pingMsg.body), 'and it says a manager has a message, not the reply content itself');
  assert(!/make it right/i.test(pingMsg.body), 'the real reply content never leaks into the billable ping');

  // === 4. Resolving works, and a missing complaint id 404s instead of
  // silently no-op'ing. ===
  const resolveRes = await authed(`${BASE}/api/complaints/${complaintRows[0].id}/resolve`, { method: 'POST' });
  assert(resolveRes.status === 200, 'resolving succeeds');
  const { rows: afterResolve } = await pool.query('select status from complaint where id = $1', [complaintRows[0].id]);
  assert(afterResolve[0].status === 'resolved', 'the status is now resolved');

  const missingRes = await authed(`${BASE}/api/complaints/00000000-0000-0000-0000-000000000000/reply`, {
    method: 'POST', body: JSON.stringify({ text: 'hi' }),
  });
  assert(missingRes.status === 404, 'replying to a non-existent complaint 404s, not a silent success');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
