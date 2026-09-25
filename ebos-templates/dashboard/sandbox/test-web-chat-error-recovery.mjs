// Chidera, 2026-09-23, live report: "i sent a text, bot didnt reply me" --
// typed on the /wa chat page. Root cause: unlike the real WhatsApp path
// (scheduleDebouncedProcessing's own catch, flow.js), handleWebChatMessage
// had NO error-recovery net at all -- a free-text turn failing for any
// reason (the AI provider down/rate-limited, any dependency error) threw
// straight out with nothing caught anywhere. The client's own fetch call
// (web-chat-page-template.js's sendText) silently swallows the error, so
// the customer got absolute silence, not even a visible failure.
//
// This sandbox has no real ANTHROPIC_API_KEY (documented, deliberate, same
// scope note every other web-chat test makes) -- which makes it the
// perfect real reproduction of exactly this bug: typing genuine free text
// here always throws for real, no mocking needed.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3936';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3936';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3936';

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

  await pool.query(`insert into staff (name, phone_number, handover_alerts, order_alerts, role) values ('Owner', '2348099990005', true, true, 'owner')`);

  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012346001', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);
  // Real first bubble, then the customer actually types something --
  // driven through the real HTTP route, exactly as the chat page's own
  // sendText() does.
  await fetch(`${BASE}/wa/${token}`);

  const res1 = await fetch(`${BASE}/wa/${token}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'I want jollof rice please' }),
  });
  assert(res1.status === 200, 'the route itself still responds 200 even though processing fails behind it -- the crash never reaches the customer as a raw 500');

  const { rows: msgs1 } = await pool.query(
    `select body, channel, trigger from message where customer_id = $1 and direction = 'outbound' order by created_at`,
    [customer.id]
  );
  const errorAck = msgs1.find((m) => /someone will be with you shortly/i.test(m.body));
  assert(Boolean(errorAck), 'the customer gets a real apologetic ack instead of silence when processing genuinely fails');
  assert(errorAck?.channel === 'website', 'and it lands as a free bubble on the chat page, not a real WhatsApp send');

  const { rows: custAfter1 } = await pool.query(`select handled_by, handover_reason from customers where id = $1`, [customer.id]);
  assert(custAfter1[0].handled_by === 'staff', 'correctly handed over to staff since the bot genuinely could not process this turn');
  assert(/Unexpected error/i.test(custAfter1[0].handover_reason || ''), 'the real system-error reason, not a made-up customer-facing one');

  // === A second message while still in this same unresolved error-handover
  // must NOT repeat the "someone will be with you shortly" ack (no spam),
  // but staff must still get told a message came in. ===
  const res2 = await fetch(`${BASE}/wa/${token}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hello? anyone there?' }),
  });
  assert(res2.status === 200, 'the second message is also accepted without a raw crash reaching the customer');

  const { rows: msgs2 } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'outbound' order by created_at`,
    [customer.id]
  );
  const ackCount = msgs2.filter((m) => /someone will be with you shortly/i.test(m.body)).length;
  assert(ackCount === 1, 'the apologetic ack is sent exactly once, not repeated on every subsequent failed message');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
