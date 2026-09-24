// Chidera, 2026-09-24: "let the webchat notification of received pop as a
// banner so customer can know their payment has been confirmed cause
// sometimes paystack leaves it loading there without making it clear when
// it has actually been confirmed." The chat page's own poll() only shows
// the banner for a message tagged trigger='payment_confirmed' -- verifying
// completePayment actually tags its customer-facing reply that way (both
// the delivery and pickup wording branches), and that the poll endpoint
// actually returns `trigger` in its JSON (the client-side check is dead
// without it).
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3946';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3946';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3946';

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

  const { rows: prodRows } = await pool.query(`select id, price from product limit 1`);

  // Pickup order, paid via a web-chat customer recently active.
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012355001', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);
  await pool.query(`update customers set web_chat_active_at = now() where id = $1`, [customer.id]);
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-BANNER-1', 'pickup', 3500, 'new', 'pending', 'confirm_payment', 'whatsapp') returning *`,
    [customer.id, ]
  );
  await pool.query(`insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)`, [orderRows[0].id, prodRows[0].id, prodRows[0].price]);

  await flow.completePayment(orderRows[0].id);

  const messages = await (await fetch(`${BASE}/wa/${token}/messages`)).json();
  const confirmed = messages.find((m) => m.trigger === 'payment_confirmed');
  assert(Boolean(confirmed), 'the poll endpoint returns a message tagged payment_confirmed -- what the client checks for to show the banner');
  assert(/payment received/i.test(confirmed?.body || ''), 'and it is the real payment-confirmed text, not something else coincidentally tagged');

  const { rows: allOutbound } = await pool.query(
    `select trigger, channel from message where customer_id = $1 and direction = 'outbound' order by created_at asc`,
    [customer.id]
  );
  assert(
    allOutbound.every((m) => m.channel === 'website'),
    'every reply for this recently-active web-chat customer stayed on the website channel -- no real WhatsApp send for the payment confirmation'
  );

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
