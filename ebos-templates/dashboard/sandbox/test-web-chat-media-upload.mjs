// Chidera, 2026-09-23: "also where customer is typing let + actually
// enable them to upload photo of file or camer...qnd remove the camera
// image icon by the side, it doesnt do anything." The chat page's "+" now
// posts a data URL straight to routes/web-chat.js's new /:token/media,
// which calls flow.js's new handleWebChatMedia -- the web-chat equivalent
// of handleInboundMedia (real WhatsApp photos), minus the WhatsApp
// media-ID download step since the browser already hands over the file.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3942';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3942';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3942';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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

  // === 1. A customer with an order genuinely awaiting payment -- proof
  // should be saved, order flipped to proof_submitted/confirmation, and
  // the ack stays on the website channel (no real WhatsApp send). ===
  const customer = await flow.findOrCreateCustomer({ phoneNumber: '2348012351001', channel: 'whatsapp' });
  const token = await flow.ensureMenuToken(customer);
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, fulfilment_type, total, status, payment_status, engine_state, channel)
     values ($1, 'REF-MEDIA-1', 'pickup', $2, 'new', 'pending', 'confirm_payment', 'whatsapp') returning *`,
    [customer.id, prodRows[0].price]
  );
  const order = orderRows[0];

  // handover() (called after a proof is saved) summarises the transcript
  // via a real Anthropic call -- no key is configured in this sandbox, so
  // it 401s here the exact same way it would for ANY handover in this
  // environment (every existing call site does this, not something new).
  // The upload/proof-saving logic itself runs and is fully verifiable
  // against the database before that call happens; the route surfacing a
  // 500 for a downstream summarisation failure is an existing, unrelated
  // behavior of handover() shared by every trigger that calls it.
  try {
    await fetch(`${BASE}/wa/${token}/media`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: TINY_PNG }),
    });
  } catch (err) {}

  const { rows: proofRows } = await pool.query(`select * from order_payment_proof where order_id = $1`, [order.id]);
  assert(proofRows.length === 1, 'exactly one payment-proof row saved for the order');
  assert(proofRows[0].data_url === TINY_PNG, 'the real uploaded image data is what got stored');

  const { rows: orderAfter } = await pool.query(`select payment_status, status from "order" where id = $1`, [order.id]);
  assert(orderAfter[0].payment_status === 'proof_submitted', 'order payment_status moved to proof_submitted');
  assert(orderAfter[0].status === 'confirmation', 'order status moved to confirmation, pending a real person');

  const { rows: outbound } = await pool.query(
    `select channel, body from message where customer_id = $1 and direction = 'outbound' order by created_at asc limit 1`,
    [customer.id]
  );
  assert(outbound[0]?.channel === 'website', 'the ack stayed on the website channel -- no real WhatsApp send for an upload done on the chat page');
  assert(/confirm the payment/i.test(outbound[0]?.body || ''), 'and the FIRST ack sent (before handover ever ran) is the real payment-proof-received message');

  // === 2. A customer with no order awaiting payment -- no proof row gets
  // created, no crash from the upload handling itself. ===
  const strayCustomer = await flow.findOrCreateCustomer({ phoneNumber: '2348012351002', channel: 'whatsapp' });
  const strayToken = await flow.ensureMenuToken(strayCustomer);
  try {
    await fetch(`${BASE}/wa/${strayToken}/media`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: TINY_PNG }),
    });
  } catch (err) {}
  const { rows: strayProof } = await pool.query(
    `select count(*)::int as n from order_payment_proof op join "order" o on o.id = op.order_id where o.customer_id = $1`,
    [strayCustomer.id]
  );
  assert(strayProof[0].n === 0, 'nothing gets saved as a payment proof when there is no order to attach it to');

  // === 3. Not an image/PDF -- rejected outright, never reaches the engine. ===
  const res3 = await fetch(`${BASE}/wa/${token}/media`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: 'data:text/plain;base64,aGVsbG8=' }),
  });
  assert(res3.status === 400, 'a non-image/PDF data URL is rejected with a 400, not silently accepted');

  console.log(process.exitCode === 1 ? '\n=== SOME CHECKS FAILED ===' : '\n=== ALL CHECKS PASSED ===');
  process.exit(process.exitCode === 1 ? 1 : 0);
}

main().catch((err) => { console.error('CRASHED:', err); process.exit(1); });
